/**
 * Composition Graph Service
 *
 * Manages the composition graph for activity orchestration with Thompson Sampling at edge level.
 *
 * SPEC: openspec/changes/vessel-integration-standardization/specs/minibob-goal-orchestrators/spec.md
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import beta from '@stdlib/random-base-beta';
import { accountIdScopedWhere } from '../routes/activities';

// =============================================================================
// TYPES
// =============================================================================

export interface CompositionNode {
  id?: string;
  activity_id: string;
  input_shapes: string[];
  output_shapes: string[];
  success_rate: number;
  avg_duration_ms: number;
  total_executions: number;
  org_id: string;
  public: boolean;
  updated_at?: string;
}

export interface CompositionEdge {
  id?: string;
  from_activity: string;
  to_activity: string;
  shape_produced: string;
  alpha: number;
  beta: number;
  weight: number;
  success_count: number;
  failure_count: number;
  total_count: number;
  org_id: string;
  public: boolean;
  updated_at?: string;
}

export interface CompositionChain {
  id?: string;
  orchestrator_id: string;
  execution_id: string;
  activity_sequence: string[];
  shape_sequence: string[];
  success: boolean;
  target_shapes_achieved: string[];
  target_shapes_missing: string[];
  total_duration_ms: number;
  total_cost_usd: number;
  org_id: string;
  created_at?: string;
}

export interface ChainCandidate {
  activity_id: string;
  input_shapes: string[];
  output_shapes: string[];
  success_rate: number;
  thompson_score: number;
}

// =============================================================================
// COMPOSITION GRAPH SERVICE
// =============================================================================

export class CompositionGraphService {
  /**
   * Find activity chains that can transform current shapes to target shapes
   *
   * Phase B-followup: dual-tenant scoping. Prefer account_id; legacy rows
   * (account_id IS NONE) match via the org_id branch. accountId optional.
   */
  async findChains(
    currentShapes: string[],
    targetShapes: string[],
    orgId: string,
    maxDepth: number = 5,
    accountId?: string | null
  ): Promise<ChainCandidate[]> {
    try {
      // Find activities that can run with current shapes
      const candidatesQuery = `
        SELECT * FROM composition_node WHERE
          (${accountIdScopedWhere()} OR public = true) AND
          array::intersect(input_shapes, $current_shapes) = input_shapes
      `;

      const candidatesResult = await surrealDB.query(candidatesQuery, {
        org_id: orgId,
        account_id: accountId ?? null,
        current_shapes: currentShapes,
      });

      const candidates = (candidatesResult[0] as CompositionNode[]) || [];

      // Filter to activities that produce target shapes
      const productive = candidates.filter(node =>
        node.output_shapes.some(shape => targetShapes.includes(shape))
      );

      // Sample Thompson Sampling scores for each edge
      // (In a full implementation, we'd traverse the graph to find multi-hop chains)
      const chainCandidates: ChainCandidate[] = productive.map(node => {
        // For each productive node, sample its Thompson score
        // In reality, we'd look at edges FROM current activities TO this one
        // For now, use the node's success rate as a proxy
        const alpha = node.success_rate * node.total_executions + 1;
        const beta_param = (1 - node.success_rate) * node.total_executions + 1;
        const thompson_score = beta(alpha, beta_param);

        return {
          activity_id: node.activity_id,
          input_shapes: node.input_shapes,
          output_shapes: node.output_shapes,
          success_rate: node.success_rate,
          thompson_score,
        };
      });

      // Sort by Thompson score descending
      chainCandidates.sort((a, b) => b.thompson_score - a.thompson_score);

      logger.info(`Found ${chainCandidates.length} chain candidates`, {
        currentShapes,
        targetShapes,
        topCandidate: chainCandidates[0]?.activity_id,
      });

      return chainCandidates;
    } catch (error) {
      logger.error('Failed to find composition chains', { error });
      throw error;
    }
  }

  /**
   * Select next activity using Thompson Sampling
   *
   * Phase B-followup: dual-tenant scoping. accountId optional; legacy rows
   * match via accountIdScopedWhere()'s org_id fallback.
   */
  async selectNext(
    currentShapes: string[],
    candidates: string[],
    orgId: string,
    accountId?: string | null
  ): Promise<string | null> {
    try {
      if (candidates.length === 0) {
        return null;
      }

      // Get edges for all candidate transitions
      // For simplification, assume we're selecting the first activity in a chain
      // In a full implementation, we'd consider edges from the current activity
      const nodesQuery = `
        SELECT * FROM composition_node WHERE
          (${accountIdScopedWhere()} OR public = true) AND
          activity_id INSIDE $candidates
      `;

      const nodesResult = await surrealDB.query(nodesQuery, {
        org_id: orgId,
        account_id: accountId ?? null,
        candidates,
      });

      const nodes = (nodesResult[0] as CompositionNode[]) || [];

      if (nodes.length === 0) {
        // No nodes found, just return first candidate
        return candidates[0];
      }

      // Sample Thompson scores for each node
      const scores = nodes.map(node => {
        const alpha = node.success_rate * node.total_executions + 1;
        const beta_param = (1 - node.success_rate) * node.total_executions + 1;
        return {
          activity_id: node.activity_id,
          score: beta(alpha, beta_param),
        };
      });

      // Select activity with highest sampled score
      scores.sort((a, b) => b.score - a.score);
      const selected = scores[0].activity_id;

      logger.info(`Thompson Sampling selected activity: ${selected}`, {
        scores: scores.map(s => ({ id: s.activity_id, score: s.score.toFixed(3) })),
      });

      return selected;
    } catch (error) {
      logger.error('Failed to select next activity', { error });
      // Fallback to first candidate
      return candidates[0] || null;
    }
  }

  /**
   * Update composition edge after traversal
   */
  async updateEdge(
    fromActivity: string,
    toActivity: string,
    shapeProduced: string,
    success: boolean,
    orgId: string
  ): Promise<void> {
    try {
      // Use the helper function defined in schema
      const updateQuery = `
        RETURN fn::update_composition_edge($from, $to, $shape, $success);
      `;

      await surrealDB.query(updateQuery, {
        from: fromActivity,
        to: toActivity,
        shape: shapeProduced,
        success,
      });

      logger.info(`Updated composition edge: ${fromActivity} → ${toActivity}`, {
        shape: shapeProduced,
        success,
      });
    } catch (error) {
      logger.error('Failed to update composition edge', { error });
      throw error;
    }
  }

  /**
   * Record a composition chain from an orchestration execution
   *
   * Phase B-followup: dual-write account_id alongside org_id on CREATE
   * (table now has the field via migration 097). accountId optional.
   */
  async recordChain(
    chain: Omit<CompositionChain, 'id' | 'created_at'>,
    accountId?: string | null
  ): Promise<void> {
    try {
      const createQuery = `
        CREATE composition_chain SET
          orchestrator_id = $orchestrator_id,
          execution_id = $execution_id,
          activity_sequence = $activity_sequence,
          shape_sequence = $shape_sequence,
          success = $success,
          target_shapes_achieved = $target_shapes_achieved,
          target_shapes_missing = $target_shapes_missing,
          total_duration_ms = $total_duration_ms,
          total_cost_usd = $total_cost_usd,
          org_id = $org_id,
          account_id = $account_id,
          account_id_version = $account_id_version;
      `;

      await surrealDB.query(createQuery, {
        ...chain,
        account_id: accountId ?? null,
        account_id_version: 1,
      });

      logger.info(`Recorded composition chain for execution ${chain.execution_id}`, {
        orchestrator: chain.orchestrator_id,
        success: chain.success,
        chain_length: chain.activity_sequence.length,
      });

      // Update edges in the chain
      for (let i = 0; i < chain.activity_sequence.length - 1; i++) {
        const from = chain.activity_sequence[i];
        const to = chain.activity_sequence[i + 1];
        const shape = chain.shape_sequence[i + 1] || 'unknown';

        await this.updateEdge(from, to, shape, chain.success, chain.org_id);
      }
    } catch (error) {
      logger.error('Failed to record composition chain', { error });
      throw error;
    }
  }

  /**
   * Update or create a composition node for an activity
   *
   * Phase B-followup: dual-tenant scoping for the lookup; dual-write
   * account_id + version on CREATE. accountId optional; legacy rows
   * match via accountIdScopedWhere()'s org_id fallback.
   */
  async updateNode(
    activityId: string,
    inputShapes: string[],
    outputShapes: string[],
    success: boolean,
    durationMs: number,
    orgId: string,
    accountId?: string | null
  ): Promise<void> {
    try {
      // Check if node exists
      const existsQuery = `
        SELECT * FROM composition_node WHERE
          activity_id = $activity_id AND
          ${accountIdScopedWhere()}
        LIMIT 1;
      `;

      const existsResult = await surrealDB.query(existsQuery, {
        activity_id: activityId,
        org_id: orgId,
        account_id: accountId ?? null,
      });

      const existing = (existsResult[0] as CompositionNode[])?.[0];

      if (existing) {
        // Update existing node
        const totalExec = existing.total_executions + 1;
        const successCount = existing.success_rate * existing.total_executions + (success ? 1 : 0);
        const newSuccessRate = successCount / totalExec;
        const newAvgDuration =
          (existing.avg_duration_ms * existing.total_executions + durationMs) / totalExec;

        const updateQuery = `
          UPDATE composition_node SET
            success_rate = $success_rate,
            avg_duration_ms = $avg_duration_ms,
            total_executions = $total_executions,
            updated_at = time::now()
          WHERE id = $id;
        `;

        await surrealDB.query(updateQuery, {
          id: existing.id,
          success_rate: newSuccessRate,
          avg_duration_ms: Math.round(newAvgDuration),
          total_executions: totalExec,
        });
      } else {
        // Create new node
        const createQuery = `
          CREATE composition_node SET
            activity_id = $activity_id,
            input_shapes = $input_shapes,
            output_shapes = $output_shapes,
            success_rate = $success_rate,
            avg_duration_ms = $avg_duration_ms,
            total_executions = 1,
            org_id = $org_id,
            account_id = $account_id,
            account_id_version = $account_id_version,
            public = false;
        `;

        await surrealDB.query(createQuery, {
          activity_id: activityId,
          input_shapes: inputShapes,
          output_shapes: outputShapes,
          success_rate: success ? 1.0 : 0.0,
          avg_duration_ms: durationMs,
          org_id: orgId,
          account_id: accountId ?? null,
          account_id_version: 1,
        });
      }

      logger.info(`Updated composition node: ${activityId}`, { success, durationMs });
    } catch (error) {
      logger.error('Failed to update composition node', { error });
      throw error;
    }
  }

  /**
   * Get recent composition chains for an orchestrator
   *
   * Phase B-followup: dual-tenant scoping. accountId optional; legacy rows
   * match via accountIdScopedWhere()'s org_id fallback.
   */
  async getRecentChains(
    orchestratorId: string,
    orgId: string,
    limit: number = 10,
    accountId?: string | null
  ): Promise<CompositionChain[]> {
    try {
      const query = `
        SELECT * FROM composition_chain WHERE
          orchestrator_id = $orchestrator_id AND
          ${accountIdScopedWhere()}
        ORDER BY created_at DESC
        LIMIT $limit;
      `;

      const result = await surrealDB.query(query, {
        orchestrator_id: orchestratorId,
        org_id: orgId,
        account_id: accountId ?? null,
        limit,
      });

      return (result[0] as CompositionChain[]) || [];
    } catch (error) {
      logger.error('Failed to get recent chains', { error });
      throw error;
    }
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const compositionGraphService = new CompositionGraphService();
