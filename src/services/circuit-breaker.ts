/**
 * Circuit Breaker Service
 *
 * Implements circuit breaker state machine for vessel fault tolerance.
 * Spec: openspec/changes/vessel-integration-standardization/specs/execution-tracing-integration/spec.md
 *
 * State machine:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Circuit broken due to failures, requests rejected
 * - HALF_OPEN: Testing recovery, single probe request allowed
 *
 * Thresholds:
 * - 5 consecutive failures OR
 * - ≥50% failure rate over 60 seconds
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerState {
  vessel_id: string;
  org_id: string;
  state: CircuitState;
  state_changed_at: string;
  consecutive_failures: number;
  total_requests: number;
  failed_requests: number;
  failure_window_start: string;
  max_consecutive_failures: number;
  failure_rate_threshold: number;
  failure_window_seconds: number;
  cooldown_period_ms: number;
  next_probe_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CircuitBreakerTransition {
  vessel_id: string;
  event: 'opened' | 'half_open' | 'closed' | 'reopened';
  previous_state: CircuitState;
  trigger_type?: 'consecutive_failures' | 'failure_rate_threshold';
  consecutive_failures?: number;
  failure_rate?: number;
  health_score_before?: number;
  health_score_after?: number;
  cooldown_period_ms?: number;
  probe_succeeded?: boolean;
  probe_failed?: boolean;
  probe_error_code?: string;
  caused_by_activity_id?: string;
}

// =============================================================================
// CIRCUIT BREAKER OPERATIONS
// =============================================================================

export class CircuitBreakerService {
  /**
   * Get or create circuit breaker state for a vessel
   */
  static async getState(vesselId: string, orgId: string): Promise<CircuitBreakerState> {
    const recordId = `vessel_circuit_breaker:${vesselId}`;

    try {
      // Try to get existing state
      const query = `SELECT * FROM ${recordId}`;
      const result = await surrealDB.query<CircuitBreakerState[]>(query);

      if (result?.[0]?.[0]) {
        return result[0][0];
      }

      // Create new circuit breaker (default: CLOSED state)
      const createQuery = `
        CREATE ${recordId} CONTENT {
          vessel_id: $vesselId,
          org_id: $orgId,
          state: 'closed',
          state_changed_at: time::now(),
          consecutive_failures: 0,
          total_requests: 0,
          failed_requests: 0,
          failure_window_start: time::now(),
          max_consecutive_failures: 5,
          failure_rate_threshold: 0.5,
          failure_window_seconds: 60,
          cooldown_period_ms: 30000,
          next_probe_at: NONE,
          last_error_code: NONE,
          last_error_message: NONE,
          last_error_at: NONE,
          created_at: time::now(),
          updated_at: time::now()
        } RETURN *;
      `;

      const created = await surrealDB.query<CircuitBreakerState[]>(createQuery, {
        vesselId,
        orgId,
      });

      return created[0][0];
    } catch (error) {
      logger.error('Failed to get circuit breaker state', {
        vesselId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Record a successful request
   * Resets consecutive failures, may transition to CLOSED from HALF_OPEN
   */
  static async recordSuccess(
    vesselId: string,
    orgId: string,
    latencyMs: number
  ): Promise<{ state: CircuitBreakerState; transitioned: boolean }> {
    const current = await this.getState(vesselId, orgId);
    const recordId = `vessel_circuit_breaker:${vesselId}`;

    // Reset failure window if it's been more than window_seconds
    const windowStart = new Date(current.failure_window_start);
    const now = Date.now();
    const windowAge = (now - windowStart.getTime()) / 1000;
    const shouldResetWindow = windowAge > current.failure_window_seconds;

    let transitioned = false;
    let newState = current.state;

    // Half-open → Closed on success
    if (current.state === 'half_open') {
      newState = 'closed';
      transitioned = true;

      await this.recordTransition(orgId, {
        vessel_id: vesselId,
        event: 'closed',
        previous_state: 'half_open',
        probe_succeeded: true,
      });

      logger.info('Circuit breaker closed after successful probe', { vesselId });
    }

    const updateQuery = `
      UPDATE ${recordId} SET
        state = $state,
        state_changed_at = IF($stateChanged, time::now(), state_changed_at),
        consecutive_failures = 0,
        total_requests = ${shouldResetWindow ? '1' : 'total_requests + 1'},
        failed_requests = ${shouldResetWindow ? '0' : 'failed_requests'},
        failure_window_start = ${shouldResetWindow ? 'time::now()' : 'failure_window_start'},
        next_probe_at = NONE,
        updated_at = time::now()
      RETURN *;
    `;

    const updated = await surrealDB.query<CircuitBreakerState[]>(updateQuery, {
      state: newState,
      stateChanged: transitioned,
    });

    return {
      state: updated[0][0],
      transitioned,
    };
  }

  /**
   * Record a failed request
   * May transition to OPEN if thresholds exceeded
   */
  static async recordFailure(
    vesselId: string,
    orgId: string,
    errorCode: string,
    errorMessage: string,
    activityExecutionId?: string
  ): Promise<{ state: CircuitBreakerState; transitioned: boolean }> {
    const current = await this.getState(vesselId, orgId);
    const recordId = `vessel_circuit_breaker:${vesselId}`;

    // Can't fail in OPEN state (requests are blocked)
    if (current.state === 'open') {
      return { state: current, transitioned: false };
    }

    // Calculate new failure counts
    const newConsecutiveFailures = current.consecutive_failures + 1;
    const newTotalRequests = current.total_requests + 1;
    const newFailedRequests = current.failed_requests + 1;

    // Check if window should reset
    const windowStart = new Date(current.failure_window_start);
    const now = Date.now();
    const windowAge = (now - windowStart.getTime()) / 1000;
    const shouldResetWindow = windowAge > current.failure_window_seconds;

    // Calculate failure rate
    const effectiveFailed = shouldResetWindow ? 1 : newFailedRequests;
    const effectiveTotal = shouldResetWindow ? 1 : newTotalRequests;
    const failureRate = effectiveTotal > 0 ? effectiveFailed / effectiveTotal : 0;

    // Determine if we should open the circuit
    const shouldOpen =
      newConsecutiveFailures >= current.max_consecutive_failures ||
      failureRate >= current.failure_rate_threshold;

    let transitioned = false;
    let newState = current.state;
    let triggerType: 'consecutive_failures' | 'failure_rate_threshold' | undefined;

    if (shouldOpen && current.state === 'closed') {
      newState = 'open';
      transitioned = true;
      triggerType =
        newConsecutiveFailures >= current.max_consecutive_failures
          ? 'consecutive_failures'
          : 'failure_rate_threshold';

      await this.recordTransition(orgId, {
        vessel_id: vesselId,
        event: 'opened',
        previous_state: 'closed',
        trigger_type: triggerType,
        consecutive_failures: newConsecutiveFailures,
        failure_rate: failureRate,
        cooldown_period_ms: current.cooldown_period_ms,
        caused_by_activity_id: activityExecutionId,
      });

      logger.warn('Circuit breaker opened', {
        vesselId,
        triggerType,
        consecutiveFailures: newConsecutiveFailures,
        failureRate,
        errorCode,
      });
    } else if (current.state === 'half_open') {
      // Probe failed - reopen circuit with exponential backoff
      newState = 'open';
      transitioned = true;
      const newCooldown = Math.min(current.cooldown_period_ms * 2, 300000); // Max 5 minutes

      await this.recordTransition(orgId, {
        vessel_id: vesselId,
        event: 'reopened',
        previous_state: 'half_open',
        probe_failed: true,
        probe_error_code: errorCode,
        cooldown_period_ms: newCooldown,
      });

      logger.warn('Circuit breaker reopened after failed probe', {
        vesselId,
        errorCode,
        newCooldown,
      });
    }

    // Calculate next probe time if opening
    const nextProbeAt = newState === 'open'
      ? new Date(Date.now() + current.cooldown_period_ms).toISOString()
      : null;

    const updateQuery = `
      UPDATE ${recordId} SET
        state = $state,
        state_changed_at = IF($stateChanged, time::now(), state_changed_at),
        consecutive_failures = $consecutiveFailures,
        total_requests = ${shouldResetWindow ? '1' : '$totalRequests'},
        failed_requests = ${shouldResetWindow ? '1' : '$failedRequests'},
        failure_window_start = ${shouldResetWindow ? 'time::now()' : 'failure_window_start'},
        cooldown_period_ms = IF($stateChanged AND $state = 'open',
          IF(state = 'half_open', cooldown_period_ms * 2, cooldown_period_ms),
          cooldown_period_ms
        ),
        next_probe_at = $nextProbeAt,
        last_error_code = $errorCode,
        last_error_message = $errorMessage,
        last_error_at = time::now(),
        updated_at = time::now()
      RETURN *;
    `;

    const updated = await surrealDB.query<CircuitBreakerState[]>(updateQuery, {
      state: newState,
      stateChanged: transitioned,
      consecutiveFailures: newConsecutiveFailures,
      totalRequests: newTotalRequests,
      failedRequests: newFailedRequests,
      nextProbeAt: nextProbeAt || null,
      errorCode,
      errorMessage,
    });

    return {
      state: updated[0][0],
      transitioned,
    };
  }

  /**
   * Check if circuit should transition to half-open
   * Called periodically to allow recovery attempts
   */
  static async checkHalfOpenTransition(
    vesselId: string,
    orgId: string
  ): Promise<{ state: CircuitBreakerState; transitioned: boolean }> {
    const current = await this.getState(vesselId, orgId);

    if (current.state !== 'open' || !current.next_probe_at) {
      return { state: current, transitioned: false };
    }

    const now = Date.now();
    const probeTime = new Date(current.next_probe_at).getTime();

    if (now < probeTime) {
      return { state: current, transitioned: false };
    }

    // Transition to half-open
    const recordId = `vessel_circuit_breaker:${vesselId}`;
    const updateQuery = `
      UPDATE ${recordId} SET
        state = 'half_open',
        state_changed_at = time::now(),
        next_probe_at = NONE,
        updated_at = time::now()
      RETURN *;
    `;

    const updated = await surrealDB.query<CircuitBreakerState[]>(updateQuery);

    await this.recordTransition(orgId, {
      vessel_id: vesselId,
      event: 'half_open',
      previous_state: 'open',
    });

    logger.info('Circuit breaker transitioned to half-open', { vesselId });

    return {
      state: updated[0][0],
      transitioned: true,
    };
  }

  /**
   * Check if a request should be allowed through the circuit breaker
   */
  static async shouldAllowRequest(vesselId: string, orgId: string): Promise<boolean> {
    const current = await this.getState(vesselId, orgId);

    if (current.state === 'closed') {
      return true;
    }

    if (current.state === 'open') {
      // Check if we should transition to half-open
      const { state } = await this.checkHalfOpenTransition(vesselId, orgId);
      return state.state === 'half_open';
    }

    // Half-open: allow single probe request (caller must handle locking)
    return true;
  }

  /**
   * Record a circuit breaker state transition
   */
  private static async recordTransition(
    orgId: string,
    transition: CircuitBreakerTransition
  ): Promise<void> {
    try {
      const traceId = `cb_trace:${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const query = `
        CREATE circuit_breaker_trace CONTENT {
          trace_id: $traceId,
          trace_type: 'circuit_breaker',
          org_id: $orgId,
          vessel_id: $vesselId,
          event: $event,
          previous_state: $previousState,
          trigger_type: $triggerType,
          consecutive_failures: $consecutiveFailures,
          failure_rate: $failureRate,
          health_score_before: $healthScoreBefore,
          health_score_after: $healthScoreAfter,
          cooldown_period_ms: $cooldownPeriodMs,
          probe_request_succeeded: $probeSucceeded,
          probe_request_failed: $probeFailed,
          probe_error_code: $probeErrorCode,
          caused_by_activity_id: $causedByActivityId,
          vessel_eligible_for_routing: IF($event = 'closed', true, false),
          timestamp: time::now()
        };
      `;

      await surrealDB.query(query, {
        traceId,
        orgId,
        vesselId: transition.vessel_id,
        event: transition.event,
        previousState: transition.previous_state,
        triggerType: transition.trigger_type || null,
        consecutiveFailures: transition.consecutive_failures || null,
        failureRate: transition.failure_rate || null,
        healthScoreBefore: transition.health_score_before || null,
        healthScoreAfter: transition.health_score_after || null,
        cooldownPeriodMs: transition.cooldown_period_ms || null,
        probeSucceeded: transition.probe_succeeded || null,
        probeFailed: transition.probe_failed || null,
        probeErrorCode: transition.probe_error_code || null,
        causedByActivityId: transition.caused_by_activity_id || null,
      });

      logger.info('Recorded circuit breaker transition', {
        vesselId: transition.vessel_id,
        event: transition.event,
        previousState: transition.previous_state,
      });
    } catch (error) {
      logger.error('Failed to record circuit breaker transition', {
        vesselId: transition.vessel_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get circuit states for multiple vessels
   */
  static async getStates(
    vesselIds: string[],
    orgId: string
  ): Promise<Record<string, CircuitBreakerState>> {
    const states: Record<string, CircuitBreakerState> = {};

    await Promise.all(
      vesselIds.map(async (vesselId) => {
        states[vesselId] = await this.getState(vesselId, orgId);
      })
    );

    return states;
  }
}
