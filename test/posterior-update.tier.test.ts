/**
 * Unit tests for M4 tier-restricted bandit gating in applyOutcomeToPosteriors.
 *
 * For all-deterministic templates the variant_performance_metrics UPDATE is
 * skipped (degenerate Beta posterior), but propagateCreditAlongChain still
 * fires. Mixed and all-stochastic templates run the full update path.
 * Traces without resolver_tier default to stochastic treatment.
 */

import { describe, test, expect } from 'bun:test';
import {
  applyOutcomeToPosteriors,
  type DBQueryable,
  type TraceForPosterior,
} from '../src/lib/posterior-update';

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
    ...overrides,
  };
}

function countVariantUpdates(
  calls: Array<{ sql: string; params: Record<string, unknown> }>,
): number {
  return calls.filter(
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
    expect(summary.alpha_delta).toBe(1);
    expect(summary.beta_delta).toBe(0);
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

    // The ancestor lookup SELECT is the canonical fingerprint of chain credit
    // propagation having fired.
    const selectCall = calls.find(
      (c) =>
        c.sql.includes('activity_execution_traces') && c.sql.includes('SELECT'),
    );
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
