/**
 * Unit tests for M4 tier-restricted bandit gating in applyOutcomeToPosteriors.
 *
 * For all-deterministic templates the variant_performance_metrics UPDATE is
 * skipped (degenerate Beta posterior), but propagateCreditAlongChain still
 * fires. Mixed and all-stochastic templates run the full update path.
 * Traces without resolver_tier default to stochastic treatment.
 */

import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import {
  applyOutcomeToPosteriors,
  type DBQueryable,
  type TraceForPosterior,
} from '../src/lib/posterior-update';
import * as aggregator from '../src/lib/posterior-aggregator';

// The leaf write is coalesced through the aggregator (1540053), not a direct
// UPDATE. Capture leaf enqueues without queueing, so nothing flushes to a store.
let leafEnqueues = 0;
let enqueueSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  leafEnqueues = 0;
  enqueueSpy = spyOn(aggregator, 'enqueueVariantDelta').mockImplementation(((
    _v: string, _o: string, a: number, b: number, kind = 'leaf',
  ) => {
    if (kind === 'leaf' && (a !== 0 || b !== 0)) leafEnqueues++;
    return true;
  }) as typeof aggregator.enqueueVariantDelta);
});
afterEach(() => {
  enqueueSpy?.mockRestore();
  enqueueSpy = null;
});

function makeDb(): {
  db: DBQueryable;
  calls: Array<{ sql: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db: DBQueryable = {
    async query(sql, params = {}) {
      calls.push({ sql, params });
      return [];
    },
  };
  return { db, calls };
}

const ORG = 'org-test';

function makeTrace(overrides: Partial<TraceForPosterior> = {}): TraceForPosterior {
  return {
    activity_id: 'test-activity',
    variant_id: 'test-activity',
    success: true,
    failure_mode: null,
    org_id: ORG,
    // The honest-reach gate (159bca7) skips an untagged success as ungraded;
    // carry a reach verdict so the tier gate is what is under test.
    tags: ['reached:true'],
    ...overrides,
  };
}

/** Leaf VPM writes: coalesced enqueues plus any synchronous fallback UPDATE. */
function countVariantUpdates(
  calls: Array<{ sql: string; params: Record<string, unknown> }>,
): number {
  return leafEnqueues + calls.filter(
    (c) =>
      c.sql.includes('variant_performance_metrics') &&
      c.sql.includes('UPDATE'),
  ).length;
}

describe('applyOutcomeToPosteriors — M4 tier-restricted bandit', () => {
  test('all-deterministic template skips variant_performance_metrics UPDATE', async () => {
    const { db, calls } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({
        success: true,
        tasks: [
          { resolver_tier: 'deterministic' },
          { resolver_tier: 'deterministic' },
        ],
      }),
      db,
      ORG,
    );

    expect(summary.skipped_reason).toBe('all_deterministic');
    // Graded-yield success (6793d04): alpha = y, beta = 1 - y, y in (0, 1].
    expect(summary.alpha_delta).toBeGreaterThan(0);
    expect(summary.alpha_delta + summary.beta_delta).toBeCloseTo(1);
    // No UPDATE against variant_performance_metrics on the leaf.
    expect(countVariantUpdates(calls)).toBe(0);
  });

  test('all-deterministic with composition_chain still fires propagateCreditAlongChain', async () => {
    const { db, calls } = makeDb();
    await applyOutcomeToPosteriors(
      makeTrace({
        success: true,
        composition_chain: ['exec_parent_1'],
        tasks: [
          { resolver_tier: 'deterministic' },
          { resolver: 'bash' },
        ],
      }),
      db,
      ORG,
    );
    // Chain propagation runs as fire-and-forget; give it a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The ancestor lookup is the canonical fingerprint of chain credit
    // propagation having fired (a point lookup on execution since 2f0451e).
    const selectCall = calls.find((c) => /FROM execution WHERE id IN/.test(c.sql));
    expect(selectCall).toBeDefined();
  });

  test('mixed-tier template runs the full UPDATE path', async () => {
    const { db, calls } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({
        success: true,
        tasks: [
          { resolver_tier: 'deterministic' },
          { resolver_tier: 'llm' },
        ],
      }),
      db,
      ORG,
    );

    expect(summary.skipped_reason).toBeUndefined();
    expect(countVariantUpdates(calls)).toBe(1);
  });

  test('all-stochastic template runs the full UPDATE path', async () => {
    const { db, calls } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({
        success: true,
        tasks: [
          { resolver_tier: 'llm' },
          { resolver_tier: 'pattern' },
        ],
      }),
      db,
      ORG,
    );

    expect(summary.skipped_reason).toBeUndefined();
    expect(countVariantUpdates(calls)).toBe(1);
  });

  test('missing resolver_tier on every task defaults to stochastic (full UPDATE runs)', async () => {
    const { db, calls } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({
        success: true,
        // No resolver_tier, no resolver, no prompt — classifier sees a tasks
        // array of empty objects and returns 'all_stochastic'.
        tasks: [{}, {}],
      }),
      db,
      ORG,
    );

    expect(summary.skipped_reason).toBeUndefined();
    expect(countVariantUpdates(calls)).toBe(1);
  });

  test('empty tasks array defaults to stochastic (full UPDATE runs)', async () => {
    const { db, calls } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: true, tasks: [] }),
      db,
      ORG,
    );

    expect(summary.skipped_reason).toBeUndefined();
    expect(countVariantUpdates(calls)).toBe(1);
  });
});
