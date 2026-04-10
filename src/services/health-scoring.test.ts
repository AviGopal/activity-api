/**
 * Health Scoring Service Tests
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { HealthScoringService } from './health-scoring';

// Note: These tests require a running SurrealDB instance
// Run with: SURREALDB_URL=... bun test health-scoring.test.ts

describe('HealthScoringService', () => {
  const testVesselId = 'test-vessel-health';
  const testOrgId = 'organizations:test-org';

  beforeEach(async () => {
    // Clean up any existing test data
    try {
      await HealthScoringService.getMetrics(testVesselId, testOrgId);
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  test('should create health metrics with perfect score by default', async () => {
    const metrics = await HealthScoringService.getMetrics(testVesselId, testOrgId);

    expect(metrics.vessel_id).toBe(testVesselId);
    expect(metrics.org_id).toBe(testOrgId);
    expect(metrics.health_score).toBe(1.0);
    expect(metrics.success_rate).toBe(1.0);
    expect(metrics.availability).toBe(1.0);
    expect(metrics.eligible_for_routing).toBe(true);
  });

  test('should update health score after successful request', async () => {
    const metrics = await HealthScoringService.recordSuccess(testVesselId, testOrgId, 150);

    expect(metrics.total_count).toBe(1);
    expect(metrics.success_count).toBe(1);
    expect(metrics.success_rate).toBe(1.0);
    expect(metrics.avg_latency_ms).toBeGreaterThan(0);
    expect(metrics.health_score).toBeGreaterThan(0.9); // Should be high
  });

  test('should decrease health score after failed request', async () => {
    // Record one success first
    await HealthScoringService.recordSuccess(testVesselId, testOrgId, 100);

    // Record failure
    const metrics = await HealthScoringService.recordFailure(testVesselId, testOrgId, 500);

    expect(metrics.total_count).toBe(2);
    expect(metrics.success_count).toBe(1);
    expect(metrics.success_rate).toBe(0.5);
    expect(metrics.health_score).toBeLessThan(1.0);
  });

  test('should maintain sliding window of last 100 requests', async () => {
    // Record 101 successes
    for (let i = 0; i < 101; i++) {
      await HealthScoringService.recordSuccess(testVesselId, testOrgId, 100);
    }

    const metrics = await HealthScoringService.getMetrics(testVesselId, testOrgId);

    // Should cap at 100 requests
    expect(metrics.total_count).toBe(100);
  });

  test('should update availability on heartbeat', async () => {
    const metrics = await HealthScoringService.recordHeartbeat(testVesselId, testOrgId);

    expect(metrics.heartbeats_received).toBe(1);
    expect(metrics.heartbeats_expected).toBe(1);
    expect(metrics.availability).toBe(1.0);
    expect(metrics.last_heartbeat_at).toBeTruthy();
  });

  test('should decrease availability on missed heartbeat', async () => {
    // Record a heartbeat first
    await HealthScoringService.recordHeartbeat(testVesselId, testOrgId);

    // Record a missed heartbeat
    const metrics = await HealthScoringService.recordMissedHeartbeat(testVesselId, testOrgId);

    expect(metrics.heartbeats_received).toBe(1);
    expect(metrics.heartbeats_expected).toBe(2);
    expect(metrics.availability).toBe(0.5);
    expect(metrics.health_score).toBeLessThan(1.0);
  });

  test('should compute health score components correctly', async () => {
    // Set up specific scenario: 60% success rate, 800ms p95 latency, 80% availability
    // Record 3 successes and 2 failures
    await HealthScoringService.recordSuccess(testVesselId, testOrgId, 100);
    await HealthScoringService.recordSuccess(testVesselId, testOrgId, 150);
    await HealthScoringService.recordSuccess(testVesselId, testOrgId, 200);
    await HealthScoringService.recordFailure(testVesselId, testOrgId, 800);
    await HealthScoringService.recordFailure(testVesselId, testOrgId, 900);

    // Record heartbeats (4 received out of 5 expected)
    await HealthScoringService.recordHeartbeat(testVesselId, testOrgId);
    await HealthScoringService.recordHeartbeat(testVesselId, testOrgId);
    await HealthScoringService.recordHeartbeat(testVesselId, testOrgId);
    await HealthScoringService.recordHeartbeat(testVesselId, testOrgId);
    await HealthScoringService.recordMissedHeartbeat(testVesselId, testOrgId);

    const metrics = await HealthScoringService.getMetrics(testVesselId, testOrgId);
    const breakdown = HealthScoringService.getScoreBreakdown(metrics);

    expect(metrics.success_rate).toBe(0.6);
    expect(metrics.availability).toBe(0.8);
    expect(breakdown.success_factor).toBeCloseTo(0.6 * 0.5, 2); // 0.3
    expect(breakdown.availability_factor).toBeCloseTo(0.8 * 0.2, 2); // 0.16

    // Health score should be around 0.5-0.6 range
    expect(metrics.health_score).toBeGreaterThan(0.4);
    expect(metrics.health_score).toBeLessThan(0.7);
  });

  test('should mark vessel ineligible when health score drops below 0.3', async () => {
    // Record many failures to drive health score down
    for (let i = 0; i < 10; i++) {
      await HealthScoringService.recordFailure(testVesselId, testOrgId, 1000);
    }

    // Miss some heartbeats
    for (let i = 0; i < 5; i++) {
      await HealthScoringService.recordMissedHeartbeat(testVesselId, testOrgId);
    }

    const metrics = await HealthScoringService.getMetrics(testVesselId, testOrgId);

    expect(metrics.health_score).toBeLessThan(0.3);
    expect(metrics.eligible_for_routing).toBe(false);
  });

  test('should get health scores for multiple vessels', async () => {
    const vessel1 = 'test-vessel-1';
    const vessel2 = 'test-vessel-2';

    await HealthScoringService.recordSuccess(vessel1, testOrgId, 100);
    await HealthScoringService.recordSuccess(vessel2, testOrgId, 200);

    const scores = await HealthScoringService.getHealthScores(
      [vessel1, vessel2],
      testOrgId
    );

    expect(scores[vessel1]).toBeGreaterThan(0);
    expect(scores[vessel2]).toBeGreaterThan(0);
  });

  test('should filter eligible vessels correctly', async () => {
    const vessel1 = 'test-vessel-eligible';
    const vessel2 = 'test-vessel-ineligible';

    // Make vessel1 eligible (high health)
    await HealthScoringService.recordSuccess(vessel1, testOrgId, 100);

    // Make vessel2 ineligible (low health)
    for (let i = 0; i < 10; i++) {
      await HealthScoringService.recordFailure(vessel2, testOrgId, 1000);
    }

    const eligible = await HealthScoringService.getEligibleVessels(
      [vessel1, vessel2],
      testOrgId
    );

    expect(eligible).toContain(vessel1);
    expect(eligible).not.toContain(vessel2);
  });
});
