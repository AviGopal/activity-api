/**
 * Phase 5 Integration Tests
 *
 * Validates deployed Phase 4 infrastructure:
 * - Circuit breaker opens after failures (5.2.4)
 * - Health scoring reflects vessel state (5.2.5)
 * - Routing traces appear in database (5.2.6)
 *
 * These tests validate the entire routing stack works together.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { CircuitBreakerService } from './circuit-breaker';
import { HealthScoringService } from './health-scoring';
import { RoutingTraceService } from './routing-trace';
import { surrealDB } from '../db/surreal';

describe('Phase 5 Integration Tests', () => {
  const testOrgId = 'organizations:test-integration';
  const testVesselId = 'test-vessel-integration';
  const testShape = 'test_impulse_shape';

  beforeEach(async () => {
    // Clean up test data before each test
    try {
      await surrealDB.query(`DELETE routing_trace WHERE org_id = $orgId`, {
        orgId: testOrgId,
      });
      await surrealDB.query(
        `DELETE vessel_health_metrics WHERE org_id = $orgId AND vessel_id = $vesselId`,
        { orgId: testOrgId, vesselId: testVesselId }
      );
      await surrealDB.query(
        `DELETE vessel_circuit_breaker WHERE org_id = $orgId AND vessel_id = $vesselId`,
        { orgId: testOrgId, vesselId: testVesselId }
      );
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  afterAll(async () => {
    // Force flush any buffered routing traces
    await RoutingTraceService.forceFlush();
  });

  // =============================================================================
  // TEST 5.2.4: Circuit Breaker Opens After Failures
  // =============================================================================

  test('5.2.4: Circuit breaker should open after consecutive failures', async () => {
    // GIVEN: A vessel with a closed circuit
    let state = await CircuitBreakerService.getState(testVesselId, testOrgId);
    expect(state.state).toBe('closed');

    // WHEN: Recording 5 consecutive failures
    for (let i = 0; i < 5; i++) {
      const result = await CircuitBreakerService.recordFailure(
        testVesselId,
        testOrgId,
        'TEST_ERROR',
        `Integration test failure ${i + 1}`
      );

      if (i < 4) {
        expect(result.state.state).toBe('closed');
      } else {
        expect(result.state.state).toBe('open');
        expect(result.transitioned).toBe(true);
      }
    }

    // THEN: Circuit is open and requests blocked
    state = await CircuitBreakerService.getState(testVesselId, testOrgId);
    expect(state.state).toBe('open');
    expect(state.consecutive_failures).toBe(5);

    const allowed = await CircuitBreakerService.shouldAllowRequest(testVesselId, testOrgId);
    expect(allowed).toBe(false);

    console.log('✅ 5.2.4 PASSED: Circuit breaker opened after failures');
  }, 10000);

  // =============================================================================
  // TEST 5.2.5: Health Scoring Reflects Vessel State
  // =============================================================================

  test('5.2.5: Health score should decrease after failures', async () => {
    // GIVEN: A vessel with perfect health
    let metrics = await HealthScoringService.getMetrics(testVesselId, testOrgId);
    expect(metrics.health_score).toBe(1.0);
    expect(metrics.eligible_for_routing).toBe(true);

    // WHEN: Recording 10 consecutive failures
    for (let i = 0; i < 10; i++) {
      await HealthScoringService.recordFailure(testVesselId, testOrgId, 1000);
    }

    // AND: Missing 5 heartbeats
    for (let i = 0; i < 5; i++) {
      await HealthScoringService.recordMissedHeartbeat(testVesselId, testOrgId);
    }

    // THEN: Health score drops and vessel excluded
    metrics = await HealthScoringService.getMetrics(testVesselId, testOrgId);
    expect(metrics.health_score).toBeLessThan(0.3);
    expect(metrics.eligible_for_routing).toBe(false);

    console.log('✅ 5.2.5 PASSED: Health scoring excludes unhealthy vessels');
  }, 10000);

  // =============================================================================
  // TEST 5.2.6: Routing Traces Appear in Database
  // =============================================================================

  test('5.2.6: Routing traces should be recorded and queryable', async () => {
    const impulseId = 'test-impulse-001';

    // GIVEN: A routing decision is made
    await RoutingTraceService.recordTraceSync({
      impulse_id: impulseId,
      shape: testShape,
      org_id: testOrgId,
      discovery_query_duration_ms: 50,
      candidates: ['vessel-1', 'vessel-2'],
      health_scores: { 'vessel-1': 0.95, 'vessel-2': 0.75 },
      circuit_states: { 'vessel-1': 'closed', 'vessel-2': 'closed' },
      excluded_vessels: [],
      selected_vessel_id: 'vessel-1',
      selection_algorithm: 'health_weighted',
      outcome: 'success',
    });

    // Wait for trace to be written
    await new Promise((resolve) => setTimeout(resolve, 100));

    // WHEN: Querying traces
    const traces = await RoutingTraceService.queryTraces({
      org_id: testOrgId,
      shape: testShape,
      limit: 10,
    });

    // THEN: Trace should be found
    expect(traces.length).toBeGreaterThan(0);
    const trace = traces[0];
    expect(trace.impulse_id).toBe(impulseId);
    expect(trace.selected_vessel_id).toBe('vessel-1');
    expect(trace.outcome).toBe('success');

    console.log('✅ 5.2.6 PASSED: Routing traces recorded and queryable');
  }, 10000);
});
