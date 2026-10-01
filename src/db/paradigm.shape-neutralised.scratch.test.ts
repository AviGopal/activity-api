/**
 * Behavioural proof against a REAL SurrealDB 2.3.3 view: whatever v_shape_conditioned_score holds,
 * getShapeConditionedScores returns exactly the global posteriors (getActivityScores) with an empty
 * shape signature. Fails on the parent commit, which returned the view row.
 *
 * Runs only with SCRATCH_SURREALDB_URL (loopback, never :8000/:18000) and its own database.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'shape_neutralised_test';
if (SCRATCH) {
  const u = new URL(SCRATCH);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || ['8000', '18000'].includes(u.port)) {
    throw new Error(`refusing non-scratch SurrealDB: ${SCRATCH}`);
  }
  process.env.SURREALDB_URL = SCRATCH;
  process.env.SURREALDB_NAMESPACE = 'activity-system';
  process.env.SURREALDB_DATABASE = TEST_DB;
  process.env.SURREALDB_USERNAME = 'root';
  process.env.SURREALDB_PASSWORD = process.env.SCRATCH_SURREALDB_PASS ?? 'root';
}
import { describe, test, expect, beforeAll } from 'bun:test';
import { readFileSync } from 'fs';

const run = SCRATCH ? describe : describe.skip;
const SCHEMA_023 = readFileSync(new URL('../../sql/schemas/023-shape-conditioned-scores.surql', import.meta.url), 'utf8');
const VIEW_DDL = (() => {
  const s = SCHEMA_023.indexOf('DEFINE TABLE IF NOT EXISTS v_shape_conditioned_score');
  return SCHEMA_023.slice(s, SCHEMA_023.indexOf(';', s) + 1);
})();

run('getShapeConditionedScores against the real view (scratch)', () => {
  let P: typeof import('./paradigm');
  let db: typeof import('./surreal')['surrealDB'];
  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) throw new Error('not the scratch DB — refusing');
    db = (await import('./surreal')).surrealDB;
    P = await import('./paradigm');
    if (typeof P.getShapeConditionedScores !== 'function' || typeof db.query !== 'function') {
      throw new Error('paradigm/surreal are mocked in this process — run this file on its own');
    }
  });

  async function withView(outcomes: boolean[]) {
    await db.query('REMOVE TABLE IF EXISTS v_shape_conditioned_score; REMOVE TABLE IF EXISTS execution; REMOVE TABLE IF EXISTS variant_performance_metrics;');
    await db.query('DEFINE TABLE execution SCHEMALESS;');
    // The reach-graded posterior store the global path reads: Beta(8, 4) for A.
    await db.query('CREATE variant_performance_metrics CONTENT $r', { r: {
      variant_id: 'A', org_id: 'organizations:o', thompson_alpha: 8, thompson_beta: 4,
      successful_executions: 7, failed_executions: 3, total_executions: 10, avg_duration_ms: 5, avg_cost_usd: 0,
    } });
    await db.query(VIEW_DDL);
    for (const [i, ok] of outcomes.entries()) {
      await db.query('INSERT INTO execution $r RETURN NONE', { r: {
        id: `e${i}`, activity_id: 'A', org_id: 'organizations:o', success: ok, duration_ms: 10, cost_usd: 0,
        input_impulse_shapes: ['x', 'y'], executed_at: new Date(Date.now() - (10 - i) * 1000),
      } });
    }
    const view = await db.query<{ successes: number }>('SELECT * FROM v_shape_conditioned_score WHERE activity_id = "A"');
    expect(view.length).toBe(1); // the view really holds a matching group
    return {
      exact: await P.getShapeConditionedScores('organizations:o', ['A'], ['y', 'x']),
      subset: await P.getShapeConditionedScores('organizations:o', ['A'], ['x', 'y', 'z']),
      global: await P.getActivityScores('organizations:o', ['A']),
    };
  }

  test('output is the global posterior, identical whatever the view row holds', async () => {
    const mostlyOk = await withView([true, true, true, true, true, false]);
    const allFail = await withView([false, false, false, false, false, false]);
    for (const r of [mostlyOk, allFail]) {
      const expected = r.global.data.map((g) => ({ ...g, shape_signature: [] }));
      expect(r.exact.data).toEqual(expected);
      expect(r.subset.data).toEqual(expected);
      expect(r.exact.data.every((d) => d.shape_signature.length === 0)).toBe(true);
    }
    expect(mostlyOk.exact.data).toEqual(allFail.exact.data);
    // Non-vacuous: the global posterior is really there, and it is the reach-graded one.
    expect(mostlyOk.exact.data.map((d) => [d.activity_id, d.alpha, d.beta])).toEqual([['A', 8, 4]]);
  });
});
