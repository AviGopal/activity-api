/**
 * execution_completed CARRIES THE JUDGE'S REACH VERDICT, AND ONLY THAT (REALIGNMENT §2.2: credit only on a graded verdict).
 *
 * activity-api broadcast execution_completed with `success` (the template exited cleanly) and no reach verdict, so a
 * consumer that credits from the outcome (concept-db's execution observer credits the concepts a walk recalled) had
 * only the exit status, and a hollow completion (status completed, judge reached:false) read as a success.
 *
 * THE RULE PINNED HERE:
 *   - The event's `reached` is goal-host's JUDGE verdict as activity-api receives it: with the trace (the body's
 *     `reached`, or a reached:* tag), or on POST /reach. Never `success`, `status` or the failure mode.
 *   - A goal-host walk arrives BEFORE its verdict: its arrival event has NO `reached` (ungraded, not false). When POST
 *     /reach persists that execution's first verdict, execution_completed is emitted again carrying it, with
 *     verdict:true. A redelivered verdict, a later correction and an observe verdict emit nothing more; a withheld
 *     verdict (beta_withheld) is never put on the event.
 *   [MUST-FAIL] status completed + success true + judge reached:false with the trace ⇒ the event carries reached:false.
 *   [MUST-FAIL] a walk graded later: POST /reach reached:false ⇒ a second execution_completed with reached:false and
 *               verdict:true (and reached:true likewise).
 *   [CONTROL]   no judge verdict yet ⇒ `reached` is ABSENT from the arrival event (not false); a reached:true trace
 *               carries reached:true.
 *   [MUST-FAIL] no second graded event for a redelivery, a correction, an observe verdict or a withheld one.
 *
 * Harness: the insert-beta-withheld pattern (spies on the real exports, restored afterAll; no mock.module), with the
 * broadcaster's emit recorded instead of discarded.
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

describe('MUST-FAIL — a hollow completion carries the judge verdict reached:false', () => {
  test('status completed, success true, judge reached:false with the trace ⇒ execution_completed.reached === false', async () => {
    expect(await postTrace(completedBody('exec-hollow', { reached: false }))).toBe(200);
    const ev = completedFor('exec-hollow');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data.success).toBe(true);
    expect(ev[0]!.data.reached).toBe(false);
  });

  test('the verdict as a reached:false tag is read the same way', async () => {
    await postTrace(completedBody('exec-hollow-tag', { tags: ['surface:mcp', 'reached:false'] }));
    expect(completedFor('exec-hollow-tag')[0]!.data.reached).toBe(false);
  });
});

describe('CONTROL — no judge verdict yet is ungraded (absent), and a reach is carried', () => {
  test('a walk awaiting its verdict: the arrival event has no reached field at all', async () => {
    await postTrace(walkBody('walk-ungraded'));
    const ev = completedFor('walk-ungraded');
    expect(ev).toHaveLength(1);
    expect('reached' in ev[0]!.data).toBe(false);
    expect(ev[0]!.data.success).toBe(true);
  });

  test('a failed run with no verdict is also absent: the exit status is never read as reach', async () => {
    await postTrace(completedBody('exec-failed-noverdict', { status: 'failure', success: false, failure_mode: { type: 'execution_error', reason: 'x' } }));
    expect('reached' in completedFor('exec-failed-noverdict')[0]!.data).toBe(false);
  });

  test('a judge reached:true with the trace ⇒ reached:true', async () => {
    await postTrace(completedBody('exec-reached', { reached: true }));
    expect(completedFor('exec-reached')[0]!.data.reached).toBe(true);
  });

  test('a withheld not-reached verdict at insert is not put on the event', async () => {
    await postTrace(completedBody('exec-withheld', { reached: false, beta_withheld: true, beta_withheld_reason: 'r' }));
    expect('reached' in completedFor('exec-withheld')[0]!.data).toBe(false);
  });
});

describe('MUST-FAIL — the verdict that arrives later is emitted on a second execution_completed', () => {
  test('POST /reach reached:false on an ungraded walk ⇒ a graded event with reached:false, verdict:true', async () => {
    await postTrace(walkBody('walk-late-false'));
    expect(await postReach('walk-late-false', { reached: false, reason: 'deterministic:edit-intent-no-landed-edit' })).toBe(200);
    const ev = completedFor('walk-late-false');
    expect(ev).toHaveLength(2);
    expect('reached' in ev[0]!.data).toBe(false);
    expect(ev[1]!.data).toMatchObject({ execution_id: 'walk-late-false', activity_id: 'walk-arm', success: true, reached: false, verdict: true, org_id: ORG });
  });

  test('POST /reach reached:true ⇒ a graded event with reached:true', async () => {
    await postTrace(walkBody('walk-late-true'));
    await postReach('walk-late-true', { reached: true });
    const ev = completedFor('walk-late-true');
    expect(ev.map((e) => e.data.reached)).toEqual([undefined, true]);
  });

  test('a redelivered verdict, and a later correction, emit no further event', async () => {
    await postTrace(walkBody('walk-redeliver'));
    await postReach('walk-redeliver', { reached: false, reason: 'deterministic:x' });
    await postReach('walk-redeliver', { reached: false, reason: 'deterministic:x' });
    await postReach('walk-redeliver', { reached: true });
    expect(completedFor('walk-redeliver').map((e) => e.data.reached)).toEqual([undefined, false]);
  });

  test('an observe verdict, and a withheld one, emit no graded event', async () => {
    await postTrace(walkBody('walk-observe'));
    await postReach('walk-observe', { reached: true, learning_mode: 'observe' });
    expect(completedFor('walk-observe').filter((e) => 'reached' in e.data)).toEqual([]);
    await postTrace(walkBody('walk-withheld'));
    await postReach('walk-withheld', { reached: false, beta_withheld: true, beta_withheld_reason: 'r' });
    expect(completedFor('walk-withheld').filter((e) => 'reached' in e.data)).toEqual([]);
  });

  test('a declined outcome emits no graded event', async () => {
    await postTrace(walkBody('walk-declined'));
    await postReach('walk-declined', { outcome: 'declined', decline: { class: 'needs_information' } });
    expect(completedFor('walk-declined').filter((e) => 'reached' in e.data)).toEqual([]);
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
