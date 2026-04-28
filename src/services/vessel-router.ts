/**
 * Vessel Router Service
 *
 * Integrates vessel discovery, health scoring, and circuit breaker for intelligent routing.
 * Spec: openspec/changes/vessel-integration-standardization/specs/execution-tracing-integration/spec.md
 *
 * Routing algorithm:
 * 1. Discover vessels capable of handling the shape
 * 2. Filter by circuit breaker state (exclude OPEN circuits)
 * 3. Filter by health score threshold (>= 0.3)
 * 4. Select using health-weighted Thompson Sampling
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { CircuitBreakerService } from './circuit-breaker';
import { HealthScoringService } from './health-scoring';
import { RoutingTraceService } from './routing-trace';
import { accountIdScopedWhere } from '../routes/activities';

// =============================================================================
// TYPES
// =============================================================================

export interface VesselCandidate {
  vessel_id: string;
  endpoint: string;
  health_score: number;
  circuit_state: string;
  last_heartbeat: string;
}

export interface RoutingDecision {
  selected_vessel: VesselCandidate | null;
  candidates: VesselCandidate[];
  excluded: Array<{ vessel_id: string; reason: string }>;
  selection_algorithm: string;
  selection_probability?: number;
  discovery_duration_ms: number;
}

export interface RoutingOptions {
  shape: string;
  org_id: string;
  // Phase B4a: prefer account_id when caller carries one; legacy rows
  // (account_id IS NONE) still match via the org_id branch.
  account_id?: string | null;
  activity_execution_id?: string;
  correlation_id?: string;
  impulse_id: string;
}

// =============================================================================
// VESSEL ROUTER
// =============================================================================

export class VesselRouter {
  /**
   * Route an impulse to the best available vessel
   *
   * Phase B4a: thread `options.account_id` through to discovery + circuit
   * breaker so dual-tenant scoping and trace dual-write apply consistently.
   */
  static async route(options: RoutingOptions): Promise<RoutingDecision> {
    const startTime = Date.now();
    const accountId = options.account_id ?? null;

    try {
      // Step 1: Discover vessels capable of handling the shape
      const discoveryStart = Date.now();
      const vessels = await this.discoverVessels(options.shape, options.org_id, accountId);
      const discoveryDuration = Date.now() - discoveryStart;

      if (vessels.length === 0) {
        // No vessels found
        const decision: RoutingDecision = {
          selected_vessel: null,
          candidates: [],
          excluded: [],
          selection_algorithm: 'none',
          discovery_duration_ms: discoveryDuration,
        };

        // Record routing trace
        await RoutingTraceService.recordTrace({
          impulse_id: options.impulse_id,
          shape: options.shape,
          org_id: options.org_id,
          account_id: accountId,
          correlation_id: options.correlation_id,
          activity_execution_id: options.activity_execution_id,
          discovery_query_duration_ms: discoveryDuration,
          candidates: [],
          health_scores: {},
          circuit_states: {},
          excluded_vessels: [],
          selected_vessel_id: null,
          selection_algorithm: 'none',
          outcome: 'no_candidates',
        });

        return decision;
      }

      // Step 2: Get health scores and circuit breaker states
      // Phase B-followup: thread account_id so getMetrics/getState CREATE
      // paths dual-write account_id when the row doesn't yet exist.
      const vesselIds = vessels.map((v) => v.id);
      const healthMetrics = await HealthScoringService.getMultipleMetrics(
        vesselIds,
        options.org_id,
        options.account_id ?? null
      );
      const circuitStates = await CircuitBreakerService.getStates(
        vesselIds,
        options.org_id,
        options.account_id ?? null
      );

      // Step 3: Build candidates with health and circuit info
      const candidates: VesselCandidate[] = vessels.map((vessel) => ({
        vessel_id: vessel.id,
        endpoint: vessel.endpoint,
        health_score: healthMetrics[vessel.id]?.health_score ?? 0,
        circuit_state: circuitStates[vessel.id]?.state ?? 'closed',
        last_heartbeat: vessel.last_heartbeat,
      }));

      // Step 4: Filter out ineligible vessels
      const excluded: Array<{ vessel_id: string; reason: string }> = [];
      const eligible = candidates.filter((candidate) => {
        // Exclude if circuit is OPEN
        if (candidate.circuit_state === 'open') {
          excluded.push({
            vessel_id: candidate.vessel_id,
            reason: 'circuit_breaker_open',
          });
          return false;
        }

        // Exclude if health score below threshold
        const healthMetric = healthMetrics[candidate.vessel_id];
        if (!healthMetric?.eligible_for_routing) {
          excluded.push({
            vessel_id: candidate.vessel_id,
            reason: `health_score_below_threshold (${candidate.health_score.toFixed(2)})`,
          });
          return false;
        }

        return true;
      });

      if (eligible.length === 0) {
        // All vessels filtered out
        const decision: RoutingDecision = {
          selected_vessel: null,
          candidates,
          excluded,
          selection_algorithm: 'health_weighted',
          discovery_duration_ms: discoveryDuration,
        };

        // Record routing trace
        await RoutingTraceService.recordTrace({
          impulse_id: options.impulse_id,
          shape: options.shape,
          org_id: options.org_id,
          account_id: accountId,
          correlation_id: options.correlation_id,
          activity_execution_id: options.activity_execution_id,
          discovery_query_duration_ms: discoveryDuration,
          candidates: vesselIds,
          health_scores: Object.fromEntries(
            Object.entries(healthMetrics).map(([id, m]) => [id, m.health_score])
          ),
          circuit_states: Object.fromEntries(
            Object.entries(circuitStates).map(([id, s]) => [id, s.state])
          ),
          excluded_vessels: excluded,
          selected_vessel_id: null,
          selection_algorithm: 'health_weighted',
          outcome: 'no_candidates',
          selection_reason: 'all_vessels_excluded_by_health_or_circuit',
        });

        return decision;
      }

      // Step 5: Select vessel using health-weighted selection
      const selected = this.selectVessel(eligible);

      const decision: RoutingDecision = {
        selected_vessel: selected.vessel,
        candidates,
        excluded,
        selection_algorithm: 'health_weighted',
        selection_probability: selected.probability,
        discovery_duration_ms: discoveryDuration,
      };

      // Record routing trace
      await RoutingTraceService.recordTrace({
        impulse_id: options.impulse_id,
        shape: options.shape,
        org_id: options.org_id,
        account_id: accountId,
        correlation_id: options.correlation_id,
        activity_execution_id: options.activity_execution_id,
        discovery_query_duration_ms: discoveryDuration,
        candidates: vesselIds,
        health_scores: Object.fromEntries(
          Object.entries(healthMetrics).map(([id, m]) => [id, m.health_score])
        ),
        circuit_states: Object.fromEntries(
          Object.entries(circuitStates).map(([id, s]) => [id, s.state])
        ),
        excluded_vessels: excluded,
        selected_vessel_id: selected.vessel.vessel_id,
        selection_algorithm: 'health_weighted',
        selection_probability: selected.probability,
        selection_reason: `health_weighted_selection (score: ${selected.vessel.health_score.toFixed(2)})`,
        outcome: 'success',
        latency_ms: Date.now() - startTime,
      });

      return decision;
    } catch (error) {
      logger.error('Vessel routing failed', {
        shape: options.shape,
        error: error instanceof Error ? error.message : String(error),
      });

      // Record failure trace
      await RoutingTraceService.recordTrace({
        impulse_id: options.impulse_id,
        shape: options.shape,
        org_id: options.org_id,
        account_id: accountId,
        correlation_id: options.correlation_id,
        activity_execution_id: options.activity_execution_id,
        discovery_query_duration_ms: Date.now() - startTime,
        candidates: [],
        health_scores: {},
        circuit_states: {},
        excluded_vessels: [],
        selected_vessel_id: null,
        selection_algorithm: 'health_weighted',
        outcome: 'failure',
        latency_ms: Date.now() - startTime,
      });

      throw error;
    }
  }

  /**
   * Discover vessels capable of handling a shape
   *
   * Phase B4a: dual-tenant scoping. Prefer account_id; legacy rows
   * (account_id IS NONE) match via the org_id branch. accountIdScopedWhere()
   * binds `$account_id` and `$org_id`; we keep `$orgId` here too because
   * the helper expects `$org_id` (snake_case) while the surrounding query
   * still uses `$shape`.
   */
  private static async discoverVessels(
    shape: string,
    orgId: string,
    accountId: string | null = null
  ): Promise<Array<{ id: string; endpoint: string; last_heartbeat: string }>> {
    const query = `
      SELECT id, endpoint, last_heartbeat FROM vessel
      WHERE $shape IN shapes
        AND ${accountIdScopedWhere()}
        AND expires_at > time::now()
      ORDER BY last_heartbeat DESC;
    `;

    const result = await surrealDB.query<
      Array<{ id: string; endpoint: string; last_heartbeat: string }>
    >(query, {
      shape,
      org_id: orgId,
      account_id: accountId,
    });

    return result[0] || [];
  }

  /**
   * Select vessel using health-weighted probability
   */
  private static selectVessel(candidates: VesselCandidate[]): {
    vessel: VesselCandidate;
    probability: number;
  } {
    // Calculate total weight (sum of health scores)
    const totalWeight = candidates.reduce((sum, c) => sum + c.health_score, 0);

    if (totalWeight === 0) {
      // All have zero health score - select randomly
      const selected = candidates[Math.floor(Math.random() * candidates.length)];
      return {
        vessel: selected,
        probability: 1 / candidates.length,
      };
    }

    // Weighted random selection
    let random = Math.random() * totalWeight;
    for (const candidate of candidates) {
      random -= candidate.health_score;
      if (random <= 0) {
        return {
          vessel: candidate,
          probability: candidate.health_score / totalWeight,
        };
      }
    }

    // Fallback (shouldn't reach here, but handle gracefully)
    const selected = candidates[candidates.length - 1];
    return {
      vessel: selected,
      probability: selected.health_score / totalWeight,
    };
  }

  /**
   * Record successful vessel resolution
   *
   * Phase B4a: pass accountId to circuit breaker so trace dual-writes.
   */
  static async recordSuccess(
    vesselId: string,
    orgId: string,
    latencyMs: number,
    accountId?: string | null
  ): Promise<void> {
    try {
      // Update health metrics
      // Phase B-followup: pass accountId so getMetrics CREATE dual-writes.
      await HealthScoringService.recordSuccess(vesselId, orgId, latencyMs, accountId ?? null);

      // Update circuit breaker
      await CircuitBreakerService.recordSuccess(vesselId, orgId, latencyMs, accountId ?? null);

      logger.debug('Recorded successful vessel resolution', {
        vesselId,
        latencyMs,
      });
    } catch (error) {
      logger.error('Failed to record vessel success', {
        vesselId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Record failed vessel resolution
   *
   * Phase B4a: pass accountId to circuit breaker so trace dual-writes.
   */
  static async recordFailure(
    vesselId: string,
    orgId: string,
    errorCode: string,
    errorMessage: string,
    latencyMs: number,
    activityExecutionId?: string,
    accountId?: string | null
  ): Promise<void> {
    try {
      // Update health metrics
      // Phase B-followup: pass accountId so getMetrics CREATE dual-writes.
      await HealthScoringService.recordFailure(vesselId, orgId, latencyMs, accountId ?? null);

      // Update circuit breaker
      await CircuitBreakerService.recordFailure(
        vesselId,
        orgId,
        errorCode,
        errorMessage,
        activityExecutionId,
        accountId ?? null
      );

      logger.warn('Recorded failed vessel resolution', {
        vesselId,
        errorCode,
        latencyMs,
      });
    } catch (error) {
      logger.error('Failed to record vessel failure', {
        vesselId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
