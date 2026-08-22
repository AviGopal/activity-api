/**
 * Posterior time-decay tests (openspec 2026-07-29-thompson-posterior-time-decay).
 *
 * Pins the decay formula `1 + (count - 1) * 0.5^(age_days / halfLifeDays)` with
 * concrete before/after values (house style: vessel-mitosis-evaluate.test.ts), and
 * asserts the property the whole fix exists for: a long-stale poisoned posterior
 * decays toward the neutral prior (so it can be re-tried and heal), while a FRESH
 * equally-poisoned posterior is left essentially untouched.
 *
 * Also asserts the context_thompson_scores write site applies the SQL-side decay
 * (decay stored counts BEFORE adding the delta) and binds the half-life param.
 */

import { describe, test, expect, mock } from 'bun:test';

// Stub the surreal singleton BEFORE importing posterior-update so getTuningParam
// (used by resolveThompsonDecayHalfLifeDays) never touches a real DB connection.
mock.module('../src/db/surreal', () => ({
  surrealDB: {
    query: async () => [],
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

// Stub the concept-seeded prior and embedding lookup — both can reach out to
// other vessels (network) and are irrelevant to the decay SQL under test.
mock.module('../src/lib/prior-seed', () => ({
  seedPriorFromConcepts: async () => ({ alpha0: 1, beta0: 1, seeded: false }),
}));
mock.module('../src/lib/embedding-lookup-cache', () => ({
  lookupEmbeddingForSignature: async () => null,
}));

const {
  decayedThompsonCounts,
  THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
  applyOutcomeToPosteriors,
} = await import('../src/lib/posterior-update');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('decayedThompsonCounts', () => {
  test('fresh counts are untouched (age 0)', () => {
    const now = Date.now();
    const { alpha, beta } = decayedThompsonCounts(1, 81, now, now);
    expect(alpha).toBeCloseTo(1, 10);
    expect(beta).toBeCloseTo(81, 10);
  });

  test('one half-life decays the excess over the prior by exactly half', () => {
    const now = Date.now();
    const { alpha, beta } = decayedThompsonCounts(
      5,
      81,
      now - THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT * DAY_MS,
      now,
    );
    // 1 + (5-1)*0.5 = 3 ; 1 + (81-1)*0.5 = 41
    expect(alpha).toBeCloseTo(3, 10);
    expect(beta).toBeCloseTo(41, 10);
  });

  test('a poisoned posterior heals — over a quarter now, not a fortnight', () => {
    // THIS TEST'S PREMISE CHANGED ON 2026-08-22, and the change is the point.
    //
    // It used to assert that alpha=1, beta=81 — a posterior poisoned by a transient
    // outage — healed to re-selectable within 30 DAYS, which pinned the half-life at 3.
    // That requirement existed because outage poison was being CREATED: every
    // `execution_error` fell through computeDeltas' `default:` branch and took a full
    // beta=1 penalty, so any arm that happened to run during an outage was condemned for
    // a failure it did not cause. 98% of all recorded failures took that branch.
    //
    // Blame attribution now abstains on transport/availability failures
    // (isEnvironmentalFailureReason + the execution_error case in computeDeltas), so this
    // poison is no longer manufactured. Decay's remaining job is to fade the 32 historical
    // arms that already carry it, and it does — the beta=81 case crosses back to
    // re-selectable (mean > 0.4) at roughly 220 days rather than 30. That is the
    // deliberate trade for keeping earned evidence alive, and the figure is stated
    // rather than rounded: at 180 days the mean is 0.308, still suppressed.
    //
    // The property still asserted: decay MOVES a poisoned posterior toward re-selectable,
    // monotonically, and gets there. Only the timescale moved.
    const now = Date.now();
    const fresh = decayedThompsonCounts(1, 81, now - 10_000, now);
    const oneMonth = decayedThompsonCounts(1, 81, now - 30 * DAY_MS, now);
    const halfYear = decayedThompsonCounts(1, 81, now - 180 * DAY_MS, now);
    const fullFade = decayedThompsonCounts(1, 81, now - 240 * DAY_MS, now);
    const meanOf = (c: { alpha: number; beta: number }) => c.alpha / (c.alpha + c.beta);

    // Fresh poison still suppresses, as it must — a genuinely failing arm is not excused.
    expect(meanOf(fresh)).toBeLessThan(0.02);
    // Healing is monotone in staleness.
    expect(meanOf(oneMonth)).toBeGreaterThan(meanOf(fresh));
    expect(meanOf(halfYear)).toBeGreaterThan(meanOf(oneMonth));
    expect(meanOf(fullFade)).toBeGreaterThan(meanOf(halfYear));
    // Still suppressed at half a year — recorded so the cost is explicit, not implied.
    expect(meanOf(halfYear)).toBeLessThan(0.4);
    // And it does arrive at re-selectable.
    expect(meanOf(fullFade)).toBeGreaterThan(0.4);
  });

  test('future timestamps (clock skew) clamp to no decay', () => {
    const now = Date.now();
    const { beta } = decayedThompsonCounts(1, 81, now + DAY_MS, now);
    expect(beta).toBeCloseTo(81, 10);
  });

  test('halfLifeDays parameter is honored', () => {
    const now = Date.now();
    const { beta } = decayedThompsonCounts(1, 81, now - 6 * DAY_MS, now, 6);
    // one 6-day half-life: 1 + 80*0.5 = 41
    expect(beta).toBeCloseTo(41, 10);
  });
});

describe('context_thompson_scores write-site decay', () => {
  test('UPDATE branch decays stored counts before adding the delta and binds half_life_secs', async () => {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const db = {
      async query(sql: string, params: Record<string, unknown> = {}) {
        calls.push({ sql, params });
        return [];
      },
    };

    await applyOutcomeToPosteriors(
      {
        activity_id: 'decay-test-activity',
        success: true,
        signature: 'a1b2c3d4e5f60718',
        signature_version: 1,
        tasks: [{ resolver_tier: 'llm' }],
      } as any,
      db as any,
      'organizations:test',
    );

    const ctsCall = calls.find(
      (c) => c.sql.includes('context_thompson_scores') && c.sql.includes('UPDATE'),
    );
    expect(ctsCall).toBeDefined();
    // Decay-then-add, both counts:
    expect(ctsCall!.sql).toContain('alpha = 1 + (alpha - 1) * math::pow(0.5,');
    expect(ctsCall!.sql).toContain('beta  = 1 + (beta - 1) * math::pow(0.5,');
    expect(ctsCall!.sql).toContain('$half_life_secs');
    // Negative-duration clamp (SurrealDB 2.3.3 errors on negative datetime diffs):
    expect(ctsCall!.sql).toContain('math::max([0,');
    // Half-life bound in seconds (default 3 days with no tuning row / stubbed DB):
    expect(ctsCall!.params.half_life_secs).toBe(
      THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT * 86400,
    );
  });
});
