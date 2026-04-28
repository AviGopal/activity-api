/**
 * Health Scoring Service
 *
 * Computes vessel health scores for routing decisions.
 * Spec: openspec/changes/vessel-integration-standardization/specs/execution-tracing-integration/spec.md
 *
 * Health score formula:
 * health_score = (success_rate × 0.5) + (latency_factor × 0.3) + (availability_factor × 0.2)
 *
 * Where:
 * - success_rate = successful_requests / total_requests (last 100 requests)
 * - latency_factor = 1.0 - min(p95_latency / 1000ms, 1.0)
 * - availability_factor = heartbeats_received / heartbeats_expected (last 10 periods)
 *
 * Thresholds:
 * - health_score < 0.3: Vessel excluded from routing
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { accountIdScopedWhere } from '../routes/activities';

// =============================================================================
// TYPES
// =============================================================================

export interface HealthMetrics {
  vessel_id: string;
  org_id: string;
  success_count: number;
  total_count: number;
  success_rate: number;
  p95_latency_ms: number;
  avg_latency_ms: number;
  latency_ema_alpha: number;
  heartbeats_received: number;
  heartbeats_expected: number;
  availability: number;
  last_heartbeat_at: string | null;
  health_score: number;
  eligible_for_routing: boolean;
  window_start: string;
  window_size_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface HealthScoreBreakdown {
  success_rate: number;
  success_factor: number;
  latency_ms: number;
  latency_factor: number;
  availability: number;
  availability_factor: number;
  health_score: number;
}

// =============================================================================
// HEALTH SCORING OPERATIONS
// =============================================================================

export class HealthScoringService {
  // Weights for health score computation
  private static readonly SUCCESS_WEIGHT = 0.5;
  private static readonly LATENCY_WEIGHT = 0.3;
  private static readonly AVAILABILITY_WEIGHT = 0.2;

  // Thresholds
  private static readonly HEALTH_THRESHOLD = 0.3;
  private static readonly MAX_LATENCY_MS = 1000;
  private static readonly MAX_TRACKED_REQUESTS = 100;
  private static readonly HEARTBEAT_WINDOW_PERIODS = 10;

  /**
   * Get or create health metrics for a vessel
   *
   * Phase B-followup: dual-write account_id alongside org_id on CREATE
   * (table now has the field via migration 097). SELECT-by-record-id stays
   * unchanged — recordId already targets a single row, no scoping needed.
   */
  static async getMetrics(
    vesselId: string,
    orgId: string,
    accountId?: string | null
  ): Promise<HealthMetrics> {
    const recordId = `vessel_health_metrics:${vesselId}`;

    try {
      // Try to get existing metrics
      const query = `SELECT * FROM ${recordId}`;
      const result = await surrealDB.query<HealthMetrics[]>(query);

      if (result?.[0]?.[0]) {
        return result[0][0];
      }

      // Create new health metrics (default: perfect health)
      const createQuery = `
        CREATE ${recordId} CONTENT {
          vessel_id: $vesselId,
          org_id: $orgId,
          account_id: $account_id,
          account_id_version: $account_id_version,
          success_count: 0,
          total_count: 0,
          success_rate: 1.0,
          p95_latency_ms: 0.0,
          avg_latency_ms: 0.0,
          latency_ema_alpha: 0.2,
          heartbeats_received: 0,
          heartbeats_expected: 0,
          availability: 1.0,
          last_heartbeat_at: NONE,
          health_score: 1.0,
          eligible_for_routing: true,
          window_start: time::now(),
          window_size_seconds: 300,
          created_at: time::now(),
          updated_at: time::now()
        } RETURN *;
      `;

      const created = await surrealDB.query<HealthMetrics[]>(createQuery, {
        vesselId,
        orgId,
        account_id: accountId ?? null,
        account_id_version: 1,
      });

      return created[0][0];
    } catch (error) {
      logger.error('Failed to get health metrics', {
        vesselId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Record a successful request and update health score
   *
   * Phase B-followup: thread accountId so the record CREATE inside
   * getMetrics() dual-writes when the row doesn't exist yet.
   */
  static async recordSuccess(
    vesselId: string,
    orgId: string,
    latencyMs: number,
    accountId?: string | null
  ): Promise<HealthMetrics> {
    const current = await this.getMetrics(vesselId, orgId, accountId);
    const recordId = `vessel_health_metrics:${vesselId}`;

    // Sliding window: keep last 100 requests
    const newTotalCount = Math.min(current.total_count + 1, this.MAX_TRACKED_REQUESTS);

    // When window is full, maintain success count (assuming oldest was a failure)
    // If success_count === total_count (all successes), adding success keeps it at MAX
    // If success_count < total_count, we need to assume oldest request drops out
    let newSuccessCount: number;
    if (current.total_count >= this.MAX_TRACKED_REQUESTS) {
      // Window is full - we're dropping oldest request
      // Assume oldest request had same success rate as current window
      // To keep the math simple: if all were successes, stays at 100
      // Otherwise, increment by 1 (this success) but capped at MAX
      if (current.success_count === current.total_count) {
        newSuccessCount = this.MAX_TRACKED_REQUESTS; // All successes
      } else {
        // Mixed results - maintain approximately same success rate
        // Drop one request (unknown if success/failure), add this success
        const currentSuccessRate = current.success_count / current.total_count;
        // Probabilistically: if we drop a failure, success count increases
        // Simplification: assume we drop based on current ratio
        newSuccessCount = Math.min(
          Math.round((current.success_count - currentSuccessRate) + 1),
          this.MAX_TRACKED_REQUESTS
        );
      }
    } else {
      // Window not full yet - just increment
      newSuccessCount = current.success_count + 1;
    }

    // Update latency with exponential moving average
    const alpha = current.latency_ema_alpha;
    const newAvgLatency = current.avg_latency_ms === 0
      ? latencyMs
      : alpha * latencyMs + (1 - alpha) * current.avg_latency_ms;

    // Simple approximation for p95: use max(avg * 1.5, current p95 * 0.9)
    const newP95Latency = Math.max(newAvgLatency * 1.5, current.p95_latency_ms * 0.9);

    // Calculate success rate
    const newSuccessRate = newTotalCount > 0 ? newSuccessCount / newTotalCount : 1.0;

    // Compute health score
    const score = this.computeHealthScore(
      newSuccessRate,
      newP95Latency,
      current.availability
    );

    const updateQuery = `
      UPDATE ${recordId} SET
        success_count = $successCount,
        total_count = $totalCount,
        success_rate = $successRate,
        p95_latency_ms = $p95Latency,
        avg_latency_ms = $avgLatency,
        health_score = $healthScore,
        eligible_for_routing = $eligible,
        updated_at = time::now()
      RETURN *;
    `;

    const updated = await surrealDB.query<HealthMetrics[]>(updateQuery, {
      successCount: newSuccessCount,
      totalCount: newTotalCount,
      successRate: newSuccessRate,
      p95Latency: newP95Latency,
      avgLatency: newAvgLatency,
      healthScore: score,
      eligible: score >= this.HEALTH_THRESHOLD,
    });

    return updated[0][0];
  }

  /**
   * Record a failed request and update health score
   *
   * Phase B-followup: thread accountId so the record CREATE inside
   * getMetrics() dual-writes when the row doesn't exist yet.
   */
  static async recordFailure(
    vesselId: string,
    orgId: string,
    latencyMs: number,
    accountId?: string | null
  ): Promise<HealthMetrics> {
    const current = await this.getMetrics(vesselId, orgId, accountId);
    const recordId = `vessel_health_metrics:${vesselId}`;

    // Sliding window: keep last 100 requests
    const newTotalCount = Math.min(current.total_count + 1, this.MAX_TRACKED_REQUESTS);

    // When window is full, maintain success count by dropping oldest request
    let newSuccessCount: number;
    if (current.total_count >= this.MAX_TRACKED_REQUESTS) {
      // Window is full - dropping oldest request, adding this failure
      // Assume oldest request had same success rate as current window
      const currentSuccessRate = current.success_count / current.total_count;
      // Drop one request probabilistically, add this failure (no success increment)
      newSuccessCount = Math.max(
        0,
        Math.round(current.success_count - currentSuccessRate)
      );
    } else {
      // Window not full yet - success count unchanged (adding a failure)
      newSuccessCount = current.success_count;
    }

    // Update latency (even for failures)
    const alpha = current.latency_ema_alpha;
    const newAvgLatency = current.avg_latency_ms === 0
      ? latencyMs
      : alpha * latencyMs + (1 - alpha) * current.avg_latency_ms;

    const newP95Latency = Math.max(newAvgLatency * 1.5, current.p95_latency_ms * 0.9);

    // Calculate success rate with new success count
    const newSuccessRate = newTotalCount > 0 ? newSuccessCount / newTotalCount : 0.0;

    // Compute health score
    const score = this.computeHealthScore(
      newSuccessRate,
      newP95Latency,
      current.availability
    );

    const updateQuery = `
      UPDATE ${recordId} SET
        total_count = $totalCount,
        success_rate = $successRate,
        p95_latency_ms = $p95Latency,
        avg_latency_ms = $avgLatency,
        health_score = $healthScore,
        eligible_for_routing = $eligible,
        updated_at = time::now()
      RETURN *;
    `;

    const updated = await surrealDB.query<HealthMetrics[]>(updateQuery, {
      totalCount: newTotalCount,
      successRate: newSuccessRate,
      p95Latency: newP95Latency,
      avgLatency: newAvgLatency,
      healthScore: score,
      eligible: score >= this.HEALTH_THRESHOLD,
    });

    return updated[0][0];
  }

  /**
   * Record a heartbeat and update availability
   *
   * Phase B-followup: thread accountId for getMetrics CREATE path.
   */
  static async recordHeartbeat(
    vesselId: string,
    orgId: string,
    accountId?: string | null
  ): Promise<HealthMetrics> {
    const current = await this.getMetrics(vesselId, orgId, accountId);
    const recordId = `vessel_health_metrics:${vesselId}`;

    // Track last 10 heartbeat periods
    const newHeartbeatsReceived = Math.min(
      current.heartbeats_received + 1,
      this.HEARTBEAT_WINDOW_PERIODS
    );
    const newHeartbeatsExpected = Math.min(
      current.heartbeats_expected + 1,
      this.HEARTBEAT_WINDOW_PERIODS
    );

    // Calculate availability
    const newAvailability = newHeartbeatsExpected > 0
      ? newHeartbeatsReceived / newHeartbeatsExpected
      : 1.0;

    // Compute health score
    const score = this.computeHealthScore(
      current.success_rate,
      current.p95_latency_ms,
      newAvailability
    );

    const updateQuery = `
      UPDATE ${recordId} SET
        heartbeats_received = $heartbeatsReceived,
        heartbeats_expected = $heartbeatsExpected,
        availability = $availability,
        last_heartbeat_at = time::now(),
        health_score = $healthScore,
        eligible_for_routing = $eligible,
        updated_at = time::now()
      RETURN *;
    `;

    const updated = await surrealDB.query<HealthMetrics[]>(updateQuery, {
      heartbeatsReceived: newHeartbeatsReceived,
      heartbeatsExpected: newHeartbeatsExpected,
      availability: newAvailability,
      healthScore: score,
      eligible: score >= this.HEALTH_THRESHOLD,
    });

    return updated[0][0];
  }

  /**
   * Record a missed heartbeat (expected but not received)
   *
   * Phase B-followup: thread accountId for getMetrics CREATE path.
   */
  static async recordMissedHeartbeat(
    vesselId: string,
    orgId: string,
    accountId?: string | null
  ): Promise<HealthMetrics> {
    const current = await this.getMetrics(vesselId, orgId, accountId);
    const recordId = `vessel_health_metrics:${vesselId}`;

    // Heartbeat was expected but not received
    const newHeartbeatsExpected = Math.min(
      current.heartbeats_expected + 1,
      this.HEARTBEAT_WINDOW_PERIODS
    );

    // Calculate availability (decreases)
    const newAvailability = newHeartbeatsExpected > 0
      ? current.heartbeats_received / newHeartbeatsExpected
      : 0.0;

    // Compute health score
    const score = this.computeHealthScore(
      current.success_rate,
      current.p95_latency_ms,
      newAvailability
    );

    const updateQuery = `
      UPDATE ${recordId} SET
        heartbeats_expected = $heartbeatsExpected,
        availability = $availability,
        health_score = $healthScore,
        eligible_for_routing = $eligible,
        updated_at = time::now()
      RETURN *;
    `;

    const updated = await surrealDB.query<HealthMetrics[]>(updateQuery, {
      heartbeatsExpected: newHeartbeatsExpected,
      availability: newAvailability,
      healthScore: score,
      eligible: score >= this.HEALTH_THRESHOLD,
    });

    return updated[0][0];
  }

  /**
   * Compute health score from components
   */
  private static computeHealthScore(
    successRate: number,
    p95LatencyMs: number,
    availability: number
  ): number {
    // Success factor: 0.0 to 1.0
    const successFactor = successRate;

    // Latency factor: 1.0 (fast) to 0.0 (slow)
    const latencyFactor = Math.max(0, 1.0 - Math.min(p95LatencyMs / this.MAX_LATENCY_MS, 1.0));

    // Availability factor: 0.0 to 1.0
    const availabilityFactor = availability;

    // Weighted sum
    const score =
      successFactor * this.SUCCESS_WEIGHT +
      latencyFactor * this.LATENCY_WEIGHT +
      availabilityFactor * this.AVAILABILITY_WEIGHT;

    // Clamp to [0.0, 1.0]
    return Math.max(0.0, Math.min(1.0, score));
  }

  /**
   * Get detailed breakdown of health score components
   */
  static getScoreBreakdown(metrics: HealthMetrics): HealthScoreBreakdown {
    const successFactor = metrics.success_rate;
    const latencyFactor = Math.max(
      0,
      1.0 - Math.min(metrics.p95_latency_ms / this.MAX_LATENCY_MS, 1.0)
    );
    const availabilityFactor = metrics.availability;

    return {
      success_rate: metrics.success_rate,
      success_factor: successFactor * this.SUCCESS_WEIGHT,
      latency_ms: metrics.p95_latency_ms,
      latency_factor: latencyFactor * this.LATENCY_WEIGHT,
      availability: metrics.availability,
      availability_factor: availabilityFactor * this.AVAILABILITY_WEIGHT,
      health_score: metrics.health_score,
    };
  }

  /**
   * Get health metrics for multiple vessels
   *
   * Phase B-followup: thread accountId so getMetrics CREATE path dual-writes.
   */
  static async getMultipleMetrics(
    vesselIds: string[],
    orgId: string,
    accountId?: string | null
  ): Promise<Record<string, HealthMetrics>> {
    const metrics: Record<string, HealthMetrics> = {};

    await Promise.all(
      vesselIds.map(async (vesselId) => {
        metrics[vesselId] = await this.getMetrics(vesselId, orgId, accountId);
      })
    );

    return metrics;
  }

  /**
   * Get health scores only (lightweight)
   *
   * Phase B-followup: thread accountId for getMetrics CREATE path.
   */
  static async getHealthScores(
    vesselIds: string[],
    orgId: string,
    accountId?: string | null
  ): Promise<Record<string, number>> {
    const scores: Record<string, number> = {};

    await Promise.all(
      vesselIds.map(async (vesselId) => {
        const metrics = await this.getMetrics(vesselId, orgId, accountId);
        scores[vesselId] = metrics.health_score;
      })
    );

    return scores;
  }

  /**
   * Filter vessels by health threshold
   *
   * Phase B-followup: thread accountId for getMetrics CREATE path.
   */
  static async getEligibleVessels(
    vesselIds: string[],
    orgId: string,
    accountId?: string | null
  ): Promise<string[]> {
    const eligible: string[] = [];

    await Promise.all(
      vesselIds.map(async (vesselId) => {
        const metrics = await this.getMetrics(vesselId, orgId, accountId);
        if (metrics.eligible_for_routing) {
          eligible.push(vesselId);
        }
      })
    );

    return eligible;
  }
}
