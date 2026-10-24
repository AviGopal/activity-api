/**
 * execution_completed FORWARDS THE CONCEPTS THE WALK RECALLED (the request's `recalled_concept_ids`), never stored.
 *
 * goal-host's concept recalls name its DISPATCH id, and its verdict names the TRACE id, so concept-db's recall ledger
 * (keyed by the id a recall named) never met the verdict that should credit it. goal-host now sends, on the verdict's
 * request, the ids it recalled for that dispatch; the event carries them on and concept-db credits them from the event.
 *   [MUST-FAIL] POST /reach with recalled_concept_ids on an ungraded walk ⇒ the graded event carries exactly those ids
 *               (strings only, deduplicated, capped at 50).
 *   [MUST-FAIL] a trace that arrives WITH its verdict and the ids ⇒ the arrival event carries them.
 *   [CONTROL]   no ids on the request ⇒ the field is ABSENT from the event (not []); an empty list is absent too.
 *   [CONTROL]   forwarded only: no write carries the field, and the event's `reached` is still the stored column.
 *
 * Harness: execution-traces.completed-reached.test.ts's, verbatim (spies on the real exports, restored afterAll).
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

const surrealMod = await import('../db/surreal');
const redisMod = await import('../db/redis');
const broadcasterMod = await import('../websocket/broadcaster');
const paradigmMod = await import('../db/paradigm');
const variantCreatorMod = await import('../services/variant-creator');
const { logger } = await import('../utils/logger');

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

const executionTracesRouter = (await import('./execution-traces')).default;
const { flushPosteriors } = await import('../lib/posterior-aggregator');
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
async function postReach(executionId: string, body: Row): Promise<number> {
  const res = await app.request('/v2/activities/execution-traces/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: executionId, ...body }) });
  await settle();
  return res.status;
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
const writes = () => queries.filter((q) => /^\s*(UPDATE|INSERT|UPSERT|CREATE)\b/i.test(q.sql));
const mentionsField = (x: unknown) => JSON.stringify(x ?? null).includes('recalled_concept_ids');

describe('MUST-FAIL — the graded /reach event carries the recalled concept ids', () => {
  test('POST /reach with ids on an ungraded walk ⇒ the second event carries exactly those ids', async () => {
    await postTrace(walkBody('walk-recalled'));
    expect(await postReach('walk-recalled', { reached: true, recalled_concept_ids: IDS })).toBe(200);
    const ev = completedFor('walk-recalled');
    expect(ev).toHaveLength(2);
    expect('recalled_concept_ids' in ev[0]!.data).toBe(false);
    expect(ev[1]!.data).toMatchObject({ execution_id: 'walk-recalled', reached: true, verdict: true });
    expect(ev[1]!.data.recalled_concept_ids).toEqual(IDS);
  });

  test('a not-reached verdict carries them too (the consumer charges them)', async () => {
    await postTrace(walkBody('walk-recalled-false'));
    await postReach('walk-recalled-false', { reached: false, reason: 'deterministic:x', recalled_concept_ids: IDS });
    const ev = completedFor('walk-recalled-false');
    expect(ev[1]!.data.reached).toBe(false);
    expect(ev[1]!.data.recalled_concept_ids).toEqual(IDS);
  });

  test('strings only, deduplicated, capped at 50', async () => {
    await postTrace(walkBody('walk-recalled-cap'));
    const many = [...Array.from({ length: 60 }, (_, i) => `concept_${i}`), 'concept_0', 7, null, ''];
    await postReach('walk-recalled-cap', { reached: true, recalled_concept_ids: many });
    const got = completedFor('walk-recalled-cap')[1]!.data.recalled_concept_ids as string[];
    expect(got).toEqual(Array.from({ length: 50 }, (_, i) => `concept_${i}`));
  });

  test('a trace that arrives with its verdict and the ids ⇒ the arrival event carries them', async () => {
    await postTrace(completedBody('exec-recalled-insert', { reached: true, recalled_concept_ids: IDS }));
    const ev = completedFor('exec-recalled-insert');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data.reached).toBe(true);
    expect(ev[0]!.data.recalled_concept_ids).toEqual(IDS);
  });
});

describe('CONTROL — no ids on the request ⇒ the field is absent', () => {
  test('POST /reach without recalled_concept_ids ⇒ the graded event has no such field', async () => {
    await postTrace(walkBody('walk-norecall'));
    await postReach('walk-norecall', { reached: true });
    const ev = completedFor('walk-norecall');
    expect(ev).toHaveLength(2);
    expect(ev[1]!.data.verdict).toBe(true);
    expect('recalled_concept_ids' in ev[1]!.data).toBe(false);
  });

  test('an empty list, or a non-array, is absent too', async () => {
    await postTrace(walkBody('walk-emptyrecall'));
    await postReach('walk-emptyrecall', { reached: true, recalled_concept_ids: [] });
    expect('recalled_concept_ids' in completedFor('walk-emptyrecall')[1]!.data).toBe(false);
    await postTrace(walkBody('walk-badrecall'));
    await postReach('walk-badrecall', { reached: true, recalled_concept_ids: 'concept_x' });
    expect('recalled_concept_ids' in completedFor('walk-badrecall')[1]!.data).toBe(false);
  });

  test('a redelivered verdict with ids emits nothing more (the first-verdict rule is unchanged)', async () => {
    await postTrace(walkBody('walk-recall-redeliver'));
    await postReach('walk-recall-redeliver', { reached: true });
    await postReach('walk-recall-redeliver', { reached: true, recalled_concept_ids: IDS });
    const ev = completedFor('walk-recall-redeliver');
    expect(ev).toHaveLength(2);
    expect('recalled_concept_ids' in ev[1]!.data).toBe(false);
  });
});

describe('CONTROL — forwarded only, never stored', () => {
  test('no write carries the field, the stored row has none, and reached is the stored column', async () => {
    await postTrace(completedBody('exec-recall-nostore', { reached: true, recalled_concept_ids: IDS }));
    await postTrace(walkBody('walk-recall-nostore'));
    await postReach('walk-recall-nostore', { reached: true, recalled_concept_ids: IDS });
    expect(writes().length).toBeGreaterThan(0);
    for (const w of writes()) expect(mentionsField(w.sql) || mentionsField(w.params)).toBe(false);
    for (const id of ['exec-recall-nostore', 'walk-recall-nostore']) {
      expect(mentionsField(executionRows.get(id))).toBe(false);
      expect(mentionsField(executions.find((e) => e.id === id))).toBe(false);
    }
    const ev = completedFor('walk-recall-nostore');
    expect(ev[1]!.data.reached).toBe(executionRows.get('walk-recall-nostore')?.reached);
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
