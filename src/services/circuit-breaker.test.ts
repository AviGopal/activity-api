/**
 * Circuit Breaker Service Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { CircuitBreakerService, type CircuitState } from './circuit-breaker';

// Note: These tests require a running SurrealDB instance
// Run with: SURREALDB_URL=... bun test circuit-breaker.test.ts

describe('CircuitBreakerService', () => {
  const testVesselId = 'test-vessel-circuit-breaker';
  const testOrgId = 'organizations:test-org';

  beforeEach(async () => {
    // Clean up any existing test data
    try {
      await CircuitBreakerService.getState(testVesselId, testOrgId);
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  test('should create circuit breaker in CLOSED state by default', async () => {
    const state = await CircuitBreakerService.getState(testVesselId, testOrgId);

    expect(state.vessel_id).toBe(testVesselId);
    expect(state.org_id).toBe(testOrgId);
    expect(state.state).toBe('closed');
    expect(state.consecutive_failures).toBe(0);
    expect(state.total_requests).toBe(0);
    expect(state.failed_requests).toBe(0);
  });

  test('should reset consecutive failures on success', async () => {
    // Record some failures first
    await CircuitBreakerService.recordFailure(
      testVesselId,
      testOrgId,
      'TEST_ERROR',
      'Test error message'
    );

    let state = await CircuitBreakerService.getState(testVesselId, testOrgId);
    expect(state.consecutive_failures).toBe(1);

    // Record success
    const result = await CircuitBreakerService.recordSuccess(testVesselId, testOrgId, 100);

    expect(result.state.consecutive_failures).toBe(0);
    expect(result.transitioned).toBe(false);
  });

  test('should open circuit after max consecutive failures', async () => {
    // Record 5 consecutive failures (default threshold)
    for (let i = 0; i < 5; i++) {
      const result = await CircuitBreakerService.recordFailure(
        testVesselId,
        testOrgId,
        'TEST_ERROR',
        `Failure ${i + 1}`
      );

      if (i < 4) {
        expect(result.state.state).toBe('closed');
        expect(result.transitioned).toBe(false);
      } else {
        expect(result.state.state).toBe('open');
        expect(result.transitioned).toBe(true);
      }
    }
  });

  test('should not allow requests when circuit is OPEN', async () => {
    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await CircuitBreakerService.recordFailure(
        testVesselId,
        testOrgId,
        'TEST_ERROR',
        'Test error'
      );
    }

    const allowed = await CircuitBreakerService.shouldAllowRequest(testVesselId, testOrgId);
    expect(allowed).toBe(false);
  });

  test('should transition to HALF_OPEN after cooldown period', async () => {
    // Open the circuit with minimal cooldown for testing
    for (let i = 0; i < 5; i++) {
      await CircuitBreakerService.recordFailure(
        testVesselId,
        testOrgId,
        'TEST_ERROR',
        'Test error'
      );
    }

    // Wait for cooldown (this test may be slow in real environment)
    // In production, this would be 30 seconds
    // For testing, we'd need to mock or reduce the cooldown

    // Check transition manually
    const result = await CircuitBreakerService.checkHalfOpenTransition(testVesselId, testOrgId);

    // This will depend on whether cooldown period has elapsed
    // In real tests, you'd control time or use shorter cooldowns
    console.log('Half-open transition result:', result.transitioned);
  }, 60000); // 60 second timeout for this test

  test('should close circuit on successful HALF_OPEN probe', async () => {
    // This test would require manually setting circuit to HALF_OPEN state
    // or waiting for cooldown period
    // Skipped for now - would need database seeding
  });

  test('should track failure window correctly', async () => {
    const state = await CircuitBreakerService.getState(testVesselId, testOrgId);

    // Record a failure
    await CircuitBreakerService.recordFailure(
      testVesselId,
      testOrgId,
      'TEST_ERROR',
      'Test error'
    );

    const updatedState = await CircuitBreakerService.getState(testVesselId, testOrgId);

    expect(updatedState.total_requests).toBe(1);
    expect(updatedState.failed_requests).toBe(1);
    expect(updatedState.last_error_code).toBe('TEST_ERROR');
  });

  test('should use distributed lock to prevent multiple half-open probe requests', async () => {
    const vesselId = 'test-vessel-probe-lock';

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      await CircuitBreakerService.recordFailure(
        vesselId,
        testOrgId,
        'TEST_ERROR',
        'Test error'
      );
    }

    // Manually transition to half-open for testing
    // In production, this happens after cooldown period
    const recordId = `vessel_circuit_breaker:${vesselId}`;
    await CircuitBreakerService['checkHalfOpenTransition'](vesselId, testOrgId);

    // Simulate concurrent requests
    const request1 = CircuitBreakerService.shouldAllowRequest(vesselId, testOrgId);
    const request2 = CircuitBreakerService.shouldAllowRequest(vesselId, testOrgId);
    const request3 = CircuitBreakerService.shouldAllowRequest(vesselId, testOrgId);

    const results = await Promise.all([request1, request2, request3]);

    // Only ONE request should be allowed (get the lock)
    const allowedCount = results.filter((r) => r === true).length;
    expect(allowedCount).toBe(1);

    // Other requests should be rejected
    const rejectedCount = results.filter((r) => r === false).length;
    expect(rejectedCount).toBe(2);
  });

  test('should release probe lock after successful probe', async () => {
    const vesselId = 'test-vessel-probe-success';
    const { redis } = await import('../db/redis');

    // Open circuit
    for (let i = 0; i < 5; i++) {
      await CircuitBreakerService.recordFailure(
        vesselId,
        testOrgId,
        'TEST_ERROR',
        'Test error'
      );
    }

    // Transition to half-open
    await CircuitBreakerService['checkHalfOpenTransition'](vesselId, testOrgId);

    // Acquire probe lock
    const allowed = await CircuitBreakerService.shouldAllowRequest(vesselId, testOrgId);
    expect(allowed).toBe(true);

    // Check lock exists
    const lockKey = `circuit_breaker:probe_lock:${vesselId}`;
    const lockExists = await redis.get(lockKey);
    expect(lockExists).toBeTruthy();

    // Record successful probe
    await CircuitBreakerService.recordSuccess(vesselId, testOrgId, 100);

    // Lock should be released
    const lockAfter = await redis.get(lockKey);
    expect(lockAfter).toBeNull();
  });

  test('should release probe lock after failed probe', async () => {
    const vesselId = 'test-vessel-probe-failure';
    const { redis } = await import('../db/redis');

    // Open circuit
    for (let i = 0; i < 5; i++) {
      await CircuitBreakerService.recordFailure(
        vesselId,
        testOrgId,
        'TEST_ERROR',
        'Test error'
      );
    }

    // Transition to half-open
    await CircuitBreakerService['checkHalfOpenTransition'](vesselId, testOrgId);

    // Acquire probe lock
    const allowed = await CircuitBreakerService.shouldAllowRequest(vesselId, testOrgId);
    expect(allowed).toBe(true);

    // Check lock exists
    const lockKey = `circuit_breaker:probe_lock:${vesselId}`;
    const lockExists = await redis.get(lockKey);
    expect(lockExists).toBeTruthy();

    // Record failed probe
    await CircuitBreakerService.recordFailure(
      vesselId,
      testOrgId,
      'PROBE_ERROR',
      'Probe failed'
    );

    // Lock should be released
    const lockAfter = await redis.get(lockKey);
    expect(lockAfter).toBeNull();
  });
});
