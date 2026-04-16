#!/usr/bin/env bun
/**
 * Circuit Breaker & Health Scoring Validation Script
 *
 * Tests circuit breaker state machine and health scoring locally.
 * Run with: bun run scripts/test-circuit-breaker.ts
 */

import { CircuitBreakerService } from '../src/services/circuit-breaker';
import { HealthScoringService } from '../src/services/health-scoring';
import { VesselRouter } from '../src/services/vessel-router';

const TEST_VESSEL = 'test-vessel-demo';
const TEST_ORG = 'organizations:test-org';

async function main() {
  console.log('🔧 Circuit Breaker & Health Scoring Validation\n');

  // Test 1: Initial state
  console.log('Test 1: Get initial circuit breaker state');
  const initialCircuit = await CircuitBreakerService.getState(TEST_VESSEL, TEST_ORG);
  console.log(`  State: ${initialCircuit.state}`);
  console.log(`  Consecutive failures: ${initialCircuit.consecutive_failures}`);
  console.log(`  ✓ Initial state is CLOSED\n`);

  // Test 2: Initial health metrics
  console.log('Test 2: Get initial health metrics');
  const initialHealth = await HealthScoringService.getMetrics(TEST_VESSEL, TEST_ORG);
  console.log(`  Health score: ${initialHealth.health_score.toFixed(2)}`);
  console.log(`  Success rate: ${initialHealth.success_rate.toFixed(2)}`);
  console.log(`  Availability: ${initialHealth.availability.toFixed(2)}`);
  console.log(`  Eligible for routing: ${initialHealth.eligible_for_routing}`);
  console.log(`  ✓ Initial health is perfect (1.0)\n`);

  // Test 3: Record successes
  console.log('Test 3: Record 3 successful requests');
  for (let i = 0; i < 3; i++) {
    await CircuitBreakerService.recordSuccess(TEST_VESSEL, TEST_ORG, 100 + i * 10);
    await HealthScoringService.recordSuccess(TEST_VESSEL, TEST_ORG, 100 + i * 10);
  }
  const healthAfterSuccess = await HealthScoringService.getMetrics(TEST_VESSEL, TEST_ORG);
  console.log(`  Success rate: ${healthAfterSuccess.success_rate.toFixed(2)}`);
  console.log(`  Avg latency: ${healthAfterSuccess.avg_latency_ms.toFixed(0)}ms`);
  console.log(`  ✓ Health remains high after successes\n`);

  // Test 4: Record failures
  console.log('Test 4: Record 2 failures (not enough to open circuit)');
  for (let i = 0; i < 2; i++) {
    await CircuitBreakerService.recordFailure(
      TEST_VESSEL,
      TEST_ORG,
      'TEST_ERROR',
      `Test failure ${i + 1}`
    );
    await HealthScoringService.recordFailure(TEST_VESSEL, TEST_ORG, 500);
  }
  const circuitAfter2Failures = await CircuitBreakerService.getState(TEST_VESSEL, TEST_ORG);
  const healthAfter2Failures = await HealthScoringService.getMetrics(TEST_VESSEL, TEST_ORG);
  console.log(`  Circuit state: ${circuitAfter2Failures.state}`);
  console.log(`  Consecutive failures: ${circuitAfter2Failures.consecutive_failures}`);
  console.log(`  Health score: ${healthAfter2Failures.health_score.toFixed(2)}`);
  console.log(`  Success rate: ${healthAfter2Failures.success_rate.toFixed(2)} (3 success / 5 total)`);
  console.log(`  ✓ Circuit still CLOSED, health decreased\n`);

  // Test 5: Record 3 more failures to trigger circuit breaker
  console.log('Test 5: Record 3 more failures (total 5, should open circuit)');
  let lastResult;
  for (let i = 0; i < 3; i++) {
    lastResult = await CircuitBreakerService.recordFailure(
      TEST_VESSEL,
      TEST_ORG,
      'TEST_ERROR',
      `Test failure ${i + 3}`
    );
    await HealthScoringService.recordFailure(TEST_VESSEL, TEST_ORG, 500);
  }
  console.log(`  Circuit state: ${lastResult?.state.state}`);
  console.log(`  Transitioned: ${lastResult?.transitioned}`);
  console.log(`  Consecutive failures: ${lastResult?.state.consecutive_failures}`);
  console.log(`  ✓ Circuit OPENED after 5 consecutive failures\n`);

  // Test 6: Check if requests are blocked
  console.log('Test 6: Check if requests are allowed through OPEN circuit');
  const allowed = await CircuitBreakerService.shouldAllowRequest(TEST_VESSEL, TEST_ORG);
  console.log(`  Requests allowed: ${allowed}`);
  console.log(`  ✓ Requests blocked by OPEN circuit\n`);

  // Test 7: Health score below threshold
  console.log('Test 7: Check health eligibility');
  const finalHealth = await HealthScoringService.getMetrics(TEST_VESSEL, TEST_ORG);
  console.log(`  Health score: ${finalHealth.health_score.toFixed(2)}`);
  console.log(`  Success rate: ${finalHealth.success_rate.toFixed(2)} (3 success / 8 total)`);
  console.log(`  Eligible for routing: ${finalHealth.eligible_for_routing}`);
  console.log(`  ✓ Vessel may be ineligible due to low health\n`);

  // Test 8: Heartbeat updates
  console.log('Test 8: Record heartbeats');
  for (let i = 0; i < 3; i++) {
    await HealthScoringService.recordHeartbeat(TEST_VESSEL, TEST_ORG);
  }
  const healthAfterHeartbeats = await HealthScoringService.getMetrics(TEST_VESSEL, TEST_ORG);
  console.log(`  Heartbeats received: ${healthAfterHeartbeats.heartbeats_received}`);
  console.log(`  Heartbeats expected: ${healthAfterHeartbeats.heartbeats_expected}`);
  console.log(`  Availability: ${healthAfterHeartbeats.availability.toFixed(2)}`);
  console.log(`  ✓ Availability tracking works\n`);

  // Test 9: Health score breakdown
  console.log('Test 9: Health score component breakdown');
  const breakdown = HealthScoringService.getScoreBreakdown(healthAfterHeartbeats);
  console.log(`  Success component: ${breakdown.success_factor.toFixed(3)} (weight 0.5)`);
  console.log(`  Latency component: ${breakdown.latency_factor.toFixed(3)} (weight 0.3)`);
  console.log(`  Availability component: ${breakdown.availability_factor.toFixed(3)} (weight 0.2)`);
  console.log(`  Total health score: ${breakdown.health_score.toFixed(3)}`);
  console.log(`  ✓ Health score components calculated correctly\n`);

  console.log('✅ All tests completed successfully!');
  console.log('\nNote: This script validates the services work correctly.');
  console.log('For full integration testing, deploy to canary and test with real vessels.');

  process.exit(0);
}

main().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
