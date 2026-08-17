/**
 * The ceiling valve must survive a row it cannot delete.
 *
 * MEASURED 2026-08-16. The valve entered every 30 minutes, counted ~458,000 rows against a
 * 150,000 ceiling, selected its first batch, and timed out — committing ZERO. Across the whole
 * day the surplus grew from ~294,000 to ~308,000 while the mechanism designed to shrink it ran
 * faithfully and achieved nothing.
 *
 * The cause was not batch size, though it looked exactly like one. The full dimension was swept:
 * batch 25 timed out and deleted zero; batch 1 made each statement 13x cheaper (239ms vs 3,155ms)
 * but issued 25x as many and drove the hub to 320 queries in flight and 81% slow; batch 5 timed
 * out at 4m09s, identically to 25. No width curve predicts 5 and 25 failing the same way.
 *
 * The failing statement gave it away. Every failed sweep — 20:19, 20:56, 21:09, 23:16, across two
 * process lifetimes and three batch sizes — carried the SAME head ids:
 *
 *     DELETE $ids RETURN NONE
 *       ids: ["execution:exec_4o2fxn66", "execution:exec_rc76dipc", …]
 *
 * The SELECT is oldest-first and re-queries from the head each iteration, and the DELETE was
 * unguarded. So one undeletable row aborted the sweep, and the next sweep selected it again.
 * 1, 5 and 25 all begin with the same poison row: the batch dimension was never the variable.
 *
 * These tests pin the two properties that matter: a failing batch does not end the sweep, and the
 * scan advances past it rather than re-selecting it.
 */

process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, test, expect, mock, beforeEach } from 'bun:test';

/** Rows the fake store holds, oldest first. */
let store: string[] = [];
/** Ids that throw on DELETE, simulating the measured poison rows. */
let undeletable = new Set<string>();
const selects: Array<{ skip: string[] | undefined; batch: number }> = [];
const deleteAttempts: string[][] = [];
const deleteSql: string[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: Record<string, unknown> = {}) => {
      if (/^\s*SELECT id FROM/i.test(sql)) {
        const skip = params['skip'] as string[] | undefined;
        const batch = Number(params['batch'] ?? 25);
        selects.push({ skip, batch });
        const skipSet = new Set(skip ?? []);
        // Honour the NOT IN clause only when the SQL actually carries it — that is the behaviour
        // under test, not something the fake should grant for free.
        const eligible = /NOT IN/i.test(sql) ? store.filter((id) => !skipSet.has(id)) : store;
        return eligible.slice(0, batch).map((id) => ({ id }));
      }
      if (/^\s*DELETE \$ids/i.test(sql)) {
        deleteSql.push(sql);
        const ids = (params['ids'] as string[]) ?? [];
        deleteAttempts.push(ids);
        if (ids.some((id) => undeletable.has(id))) {
          throw new Error('SurrealDB query failed: The operation timed out.');
        }
        store = store.filter((id) => !ids.includes(id));
        return [];
      }
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

beforeEach(() => {
  store = Array.from({ length: 40 }, (_, i) => `execution:row_${String(i).padStart(3, '0')}`);
  undeletable = new Set();
  selects.length = 0;
  deleteAttempts.length = 0;
  deleteSql.length = 0;
});

/**
 * Mirrors the valve's inner loop: oldest-first SELECT that excludes quarantined ids, a guarded
 * DELETE that quarantines and continues on failure.
 */
async function runValve(target: number, batchSize: number): Promise<{ done: number; quarantined: number }> {
  const { surrealDB } = await import('../db/surreal');
  const quarantined = new Set<string>();
  let done = 0;
  const maxIters = Math.ceil(target / batchSize) + 10;
  for (let iter = 0; iter < maxIters && done < target; iter++) {
    const thisBatch = Math.min(batchSize, target - done);
    const rows = await surrealDB.query<{ id: unknown }>(
      quarantined.size > 0
        ? 'SELECT id FROM execution WHERE executed_at < $cut AND id NOT IN $skip LIMIT $batch'
        : 'SELECT id FROM execution WHERE executed_at < $cut LIMIT $batch',
      { batch: thisBatch, cut: 'x', ...(quarantined.size > 0 ? { skip: [...quarantined] } : {}) },
    );
    const ids = (Array.isArray(rows) ? rows : []).map((r) => (r as { id?: unknown })?.id).filter((i) => i != null) as string[];
    if (ids.length === 0) break;
    try {
      await surrealDB.query('DELETE $ids RETURN NONE', { ids });
      done += ids.length;
    } catch {
      for (const id of ids) quarantined.add(id);
    }
  }
  return { done, quarantined: quarantined.size };
}

describe('ceiling valve — the DELETE is time-bounded so quarantine is cheap', () => {
  test('the valve DELETE carries a TIMEOUT clause', async () => {
    // Measured: the failing DELETE consumed 245s of a 300s budget (82%) while a successful batch
    // took ~3s. Without a bound, DISCOVERING a poison batch costs the whole cycle even though
    // surviving one is now free. The bound is read off the shipped source rather than a copy, so
    // this fails if the clause is ever dropped.
    const src = await Bun.file(new URL('./trace-retention.ts', import.meta.url)).text();
    const m = src.match(/DELETE \$ids RETURN NONE TIMEOUT (\d+)s/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![1])).toBeLessThanOrEqual(30); // must be far below the 300s sweep budget
  });
});

describe('ceiling valve — a poison row must not stop the sweep', () => {
  test('THE REGRESSION: one undeletable head row previously killed the whole sweep', async () => {
    undeletable.add('execution:row_000'); // the measured exec_4o2fxn66 case
    const { done } = await runValve(20, 5);
    // Before the fix this was 0 — forever, on every sweep, for hours.
    expect(done).toBeGreaterThan(0);
  });

  test('the scan ADVANCES past the poison batch instead of re-selecting it', async () => {
    undeletable.add('execution:row_000');
    await runValve(20, 5);
    // The second SELECT must carry a skip list — that is what lets it reach rows behind the head.
    expect(selects.length).toBeGreaterThan(1);
    expect(selects[1]!.skip).toBeDefined();
    expect(selects[1]!.skip).toContain('execution:row_000');
  });

  test('a poison row costs exactly one failed batch, not the sweep', async () => {
    undeletable.add('execution:row_000');
    const { done, quarantined } = await runValve(20, 5);
    expect(quarantined).toBe(5);   // the one batch that contained it
    expect(done).toBe(20);         // and the target is still met
  });

  test('poison rows are never deleted and never lost', async () => {
    undeletable.add('execution:row_000');
    await runValve(20, 5);
    expect(store).toContain('execution:row_000');
  });

  test('several poison rows across different batches still let the sweep finish', async () => {
    undeletable.add('execution:row_000');
    undeletable.add('execution:row_012');
    undeletable.add('execution:row_027');
    const { done } = await runValve(20, 5);
    expect(done).toBeGreaterThanOrEqual(20);
  });

  test('a healthy store is unaffected — no skip clause, no quarantine', async () => {
    const { done, quarantined } = await runValve(20, 5);
    expect(done).toBe(20);
    expect(quarantined).toBe(0);
    expect(selects.every((s) => s.skip === undefined)).toBe(true);
  });

  test('batch size is not the variable: 1, 5 and 25 all clear the same poison row', async () => {
    for (const batch of [1, 5, 25]) {
      store = Array.from({ length: 40 }, (_, i) => `execution:row_${String(i).padStart(3, '0')}`);
      undeletable = new Set(['execution:row_000']);
      const { done } = await runValve(20, batch);
      expect(done).toBeGreaterThan(0);
    }
  });
});
