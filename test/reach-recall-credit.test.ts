/**
 * A VERDICT GRADED AT INSERT STILL CREDITS THE CONCEPTS THE WALK RECALLED, ONCE (POST /reach).
 *
 * goal-host stamps a reached walk reached:true at insert, so POST / emits its graded execution_completed then, with no
 * recalled ids (the trace body carries none), and the later POST /reach, the only request that carries the ids, is not
 * the execution's first verdict, so it emitted nothing: reached walks credited no recalled concept, only failures did.
 *   [MUST-FAIL] insert graded (reached:true), then /reach with ids [a,b] and reached true => ONE more execution_completed
 *               carrying exactly [a,b], reached true, verdict true, and the trace's own org_id.
 *   [MUST-FAIL] the recall_credited:true marker is stamped on the row.
 *   [ONCE]      a second identical /reach emits nothing; two CONCURRENT /reach calls emit exactly one; a first
 *               verdict that carried the ids stamps the marker, so its retry credits nothing more.
 *   [CONTROL]   an ungraded insert then /reach with ids => exactly one graded event, the same shape as before.
 *   [CONTROL]   a graded-at-insert /reach without ids => nothing emitted; the response body is unchanged.
 *   [CONTROL]   a verdict first graded by an earlier /reach (not at insert), redelivered with ids => nothing more.
 *
 * Harness: src/routes/execution-traces.recalled-concepts.test.ts's, plus the marker's conditional UPDATE.
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
function completedBody(executionId: string, extra: Row = {}): Row {
  return {
    execution_id: executionId, template_id: 'walk-arm', activity_id: 'walk-arm', status: 'completed', success: true,
    org_id: ORG, duration_ms: 12, cost_usd: 0, tags: ['surface:mcp'], output_impulse_shapes: ['shellResult'],
    execution_trace: { tasks: [{ id: 't1', resolver: 'vessel', success: true }] },
    ...extra,
  };
}
/** A goal-host walk as inserted: awaiting its verdict (goal-host tag, top level, no reach tag). */
const walkBody = (id: string, extra: Row = {}) => completedBody(id, { tags: ['dispatcher_used:goal-host'], ...extra });

beforeEach(() => { queries.length = 0; executions.length = 0; });

const IDS = ['concept:concept_alpha', 'concept_beta'];
const MARKER = 'recall_credited:true';
/** A reached walk as goal-host inserts it: graded at insert by its reached:true tag. */
const gradedWalk = (id: string) => walkBody(id, { tags: ['dispatcher_used:goal-host', 'reached:true'] });
const tagsOf = (id: string) => ((executionRows.get(id)?.tags as string[] | undefined) ?? []);
const SHAPE_KEYS = ['execution_id', 'activity_id', 'variant_id', 'success', 'task_count', 'completed_task_count', 'failed_task_count',
  'duration_ms', 'cost', 'completed_at', 'org_id', 'reached', 'verdict', 'recalled_concept_ids'].sort();

describe('MUST-FAIL — a verdict graded at insert credits the recalled concepts on /reach', () => {
  test('insert reached:true, then /reach with ids ⇒ ONE more graded event carrying exactly those ids and the trace org', async () => {
    await postTrace(gradedWalk('ins-graded-recall'));
    expect(tagsOf('ins-graded-recall')).toContain('insert_graded:true');
    const before = completedFor('ins-graded-recall');
    expect(before).toHaveLength(1);
    expect(before[0]!.data.reached).toBe(true);
    expect('recalled_concept_ids' in before[0]!.data).toBe(false);
    const r = await postReach('ins-graded-recall', { reached: true, recalled_concept_ids: IDS });
    expect(r.status).toBe(200);
    const added = completedFor('ins-graded-recall').slice(1);
    expect(added).toHaveLength(1);
    expect(added[0]!.data).toMatchObject({ execution_id: 'ins-graded-recall', reached: true, verdict: true, org_id: ORG });
    expect(added[0]!.data.org_id).toBe(executionRows.get('ins-graded-recall')?.org_id);
    expect(added[0]!.data.recalled_concept_ids).toEqual(IDS);
    expect(Object.keys(added[0]!.data).sort()).toEqual(SHAPE_KEYS);
  });

  test('the recall_credited:true marker is stamped on the row', async () => {
    await postTrace(gradedWalk('ins-graded-marker'));
    expect(tagsOf('ins-graded-marker')).not.toContain(MARKER);
    await postReach('ins-graded-marker', { reached: true, recalled_concept_ids: IDS });
    expect(tagsOf('ins-graded-marker')).toContain(MARKER);
  });
});

describe('ONCE — a retried or concurrent /reach never credits again', () => {
  test('a second identical /reach emits nothing', async () => {
    await postTrace(gradedWalk('ins-graded-twice'));
    await postReach('ins-graded-twice', { reached: true, recalled_concept_ids: IDS });
    const n = completedFor('ins-graded-twice').length;
    expect(n).toBe(2);
    const r2 = await postReach('ins-graded-twice', { reached: true, recalled_concept_ids: IDS });
    expect(r2.status).toBe(200);
    expect(completedFor('ins-graded-twice')).toHaveLength(n);
  });

  test('two concurrent /reach calls with ids emit exactly one recall event', async () => {
    await postTrace(gradedWalk('ins-graded-concurrent'));
    const rs = await Promise.all([
      postReachNoSettle('ins-graded-concurrent', { reached: true, recalled_concept_ids: IDS }),
      postReachNoSettle('ins-graded-concurrent', { reached: true, recalled_concept_ids: IDS }),
    ]);
    await settle();
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    const withIds = completedFor('ins-graded-concurrent').filter((e) => 'recalled_concept_ids' in e.data);
    expect(withIds).toHaveLength(1);
    expect(completedFor('ins-graded-concurrent')).toHaveLength(2);
  });
});

describe('ONCE — a first verdict that carried the ids spends the credit', () => {
  // A failed run with no verdict tag is graded at insert (the ungraded-failure arm blames it: insert_graded:true) while
  // its arrival event carries no `reached`, so its first /reach is a first verdict that emits the ids.
  test('insert graded without a verdict tag, first /reach with ids, then a retry ⇒ exactly one event with ids', async () => {
    await postTrace(completedBody('ins-graded-notag', { status: 'failed', success: false, execution_trace: { tasks: [{ id: 't1', resolver: 'vessel', success: false }] } }));
    expect(tagsOf('ins-graded-notag')).toContain('insert_graded:true');
    expect('reached' in completedFor('ins-graded-notag')[0]!.data).toBe(false);
    await postReach('ins-graded-notag', { reached: false, reason: 'deterministic:x', recalled_concept_ids: IDS });
    expect(tagsOf('ins-graded-notag')).toContain(MARKER);
    await postReach('ins-graded-notag', { reached: false, reason: 'deterministic:y', recalled_concept_ids: IDS });
    const withIds = completedFor('ins-graded-notag').filter((e) => 'recalled_concept_ids' in e.data);
    expect(withIds).toHaveLength(1);
    expect(withIds[0]!.data).toMatchObject({ reached: false, verdict: true, org_id: ORG });
  });
});

describe('CONTROL — every other /reach behaviour is unchanged', () => {
  test('an ungraded insert then /reach with ids ⇒ exactly one graded event, the same shape', async () => {
    await postTrace(walkBody('ungraded-recall'));
    await postReach('ungraded-recall', { reached: true, recalled_concept_ids: IDS });
    const ev = completedFor('ungraded-recall');
    expect(ev).toHaveLength(2);
    expect('reached' in ev[0]!.data).toBe(false);
    expect(ev[1]!.data).toMatchObject({ execution_id: 'ungraded-recall', reached: true, verdict: true, org_id: ORG });
    expect(ev[1]!.data.recalled_concept_ids).toEqual(IDS);
    expect(Object.keys(ev[1]!.data).sort()).toEqual(SHAPE_KEYS);
  });

  test('a graded-at-insert /reach WITHOUT ids emits nothing and stamps no marker', async () => {
    await postTrace(gradedWalk('ins-graded-noids'));
    await postReach('ins-graded-noids', { reached: true });
    await postReach('ins-graded-noids', { reached: true, recalled_concept_ids: [] });
    expect(completedFor('ins-graded-noids')).toHaveLength(1);
    expect(tagsOf('ins-graded-noids')).not.toContain(MARKER);
  });

  test('the response body is unchanged: with ids, without ids, and on the retry', async () => {
    await postTrace(gradedWalk('ins-graded-body-a'));
    await postTrace(gradedWalk('ins-graded-body-b'));
    const a = await postReach('ins-graded-body-a', { reached: true, recalled_concept_ids: IDS });
    const b = await postReach('ins-graded-body-b', { reached: true });
    const a2 = await postReach('ins-graded-body-a', { reached: true, recalled_concept_ids: IDS });
    expect(a.json).toEqual({ success: true, execution_id: 'ins-graded-body-a', reached: true, updated: 1 });
    expect(b.json).toEqual({ success: true, execution_id: 'ins-graded-body-b', reached: true, updated: 1 });
    expect(a2.json).toEqual({ success: true, execution_id: 'ins-graded-body-a', reached: true, updated: 1 });
  });

  test('a verdict first graded by an earlier /reach, redelivered with ids ⇒ nothing more', async () => {
    await postTrace(walkBody('reach-graded-redeliver'));
    await postReach('reach-graded-redeliver', { reached: true });
    await postReach('reach-graded-redeliver', { reached: true, recalled_concept_ids: IDS });
    expect(completedFor('reach-graded-redeliver')).toHaveLength(2);
    expect(tagsOf('reach-graded-redeliver')).not.toContain(MARKER);
  });

  test('an observe verdict on a graded-at-insert row emits nothing', async () => {
    await postTrace(gradedWalk('ins-graded-observe'));
    await postReach('ins-graded-observe', { reached: true, learning_mode: 'observe', recalled_concept_ids: IDS });
    expect(completedFor('ins-graded-observe')).toHaveLength(1);
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
