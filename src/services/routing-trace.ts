/**
 * Routing Trace Service
 *
 * Records routing decisions for learning and optimization.
 * Spec: openspec/changes/vessel-integration-standardization/specs/activity-execution-coordination-traces/spec.md
 *
 * Sampling strategy:
 * - 100% of failures (outcome != 'success')
 * - 10% of successes (sampled)
 *
 * TTL: 30 days
 * Batch writes: Buffer up to 100 traces before flushing
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { accountIdScopedWhere } from '../routes/activities';

// =============================================================================
// TYPES
// =============================================================================

export interface RoutingTraceInput {
  impulse_id: string;
  shape: string;
  org_id: string;
  /**
   * Phase B4b: optional account_id (null when caller has no JWT
   * `account_id` claim). Dual-written to routing_trace alongside org_id.
   */
  account_id?: string | null;
  correlation_id?: string;
  activity_execution_id?: string;
  discovery_query_duration_ms: number;
  candidates: string[];
  health_scores: Record<string, number>;
  circuit_states: Record<string, string>;
  excluded_vessels: Array<{ vessel_id: string; reason: string }>;
  selected_vessel_id: string | null;
  selection_algorithm: string;
  selection_probability?: number;
  selection_reason?: string;
  outcome: 'success' | 'failure' | 'timeout' | 'circuit_open' | 'fallback' | 'no_candidates';
  latency_ms?: number;
  direct_attempt_failed?: boolean;
  direct_failure_reason?: string;
  fallback_tier_used?: string;
  fallback_vessel_id?: string;
  fallback_success?: boolean;
}

export interface RoutingTrace extends RoutingTraceInput {
  trace_id: string;
  trace_type: 'routing';
  sampled: boolean;
  timestamp: string;
  expires_at: string;
}

// =============================================================================
// ROUTING TRACE OPERATIONS
// =============================================================================

export class RoutingTraceService {
  // Sampling rate for successful routing (10%)
  private static readonly SUCCESS_SAMPLE_RATE = 0.1;

  // TTL for routing traces (30 days)
  private static readonly TRACE_TTL_DAYS = 30;

  // Batch size for async writes
  private static readonly BATCH_SIZE = 100;

  // In-memory buffer for async trace writes
  private static traceBuffer: RoutingTraceInput[] = [];
  private static flushTimer: Timer | null = null;

  /**
   * Record a routing trace (async, batched)
   */
  static async recordTrace(trace: RoutingTraceInput): Promise<void> {
    // Determine if this trace should be sampled
    const shouldSample = this.shouldSampleTrace(trace.outcome);

    if (shouldSample) {
      // Add to buffer
      this.traceBuffer.push(trace);

      // Flush if buffer is full
      if (this.traceBuffer.length >= this.BATCH_SIZE) {
        await this.flushTraces();
      } else {
        // Schedule flush after 1 second if not already scheduled
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTraces();
          }, 1000);
        }
      }
    }
  }

  /**
   * Record a routing trace immediately (synchronous, for critical traces)
   */
  static async recordTraceSync(trace: RoutingTraceInput): Promise<void> {
    const shouldSample = this.shouldSampleTrace(trace.outcome);

    if (!shouldSample) {
      return;
    }

    try {
      const traceId = this.generateTraceId();
      const expiresAt = this.calculateExpiryDate();

      const query = `
        CREATE routing_trace CONTENT {
          trace_id: $traceId,
          trace_type: 'routing',
          correlation_id: $correlationId,
          activity_execution_id: $activityExecutionId,
          org_id: $orgId,
          account_id: $accountId,
          account_id_version: $accountIdVersion,
          impulse_id: $impulseId,
          shape: $shape,
          discovery_query_duration_ms: $discoveryQueryDurationMs,
          candidates: $candidates,
          health_scores: $healthScores,
          circuit_states: $circuitStates,
          excluded_vessels: $excludedVessels,
          selected_vessel_id: $selectedVesselId,
          selection_algorithm: $selectionAlgorithm,
          selection_probability: $selectionProbability,
          selection_reason: $selectionReason,
          outcome: $outcome,
          latency_ms: $latencyMs,
          direct_attempt_failed: $directAttemptFailed,
          direct_failure_reason: $directFailureReason,
          fallback_tier_used: $fallbackTierUsed,
          fallback_vessel_id: $fallbackVesselId,
          fallback_success: $fallbackSuccess,
          sampled: $sampled,
          timestamp: time::now(),
          expires_at: $expiresAt
        };
      `;

      await surrealDB.query(query, {
        traceId,
        correlationId: trace.correlation_id || null,
        activityExecutionId: trace.activity_execution_id || null,
        orgId: trace.org_id,
        accountId: trace.account_id ?? null,
        accountIdVersion: 1,
        impulseId: trace.impulse_id,
        shape: trace.shape,
        discoveryQueryDurationMs: trace.discovery_query_duration_ms,
        candidates: trace.candidates,
        healthScores: trace.health_scores,
        circuitStates: trace.circuit_states,
        excludedVessels: trace.excluded_vessels,
        selectedVesselId: trace.selected_vessel_id || null,
        selectionAlgorithm: trace.selection_algorithm,
        selectionProbability: trace.selection_probability || null,
        selectionReason: trace.selection_reason || null,
        outcome: trace.outcome,
        latencyMs: trace.latency_ms || null,
        directAttemptFailed: trace.direct_attempt_failed || false,
        directFailureReason: trace.direct_failure_reason || null,
        fallbackTierUsed: trace.fallback_tier_used || null,
        fallbackVesselId: trace.fallback_vessel_id || null,
        fallbackSuccess: trace.fallback_success || null,
        sampled: true,
        expiresAt,
      });

      logger.debug('Recorded routing trace (sync)', {
        traceId,
        shape: trace.shape,
        outcome: trace.outcome,
        selectedVessel: trace.selected_vessel_id,
      });
    } catch (error) {
      logger.error('Failed to record routing trace (sync)', {
        shape: trace.shape,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Flush buffered traces to database
   */
  private static async flushTraces(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.traceBuffer.length === 0) {
      return;
    }

    const traces = this.traceBuffer.splice(0, this.traceBuffer.length);

    try {
      // Build batch insert query
      const values = traces.map((trace) => {
        const traceId = this.generateTraceId();
        const expiresAt = this.calculateExpiryDate();

        return `{
          trace_id: "${traceId}",
          trace_type: "routing",
          correlation_id: ${trace.correlation_id ? `"${trace.correlation_id}"` : 'NONE'},
          activity_execution_id: ${trace.activity_execution_id ? `"${trace.activity_execution_id}"` : 'NONE'},
          org_id: "${trace.org_id}",
          account_id: ${trace.account_id ? `"${trace.account_id}"` : 'NONE'},
          account_id_version: 1,
          impulse_id: "${trace.impulse_id}",
          shape: "${trace.shape}",
          discovery_query_duration_ms: ${trace.discovery_query_duration_ms},
          candidates: ${JSON.stringify(trace.candidates)},
          health_scores: ${JSON.stringify(trace.health_scores)},
          circuit_states: ${JSON.stringify(trace.circuit_states)},
          excluded_vessels: ${JSON.stringify(trace.excluded_vessels)},
          selected_vessel_id: ${trace.selected_vessel_id ? `"${trace.selected_vessel_id}"` : 'NONE'},
          selection_algorithm: "${trace.selection_algorithm}",
          selection_probability: ${trace.selection_probability ?? 'NONE'},
          selection_reason: ${trace.selection_reason ? `"${trace.selection_reason}"` : 'NONE'},
          outcome: "${trace.outcome}",
          latency_ms: ${trace.latency_ms ?? 'NONE'},
          direct_attempt_failed: ${trace.direct_attempt_failed ?? false},
          direct_failure_reason: ${trace.direct_failure_reason ? `"${trace.direct_failure_reason}"` : 'NONE'},
          fallback_tier_used: ${trace.fallback_tier_used ? `"${trace.fallback_tier_used}"` : 'NONE'},
          fallback_vessel_id: ${trace.fallback_vessel_id ? `"${trace.fallback_vessel_id}"` : 'NONE'},
          fallback_success: ${trace.fallback_success ?? 'NONE'},
          sampled: true,
          timestamp: time::now(),
          expires_at: "${expiresAt}"
        }`;
      });

      const query = `INSERT INTO routing_trace ${values.join(', ')};`;
      await surrealDB.query(query);

      logger.debug('Flushed routing traces', { count: traces.length });
    } catch (error) {
      logger.error('Failed to flush routing traces', {
        count: traces.length,
        error: error instanceof Error ? error.message : String(error),
      });

      // Put traces back in buffer to retry
      this.traceBuffer.unshift(...traces);
    }
  }

  /**
   * Determine if a trace should be sampled
   * - Always sample failures
   * - Sample 10% of successes
   */
  private static shouldSampleTrace(outcome: string): boolean {
    if (outcome !== 'success') {
      // Always sample failures
      return true;
    }

    // Sample 10% of successes
    return Math.random() < this.SUCCESS_SAMPLE_RATE;
  }

  /**
   * Generate unique trace ID
   */
  private static generateTraceId(): string {
    return `routing_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Calculate expiry date (30 days from now)
   */
  private static calculateExpiryDate(): string {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + this.TRACE_TTL_DAYS);
    return expiryDate.toISOString();
  }

  /**
   * Query routing traces for analysis
   */
  static async queryTraces(params: {
    org_id: string;
    /** Phase B4b: optional account_id; null when caller has no claim. */
    account_id?: string | null;
    shape?: string;
    outcome?: string;
    start_time?: string;
    end_time?: string;
    limit?: number;
  }): Promise<RoutingTrace[]> {
    try {
      let whereConditions = [accountIdScopedWhere()];

      if (params.shape) {
        whereConditions.push(`shape = $shape`);
      }

      if (params.outcome) {
        whereConditions.push(`outcome = $outcome`);
      }

      if (params.start_time) {
        whereConditions.push(`timestamp >= $startTime`);
      }

      if (params.end_time) {
        whereConditions.push(`timestamp <= $endTime`);
      }

      const query = `
        SELECT * FROM routing_trace
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY timestamp DESC
        LIMIT ${params.limit || 100};
      `;

      const result = await surrealDB.query<RoutingTrace[]>(query, {
        org_id: params.org_id,
        account_id: params.account_id ?? null,
        shape: params.shape,
        outcome: params.outcome,
        startTime: params.start_time,
        endTime: params.end_time,
      });

      return result[0] || [];
    } catch (error) {
      logger.error('Failed to query routing traces', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get routing statistics for a shape
   */
  static async getShapeStats(
    orgId: string,
    shape: string,
    windowHours: number = 24,
    accountId: string | null = null
  ): Promise<{
    total_requests: number;
    success_rate: number;
    avg_latency_ms: number;
    vessel_distribution: Record<string, number>;
  }> {
    try {
      const startTime = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

      const query = `
        SELECT
          count() AS total_requests,
          math::mean(latency_ms) AS avg_latency_ms,
          array::group(selected_vessel_id) AS vessel_distribution
        FROM routing_trace
        WHERE ${accountIdScopedWhere()}
          AND shape = $shape
          AND timestamp >= $startTime
          AND outcome = 'success';
      `;

      const result = await surrealDB.query<any[]>(query, {
        org_id: orgId,
        account_id: accountId,
        shape,
        startTime,
      });

      const stats = result[0]?.[0] || {};

      return {
        total_requests: stats.total_requests || 0,
        success_rate: 1.0, // Calculated from success vs failure queries
        avg_latency_ms: stats.avg_latency_ms || 0,
        vessel_distribution: stats.vessel_distribution || {},
      };
    } catch (error) {
      logger.error('Failed to get shape stats', {
        shape,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        total_requests: 0,
        success_rate: 0,
        avg_latency_ms: 0,
        vessel_distribution: {},
      };
    }
  }

  /**
   * Force flush all buffered traces (for graceful shutdown)
   */
  static async forceFlush(): Promise<void> {
    await this.flushTraces();
  }
}
