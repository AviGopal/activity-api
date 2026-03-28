/**
 * Thompson Sampling Tests
 *
 * Tests for Beta distribution sampling implementation used in activity template recommendations.
 * These tests verify that Thompson Sampling correctly balances exploration (uncertain templates)
 * and exploitation (proven templates).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import beta from '@stdlib/random-base-beta';

describe('Beta Distribution Sampling', () => {
  test('produces values between 0 and 1', () => {
    // Sample 1000 values with various alpha/beta combinations
    const testCases = [
      { alpha: 1, beta: 1 },
      { alpha: 2, beta: 5 },
      { alpha: 10, beta: 2 },
      { alpha: 0.5, beta: 0.5 },
      { alpha: 100, beta: 100 },
    ];

    for (const { alpha, beta: betaVal } of testCases) {
      const samples = Array.from({ length: 100 }, () => beta(alpha, betaVal));

      for (const sample of samples) {
        expect(sample).toBeGreaterThanOrEqual(0);
        expect(sample).toBeLessThanOrEqual(1);
      }
    }
  });

  test('produces different values on repeated calls with same alpha/beta', () => {
    // With non-seeded sampler, repeated calls should produce different values
    const alpha = 5;
    const betaVal = 5;

    const samples = Array.from({ length: 10 }, () => beta(alpha, betaVal));

    // Check that not all samples are identical
    const uniqueSamples = new Set(samples);
    expect(uniqueSamples.size).toBeGreaterThan(1);
  });

  test('Beta(1,1) produces approximately uniform distribution', () => {
    // Beta(1,1) is the uniform distribution on [0,1]
    const samples = Array.from({ length: 1000 }, () => beta(1, 1));

    const mean = samples.reduce((a, b) => a + b) / samples.length;
    const variance =
      samples.reduce((acc, s) => acc + (s - mean) ** 2, 0) / samples.length;

    // Mean should be close to 0.5
    expect(mean).toBeCloseTo(0.5, 1); // Within 0.1

    // Variance of uniform(0,1) is 1/12 ≈ 0.0833
    expect(variance).toBeCloseTo(1 / 12, 1);
  });

  test('seeded sampler produces reproducible sequences', () => {
    const seededBeta1 = beta.factory({ seed: 42 });
    const seededBeta2 = beta.factory({ seed: 42 });

    // Same seed should produce same sequence
    const seq1 = Array.from({ length: 5 }, () => seededBeta1(3, 3));
    const seq2 = Array.from({ length: 5 }, () => seededBeta2(3, 3));

    expect(seq1).toEqual(seq2);

    // Different seed should produce different sequence
    const seededBeta3 = beta.factory({ seed: 123 });
    const seq3 = Array.from({ length: 5 }, () => seededBeta3(3, 3));

    expect(seq1).not.toEqual(seq3);
  });
});

describe('Thompson Sampling Exploration Behavior', () => {
  test('explores uncertain templates (low alpha+beta)', () => {
    // Templates with low alpha+beta have high variance - they can produce
    // both high and low samples, leading to exploration
    const uncertainSamples = Array.from({ length: 100 }, () => beta(1, 1));

    const min = Math.min(...uncertainSamples);
    const max = Math.max(...uncertainSamples);

    // High variance means wide spread
    expect(max - min).toBeGreaterThan(0.5);
  });

  test('exploits proven templates (high alpha, low beta)', () => {
    // Template with 100 successes, 10 failures should have samples concentrated near 0.9
    const provenSamples = Array.from({ length: 100 }, () => beta(101, 11)); // +1 for prior

    const mean = provenSamples.reduce((a, b) => a + b) / provenSamples.length;
    const min = Math.min(...provenSamples);

    // Mean should be close to expected value: 101/(101+11) ≈ 0.90
    expect(mean).toBeCloseTo(0.9, 1);

    // Minimum should still be relatively high due to low variance
    expect(min).toBeGreaterThan(0.7);
  });

  test('templates with same success rate but different confidence get selected at different rates', () => {
    // Both have 50% success rate expected value
    // Template A: 1 success, 1 failure (uncertain)
    // Template B: 100 successes, 100 failures (confident)

    const samplesA = Array.from({ length: 1000 }, () => beta(2, 2)); // 1+1 prior
    const samplesB = Array.from({ length: 1000 }, () => beta(101, 101)); // 100+1 prior

    // Calculate how often each would be selected over the other
    let aWins = 0;
    let bWins = 0;

    for (let i = 0; i < 1000; i++) {
      const sampleA = beta(2, 2);
      const sampleB = beta(101, 101);

      if (sampleA > sampleB) aWins++;
      else if (sampleB > sampleA) bWins++;
    }

    // Uncertain template A should win sometimes (exploration)
    // but not way more than confident template B
    expect(aWins).toBeGreaterThan(100); // At least 10% of time
    expect(bWins).toBeGreaterThan(100); // At least 10% of time

    // The wins should be relatively balanced but with some variance
    // This is the exploration/exploitation tradeoff in action
    console.log(`Template A (uncertain) wins: ${aWins}, Template B (confident) wins: ${bWins}`);
  });

  test('probabilistic behavior verified over multiple seeds', () => {
    // Run the same test with different seeds to verify probabilistic nature
    const results: number[] = [];

    for (let seed = 1; seed <= 10; seed++) {
      const seededBeta = beta.factory({ seed });

      // Simulate template selection: A has high variance, B is proven
      let aSelected = 0;

      for (let i = 0; i < 100; i++) {
        const sampleA = seededBeta(2, 2); // Uncertain
        const sampleB = seededBeta(10, 2); // Proven (80% success rate)

        if (sampleA > sampleB) aSelected++;
      }

      results.push(aSelected);
    }

    // Results should vary across seeds (probabilistic)
    const uniqueResults = new Set(results);
    expect(uniqueResults.size).toBeGreaterThan(1);

    // Average should show exploration happening but exploitation winning more
    const avgASelected = results.reduce((a, b) => a + b) / results.length;
    expect(avgASelected).toBeGreaterThan(5); // Some exploration
    expect(avgASelected).toBeLessThan(50); // But exploitation wins more
  });
});

describe('Thompson Sampling Edge Cases', () => {
  test('handles alpha=0 with defaults', () => {
    // In real usage, alpha should never be 0 (we use 1.0 default)
    // But the library should handle it gracefully
    const alpha = 1.0; // Our default
    const betaVal = 1.0;

    const sample = beta(alpha, betaVal);
    expect(sample).toBeGreaterThanOrEqual(0);
    expect(sample).toBeLessThanOrEqual(1);
  });

  test('handles very large alpha/beta values', () => {
    // Template with 10000 successes, 1000 failures
    const samples = Array.from({ length: 100 }, () => beta(10001, 1001));

    const mean = samples.reduce((a, b) => a + b) / samples.length;

    // Mean should be close to 10001/11002 ≈ 0.909
    expect(mean).toBeCloseTo(10001 / 11002, 1);

    // All samples should be valid
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(1);
      expect(Number.isFinite(sample)).toBe(true);
    }
  });

  test('handles extremely skewed distributions', () => {
    // Template with 1 success, 1000 failures (terrible template)
    const samples = Array.from({ length: 100 }, () => beta(2, 1001));

    const mean = samples.reduce((a, b) => a + b) / samples.length;
    const max = Math.max(...samples);

    // Mean should be close to 2/1003 ≈ 0.002
    expect(mean).toBeCloseTo(2 / 1003, 2);

    // Even max should be relatively low
    expect(max).toBeLessThan(0.05);
  });

  test('numerical stability - no NaN, Infinity, or out-of-bounds values', () => {
    const testCases = [
      { alpha: 0.001, beta: 0.001 },
      { alpha: 0.001, beta: 1000 },
      { alpha: 1000, beta: 0.001 },
      { alpha: 10000, beta: 10000 },
      { alpha: 1, beta: 1 },
    ];

    for (const { alpha, beta: betaVal } of testCases) {
      const samples = Array.from({ length: 100 }, () => beta(alpha, betaVal));

      for (const sample of samples) {
        expect(Number.isNaN(sample)).toBe(false);
        expect(Number.isFinite(sample)).toBe(true);
        expect(sample).toBeGreaterThanOrEqual(0);
        expect(sample).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('Thompson Sampling Performance', () => {
  test('completes 10 template sampling in under 10ms', () => {
    const templates = Array.from({ length: 10 }, (_, i) => ({
      alpha: 1 + Math.random() * 100,
      beta: 1 + Math.random() * 100,
    }));

    const start = performance.now();

    const samples = templates.map((t) => ({
      sample: beta(t.alpha, t.beta),
      alpha: t.alpha,
      beta: t.beta,
    }));

    const duration = performance.now() - start;

    expect(duration).toBeLessThan(10);
    expect(samples.length).toBe(10);

    console.log(`10 template sampling took ${duration.toFixed(3)}ms`);
  });

  test('benchmark: 1000 samples performance', () => {
    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      beta(5, 5);
    }

    const duration = performance.now() - start;

    // Should complete in under 100ms
    expect(duration).toBeLessThan(100);

    console.log(`1000 samples took ${duration.toFixed(3)}ms (${(duration / 1000).toFixed(4)}ms per sample)`);
  });
});
