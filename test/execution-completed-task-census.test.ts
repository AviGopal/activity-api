/**
 * THE execution_completed TASK CENSUS COUNTS A STORED TASK BY ITS `success` WHEN IT CARRIES NO STATUS.
 *
 * light-dispatch posts its tasks with `success: true|false` and no `status`; normalizePersistedTask stores them that
 * way. Both execution_completed emits (POST / at insert, and POST /reach's graded event built from the stored row)
 * counted `status` only, so every such run read completed=0 failed=0. The ribosome extracts a template only when a
 * reached run has at least one completed task and none failed, so reached runs were never extracted.
 *   [MUST-FAIL] insert of 3 success-only tasks => the insert event carries completed=3, failed=0.
 *   [MUST-FAIL] the same run, graded by POST /reach reached:true => the graded event carries completed=3, failed=0.
 *   [MUST-FAIL] a success:false task (no status) counts as failed, on both emits.
 *   [CONTROL]   status-spelled tasks ('completed'/'success'/'failed'/'failure') count exactly as before.
 *   [CONTROL]   'pending' / 'in_progress' tasks, and tasks with neither field, count as NEITHER.
 *   [CONTROL]   countTaskCensus, the one definition both emits share, on the same cases.
 *
 * Harness: test/reach-recall-credit.test.ts's (recorder database, stubbed broadcaster, network guard).
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';

const STUB_ORIGIN = 'http://127.0.0.1:9';
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= STUB_ORIGIN;
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';
process.env.POSTERIOR_COALESCE ??= '0';
process.env.PRIOR_SEED_ENABLED ??= 'false';
process.env.RELEVANCE_SINK_ENDPOINT ??= STUB_ORIGIN;

// ---- Network guard ----------------------------------------------------------
// The database is a recorder below, so nothing here needs the network. A fetch outside the stub origin, or any
// WebSocket, is recorded and thrown; the test that caused it fails in afterEach and the summary test fails too
// (the route swallows most errors, so a throw alone would be silent).
const forbiddenNet: string[] = [];
const outbound: string[] = [];
function forbidNetwork(what: string): never {
  forbiddenNet.push(what);
  throw new Error(`NETWORK GUARD: ${what}`);
}
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  outbound.push(url);
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* not a URL */ }
  if (origin !== STUB_ORIGIN) forbidNetwork(`fetch ${url}`);
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
(globalThis as any).WebSocket = class GuardedWebSocket {
  constructor(url: unknown) { forbidNetwork(`WebSocket ${String(url)}`); }
};
let forbiddenSeen = 0;
afterEach(() => {
  const fresh = forbiddenNet.slice(forbiddenSeen);
  forbiddenSeen = forbiddenNet.length;
  expect(fresh).toEqual([]);
});

type Row = Record<string, unknown>;
const queries: { sql: string; params: any }[] = [];
const executionRows = new Map<string, Row>();
const executions: Row[] = [];

function pick(row: Row, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Row)[part];
  }
  return cur;
}
function project(row: Row, columnList: string): Row {
  const out: Row = {};
  for (const raw of columnList.split(',')) {
    const col = raw.trim();
    if (!col) continue;
    if (col === '*') { Object.assign(out, row); continue; }
    const m = /^(.+?)\s+AS\s+(\w+)$/i.exec(col);
    const path = (m ? m[1] : col).trim();
    const alias = m ? m[2] : path.split('.').pop()!;
    const v = pick(row, path);
    if (v !== undefined) out[alias] = v;
  }
  return out;
}
function addTag(execId: string, tag: string): void {
  const r = executionRows.get(execId);
  if (r) r.tags = [...new Set([...((r.tags as string[] | undefined) ?? []), tag])];
}
function answer(sql: string, params: any): any {
  queries.push({ sql, params });
  const sel = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+type::thing\(\s*'execution'\s*,\s*\$execution_id\s*\)/i.exec(sql);
  if (sel) {
    const row = executionRows.get(String(params?.execution_id));
    return row ? [project(row, sel[1]!)] : [];
  }
  const marker = /^\s*UPDATE type::thing\('execution', \$execution_id\) SET tags = array::union\(tags \?\? \[\], \[\$marker\]\) WHERE \(tags \?\? \[\]\) CONTAINSNOT \$marker\s*$/.exec(sql);
  if (marker) {
    const r = executionRows.get(String(params?.execution_id));
    if (!r || ((r.tags as string[] | undefined) ?? []).includes(String(params?.marker))) return [[]];
    addTag(String(params?.execution_id), String(params?.marker));
    return [[{ id: `execution:${String(params?.execution_id)}` }]];
  }
  const tagUnion = /^\s*UPDATE type::thing\('execution', \$execution_id\) SET tags = array::union\(tags \?\? \[\], \['([^']+)'\]\)\s*$/.exec(sql);
  if (tagUnion) {
    addTag(String(params?.execution_id), tagUnion[1]!);
    return [[{ id: `execution:${String(params?.execution_id)}` }]];
  }
  if (/^\s*UPDATE type::thing\('execution', \$execution_id\) SET reached = \$reached/.test(sql)) {
    const mr = executionRows.get(String(params?.execution_id));
    if (mr) mr.reached = params?.reached;
    addTag(String(params?.execution_id), params?.reached === true ? 'reached:true' : 'reached:false');
    return [[{ id: `execution:${String(params?.execution_id)}` }]];
  }
  return [];
}

const surrealMod = await import('../src/db/surreal');
const redisMod = await import('../src/db/redis');
const broadcasterMod = await import('../src/websocket/broadcaster');
const paradigmMod = await import('../src/db/paradigm');
const variantCreatorMod = await import('../src/services/variant-creator');
const { logger } = await import('../src/utils/logger');

const spies: Array<{ mockRestore(): void }> = [];
function stub(obj: any, key: string, impl: (...args: any[]) => unknown): void {
  if (obj == null || typeof obj[key] !== 'function') return;
  spies.push(spyOn(obj, key).mockImplementation(impl as never));
}

stub(surrealMod.surrealDB, 'query', async (sql: string, params: any) => answer(sql, params));
stub(surrealMod.surrealDB, 'queryAll', async (sql: string, params: any) => answer(sql, params));
stub(surrealMod.surrealDB, 'getInstance', async () => ({}));
stub(surrealMod.surrealDB, 'connect', async () => { throw new Error('SurrealDB is not available in this test'); });
stub(surrealMod, 'queryWithAuth', async (_token: string, sql: string, params: any) => answer(sql, params));
stub(surrealMod, 'createAuthenticatedClient', async () => ({}));

const redisProto = redisMod.RedisClient?.prototype;
stub(redisProto, 'del', async () => 0);
stub(redisProto, 'get', async () => null);
stub(redisProto, 'set', async () => 'OK');
stub(redisProto, 'sadd', async () => 0);
stub(redisProto, 'smembers', async () => []);
stub(redisProto, 'srem', async () => 0);
stub(redisProto, 'withLock', async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn());
stub(redisProto, 'getClient', () => null);

const events: Array<{ type: string; data: Row }> = [];
stub(broadcasterMod.broadcaster, 'emit', (m: { type: string; data: Row }) => { events.push({ type: m.type, data: m.data ?? {} }); });

stub(paradigmMod, 'insertActivity', async () => null);
// The authoritative execution write: kept as a row so a later POST /reach pre-read sees exactly what insert wrote.
stub(paradigmMod, 'insertExecution', async (e: Row) => {
  executions.push(e);
  executionRows.set(String(e.id), {
    id: `execution:${String(e.id)}`,
    activity_id: e.activity_id,
    variant_id: e.variant_id,
    success: e.success,
    status: e.status,
    tags: Array.isArray(e.tags) ? [...(e.tags as string[])] : [],
    cost_usd: e.cost_usd,
    org_id: e.org_id,
    trace: e.trace,
    metadata: e.metadata,
    failure_mode: e.failure_mode ?? null,
    // The stored verdict column, as the authoritative write stores it (reachedVerdict's output).
    ...(typeof e.reached === 'boolean' ? { reached: e.reached } : {}),
  });
  return null;
});
stub(paradigmMod, 'getActivityScores', async () => ({ data: [], path: 'legacy' as const }));
stub(paradigmMod, 'getShapeConditionedScores', async () => ({ data: [], path: 'legacy' as const }));
stub(paradigmMod, 'queryActivitiesByShapes', async () => ({ data: [], path: 'legacy' as const }));
stub(paradigmMod, 'queryActivitiesByFTS', async () => ({ data: [], path: 'legacy' as const }));
stub(paradigmMod, 'queryActivitiesByDense', async () => ({ data: [], path: 'legacy' as const }));
stub(paradigmMod, 'transformToLegacyTemplate', (t: any) => t);
stub(paradigmMod, 'isDualWriteEnabled', () => false);
stub(paradigmMod, 'getVariantFamily', async () => ({ data: [], path: 'legacy' as const }));
stub(paradigmMod, 'getVariantScores', async () => ({ data: [], path: 'legacy' as const }));
stub(paradigmMod, 'buildVariantTree', async () => null);
stub(paradigmMod, 'normalizeActivityId', (id: string) => id.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''));
stub(paradigmMod, 'updateShapeActivityScores', async () => null);

stub(variantCreatorMod, 'autoCreateVariantIfNeeded', async () => null);
stub(variantCreatorMod, 'checkAndRetireTemplate', async () => false);
stub(variantCreatorMod, 'checkAndRetireByPosterior', async () => false);

// The credit path's own lines: APPLIED / SKIPPED name the arm and both deltas; the WITHHELD lines name the reason.
const infos: Array<{ msg: string; meta: Row }> = [];
// RECORD ONLY, never call through. In one process an earlier file may have left logger.info spied (and unrestored);
// spyOn then hands back THAT mock, so a call-through to the `info` captured here would call this implementation
// again, recursing until the stack overflows and every POST answers 500. Restored in afterAll.
spies.push(spyOn(logger, 'info').mockImplementation(((msg: string, meta?: Row) => {
  infos.push({ msg: String(msg), meta: meta ?? {} });
}) as never));

afterAll(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  globalThis.fetch = originalFetch;
  (globalThis as any).WebSocket = originalWebSocket;
});

const executionTracesRouter = (await import('../src/routes/execution-traces')).default;
const { flushPosteriors } = await import('../src/lib/posterior-aggregator');
const app = new Hono();
// The caller's authenticated org (the session's here, the JWT's in production): the trace POST takes the org from the
// credential, and a body org_id must match it.
app.use('*', async (c, next) => { (c as any).set('session', { session_id: 't', org_id: ORG, project_id: null, api_key: null, latest_job_id: null }); await next(); });
app.route('/v2/activities/execution-traces', executionTracesRouter);

async function settle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    let last = -1;
    let stableSince = Date.now();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const n = queries.length + infos.length;
      if (n !== last) { last = n; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 150) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await flushPosteriors();
  }
}

const ORG = 'organizations:test';
const completedFor = (id: string) => events.filter((e) => e.type === 'execution_completed' && e.data.execution_id === id);

async function postTrace(body: Row): Promise<number> {
  const res = await app.request('/v2/activities/execution-traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await settle();
  return res.status;
}
async function postReach(executionId: string, body: Row): Promise<{ status: number; json: Row }> {
  const res = await app.request('/v2/activities/execution-traces/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: executionId, ...body }) });
  const json = (await res.json()) as Row;
  await settle();
  return { status: res.status, json };
}
async function postReachNoSettle(executionId: string, body: Row): Promise<{ status: number; json: Row }> {
  const res = await app.request('/v2/activities/execution-traces/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: executionId, ...body }) });
  return { status: res.status, json: (await res.json()) as Row };
}
/** A completed run as an executor posts it: exited cleanly, one successful task. */
/** A goal-host walk as inserted: awaiting its verdict (goal-host tag, no reach tag), with the given stored tasks. */
function walkWithTasks(executionId: string, tasks: Row[]): Row {
  return {
    execution_id: executionId, template_id: 'walk-arm', activity_id: 'walk-arm', status: 'completed', success: true,
    org_id: ORG, duration_ms: 12, cost_usd: 0, tags: ['dispatcher_used:goal-host'], output_impulse_shapes: ['shellResult'],
    execution_trace: { tasks },
  };
}
const census = (e: { data: Row } | undefined) => ({ completed: e?.data.completed_task_count, failed: e?.data.failed_task_count });

/** Run one stored-task list through both emits: [insert event, graded /reach event]. */
async function bothEmits(id: string, tasks: Row[]) {
  expect(await postTrace(walkWithTasks(id, tasks))).toBe(200);
  const r = await postReach(id, { reached: true });
  expect(r.status).toBe(200);
  const ev = completedFor(id);
  expect(ev).toHaveLength(2);
  expect('reached' in ev[0]!.data).toBe(false);
  expect(ev[1]!.data).toMatchObject({ reached: true, verdict: true });
  return { insert: census(ev[0]), graded: census(ev[1]), taskCount: [ev[0]!.data.task_count, ev[1]!.data.task_count] };
}

const SUCCESS_ONLY: Row[] = [
  { task_id: 'select_concept', resolver_id: 'r1', resolver_tier: 'deterministic', success: true },
  { task_id: 'extract_concept_id', resolver_id: 'r2', resolver_tier: 'deterministic', success: true },
  { task_id: 'record_usage', resolver_id: 'r3', resolver_tier: 'deterministic', success: true },
];

describe('MUST-FAIL — success-only stored tasks are counted', () => {
  test('3 success-only tasks ⇒ completed=3 failed=0 on the insert event and on the graded /reach event', async () => {
    const got = await bothEmits('census-success-only', SUCCESS_ONLY);
    // The stored row really carries no status: the census reads `success`.
    const stored = (executionRows.get('census-success-only')?.trace as Row | undefined)?.tasks as Row[] | undefined;
    expect(stored).toHaveLength(3);
    for (const t of stored!) { expect('status' in t && t.status !== undefined).toBe(false); expect(t.success).toBe(true); }
    expect(got.taskCount).toEqual([3, 3]);
    expect(got.insert).toEqual({ completed: 3, failed: 0 });
    expect(got.graded).toEqual({ completed: 3, failed: 0 });
  });

  test('a success:false task with no status counts as failed', async () => {
    const got = await bothEmits('census-success-false', [SUCCESS_ONLY[0]!, { task_id: 'b', success: false }]);
    expect(got.insert).toEqual({ completed: 1, failed: 1 });
    expect(got.graded).toEqual({ completed: 1, failed: 1 });
  });
});

describe('CONTROL — status-spelled and non-terminal tasks count as before', () => {
  test("status 'completed'/'success' complete and 'failed'/'failure' fail, exactly as before", async () => {
    const got = await bothEmits('census-status-spelled', [
      { task_id: 'a', status: 'completed' }, { task_id: 'b', status: 'success' },
      { task_id: 'c', status: 'failed' }, { task_id: 'd', status: 'failure' },
    ]);
    expect(got.insert).toEqual({ completed: 2, failed: 2 });
    expect(got.graded).toEqual({ completed: 2, failed: 2 });
  });

  test("'pending' / 'in_progress' tasks and tasks with neither field count as NEITHER", async () => {
    const got = await bothEmits('census-nonterminal', [
      { task_id: 'a', status: 'pending' }, { task_id: 'b', status: 'in_progress' }, { task_id: 'c' },
    ]);
    expect(got.taskCount).toEqual([3, 3]);
    expect(got.insert).toEqual({ completed: 0, failed: 0 });
    expect(got.graded).toEqual({ completed: 0, failed: 0 });
  });
});

describe('CONTROL — countTaskCensus, the one shared definition', () => {
  test('the same cases through the helper', async () => {
    const { countTaskCensus } = await import('../src/routes/execution-traces');
    expect(countTaskCensus(SUCCESS_ONLY)).toEqual({ completed: 3, failed: 0 });
    expect(countTaskCensus([{ success: false }, { success: true }])).toEqual({ completed: 1, failed: 1 });
    expect(countTaskCensus([{ status: 'completed' }, { status: 'success' }, { status: 'failed' }, { status: 'failure' }]))
      .toEqual({ completed: 2, failed: 2 });
    expect(countTaskCensus([{ status: 'pending' }, { status: 'in_progress' }, {}, null])).toEqual({ completed: 0, failed: 0 });
    // An explicit status decides over the boolean: a pending task is not complete because it once reported success.
    expect(countTaskCensus([{ status: 'pending', success: true }])).toEqual({ completed: 0, failed: 0 });
    expect(countTaskCensus(undefined)).toEqual({ completed: 0, failed: 0 });
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
