/**
 * Unit tests for buildDecisionOutcome (lib/decision-credit.ts) — the pure builder
 * that joins a Thompson selection to the outcome that followed it (law 12).
 *
 * The persist path (recordDecisionOutcome) is best-effort I/O tested at runtime;
 * these pin the join arithmetic and the null-safety that keeps option<T> columns
 * from being fed a rejecting NULL.
 */

import { describe, test, expect } from 'bun:test';

// decision-credit.ts imports the logger, which pulls in config at load time.
// Set the DB env before importing so the module loads (buildDecisionOutcome is pure).
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { buildDecisionOutcome, recordExecutionDecisionOutcome } = await import('./decision-credit');

describe('recordExecutionDecisionOutcome (universal per-execution capture)', () => {
  function fakeDb(posteriorRow: unknown) {
    const calls: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    return {
      calls,
      query: async <T>(sql: string, params?: Record<string, unknown>): Promise<T[]> => {
        calls.push({ sql, params });
        return (sql.includes('variant_performance_metrics') ? [posteriorRow].filter(Boolean) : []) as T[];
      },
    };
  }

  test('records predicted_success from the arm posterior and upserts keyed on execution_id', async () => {
    const db = fakeDb({ thompson_alpha: 3, thompson_beta: 1 });
    const rec = await recordExecutionDecisionOutcome(db, {
      executionId: 'exec_abc', activityId: 'a1', orgId: 'organizations:substrate', success: true, reached: true,
    });
    expect(rec).not.toBeNull();
    expect(rec!.predicted_success).toBeCloseTo(0.75, 5);
    expect(rec!.outcome_success).toBe(true);
    expect(rec!.reached).toBe(true);
    const upsert = db.calls.find((c) => c.sql.includes('UPSERT'));
    expect(upsert).toBeTruthy();
    expect((upsert!.params as any).eid).toBe('exec_abc');
    const content = (upsert!.params as any).content;
    expect(content.correlation_id).toBe('exec_abc'); // execution_id doubles as the unique key
    expect(content.execution_id).toBe('exec_abc');
    expect(content.source).toBe('execution');
    // executed_at is always stamped (ingest-time proxy when caller omits it) — a null
    // timestamp left 100% of live rows untimed and broke time-ordered consumers.
    expect(typeof content.executed_at).toBe('string');
    expect(Number.isNaN(new Date(content.executed_at as string).getTime())).toBe(false);
  });

  test('stamps executed_at at ingest-time when the caller supplies none, and honors an explicit one', async () => {
    const db = fakeDb({ thompson_alpha: 1, thompson_beta: 1 });
    await recordExecutionDecisionOutcome(db, {
      executionId: 'exec_nots', activityId: 'a', orgId: 'o', success: true, reached: true,
    });
    const c1 = (db.calls.find((c) => c.sql.includes('UPSERT'))!.params as any).content;
    expect(typeof c1.executed_at).toBe('string'); // never null anymore

    const db2 = fakeDb({ thompson_alpha: 1, thompson_beta: 1 });
    await recordExecutionDecisionOutcome(db2, {
      executionId: 'exec_ts', activityId: 'a', orgId: 'o', success: true, reached: true, executedAt: '2026-08-24T00:00:00.000Z',
    });
    const c2 = (db2.calls.find((c) => c.sql.includes('UPSERT'))!.params as any).content;
    expect(c2.executed_at).toBe('2026-08-24T00:00:00.000Z'); // explicit wins
  });

  test('predicted_success is omitted (NONE) when the arm has no posterior row', async () => {
    const db = fakeDb(null);
    const rec = await recordExecutionDecisionOutcome(db, {
      executionId: 'exec_x', activityId: 'never-run', orgId: 'o', success: false, reached: false,
    });
    expect(rec!.predicted_success).toBeNull();
    const content = (db.calls.find((c) => c.sql.includes('UPSERT'))!.params as any).content;
    expect('predicted_success' in content).toBe(false); // omitted, not null (option<T> trap)
    expect(content.reached).toBe(false);
  });

  test('returns null without an execution id or activity id (no key)', async () => {
    const db = fakeDb({ thompson_alpha: 1, thompson_beta: 1 });
    expect(await recordExecutionDecisionOutcome(db, { executionId: '', activityId: 'a', orgId: 'o', success: true, reached: true })).toBeNull();
    expect(await recordExecutionDecisionOutcome(db, { executionId: 'e', activityId: '', orgId: 'o', success: true, reached: true })).toBeNull();
  });
});

describe('buildDecisionOutcome', () => {
  test('joins a selection to its outcome and computes predicted success', () => {
    const rec = buildDecisionOutcome(
      { correlationId: 'sel_1', success: true, reached: true },
      { activity_id: 'a1', alpha: 3, beta: 1, thompson_sample: 0.8, selected_at: '2026-08-24T00:00:00Z' },
    );
    expect(rec).not.toBeNull();
    expect(rec!.activity_id).toBe('a1');
    expect(rec!.predicted_success).toBeCloseTo(0.75, 5); // 3/(3+1)
    expect(rec!.outcome_success).toBe(true);
    expect(rec!.reached).toBe(true);
    expect(rec!.thompson_sample).toBe(0.8);
  });

  test('returns null without a correlation id (no join key)', () => {
    expect(buildDecisionOutcome({ correlationId: null, success: true }, { activity_id: 'a1' })).toBeNull();
    expect(buildDecisionOutcome({ correlationId: undefined, success: true }, { activity_id: 'a1' })).toBeNull();
  });

  test('returns null when the selection was not found', () => {
    expect(buildDecisionOutcome({ correlationId: 'sel_x', success: false }, null)).toBeNull();
    expect(buildDecisionOutcome({ correlationId: 'sel_x', success: false }, undefined)).toBeNull();
  });

  test('predicted_success is null (not NaN) when alpha/beta are absent', () => {
    const rec = buildDecisionOutcome({ correlationId: 'sel_1', success: true }, { activity_id: 'a1' });
    expect(rec!.predicted_success).toBeNull();
    expect(rec!.thompson_sample).toBeNull();
  });

  test('predicted_success is null when alpha+beta is zero (no divide-by-zero)', () => {
    const rec = buildDecisionOutcome({ correlationId: 'sel_1', success: true }, { activity_id: 'a1', alpha: 0, beta: 0 });
    expect(rec!.predicted_success).toBeNull();
  });

  test('reached defaults to null (ungraded) when not supplied', () => {
    const rec = buildDecisionOutcome({ correlationId: 'sel_1', success: false }, { activity_id: 'a1', alpha: 1, beta: 1 });
    expect(rec!.reached).toBeNull();
    expect(rec!.outcome_success).toBe(false);
    expect(rec!.predicted_success).toBeCloseTo(0.5, 5);
  });

  test('a not-reached outcome records reached=false distinctly from ungraded=null', () => {
    const notReached = buildDecisionOutcome({ correlationId: 'c', success: true, reached: false }, { activity_id: 'a1' });
    expect(notReached!.reached).toBe(false);
  });
});
