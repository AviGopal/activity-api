/**
 * POST /execution-traces/reach must GRADE a late verdict — through the real route, on a real
 * SurrealDB. The pre-read used to carry `WHERE activity_id = $activity_id` with $activity_id never
 * bound, so it matched nothing and no late verdict was ever credited (fails on the parent).
 *
 * Runs only with SCRATCH_SURREALDB_URL (loopback, never :8000/:18000) and its own database.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'reach_grading_test';
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
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

const run = SCRATCH ? describe : describe.skip;
const ORG = 'organizations:o';

run('POST /execution-traces/reach grades late verdicts (scratch)', () => {
  let db: typeof import('../db/surreal')['surrealDB'];
  let AGG: typeof import('../lib/posterior-aggregator');
  let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) throw new Error('not the scratch DB — refusing');
    db = (await import('../db/surreal')).surrealDB;
    // Route first: posterior-update ↔ posterior-aggregator import each other, and loading the
    // aggregator first hits its TDZ.
    ET = (await import('./execution-traces')).default as typeof ET;
    AGG = await import('../lib/posterior-aggregator');
    if (typeof db.query !== 'function' || typeof ET?.request !== 'function') throw new Error('modules are mocked — run this file on its own');
  });

  beforeEach(async () => {
    await AGG.flushPosteriors();
    await db.query('REMOVE TABLE IF EXISTS execution; REMOVE TABLE IF EXISTS variant_performance_metrics;');
    await db.query('DEFINE TABLE execution SCHEMALESS;');
    await db.query(
      'CREATE variant_performance_metrics CONTENT { variant_id: "W", org_id: $o, thompson_alpha: 1.0, thompson_beta: 1.0, updated_at: time::now() }',
      { o: ORG });
  });

  /** A goal-host walk as inserted: ungraded (no verdict yet). */
  const walk = (id: string) => db.query('CREATE type::thing("execution", $id) CONTENT $r', { id, r: {
    activity_id: 'W', org_id: ORG, success: true, tags: ['dispatcher_used:goal-host'], executed_at: new Date(),
  } });
  async function reach(body: Record<string, unknown>) {
    const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json() as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 150)); // the credit call is fire-and-forget
    await AGG.flushPosteriors();
    return { status: res.status, json };
  }
  async function vpm() {
    await AGG.flushPosteriors();
    const r = (await db.query<{ thompson_alpha: number; thompson_beta: number }>(
      'SELECT thompson_alpha, thompson_beta FROM variant_performance_metrics WHERE variant_id = "W"'))[0]!;
    return [Number(r.thompson_alpha.toFixed(6)), Number(r.thompson_beta.toFixed(6))];
  }
  const tags = async (id: string) =>
    (await db.query<string[]>('SELECT VALUE tags FROM type::thing("execution", $id)', { id }))[0] ?? [];

  test('a late REACHED verdict for an ungraded walk moves VPM alpha exactly once', async () => {
    await walk('w1');
    const r = await reach({ execution_id: 'w1', reached: true });
    expect([r.status, r.json.success, r.json.updated]).toEqual([200, true, 1]);
    const after = await vpm();
    expect(after[0]).toBeGreaterThan(1); // credited
    expect(await tags('w1')).toEqual(expect.arrayContaining(['reach_graded:true', 'reached:true']));
    // A repeated POST (goal-host retries, spool drain) must not credit again.
    const again = await reach({ execution_id: 'w1', reached: true });
    expect(again.status).toBe(200);
    expect(await vpm()).toEqual(after);
  });

  test('a late NOT-REACHED verdict moves VPM beta exactly once', async () => {
    await walk('w2');
    await reach({ execution_id: 'w2', reached: false });
    const after = await vpm();
    expect(after[0]).toBe(1);
    expect(after[1]).toBeGreaterThan(1);
    await reach({ execution_id: 'w2', reached: false });
    expect(await vpm()).toEqual(after);
  });

  test('a matching activity_id is accepted (bare or record form)', async () => {
    await walk('w3');
    const r = await reach({ execution_id: 'w3', reached: true, activity_id: 'activity:W' });
    expect([r.status, r.json.success]).toEqual([200, true]);
    expect((await vpm())[0]).toBeGreaterThan(1);
  });

  test('an activity_id that does not match the execution is REFUSED: no credit, no verdict written', async () => {
    await walk('w4');
    const r = await reach({ execution_id: 'w4', reached: true, activity_id: 'SOMETHING-ELSE' });
    expect([r.status, r.json.success, r.json.updated]).toEqual([409, false, 0]);
    expect(await vpm()).toEqual([1, 1]);
    expect(await tags('w4')).toEqual(['dispatcher_used:goal-host']);
  });
});
