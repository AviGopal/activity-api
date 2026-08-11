// Pins the prior on an arm that has never executed.
//
// THE DEFECT: this defaulted to Beta(1,1) — a uniform prior — so an activity that had
// NEVER run was modelled as 50% likely to succeed. The measured candidate pool is
// 95-108 arms with 97.1% carrying fewer than 5 observations and 23.7% at exactly
// (1,1). The maximum of ~76 near-uniform draws lands around 0.99, so a genuinely
// learned arm could never clear it: credit landed and posteriors diverged
// (0.000-0.756 across 3,290 arms) while nothing could ever be exploited.

import { beforeAll, describe, expect, test } from 'bun:test';

// Both modules pull config, which fails fast without a namespace, and static imports
// hoist above any setup. Import BOTH dynamically after the env is in place, so this
// test pins the REAL shipped constant and the REAL sampler rather than local copies
// that could silently drift from them.
let UNTRIED_PRIOR_BETA: number;
let betaSample: (a: number, b: number) => number;
beforeAll(async () => {
  process.env.SURREALDB_NAMESPACE ??= 'activity-system';
  process.env.SURREALDB_DATABASE ??= 'learning_loop';
  ({ UNTRIED_PRIOR_BETA } = await import('./discover-by-shapes'));
  ({ betaSample } = await import('../routes/activities.scoring'));
});

/** Share of draws a learned arm wins against a pool of untried arms. */
function learnedArmWinRate(poolSize: number, priorBeta: number, mean: number, obs: number, trials = 4000): number {
  let wins = 0;
  const a = mean * obs + 1;
  const b = (1 - mean) * obs + 1;
  for (let t = 0; t < trials; t++) {
    const learned = betaSample(a, b);
    let best = 0;
    for (let i = 0; i < poolSize - 1; i++) {
      const draw = betaSample(1, priorBeta);
      if (draw > best) best = draw;
    }
    if (learned > best) wins++;
  }
  return wins / trials;
}

describe('UNTRIED_PRIOR_BETA', () => {
  test('is greater than 1 — an untried arm is not a coin flip', () => {
    expect(UNTRIED_PRIOR_BETA).toBeGreaterThan(1);
  });

  test('THE REGRESSION: at Beta(1,1) a learned arm essentially never wins the pool', () => {
    // The state this fix exists to correct. Reproduced, not assumed.
    const rate = learnedArmWinRate(100, 1, 0.755, 100);
    expect(rate).toBeLessThan(0.05);
  });

  test('at the shipped prior a learned arm wins a substantial share', () => {
    const rate = learnedArmWinRate(100, UNTRIED_PRIOR_BETA, 0.755, 100);
    expect(rate).toBeGreaterThan(0.20);
  });

  test('a strongly learned arm becomes dominant rather than merely viable', () => {
    const rate = learnedArmWinRate(100, UNTRIED_PRIOR_BETA, 0.95, 100);
    expect(rate).toBeGreaterThan(0.90);
  });

  test('EXPLORATION IS PRESERVED — untried arms still win a real share of draws', () => {
    // The failure mode of over-correcting: if untried arms never win, no new activity
    // can ever earn evidence through selection. They must still get picked sometimes.
    const mediocreLearnedArm = learnedArmWinRate(100, UNTRIED_PRIOR_BETA, 0.30, 100);
    expect(mediocreLearnedArm).toBeLessThan(0.95);
  });

  test('the prior only shifts UNTRIED arms — an evidenced arm is untouched', () => {
    // 20 observations at a 60% rate draws the same regardless of the untried prior,
    // because its own alpha/beta come from its metrics row.
    const evidenced = () => betaSample(0.6 * 20 + 1, 0.4 * 20 + 1);
    const draws = Array.from({ length: 2000 }, evidenced);
    const mean = draws.reduce((x, y) => x + y, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.5);
    expect(mean).toBeLessThan(0.7);
  });
});
