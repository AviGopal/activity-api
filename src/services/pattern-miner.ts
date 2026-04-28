/**
 * Pattern Miner Service
 *
 * Discovers frequent successful activity sequence patterns from execution traces.
 * This enables N:1 ribosome extraction where common sequences like A→B→C are
 * identified and can be merged into composite templates.
 *
 * Data sources:
 * - execution_sequences table: Full sequences with success/failure
 * - activity_composition_graph table: Edge weights for parent→child transitions
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { accountIdScopedWhere } from '../routes/activities';
import type { Surreal } from 'surrealdb';

export interface SequencePattern {
  activityIds: string[];           // Ordered sequence [A, B, C]
  frequency: number;                // How many times observed
  successCount: number;             // How many succeeded
  successRate: number;              // success_count / frequency
  avgDuration: number;              // Average duration in ms
  avgCost: number;                  // Average cost in USD
  sourceExecutionIds: string[];     // Evidence trail
  compositionWeights: number[];     // Edge weights from composition graph
}

export interface PatternMiningOptions {
  minFrequency?: number;            // Min times pattern must appear (default: 10)
  minSuccessRate?: number;          // Min success rate (default: 0.85)
  minSequenceLength?: number;       // Min activities in sequence (default: 2)
  maxSequenceLength?: number;       // Max activities in sequence (default: 5)
  minCompositionWeight?: number;    // Min edge weight (default: 0.7)
  orgId?: string;                   // Optional org filter (for root queries)
  /** Phase B4b: optional account_id; null when caller has no claim. */
  accountId?: string | null;
}

/**
 * Discover frequent successful activity sequence patterns
 *
 * Queries execution_sequences table to find patterns that appear frequently
 * with high success rates, then enriches with composition graph edge weights.
 */
export async function discoverSequencePatterns(
  options: PatternMiningOptions = {}
): Promise<SequencePattern[]> {
  const {
    minFrequency = 10,
    minSuccessRate = 0.85,
    minSequenceLength = 2,
    maxSequenceLength = 5,
    minCompositionWeight = 0.7,
    orgId,
    accountId = null,
  } = options;

  logger.info('Discovering sequence patterns', {
    minFrequency,
    minSuccessRate,
    minSequenceLength,
    maxSequenceLength,
    minCompositionWeight
  });

  // Step 1: Query execution_sequences for frequent patterns
  const frequentSequences = await queryFrequentSequences(
    minFrequency,
    minSuccessRate,
    minSequenceLength,
    maxSequenceLength,
    orgId,
    accountId
  );

  logger.info('Found frequent sequences', {
    count: frequentSequences.length
  });

  if (frequentSequences.length === 0) {
    return [];
  }

  // Step 2: Enrich with composition graph edge weights
  const enrichedPatterns = await enrichWithCompositionWeights(
    frequentSequences,
    orgId,
    accountId
  );

  // Step 3: Filter patterns where all edges meet minimum weight threshold
  const strongPatterns = enrichedPatterns.filter(pattern => {
    if (pattern.compositionWeights.length === 0) return false;

    const allEdgesStrong = pattern.compositionWeights.every(
      weight => weight >= minCompositionWeight
    );

    return allEdgesStrong;
  });

  logger.info('Filtered to strong patterns', {
    total: enrichedPatterns.length,
    strong: strongPatterns.length,
    filtered: enrichedPatterns.length - strongPatterns.length
  });

  return strongPatterns;
}

/**
 * Query execution_sequences table for frequent patterns
 *
 * Groups by activity_ids array and aggregates success metrics.
 * SurrealDB note: Grouping by arrays requires each sequence to have
 * identical activity_ids for proper aggregation.
 */
async function queryFrequentSequences(
  minFrequency: number,
  minSuccessRate: number,
  minLength: number,
  maxLength: number,
  orgId?: string,
  accountId: string | null = null
): Promise<SequencePattern[]> {

  // Phase B4b: dual-tenant scoping. Prefer account_id; legacy rows
  // (account_id IS NONE) match via the org_id branch.
  const tenantFilter = orgId ? `AND ${accountIdScopedWhere()}` : '';

  const query = `
    SELECT
      activity_ids,
      count() as frequency,
      math::sum(IF success THEN 1 ELSE 0 END) as success_count,
      math::avg(duration_ms) as avg_duration_ms,
      math::avg(cost_usd) as avg_cost_usd,
      array::group(id) as source_execution_ids
    FROM execution_sequences
    WHERE
      array::len(activity_ids) >= ${minLength}
      AND array::len(activity_ids) <= ${maxLength}
      ${tenantFilter}
    GROUP BY activity_ids
    ORDER BY frequency DESC
  `;

  logger.debug('Querying frequent sequences', { query });

  try {
    type SequenceQueryResult = {
      activity_ids: string[];
      frequency: number;
      success_count: number;
      avg_duration_ms: number;
      avg_cost_usd: number;
      source_execution_ids: string[];
    };

    const queryResults = await surrealDB.query<SequenceQueryResult[]>(query, {
      org_id: orgId ?? null,
      account_id: accountId,
    });
    const results = queryResults[0] || [];

    if (!results || !Array.isArray(results) || results.length === 0) {
      logger.info('No frequent sequences found');
      return [];
    }

    // Filter in application code since SurrealDB HAVING clause is limited
    const filtered = results.filter((row: SequenceQueryResult) => {
      const frequency = row.frequency || 0;
      const successCount = row.success_count || 0;
      const successRate = frequency > 0 ? successCount / frequency : 0;

      return frequency >= minFrequency && successRate >= minSuccessRate;
    });

    // Transform to SequencePattern format
    const patterns: SequencePattern[] = filtered.map((row: SequenceQueryResult) => ({
      activityIds: row.activity_ids || [],
      frequency: row.frequency || 0,
      successCount: row.success_count || 0,
      successRate: row.frequency > 0
        ? (row.success_count || 0) / row.frequency
        : 0,
      avgDuration: row.avg_duration_ms || 0,
      avgCost: row.avg_cost_usd || 0,
      sourceExecutionIds: row.source_execution_ids || [],
      compositionWeights: []  // Filled in next step
    }));

    return patterns;

  } catch (error) {
    logger.error('Error querying frequent sequences', { error });
    throw error;
  }
}

/**
 * Enrich patterns with composition graph edge weights
 *
 * For each pattern [A, B, C], looks up edges A→B and B→C in the
 * activity_composition_graph to validate the sequence is cohesive.
 */
async function enrichWithCompositionWeights(
  patterns: SequencePattern[],
  orgId?: string,
  accountId: string | null = null
): Promise<SequencePattern[]> {

  logger.info('Enriching patterns with composition weights', {
    count: patterns.length
  });

  for (const pattern of patterns) {
    const weights: number[] = [];

    // For sequence [A, B, C], check edges A→B and B→C
    for (let i = 0; i < pattern.activityIds.length - 1; i++) {
      const parent = pattern.activityIds[i];
      const child = pattern.activityIds[i + 1];

      const weight = await getCompositionEdgeWeight(parent, child, orgId, accountId);
      weights.push(weight);
    }

    pattern.compositionWeights = weights;

    logger.debug('Pattern weights', {
      sequence: pattern.activityIds.join(' → '),
      weights,
      avgWeight: weights.length > 0
        ? weights.reduce((sum, w) => sum + w, 0) / weights.length
        : 0
    });
  }

  return patterns;
}

/**
 * Get weight of specific composition edge from composition graph
 *
 * Returns 0 if edge doesn't exist (sequence has never been composed before,
 * only seen as individual activities in a session).
 */
async function getCompositionEdgeWeight(
  parentActivityId: string,
  childActivityId: string,
  orgId?: string,
  accountId: string | null = null
): Promise<number> {

  // Phase B4b: dual-tenant scoping. Prefer account_id; legacy rows
  // (account_id IS NONE) match via the org_id branch.
  const tenantFilter = orgId ? `AND ${accountIdScopedWhere()}` : '';

  const query = `
    SELECT weight, success_count, execution_count
    FROM activity_composition_graph
    WHERE
      parent_activity_id = $parent
      AND child_activity_id = $child
      ${tenantFilter}
    LIMIT 1
  `;

  try {
    type CompositionEdgeResult = {
      weight: number;
      success_count: number;
      execution_count: number;
    };

    const queryResults = await surrealDB.query<CompositionEdgeResult[]>(query, {
      parent: parentActivityId,
      child: childActivityId,
      org_id: orgId ?? null,
      account_id: accountId,
    });
    const results = queryResults[0] || [];

    if (!results || !Array.isArray(results) || results.length === 0) {
      // Edge doesn't exist in composition graph
      // This can happen if activities ran in sequence but weren't composed
      logger.debug('No composition edge found', {
        parent: parentActivityId,
        child: childActivityId
      });
      return 0;
    }

    const weight = results[0]?.weight ?? 0;
    return weight;

  } catch (error) {
    logger.error('Error fetching composition edge weight', {
      error,
      parent: parentActivityId,
      child: childActivityId
    });
    return 0;
  }
}

/**
 * Generate pattern signature (hash) from activity IDs
 *
 * Used to uniquely identify patterns and prevent duplicate extraction.
 * Simple implementation using JSON stringify + basic hash.
 */
export function hashActivityIds(activityIds: string[]): string {
  const str = JSON.stringify(activityIds);

  // Simple hash function (djb2 algorithm)
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
  }

  // Convert to hex string
  const hexHash = (hash >>> 0).toString(16);

  // Prefix with length for additional uniqueness
  return `seq_${activityIds.length}_${hexHash}`;
}

/**
 * Check if pattern has already been extracted
 *
 * Queries composite_sequence_patterns table to see if this exact
 * pattern signature already has a composite template.
 */
export async function isPatternExtracted(
  activityIds: string[],
  orgId?: string,
  accountId: string | null = null
): Promise<boolean> {
  const signature = hashActivityIds(activityIds);

  // Phase B4b: dual-tenant scoping. Prefer account_id; legacy rows
  // (account_id IS NONE) match via the org_id branch.
  const tenantFilter = orgId ? `AND ${accountIdScopedWhere()}` : '';

  const query = `
    SELECT id FROM composite_sequence_patterns
    WHERE pattern_signature = $signature
    ${tenantFilter}
    LIMIT 1
  `;

  try {
    const results = await surrealDB.query<any[]>(query, {
      signature,
      org_id: orgId ?? null,
      account_id: accountId,
    });
    return results && results.length > 0;
  } catch (error) {
    logger.error('Error checking if pattern extracted', { error, signature });
    return false;
  }
}
