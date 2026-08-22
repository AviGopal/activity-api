/**
 * Posterior decay must not annihilate a learned arm before it is next drawn.
 *
 * THE REGRESSION THIS PINS. The half-life default was 3 days, explicitly copied from
 * llm-resolver-vessel. LLM resolver arms fire many times an hour, so 3 days barely
 * touches them; activity templates fire on a cycle of weeks, so the same constant erased
 * them. A constant calibrated for one population applied to a population with a different
 * cadence.
 *
 * Measured live 2026-08-22 over the 1,821 arms carrying real evidence (alpha+beta > 4):
 * 95.4% retained less than 5% of it, and the median arm retained 0.0002%. 1,328 arms were
 * more than 30 days stale and therefore fully annihilated.
 *
 * Confirmed end to end against the sampler's own log rather than inferred:
 * `detect-vessel-code-drift` stores alpha=23.76/beta=10.86, was 33.9 days stale, decays
 * to alpha=1.009/beta=1.004, and with the 3.0 heuristic boost that is exactly the
 * alpha=4.0/beta=1.0 the selector recorded. The posterior was never missing — it was
 * decayed to the uniform prior before the draw.
 *
 * These tests pin the PROPERTY (a month-old posterior survives usefully), not the number,
 * so a future re-tune that keeps the property passes and one that reinstates annihilation
 * fails.
 */

import { describe, expect, test } from 'bun:test';

// config.ts evaluates `export const config = loadConfig()` at import time and THROWS
// without SURREALDB_NAMESPACE, and posterior-update imports it transitively. Set these
// unconditionally rather than with ??=: a sibling (config.account-id.test.ts) saves and
// RESTORES the variable to undefined, so whichever module triggers the first config load
// afterwards throws. Same note as variant-creator.retire-by-posterior.test.ts.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

const { decayedThompsonCounts, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT } = await import(
  './posterior-update'
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const at = (daysAgo: number) => NOW - daysAgo * DAY_MS;

/** The real arm from the live measurement. */
const ARM = { alpha: 23.76, beta: 10.86 };

/** Fraction of the original evidence mass surviving the decay. */
function retained(alpha: number, beta: number, daysAgo: number): number {
  const d = decayedThompsonCounts(alpha, beta, at(daysAgo), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT);
  return (d.alpha - 1 + (d.beta - 1)) / (alpha - 1 + (beta - 1));
}

describe('posterior decay half-life', () => {
  test('THE REGRESSION: a 30-day-old learned posterior is not erased', () => {
    // At the old 3-day default this retained 0.098% — indistinguishable from an arm that
    // had never run. The learning loop cannot compound across a gap it forgets.
    expect(retained(ARM.alpha, ARM.beta, 30)).toBeGreaterThan(0.25);
  });

  test('a month-old arm still draws meaningfully above the uniform prior', () => {
    const d = decayedThompsonCounts(ARM.alpha, ARM.beta, at(30), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT);
    // Beta(1,1) is the uniform prior. The whole defect was collapsing to it.
    expect(d.alpha).toBeGreaterThan(2);
    expect(d.beta).toBeGreaterThan(1.5);
  });

  test('THE EXACT LIVE CASE: 33.9 days no longer collapses to the boost alone', () => {
    // Previously decayed to alpha=1.009/beta=1.004, which plus a 3.0 boost produced the
    // alpha=4.0/beta=1.0 observed in thompson_selection_log.
    const d = decayedThompsonCounts(ARM.alpha, ARM.beta, at(33.9), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT);
    expect(d.alpha).toBeGreaterThan(1.5);
    // And beta must move too — beta pinned at exactly 1.0 was the tell that no failure
    // evidence was reaching the draw.
    expect(d.beta).toBeGreaterThan(1.2);
  });

  // ---- the decay must still DO its job -------------------------------------------

  test('decay still heals a poisoned posterior over a long absence', () => {
    // The stated purpose is healing a posterior poisoned during a transient outage. That
    // must survive the re-tune, or this fix trades one defect for another.
    expect(retained(ARM.alpha, ARM.beta, 180)).toBeLessThan(0.10);
  });

  test('a freshly written row is essentially undecayed', () => {
    const d = decayedThompsonCounts(ARM.alpha, ARM.beta, at(0), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT);
    expect(d.alpha).toBeCloseTo(ARM.alpha, 4);
    expect(d.beta).toBeCloseTo(ARM.beta, 4);
  });

  test('SAFETY ARGUMENT: lengthening the half-life never retains LESS evidence', () => {
    // The safety property, stated correctly on the second attempt.
    //
    // I first asserted "the hot set is unaffected". That is false and this test caught it:
    // at half a day the two half-lives differ by ~10% (0.5^(0.5/3)=0.891 vs
    // 0.5^(0.5/30)=0.989). "Unaffected" only holds for age << half-life, and half a day
    // against three is not that.
    //
    // The provable property is MONOTONICITY: d = 0.5^(age/halfLife) is increasing in
    // halfLife for every age, so the longer half-life always retains at least as much
    // evidence. No arm can draw with LESS evidence than it did before — which is the
    // claim that actually matters for safety, and it holds at every age rather than only
    // near zero.
    for (const days of [0, 0.01, 0.5, 3, 14, 30, 180]) {
      const oldD = decayedThompsonCounts(ARM.alpha, ARM.beta, at(days), NOW, 3);
      const newD = decayedThompsonCounts(ARM.alpha, ARM.beta, at(days), NOW, 30);
      expect(newD.alpha).toBeGreaterThanOrEqual(oldD.alpha - 1e-9);
      expect(newD.beta).toBeGreaterThanOrEqual(oldD.beta - 1e-9);
      // and never above the stored value — decay only ever removes
      expect(newD.alpha).toBeLessThanOrEqual(ARM.alpha + 1e-9);
      expect(newD.beta).toBeLessThanOrEqual(ARM.beta + 1e-9);
    }
  });

  // ---- controls ------------------------------------------------------------------

  test('NEGATIVE CONTROL: the OLD 3-day half-life fails the regression assertion', () => {
    // Proves the assertions above are not vacuous — they genuinely discriminate.
    const d = decayedThompsonCounts(ARM.alpha, ARM.beta, at(30), NOW, 3);
    const frac = (d.alpha - 1 + (d.beta - 1)) / (ARM.alpha - 1 + (ARM.beta - 1));
    expect(frac).toBeLessThan(0.01);
    expect(d.alpha).toBeLessThan(1.05);
    expect(d.beta).toBeLessThan(1.05);
  });

  test('NEGATIVE CONTROL: decay never pushes counts below the prior', () => {
    // Guards the direction: decay moves TOWARD 1, never past it, at any age.
    for (const days of [0, 1, 30, 365, 10_000]) {
      const d = decayedThompsonCounts(ARM.alpha, ARM.beta, at(days), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT);
      expect(d.alpha).toBeGreaterThanOrEqual(1);
      expect(d.beta).toBeGreaterThanOrEqual(1);
    }
  });

  test('a future timestamp is clamped rather than amplifying the posterior', () => {
    const d = decayedThompsonCounts(ARM.alpha, ARM.beta, NOW + 5 * DAY_MS, NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT);
    expect(d.alpha).toBeLessThanOrEqual(ARM.alpha + 1e-9);
    expect(d.beta).toBeLessThanOrEqual(ARM.beta + 1e-9);
  });
});
