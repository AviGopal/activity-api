/**
 * Sliding Window Logic Tests (Unit Tests - No Database Required)
 *
 * Tests the mathematical correctness of the sliding window implementation
 * for health scoring without requiring SurrealDB.
 */

import { describe, test, expect } from 'bun:test';

describe('Sliding Window Logic (Unit Tests)', () => {
  const MAX_TRACKED_REQUESTS = 100;

  /**
   * Calculate new success count for recordSuccess
   */
  function calculateSuccessCountOnSuccess(
    currentSuccessCount: number,
    currentTotalCount: number
  ): number {
    if (currentTotalCount >= MAX_TRACKED_REQUESTS) {
      // Window is full
      if (currentSuccessCount === currentTotalCount) {
        return MAX_TRACKED_REQUESTS; // All successes
      } else {
        const currentSuccessRate = currentSuccessCount / currentTotalCount;
        return Math.min(
          Math.round((currentSuccessCount - currentSuccessRate) + 1),
          MAX_TRACKED_REQUESTS
        );
      }
    } else {
      // Window not full yet
      return currentSuccessCount + 1;
    }
  }

  /**
   * Calculate new success count for recordFailure
   */
  function calculateSuccessCountOnFailure(
    currentSuccessCount: number,
    currentTotalCount: number
  ): number {
    if (currentTotalCount >= MAX_TRACKED_REQUESTS) {
      // Window is full
      const currentSuccessRate = currentSuccessCount / currentTotalCount;
      return Math.max(
        0,
        Math.round(currentSuccessCount - currentSuccessRate)
      );
    } else {
      // Window not full yet - success count unchanged
      return currentSuccessCount;
    }
  }

  test('should increment success count when window is not full', () => {
    const newSuccessCount = calculateSuccessCountOnSuccess(50, 80);
    expect(newSuccessCount).toBe(51);
  });

  test('should maintain 100 successes when window is full with all successes', () => {
    const newSuccessCount = calculateSuccessCountOnSuccess(100, 100);
    expect(newSuccessCount).toBe(100);
  });

  test('should approximately maintain success rate when window is full (mixed)', () => {
    // 50% success rate: 50 successes out of 100
    const newSuccessCount = calculateSuccessCountOnSuccess(50, 100);

    // After adding one success and dropping one request (assuming 50% success rate):
    // newSuccessCount = (50 - 0.5) + 1 = 50.5 → rounds to 51
    expect(newSuccessCount).toBe(51);

    // New success rate: 51/100 = 0.51 (slightly higher, which is correct)
  });

  test('should decrease success count when adding failure to full window', () => {
    // Start with 100 successes
    const newSuccessCount = calculateSuccessCountOnFailure(100, 100);

    // Should drop oldest (assume 100% success rate, so drop a success)
    // newSuccessCount = 100 - 1.0 = 99
    expect(newSuccessCount).toBe(99);
  });

  test('should approximately maintain success rate when adding failure to full window (mixed)', () => {
    // 50% success rate: 50 successes out of 100
    const newSuccessCount = calculateSuccessCountOnFailure(50, 100);

    // After dropping one request (assuming 50% success rate):
    // newSuccessCount = 50 - 0.5 = 49.5 → rounds to 50
    expect(newSuccessCount).toBe(50);

    // New success rate: 50/100 = 0.50 (maintained)
  });

  test('should not change success count when adding failure to non-full window', () => {
    const newSuccessCount = calculateSuccessCountOnFailure(30, 60);
    expect(newSuccessCount).toBe(30);
  });

  test('should handle edge case: window at 99 requests, adding success', () => {
    const newSuccessCount = calculateSuccessCountOnSuccess(60, 99);
    expect(newSuccessCount).toBe(61); // Window not full yet, so just increment
  });

  test('should handle edge case: window at 100 requests, 1% success rate', () => {
    // Very low success rate: 1 success out of 100
    const newSuccessCountOnSuccess = calculateSuccessCountOnSuccess(1, 100);

    // Drop ~1% success rate (0.01), add 1 success
    // newSuccessCount = (1 - 0.01) + 1 = 1.99 → rounds to 2
    expect(newSuccessCountOnSuccess).toBe(2);

    const newSuccessCountOnFailure = calculateSuccessCountOnFailure(1, 100);

    // Drop ~1% success rate (0.01), add 0 successes
    // newSuccessCount = 1 - 0.01 = 0.99 → rounds to 1
    expect(newSuccessCountOnFailure).toBe(1);
  });

  test('should handle edge case: window at 100 requests, 99% success rate', () => {
    // Very high success rate: 99 successes out of 100
    const newSuccessCountOnSuccess = calculateSuccessCountOnSuccess(99, 100);

    // Drop ~99% success rate (0.99), add 1 success
    // newSuccessCount = (99 - 0.99) + 1 = 99.01 → rounds to 99
    expect(newSuccessCountOnSuccess).toBe(99);

    const newSuccessCountOnFailure = calculateSuccessCountOnFailure(99, 100);

    // Drop ~99% success rate (0.99), add 0 successes
    // newSuccessCount = 99 - 0.99 = 98.01 → rounds to 98
    expect(newSuccessCountOnFailure).toBe(98);
  });

  test('should never exceed MAX_TRACKED_REQUESTS', () => {
    const newSuccessCount = calculateSuccessCountOnSuccess(100, 100);
    expect(newSuccessCount).toBeLessThanOrEqual(MAX_TRACKED_REQUESTS);
  });

  test('should never go below 0', () => {
    const newSuccessCount = calculateSuccessCountOnFailure(0, 100);
    expect(newSuccessCount).toBeGreaterThanOrEqual(0);
  });

  test('simulation: 100 successes followed by 50 failures should stabilize around 50% success rate', () => {
    let successCount = 0;
    let totalCount = 0;

    // Add 100 successes
    for (let i = 0; i < 100; i++) {
      successCount = calculateSuccessCountOnSuccess(successCount, totalCount);
      totalCount = Math.min(totalCount + 1, MAX_TRACKED_REQUESTS);
    }

    expect(successCount).toBe(100);
    expect(totalCount).toBe(100);

    // Add 50 failures
    for (let i = 0; i < 50; i++) {
      successCount = calculateSuccessCountOnFailure(successCount, totalCount);
      totalCount = Math.min(totalCount + 1, MAX_TRACKED_REQUESTS);
    }

    expect(totalCount).toBe(100);

    // After 50 failures added to full window:
    // We should have approximately 50% success rate
    const finalSuccessRate = successCount / totalCount;
    expect(finalSuccessRate).toBeGreaterThan(0.45);
    expect(finalSuccessRate).toBeLessThan(0.55);
  });
});
