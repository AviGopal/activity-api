/**
 * Retirement on posterior evidence (2026-08-16).
 *
 * The predecessor, checkAndRetireTemplate, could not retire anything for four independent
 * reasons — no live caller, wrong table, zero matching rows for the worst arms, and a row-shape
 * bug that threw inside its own try. Measured consequence on the live hub: `retired_reason =
 * "poor_performance"` on ZERO rows while an arm at posterior mean 0.0087 with 395 executions
 * stayed selectable.
 *
 * These tests pin the behaviour that has to hold for the replacement to be worth anything:
 * it reads variant_performance_metrics, it uses the POSTERIOR (not the truncated success_rate),
 * it matches the record by id part rather than bracket spelling, and it declines to retire
 * anything that has not earned it. Queries are captured rather than round-tripped.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// config.ts evaluates `export const config = loadConfig()` at import time and THROWS without
// SURREALDB_NAMESPACE. Setting the env with ??= is NOT enough in a full-suite run: a sibling
// (config.account-id.test.ts) saves and RESTORES that variable to undefined, so whichever module
// triggers the first config load afterwards throws "between tests". That is precisely what the
// hub's convergence gate measures, and why this file passed in isolation while regressing the
// gate. Set it unconditionally, so no ordering between test files can reintroduce the throw.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

const surrealQueries: { sql: string; params: any }[] = [];
let metricsRow: Record<string, unknown> | null = null;
let updateReturns: unknown[] = [{ id: 'x' }];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      if (/FROM variant_performance_metrics/i.test(sql)) return metricsRow ? [metricsRow] : [];
      if (/^\s*UPDATE activity/i.test(sql)) return updateReturns;
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

mock.module('../lib/tuning-params', () => ({
  getTuningParam: async (_n: string, _e: string | undefined, d: number) => d,
}));

const { checkAndRetireByPosterior } = await import('./variant-creator');

const metrics = (over: Record<string, unknown> = {}) => ({
  total_executions: 400,
  thompson_alpha: 1,
  thompson_beta: 113.59,
  ...over,
});

beforeEach(() => {
  surrealQueries.length = 0;
  metricsRow = metrics();
  updateReturns = [{ id: 'x' }];
});

const updates = () => surrealQueries.filter((q) => /^\s*UPDATE activity/i.test(q.sql));

describe('checkAndRetireByPosterior', () => {
  test('retires a heavily blamed arm with enough executions', async () => {
    const retired = await checkAndRetireByPosterior('activity:⟨auto-bridge-code_modification_proposal⟩', 'organizations:acme');
    expect(retired).toBe(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).toContain('retired_reason = "poor_performance"');
  });

  test('reads variant_performance_metrics, never the execution table', async () => {
    await checkAndRetireByPosterior('some-arm', 'acme');
    expect(surrealQueries.some((q) => /FROM variant_performance_metrics/i.test(q.sql))).toBe(true);
    expect(surrealQueries.some((q) => /FROM execution\b/i.test(q.sql))).toBe(false);
  });

  test('matches the record by id part, not bracket spelling', async () => {
    await checkAndRetireByPosterior('activity:⟨my-arm⟩', 'acme');
    expect(updates()[0].sql).toContain('meta::id(id) = $bare_id');
    expect(updates()[0].params.bare_id).toBe('my-arm');
  });

  test('strips the organizations: prefix when scoping the read', async () => {
    await checkAndRetireByPosterior('my-arm', 'organizations:acme');
    const read = surrealQueries.find((q) => /FROM variant_performance_metrics/i.test(q.sql))!;
    expect(read.params.org_id).toBe('acme');
  });

  test('does NOT retire below the execution floor, however bad the posterior', async () => {
    metricsRow = metrics({ total_executions: 19 });
    expect(await checkAndRetireByPosterior('my-arm', 'acme')).toBe(false);
    expect(updates()).toHaveLength(0);
  });

  test('does NOT retire an arm whose posterior is above the floor', async () => {
    metricsRow = metrics({ thompson_alpha: 1.81, thompson_beta: 1.19 }); // mean 0.603
    expect(await checkAndRetireByPosterior('my-arm', 'acme')).toBe(false);
    expect(updates()).toHaveLength(0);
  });

  test('uses the posterior, not the truncated success_rate', async () => {
    // success_rate is written int/int and truncates to 0 or 1; a healthy arm can carry a
    // stored 0. Retirement must ignore it and read alpha/beta.
    metricsRow = metrics({ success_rate: 0, thompson_alpha: 9, thompson_beta: 1 }); // mean 0.9
    expect(await checkAndRetireByPosterior('my-arm', 'acme')).toBe(false);
  });

  test('returns false when the arm has no metrics row at all', async () => {
    metricsRow = null;
    expect(await checkAndRetireByPosterior('ghost-arm', 'acme')).toBe(false);
    expect(updates()).toHaveLength(0);
  });

  test('reports false when the UPDATE matched nothing (already retired)', async () => {
    updateReturns = [];
    expect(await checkAndRetireByPosterior('my-arm', 'acme')).toBe(false);
  });

  test('never sweeps: one call retires at most one arm', async () => {
    await checkAndRetireByPosterior('my-arm', 'acme');
    expect(updates()).toHaveLength(1);
    expect(updates()[0].sql).not.toMatch(/WHERE\s+total_executions|WHERE\s+thompson_/i);
  });

  test('swallows DB errors and reports false rather than throwing at the caller', async () => {
    metricsRow = metrics();
    const spy = mock(() => {
      throw new Error('db down');
    });
    const original = surrealQueries.push.bind(surrealQueries);
    (surrealQueries as any).push = spy;
    const result = await checkAndRetireByPosterior('my-arm', 'acme').catch(() => 'THREW');
    (surrealQueries as any).push = original;
    expect(result).toBe(false);
  });
});
