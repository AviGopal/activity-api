// config.ts evaluates loadConfig() at import and THROWS without these (the
// resolver pulls in the logger, which pulls in config). Set before any import.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect } from 'bun:test';
import type { Surreal } from 'surrealdb';

// `import` declarations HOIST above the assignments above, so the module under
// test (which transitively imports config.ts) must be pulled in dynamically,
// after the env is set. Same reason trace-key-agreement.test.ts uses await import.
const { runGroupedExecutionStats } = await import('./grouped-execution-stats');

/**
 * The point of these tests is ONE distinction: reach is not success.
 *
 * `success` is the template's exit status; `reached` is the goal verdict
 * (src/lib/reach-classify.ts: "Exiting cleanly is not evidence a goal was
 * reached"). Several composed activities computed success_count/count and called
 * it reach_rate. The fixture below makes the two DIVERGE so a regression to the
 * success column cannot pass.
 */

type Row = Record<string, unknown>;

/**
 * Fake Surreal that answers by inspecting the SQL text. Encodes the query
 * contract: totals/success come off the compat view, the reach passes off the
 * base `execution` table (the view does not project `reached`).
 */
function fakeDb(counts: {
  total: Record<string, number>;
  success: Record<string, number>;
  reached?: Record<string, number>;
  graded?: Record<string, number>;
  reachThrows?: boolean;
}): { db: Surreal; sql: string[] } {
  const sql: string[] = [];
  const group = (m: Record<string, number>): Row[][] => [
    Object.entries(m).map(([activity_id, value]) => ({ activity_id, value })),
  ];
  const db = {
    query: async (q: string) => {
      sql.push(q);
      if (q.includes('failure_mode')) return [[]];
      if (q.includes('reached')) {
        if (counts.reachThrows) throw new Error('no such field: reached');
        if (q.includes('reached = true')) return group(counts.reached ?? {});
        return group(counts.graded ?? {});
      }
      if (q.includes('success = true')) return group(counts.success);
      return group(counts.total);
    },
  } as unknown as Surreal;
  return { db, sql };
}

const AUTH = { orgId: 'org:test', authType: 'apikey' as const };

describe('groupedExecutionStats reach_rate', () => {
  it('computes reach_rate from `reached`, NOT from `success` (they diverge)', async () => {
    // 100 runs, 100 exited cleanly, all 100 graded, only 4 actually reached.
    // success_rate = 1.00 and reach_rate = 0.04 — a success-derived reach_rate
    // would report 1.00 here.
    const { db } = fakeDb({
      total: { 'walk:goal': 100 },
      success: { 'walk:goal': 100 },
      reached: { 'walk:goal': 4 },
      graded: { 'walk:goal': 100 },
    });
    const res = await runGroupedExecutionStats(db, {}, AUTH);
    const row = res.rows[0]!;
    expect(row.success_rate).toBe(1);
    expect(row.reach_rate).toBe(0.04);
    expect(row.reached_count).toBe(4);
    expect(row.reach_rate).not.toBe(row.success_rate);
  });

  it('reads the reach columns off `execution`, not the compat view', async () => {
    const { db, sql } = fakeDb({ total: { a: 1 }, success: { a: 1 }, reached: { a: 1 }, graded: { a: 1 } });
    await runGroupedExecutionStats(db, {}, AUTH);
    const reachQueries = sql.filter((q) => q.includes('reached'));
    expect(reachQueries.length).toBe(2);
    for (const q of reachQueries) {
      expect(q).toContain('FROM execution');
      expect(q).not.toContain('v_paradigm_execution_traces');
    }
    // The graded predicate is the trace-retention idiom, not `!= null`.
    expect(reachQueries.some((q) => q.includes('reached != NONE'))).toBe(true);
  });

  it('a failing run that was graded REACHED still counts as reached (inverse divergence)', async () => {
    // The satisfier case: exit status failed, goal verdict reached.
    const { db } = fakeDb({
      total: { 'walk:goal': 10 },
      success: { 'walk:goal': 0 },
      reached: { 'walk:goal': 10 },
      graded: { 'walk:goal': 10 },
    });
    const row = (await runGroupedExecutionStats(db, {}, AUTH)).rows[0]!;
    expect(row.success_rate).toBe(0);
    expect(row.reach_rate).toBe(1);
  });

  describe('ungraded handling (denominator = graded only)', () => {
    it('an ungraded run is NOT counted as a failure to reach', async () => {
      // 100 runs, 10 graded, 9 of those reached. Graded-only => 0.9.
      // An all-executions denominator would report 0.09 and slander the family.
      const { db } = fakeDb({
        total: { 'tick:metabolism': 100 },
        success: { 'tick:metabolism': 100 },
        reached: { 'tick:metabolism': 9 },
        graded: { 'tick:metabolism': 10 },
      });
      const row = (await runGroupedExecutionStats(db, {}, AUTH)).rows[0]!;
      expect(row.graded_count).toBe(10);
      expect(row.ungraded_count).toBe(90);
      expect(row.reach_rate).toBeCloseTo(0.9, 10);
    });

    it('reach_rate is NULL, not 0, when nothing in the group was graded', async () => {
      const { db } = fakeDb({ total: { x: 50 }, success: { x: 50 }, reached: {}, graded: {} });
      const row = (await runGroupedExecutionStats(db, {}, AUTH)).rows[0]!;
      expect(row.reach_rate).toBeNull();
      expect(row.graded_count).toBe(0);
      expect(row.ungraded_count).toBe(50);
    });

    it('degrades to null reach_rate (never 0) when the reach pass errors', async () => {
      const { db } = fakeDb({ total: { x: 20 }, success: { x: 20 }, reachThrows: true });
      const res = await runGroupedExecutionStats(db, {}, AUTH);
      expect(res.rows[0]!.reach_rate).toBeNull();
      // The livelock signal must survive a degraded reach pass.
      expect(res.rows[0]!.success_rate).toBe(1);
      expect(res.query_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('single-group top-level projection (the falsifier seam)', () => {
    it('projects reach_rate FLAT when scoped to one activity_id', async () => {
      const { db } = fakeDb({
        total: { 'walk:goal': 40 },
        success: { 'walk:goal': 40 },
        reached: { 'walk:goal': 30 },
        graded: { 'walk:goal': 40 },
      });
      const res = await runGroupedExecutionStats(db, { activity_id: 'walk:goal' }, AUTH);
      // Read exactly the way verifyGapConditionAsync reads nonzero_field: flat.
      expect((res as unknown as Record<string, unknown>)['reach_rate']).toBe(0.75);
      expect(res.graded_count).toBe(40);
    });

    it('leaves the top-level projection null when unscoped (a fleet number is not a verdict)', async () => {
      const { db } = fakeDb({
        total: { a: 10, b: 10 },
        success: { a: 10, b: 10 },
        reached: { a: 10, b: 0 },
        graded: { a: 10, b: 10 },
      });
      const res = await runGroupedExecutionStats(db, {}, AUTH);
      expect(res.reach_rate).toBeNull();
      expect(res.rows.length).toBe(2);
    });
  });
});
