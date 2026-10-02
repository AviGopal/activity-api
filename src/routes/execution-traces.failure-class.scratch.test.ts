/**
 * The failure CLASS is stamped by the store, at the two places a failure verdict is written
 * (slice Y, steps Y1b and Y1c) — through the real routes, on a real SurrealDB.
 *
 *  - Y1b, POST /execution-traces: a posted `failure_mode` with no `class` gets `class` and
 *    `step` from failureClassOf (src/lib/failure-class.ts) merged BESIDE `type`, never over it.
 *    `type` drives beta in posterior-update (law 12: change one thing).
 *  - Y1c, POST /execution-traces/reach: a late NOT-reached verdict that carries a `reason`
 *    stamps `metadata.verdict_class` (+ the reason and the goal hash) on the authoritative
 *    `execution` row. It NEVER writes `failure_mode`: a `failure_mode` object with a class and
 *    no `type` would be skipped by trace_failure_pattern_report and default to
 *    verifier_negative in posterior-update.
 *
 * Why scratch-only: the bug class is "a field the route writes does not persist", which no
 * mocked DB can show. The `execution` fields this touches are declared with their live types
 * (migration 157: metadata / failure_mode are `option<object> FLEXIBLE`), so a nested SET on
 * a NONE object is exercised exactly as it runs live.
 *
 * Runs only with SCRATCH_SURREALDB_URL (loopback, never :8000/:18000) and its own database.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'failure_class_stamp_test';
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

let db: typeof import('../db/surreal')['surrealDB'];
let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

async function boot() {
  if (db) return;
  const { config } = await import('../config');
  if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) throw new Error('not the scratch DB — refusing');
  db = (await import('../db/surreal')).surrealDB;
  ET = (await import('./execution-traces')).default as typeof ET;
  if (typeof db.query !== 'function' || typeof ET?.request !== 'function') throw new Error('modules are mocked — run this file on its own');
}

/** `execution` with the live types of every field these routes write. */
async function freshExecutionTable() {
  await db.query('REMOVE TABLE IF EXISTS execution;');
  await db.query(`
    DEFINE TABLE execution SCHEMALESS;
    DEFINE FIELD failure_mode ON execution TYPE option<object> FLEXIBLE;
    DEFINE FIELD metadata ON execution TYPE option<object> FLEXIBLE;
    DEFINE FIELD reached ON execution TYPE option<bool>;
    DEFINE FIELD completion_shapes ON execution TYPE option<array<string>>;
    DEFINE FIELD tags ON execution TYPE option<array<string>>;
  `);
}

async function row(id: string): Promise<Record<string, any> | undefined> {
  const r = await db.query<Record<string, any>>('SELECT * FROM type::thing("execution", $id)', { id });
  return (Array.isArray(r) ? r[0] : undefined) as Record<string, any> | undefined;
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await ET.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json() as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, 150)); // detached side effects settle
  return { status: res.status, json };
}

run('POST /execution-traces', () => {
  beforeAll(boot);
  beforeEach(freshExecutionTable);

  const trace = (id: string, extra: Record<string, unknown>) => ({
    execution_id: id, template_id: 'T', variant_id: 'T', activity_id: 'T', org_id: ORG,
    duration_ms: 5, cost_usd: 0, ...extra,
  });

  test('a failure_mode without class is stamped class and step; type is unchanged', async () => {
    const fm = { type: 'execution_error', reason: 'fetch failed: ECONNREFUSED 127.0.0.1:8230' };
    const r = await post('/', trace('ins1', {
      success: false,
      failure_mode: fm,
      execution_trace: { tasks: [
        { task_id: 'fetch_input', success: true },
        { task_id: 'call_peer', success: false },
      ] },
    }));
    expect(r.status).toBe(200);
    const stored = (await row('ins1'))?.failure_mode;
    expect(stored).toEqual({ ...fm, class: 'transport', step: 'call_peer' });
  });

  test('a task the sink marked skipped is not the failure site; a light-dispatch taskId is read', async () => {
    const fm = { type: 'execution_error', reason: 'returned structuredError: bad input' };
    await post('/', trace('ins6', {
      success: false,
      failure_mode: fm,
      tasks: [
        { taskId: 'gate', success: false, skipped: true },
        { taskId: 'work', success: false },
      ],
    }));
    const stored = (await row('ins6'))?.failure_mode;
    expect(stored).toEqual({ ...fm, class: 'resolver_error', step: 'work' });
  });

  test('a floor row with a HOLLOW reason is judged_hollow, located at the floor', async () => {
    const fm = { type: 'execution_error', reason: 'HOLLOW: the answer restates the goal; the output says the resolver is not registered' };
    await post('/', trace('ins2', { success: false, failure_mode: fm, metadata: { floor: true } }));
    const stored = (await row('ins2'))?.failure_mode;
    expect(stored?.type).toBe('execution_error');
    expect(stored?.class).toBe('judged_hollow');
    expect(stored?.step).toBe('floor');
  });

  test('a deterministic verdict keeps its own token as the class', async () => {
    const fm = { type: 'verifier_negative', reason: 'deterministic:edit-intent-no-landed-edit — no landing evidence' };
    await post('/', trace('ins3', { success: false, failure_mode: fm }));
    const stored = (await row('ins3'))?.failure_mode;
    expect(stored?.type).toBe('verifier_negative');
    expect(stored?.class).toBe('deterministic:edit-intent-no-landed-edit');
  });

  test('MUST-FAIL: a class the sender already set is not overwritten', async () => {
    const fm = { type: 'execution_error', reason: 'fetch failed', class: 'resolver_error', step: 'x' };
    await post('/', trace('ins4', { success: false, failure_mode: fm }));
    expect((await row('ins4'))?.failure_mode).toEqual(fm);
  });

  test('MUST-FAIL: a trace with no failure_mode gets none (a success is never classified)', async () => {
    await post('/', trace('ins5', { success: true }));
    const stored = await row('ins5');
    expect(stored).toBeDefined();
    expect(stored?.failure_mode).toBeUndefined();
  });
});
