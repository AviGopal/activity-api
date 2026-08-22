/**
 * The posterior decay half-life is over-subscribed: one constant, two incompatible jobs.
 *
 * WHAT THIS FILE IS. Not a fix. A proof that the current design cannot be fixed by
 * choosing a better number, plus the measurement that shows the cost of the number in
 * force. The resolution is a design decision and is deliberately left to the operator;
 * see validation/reports/ for the writeup.
 *
 * ── THE MEASUREMENT ────────────────────────────────────────────────────────────────
 *
 * Live substrate, 2026-08-22, over the 1,821 arms carrying real evidence (alpha+beta > 4)
 * at the in-force 3-day half-life:
 *
 *   <1d      81 arms   ~100% of evidence retained
 *   3-7d      3 arms   20% - 0.4%
 *   14-30d  409 arms   3.9% - 0.098%
 *   >30d   1328 arms   <0.098%
 *
 *   95.4% retain LESS THAN 5% of their evidence. The median arm retains 0.0002%.
 *
 * Confirmed end to end against the sampler's own log rather than inferred. It also
 * explains, exactly, why every observed draw was alpha=4.0/beta=1.0 with beta pinned:
 *
 *   detect-vessel-code-drift        stored 23.76/10.86, 33.9d stale
 *                                   -> 1.009/1.004, +3.0 boost = 4.009/1.004
 *   operator-mcp-isomorphism-probe  stored 21.62/18.22, 25.8d stale
 *                                   -> 1.054/1.045, +3.0 boost = 4.054/1.045
 *
 * The posterior was never missing and the read was never broken. It was decayed to the
 * uniform prior before the draw.
 *
 * ── THE CONFLICT ───────────────────────────────────────────────────────────────────
 *
 * R1 (pre-existing, pinned by test/posterior-decay.test.ts): a posterior poisoned by a
 *    transient outage — alpha=1, beta=81, i.e. 80 failures and no successes that the arm
 *    did not earn — must heal to re-selectable within ~30 days.
 *
 * R2 (this measurement): a posterior EARNED over many executions must still carry
 *    evidence at ~30 days, or learning cannot compound across a normal re-execution gap.
 *
 * A symmetric exponential toward (1,1) treats both identically, so satisfying one breaks
 * the other. `noSingleHalfLifeSatisfiesBoth` below proves that over the whole parameter
 * space rather than asserting it.
 *
 * ── WHY NOT JUST DECAY BETA FASTER ─────────────────────────────────────────────────
 *
 * The tempting asymmetry — blame is contaminated by outages, credit is earned, so decay
 * beta faster than alpha — is rejected on evidence. It systematically inflates every
 * arm's mean, and "no failure evidence reaches the draw" is the precise defect this
 * investigation started from (beta pinned at 1.0 on every observed selection). It would
 * deepen the failure it appears to fix. Recorded so the next reader does not re-derive it.
 *
 * The real target is upstream: blame recorded during an infrastructure outage is not the
 * arm's fault, and decay is a workaround for attributing it in the first place.
 */

import { describe, expect, test } from 'bun:test';

// config.ts evaluates `loadConfig()` at import and THROWS without SURREALDB_NAMESPACE,
// and posterior-update imports it transitively. Set unconditionally, not with ??=: a
// sibling saves and RESTORES this to undefined, so whichever module loads config first
// afterwards throws.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

const { decayedThompsonCounts, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT } = await import(
  './posterior-update'
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const at = (daysAgo: number) => NOW - daysAgo * DAY_MS;

/** A real arm from the live measurement, with genuinely earned evidence. */
const EARNED = { alpha: 23.76, beta: 10.86 };
/** The poisoned shape R1 protects against: 80 unearned failures. */
const POISONED = { alpha: 1, beta: 81 };

const meanOf = (c: { alpha: number; beta: number }) => c.alpha / (c.alpha + c.beta);
const evidenceRetained = (a: number, b: number, days: number, hl: number) => {
  const d = decayedThompsonCounts(a, b, at(days), NOW, hl);
  return (d.alpha - 1 + (d.beta - 1)) / (a - 1 + (b - 1));
};

describe('posterior decay: the measurement', () => {
  test('at the in-force default, a month-old earned posterior is annihilated', () => {
    // This is the current, deployed behaviour. It is a characterization, not an
    // aspiration: if someone changes the default, this fails and sends them to the
    // conflict below rather than letting the change land silently.
    const retained = evidenceRetained(
      EARNED.alpha, EARNED.beta, 30, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
    );
    expect(retained).toBeLessThan(0.01);
  });

  test('THE EXACT LIVE CASE: 33.9 days collapses to the heuristic boost alone', () => {
    const d = decayedThompsonCounts(
      EARNED.alpha, EARNED.beta, at(33.9), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
    );
    // 1.009 / 1.004 — plus the 3.0 boost, exactly the alpha=4.0/beta=1.0 in the log.
    expect(d.alpha).toBeCloseTo(1.009, 2);
    expect(d.beta).toBeCloseTo(1.004, 2);
    // beta pinned at ~1 IS the tell: no failure evidence can reach the draw.
    expect(d.beta).toBeLessThan(1.02);
  });

  test('a freshly written row is undecayed — the hot set never saw this defect', () => {
    const d = decayedThompsonCounts(
      EARNED.alpha, EARNED.beta, at(0), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
    );
    expect(d.alpha).toBeCloseTo(EARNED.alpha, 4);
    expect(d.beta).toBeCloseTo(EARNED.beta, 4);
  });
});

describe('posterior decay: the conflict', () => {
  test('R1 holds at the in-force default — poison heals, which is why it is 3 days', () => {
    const stale = decayedThompsonCounts(
      POISONED.alpha, POISONED.beta, at(30), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
    );
    expect(meanOf(stale)).toBeGreaterThan(0.4);
  });

  test('NO SINGLE HALF-LIFE SATISFIES BOTH — proved over the parameter space', () => {
    // R1: a poisoned arm (alpha=1, beta=81) must be re-selectable at 30 days.
    // R2: an earned arm must retain >25% of its evidence at 30 days.
    // Swept across four orders of magnitude, no value satisfies both at once.
    const satisfiesBoth: number[] = [];
    for (const hl of [0.5, 1, 2, 3, 5, 7, 10, 14, 21, 30, 60, 90, 180, 365, 1000]) {
      const healed = meanOf(decayedThompsonCounts(POISONED.alpha, POISONED.beta, at(30), NOW, hl)) > 0.4;
      const kept = evidenceRetained(EARNED.alpha, EARNED.beta, 30, hl) > 0.25;
      if (healed && kept) satisfiesBoth.push(hl);
    }
    expect(satisfiesBoth).toEqual([]);
  });

  test('the two requirements move in opposite directions — monotone, so no gap was missed', () => {
    // Guards against the sweep above passing for a silly reason (e.g. both always false).
    // Healing decreases with half-life; retention increases. Strictly opposed.
    const healShort = meanOf(decayedThompsonCounts(POISONED.alpha, POISONED.beta, at(30), NOW, 3));
    const healLong = meanOf(decayedThompsonCounts(POISONED.alpha, POISONED.beta, at(30), NOW, 90));
    expect(healShort).toBeGreaterThan(healLong);

    const keepShort = evidenceRetained(EARNED.alpha, EARNED.beta, 30, 3);
    const keepLong = evidenceRetained(EARNED.alpha, EARNED.beta, 30, 90);
    expect(keepLong).toBeGreaterThan(keepShort);

    // POSITIVE CONTROL for the sweep: each requirement IS individually satisfiable, so
    // the empty intersection is a real conflict rather than an impossible pair of asks.
    expect(healShort).toBeGreaterThan(0.4);
    expect(keepLong).toBeGreaterThan(0.25);
  });
});

describe('posterior decay: invariants that must survive any re-tune', () => {
  test('decay moves toward the prior and never past it', () => {
    for (const days of [0, 1, 30, 365, 10_000]) {
      const d = decayedThompsonCounts(
        EARNED.alpha, EARNED.beta, at(days), NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
      );
      expect(d.alpha).toBeGreaterThanOrEqual(1);
      expect(d.beta).toBeGreaterThanOrEqual(1);
      expect(d.alpha).toBeLessThanOrEqual(EARNED.alpha + 1e-9);
      expect(d.beta).toBeLessThanOrEqual(EARNED.beta + 1e-9);
    }
  });

  test('a future timestamp is clamped rather than amplifying the posterior', () => {
    const d = decayedThompsonCounts(
      EARNED.alpha, EARNED.beta, NOW + 5 * DAY_MS, NOW, THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
    );
    expect(d.alpha).toBeLessThanOrEqual(EARNED.alpha + 1e-9);
    expect(d.beta).toBeLessThanOrEqual(EARNED.beta + 1e-9);
  });

  test('retention is monotone in the half-life at every age', () => {
    // The property any re-tune can rely on: lengthening the half-life never retains less.
    for (const days of [0, 0.5, 3, 14, 30, 180]) {
      const shortHl = decayedThompsonCounts(EARNED.alpha, EARNED.beta, at(days), NOW, 3);
      const longHl = decayedThompsonCounts(EARNED.alpha, EARNED.beta, at(days), NOW, 30);
      expect(longHl.alpha).toBeGreaterThanOrEqual(shortHl.alpha - 1e-9);
      expect(longHl.beta).toBeGreaterThanOrEqual(shortHl.beta - 1e-9);
    }
  });
});
