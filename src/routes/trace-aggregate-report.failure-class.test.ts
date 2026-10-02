// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect } from 'bun:test';
import type { Surreal } from 'surrealdb';

const { runTraceAggregateReport } = await import('./trace-aggregate-report');

/**
 * CHECK-FIRST (slice Y, steps Y1-read-a and Y1-read-b): the one windowed, server-side
 * count the class generator (Y2), its class2 falsifier and the condition-gone closer (Y3)
 * all read. Reuse before mint (law 3): traceAggregateReport is the existing aggregate
 * producer; it gains a failure-class dimension instead of a new resolver being minted.
 *
 * Y1-read-a — THE SOURCE TABLE IS DEAD. This resolver reads `v_paradigm_execution_traces`.
 * Measured on node 1 (2026-10-02): that table holds 2 rows in total, while `execution`
 * holds 9,043 rows with executed_at in the last 24h. The trace list endpoint was repointed
 * to `execution` when "the view froze or vanished (09-22..09-28)"; this sibling was not,
 * so every traceAggregateReport answer is an empty-looking zero. A zero from a dead table
 * would close a gap as "condition gone", so this must land before anything reads it.
 *
 * Y1-read-b — a failure-class dimension, signature filters, and an honest measured flag.
 */

type Row = Record<string, unknown>;

function fakeDb(answer: Row[] | Error): { db: Surreal; calls: Array<{ sql: string; params: Record<string, unknown> }> } {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db = {
    async query(sql: string, params: Record<string, unknown>) {
      calls.push({ sql, params });
      if (answer instanceof Error) throw answer;
      return [answer];
    },
  } as unknown as Surreal;
  return { db, calls };
}

const AUTH = { orgId: 'org-1', authType: 'jwt' as const };

describe('Y1-read-a: traceAggregateReport reads the authoritative execution table', () => {
  it('queries FROM execution, never the frozen v_paradigm_execution_traces table', async () => {
    const { db, calls } = fakeDb([{ status: 'failure', value: 3 }]);
    await runTraceAggregateReport(db, { group_by: 'status' }, AUTH);
    expect(calls.length).toBe(1);
    expect(calls[0]!.sql).not.toContain('v_paradigm_execution_traces');
    expect(calls[0]!.sql).toMatch(/FROM\s+execution\b/);
  });
});

describe('Y1-read-b: failure-class dimension, signature filters, measured flag', () => {
  it('accepts group_by failure_class and keys rows by the class', async () => {
    const { db } = fakeDb([
      { failure_class: 'deterministic:edit-intent-no-landed-edit', value: 369 },
      { failure_class: 'transport', value: 11088 },
    ]);
    const r = await runTraceAggregateReport(db, { group_by: 'failure_class', window_hours: 168, limit: 50 }, AUTH);
    expect(r.group_by).toBe('failure_class');
    const keys = r.rows.map((x) => x.key);
    expect(keys).toContain('deterministic:edit-intent-no-landed-edit');
    expect(keys).toContain('transport');
  });

  it('the failure class is read from the late verdict first, then the insert-time class', async () => {
    const { db, calls } = fakeDb([]);
    await runTraceAggregateReport(db, { group_by: 'failure_class' }, AUTH);
    const sql = calls[0]!.sql;
    // Late /reach verdicts land in metadata.verdict_class; insert-time failures in failure_mode.class.
    expect(sql).toContain('metadata.verdict_class');
    expect(sql).toContain('failure_mode.class');
  });

  it('group_by goal_hash gives the distinct-goal count of a class (total_groups), read from metadata.goal_hash', async () => {
    const { db, calls } = fakeDb([
      { goal_hash: '96ec4108', value: 3 }, { goal_hash: 'a1b2c3d4', value: 1 }, { goal_hash: 'ffff0000', value: 2 },
    ]);
    const r = await runTraceAggregateReport(db, { group_by: 'goal_hash', failure_class: 'deterministic:edit-intent-no-landed-edit', limit: 1 }, AUTH);
    expect(calls[0]!.sql).toContain('metadata.goal_hash');
    expect(r.group_by).toBe('goal_hash');
    expect(r.total_groups).toBe(3);
  });

  it('a failure_class filter is bound as a parameter, never interpolated', async () => {
    const { db, calls } = fakeDb([{ status: 'failure', value: 2 }]);
    await runTraceAggregateReport(db, { group_by: 'status', failure_class: "deterministic:x' OR true --" }, AUTH);
    const { sql, params } = calls[0]!;
    expect(Object.values(params)).toContain("deterministic:x' OR true --");
    expect(sql).not.toContain("OR true --");
  });

  it('a reason_contains filter is bound as a parameter and narrows the count', async () => {
    const { db, calls } = fakeDb([{ status: 'failure', value: 6853 }]);
    const r = await runTraceAggregateReport(db, { group_by: 'status', reason_contains: 'URL is invalid', window_hours: 720 }, AUTH);
    expect(Object.values(calls[0]!.params)).toContain('URL is invalid');
    expect(calls[0]!.sql).toContain('failure_mode.reason');
    expect(r.matched_total).toBe(6853);
  });

  it('until_hours_ago bounds the window from above (the "before the fix" window)', async () => {
    const { db, calls } = fakeDb([]);
    const r = await runTraceAggregateReport(db, { group_by: 'status', window_hours: 96, until_hours_ago: 96 }, AUTH);
    const p = calls[0]!.params;
    const dates = Object.values(p).filter((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v as string))) as string[];
    expect(dates.length).toBe(2);
    const [a, b] = dates.map((d) => Date.parse(d)).sort((x, y) => x - y);
    // [now-192h, now-96h]
    expect(Math.round((b! - a!) / 3_600_000)).toBe(96);
    expect(Math.round((Date.now() - b!) / 3_600_000)).toBe(96);
    expect(r.until_hours_ago).toBe(96);
  });

  it('matched_total sums every group before the limit cap (a zero_field a class2 check can read)', async () => {
    const { db } = fakeDb([
      { activity_id: 'a', value: 5 }, { activity_id: 'b', value: 4 }, { activity_id: 'c', value: 1 },
    ]);
    const r = await runTraceAggregateReport(db, { group_by: 'activity_id', limit: 1 }, AUTH);
    expect(r.rows.length).toBe(1);
    expect(r.matched_total).toBe(10);
  });

  it('a failed query is measured:false, not a zero that reads as "condition gone"', async () => {
    const { db } = fakeDb(new Error('query timed out'));
    const r = await runTraceAggregateReport(db, { group_by: 'status', reason_contains: 'URL is invalid' }, AUTH);
    expect(r.measured).toBe(false);
    expect(r.matched_total).toBeNull();
  });

  it('a successful empty query is measured:true with matched_total 0', async () => {
    const { db } = fakeDb([]);
    const r = await runTraceAggregateReport(db, { group_by: 'status', reason_contains: 'URL is invalid' }, AUTH);
    expect(r.measured).toBe(true);
    expect(r.matched_total).toBe(0);
  });

  it('an unserved group_by is refused (HTTP 400 or measured:false reason unserved_group_by), never activity_id rows under the requested label', async () => {
    // Today an unknown group_by silently falls back to activity_id and answers activity-grouped
    // counts labelled as whatever was asked: a consumer asking for a dimension this resolver does
    // not serve gets the wrong dimension with no signal. Refusal is the only honest answer.
    const { db, calls } = fakeDb([
      { activity_id: 'a', value: 5 }, { activity_id: 'b', value: 4 },
    ]);
    let r: Record<string, unknown> | undefined;
    let thrown: unknown;
    try {
      r = (await runTraceAggregateReport(db, { group_by: 'not_a_dimension' }, AUTH)) as unknown as Record<string, unknown>;
    } catch (err) {
      thrown = err;
    }
    // No query may group by the fallback dimension on this request.
    for (const c of calls) expect(c.sql).not.toMatch(/GROUP BY\s+activity_id\b/);
    if (thrown !== undefined) {
      const e = thrown as { status?: number; statusCode?: number };
      expect(e.status ?? e.statusCode).toBe(400);
      return;
    }
    expect(r!.measured).toBe(false);
    expect(r!.reason).toBe('unserved_group_by');
    expect(r!.group_by).not.toBe('activity_id');
    expect((r!.rows as unknown[] | undefined) ?? []).toEqual([]);
  });
});
