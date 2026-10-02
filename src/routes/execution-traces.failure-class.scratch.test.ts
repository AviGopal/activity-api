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
    -- Test device, not a live field: recomputed on EVERY write, so "no write happened" is
    -- observable (the live table has no updated_at; a same-value SET would be invisible).
    DEFINE FIELD touched_at ON execution VALUE time::now();
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

  test('a re-post of the same execution id is a duplicate: the stamped class is neither re-derived nor superseded', async () => {
    const fm = { type: 'execution_error', reason: 'fetch failed' };
    await post('/', trace('ins7', { success: false, failure_mode: fm }));
    const first = await row('ins7');
    const again = await post('/', trace('ins7', { success: true }));
    expect(again.json.duplicate).toBe(true);
    const after = await row('ins7');
    expect(after).toEqual(first);
    expect(String(after?.touched_at)).toBe(String(first?.touched_at)); // not re-written at all
  });

  test('MUST-FAIL: a trace with no failure_mode gets none (a success is never classified)', async () => {
    await post('/', trace('ins5', { success: true }));
    const stored = await row('ins5');
    expect(stored).toBeDefined();
    expect(stored?.failure_mode).toBeUndefined();
  });
});

run('POST /execution-traces/reach', () => {
  beforeAll(boot);
  beforeEach(freshExecutionTable);

  const walk = (id: string, extra: Record<string, unknown> = {}) => db.query('CREATE type::thing("execution", $id) CONTENT $r', { id, r: {
    activity_id: 'W', org_id: ORG, success: true, tags: ['dispatcher_used:goal-host'], executed_at: new Date(), ...extra,
  } });
  const REASON = 'deterministic:edit-intent-no-landed-edit — an edit goal is reached only by an edit-result shape WITH landing evidence';

  test('a not-reached verdict with a deterministic reason stamps metadata.verdict_class and leaves failure_mode untouched', async () => {
    // One row with no failure_mode / metadata at all (the common walk row), one with both.
    await walk('r1');
    const fm = { type: 'execution_error', reason: 'walk terminated', class: 'unclassified', step: 'walk' };
    await walk('r2', { failure_mode: fm, metadata: { floor: false, keep: 'me' } });

    const a = await post('/reach', { execution_id: 'r1', reached: false, reason: REASON, goal_hash: 'gh-abc123' });
    const b = await post('/reach', { execution_id: 'r2', reached: false, reason: REASON, goal_hash: 'gh-abc123' });
    expect([a.status, a.json.updated, b.status, b.json.updated]).toEqual([200, 1, 200, 1]);

    const r1 = await row('r1');
    expect(r1?.metadata?.verdict_class).toBe('deterministic:edit-intent-no-landed-edit');
    expect(r1?.metadata?.reach_reason).toBe(REASON);
    expect(r1?.metadata?.goal_hash).toBe('gh-abc123');
    expect(r1?.failure_mode).toBeUndefined(); // never a type-less failure_mode
    expect(r1?.reached).toBe(false);

    const r2 = await row('r2');
    expect(r2?.metadata).toEqual({ floor: false, keep: 'me', verdict_class: 'deterministic:edit-intent-no-landed-edit', reach_reason: REASON, goal_hash: 'gh-abc123' });
    expect(r2?.failure_mode).toEqual(fm);
  });

  test('a structural reason is classified too (the generator, not the store, scopes to deterministic:*)', async () => {
    await walk('r3');
    await post('/reach', { execution_id: 'r3', reached: false, reason: "no template produces the inferred target shapes" });
    const r3 = await row('r3');
    expect(r3?.metadata?.verdict_class).toBe('structural:no-producer');
    expect(r3?.metadata?.goal_hash).toBeUndefined(); // absent is absent, never fabricated
  });

  test('reached:true stamps no verdict_class', async () => {
    await walk('r4');
    const r = await post('/reach', { execution_id: 'r4', reached: true, reason: REASON, goal_hash: 'gh-abc123' });
    expect([r.status, r.json.updated]).toEqual([200, 1]);
    const r4 = await row('r4');
    expect(r4?.reached).toBe(true);
    expect(r4?.metadata).toBeUndefined();
    expect(r4?.failure_mode).toBeUndefined();
  });

  test('a not-reached verdict with no reason stamps nothing (an old sender is not "unreasoned")', async () => {
    await walk('r5');
    await post('/reach', { execution_id: 'r5', reached: false });
    const r5 = await row('r5');
    expect(r5?.reached).toBe(false);
    expect(r5?.metadata).toBeUndefined();
  });

  test('an overlong reason is stored capped, and still classified from its head', async () => {
    await walk('r6');
    await post('/reach', { execution_id: 'r6', reached: false, reason: REASON + ' ' + 'x'.repeat(5000) });
    const r6 = await row('r6');
    expect(r6?.metadata?.verdict_class).toBe('deterministic:edit-intent-no-landed-edit');
    expect(String(r6?.metadata?.reach_reason).length).toBeLessThanOrEqual(600);
  });

  // REALIGNMENT §2.2: a correction names what it supersedes; ingestion is idempotent.
  test('not-reached then reached: the class is cleared and recorded as superseded by reach:true', async () => {
    await walk('s1', { metadata: { keep: 1 } });
    await post('/reach', { execution_id: 's1', reached: false, reason: REASON, goal_hash: 'gh-s1' });
    await post('/reach', { execution_id: 's1', reached: true });
    const m = (await row('s1'))?.metadata;
    expect(m?.verdict_class).toBeUndefined();
    expect(m?.reach_reason).toBeUndefined();
    expect(m?.keep).toBe(1);
    expect(m?.goal_hash).toBe('gh-s1');
    expect(m?.superseded_verdicts).toHaveLength(1);
    expect(m?.superseded_verdicts[0]).toMatchObject({ class: 'deterministic:edit-intent-no-landed-edit', reason: REASON, superseded_by: 'reach:true' });
    expect(m?.superseded_verdicts[0]?.superseded_at).toBeDefined();
  });

  test('the same not-reached verdict twice is one stamp: the second delivery is NOT written at all', async () => {
    await walk('s2');
    await post('/reach', { execution_id: 's2', reached: false, reason: REASON, goal_hash: 'gh-s2' });
    const first = await row('s2');
    const again = await post('/reach', { execution_id: 's2', reached: false, reason: REASON, goal_hash: 'gh-s2' });
    const second = await row('s2');
    // No write touched the row; it is still reported persisted (it is), marked idempotent.
    // touched_at is a driver DateTime object; toEqual sees no enumerable fields on it and
    // calls any two equal, so compare its ISO string.
    expect(first?.touched_at).toBeDefined();
    expect(String(second?.touched_at)).toBe(String(first?.touched_at));
    expect([again.status, again.json.updated, again.json.idempotent]).toEqual([200, 1, true]);
    expect(second).toEqual(first);
    expect(second?.metadata?.superseded_verdicts).toBeUndefined();
  });

  test('A, then B, then reached: both prior verdicts are kept, in order', async () => {
    await walk('s5');
    const RB = 'deterministic:wrong-git-commit-count — 3 commits, expected 1';
    await post('/reach', { execution_id: 's5', reached: false, reason: REASON });
    await post('/reach', { execution_id: 's5', reached: false, reason: RB });
    await post('/reach', { execution_id: 's5', reached: true });
    const m = (await row('s5'))?.metadata;
    expect(m?.verdict_class).toBeUndefined();
    expect((m?.superseded_verdicts ?? []).map((v: any) => [v.class, v.reason, v.superseded_by])).toEqual([
      ['deterministic:edit-intent-no-landed-edit', REASON, 'reach:false'],
      ['deterministic:wrong-git-commit-count', RB, 'reach:true'],
    ]);
  });

  test('the supersession history is bounded to the last 10 entries', async () => {
    await walk('s6');
    for (let i = 0; i < 12; i++) await post('/reach', { execution_id: 's6', reached: false, reason: `deterministic:class-${i} — attempt ${i}` });
    const m = (await row('s6'))?.metadata;
    expect(m?.verdict_class).toBe('deterministic:class-11');
    expect(m?.superseded_verdicts).toHaveLength(10);
    expect(m?.superseded_verdicts[0]?.class).toBe('deterministic:class-1');
    expect(m?.superseded_verdicts[9]?.class).toBe('deterministic:class-10');
  });

  test('two different not-reached reasons: the second wins, the first is recorded as superseded', async () => {
    await walk('s3');
    const R2 = 'deterministic:wrong-git-commit-count — 3 commits, expected 1';
    await post('/reach', { execution_id: 's3', reached: false, reason: REASON });
    await post('/reach', { execution_id: 's3', reached: false, reason: R2 });
    const m = (await row('s3'))?.metadata;
    expect(m?.verdict_class).toBe('deterministic:wrong-git-commit-count');
    expect(m?.reach_reason).toBe(R2);
    expect(m?.superseded_verdicts).toHaveLength(1);
    expect(m?.superseded_verdicts[0]).toMatchObject({ class: 'deterministic:edit-intent-no-landed-edit', reason: REASON, superseded_by: 'reach:false' });
  });

  test('reached:true on an unstamped row leaves its metadata untouched', async () => {
    await walk('s4', { metadata: { keep: 'me' } });
    await post('/reach', { execution_id: 's4', reached: true });
    expect((await row('s4'))?.metadata).toEqual({ keep: 'me' });
  });
});
