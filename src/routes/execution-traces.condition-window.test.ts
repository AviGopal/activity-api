/**
 * A TRACE IS JUDGED BY THE CONDITION WINDOW OF ITS OWN TIME, through the route
 * (traces-recorded-during-a-hub-outage-replay-later-as-arm-blame-because-the-learner-cannot-see-the-outage).
 *
 * During a hub outage a spoke's traces spool and replay when the hub returns, and a late POST /reach grades a row
 * long after it ran. Before: the learner had no outage record, and judged everything at arrival.
 *
 *   MUST-FAIL: a failed trace whose stated completed_at is inside a past confirmed externalCondition window, POSTed
 *     after the window closed, writes no beta; so does one stating started_at + duration_ms; a late POST /reach
 *     reached:false on a row whose stored executed_at is inside the window writes no beta.
 *   CONTROL: the same trace with no stated time (judged at arrival, outside the window) charges beta once; a late
 *     verdict on a row executed outside the window charges beta once.
 *
 * Harness: execution-traces.infra-failure-ungraded.test.ts's (spies on the real exports, restored afterAll), with this
 * node's development-vessel pool stood in for by the fetch guard. Fixture node / arm names are placeholders.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';

const STUB_ORIGIN = 'http://127.0.0.1:9';
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= STUB_ORIGIN;
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';
// POSTERIOR_COALESCE is deliberately NOT set: posterior-aggregator fixes its mode at its first import, so a file that
// sets it to '0' and happens to import the aggregator first turns coalescing off for every later file in the process
// (context-lane-concurrency.real.test.ts then fails). These tests read ENQUEUED and APPLIED lines alike and settle()
// flushes, so they hold in either mode.
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
// This node's development-vessel pool (the externalCondition list read and the by-id re-read).
const POOL_URL = 'http://127.0.0.1:8090/v2/impulses/resolve';
let pool: Array<Record<string, any>> = [];
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  outbound.push(url);
  if (url === POOL_URL) {
    const p = JSON.parse(String(init?.body ?? '{}'))?.impulse ?? {};
    const impulses = typeof p.id === 'string' ? pool.filter((r) => r.id === p.id) : pool.filter((r) => r.shape === p.shape && r.status === 'open');
    return Response.json({ shape: 'poolImpulse', body: { impulses, count: impulses.length } });
  }
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
// Arms whose learning-block template read throws (the first statement of the insert's learning block).
const throwOnLearningRead = new Set<string>();
function answer(sql: string, params: any): any {
  queries.push({ sql, params });
  if (/SELECT output_shapes FROM activity_template/.test(sql) && /OR name = \$activity_id/.test(sql) && throwOnLearningRead.has(String(params?.activity_id))) {
    throw new Error('learning-block read failed (test)');
  }
  const untag = /^\s*UPDATE type::thing\('execution', \$execution_id\) SET tags = array::complement\(tags \?\? \[\], \[\$marker\]\)\s*$/.exec(sql);
  if (untag) {
    const r = executionRows.get(String(params?.execution_id));
    if (r) r.tags = ((r.tags as string[] | undefined) ?? []).filter((t) => t !== params?.marker);
    return [[{ id: `execution:${String(params?.execution_id)}` }]];
  }
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

stub(broadcasterMod.broadcaster, 'emit', () => {});

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
    // The store stamps executed_at at insert (paradigm.ts time::now()); a test re-dates a row to model an old one.
    executed_at: new Date(),
    vessel_id: e.vessel_id,
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
// Retirement evidence: the insert fires checkAndRetireByPosterior only for a graded not-reached run.
const retireChecks: string[] = [];
stub(variantCreatorMod, 'checkAndRetireByPosterior', async (arm: string) => { retireChecks.push(String(arm)); return false; });

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
// credential, and a body org_id must match it (trace-org.ts).
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

type Delta = { alpha: number; beta: number; lines: number };
/**
 * Sum of the α/β deltas the credit path handed to the VPM path for `arm` since `from` (an index into infos). The
 * outcome line is ENQUEUED (coalescing), APPLIED or PARTIAL (synchronous write ran; PARTIAL = signature row not
 * written); each carries the deltas. Matching APPLIED alone would read zero under coalescing or for an unsigned trace.
 */
const HANDED_TO_VPM = new Set(['posterior variant update APPLIED', 'posterior variant update ENQUEUED', 'posterior variant update PARTIAL']);
function appliedTo(arm: string, from: number): Delta {
  const lines = infos.slice(from).filter((i) => HANDED_TO_VPM.has(i.msg) && i.meta.activity_id === arm);
  return {
    alpha: lines.reduce((s, i) => s + Number(i.meta.alpha_delta ?? 0), 0),
    beta: lines.reduce((s, i) => s + Number(i.meta.beta_delta ?? 0), 0),
    lines: lines.length,
  };
}

async function postTrace(body: Row): Promise<{ status: number; from: number }> {
  const from = infos.length;
  const res = await app.request('/v2/activities/execution-traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await settle();
  return { status: res.status, from };
}
async function postReach(executionId: string, body: Row): Promise<{ status: number; from: number }> {
  const from = infos.length;
  const res = await app.request('/v2/activities/execution-traces/reach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ execution_id: executionId, ...body }),
  });
  await settle();
  return { status: res.status, from };
}

beforeEach(() => {
  queries.length = 0;
  executions.length = 0;
});

const ORG = 'organizations:test';

function body(executionId: string, arm: string, extra: Row = {}): Row {
  return {
    execution_id: executionId,
    template_id: arm,
    activity_id: arm,
    status: 'completed',
    success: true,
    org_id: ORG,
    duration_ms: 12,
    cost_usd: 0,
    tags: [],
    output_impulse_shapes: ['substrateObservable'],
    execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: true }] },
    ...extra,
  };
}

function failed(reason: string, extra: Row = {}): Row {
  return {
    status: 'failure', success: false,
    execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: false }] },
    failure_mode: { type: 'execution_error', reason },
    ...extra,
  };
}
const NODE = 'node-a';
const PU = (await import('../lib/posterior-update')) as Record<string, any>;
const EC = (await import('../lib/external-condition').catch(() => ({}))) as Record<string, any>;
const RULE: string = PU.CONDITION_ATTRIBUTION_RULE ?? 'absent';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const PAST = { down: iso(now - 3 * 3600_000), up: iso(now - 2 * 3600_000) };
const INSIDE = now - 2.5 * 3600_000;
const record = (id: string) => ({
  id, shape: 'externalCondition', status: 'open', source: 'operator',
  body: {
    kind: 'hub unreachable', node: NODE, unit: 'ALL', ...PAST, times: 'observed',
    source: { observer: 'research', method: 'journal read' }, evidence: 'file:infra-events.json#events[0]',
    attribution_rule: RULE, confirmed: true,
  },
  attested: { by: 'operator', key_id: 'key_cred1', at: PAST.down, sig: 'x' }, attested_verified: true,
});
const originalNode = process.env.FED_SUBSTRATE_ID;
beforeEach(() => {
  process.env.FED_SUBSTRATE_ID = NODE;
  EC._resetExternalConditionCandidatesForTests?.();
  pool = [record('cond-hub-outage')];
});
afterAll(() => { if (originalNode === undefined) delete process.env.FED_SUBSTRATE_ID; else process.env.FED_SUBSTRATE_ID = originalNode; });

// A failure whose reason no pattern recognises (a spoke resolving models on the hub during its outage).
const OUTAGE_FAILURE = 'no llm_completion producer';

describe('MUST-FAIL — a replayed trace is judged by the window of the time it states', () => {
  test('completed_at inside the past window, POSTed after it closed: no beta', async () => {
    const arm = 'fixture-vessel:replayed-completed-at';
    const ins = await postTrace(body('exec-replay-1', arm, failed(OUTAGE_FAILURE, { completed_at: iso(INSIDE) })));
    expect(ins.status).toBe(200);
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
  });

  test('started_at + duration_ms inside the past window: no beta', async () => {
    const arm = 'fixture-vessel:replayed-started-at';
    const ins = await postTrace(body('exec-replay-2', arm, failed(OUTAGE_FAILURE, { started_at: iso(INSIDE - 12), duration_ms: 12 })));
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
  });

  test('a late POST /reach reached:false on a row executed inside the window: no beta', async () => {
    const arm = 'fixture-vessel:late-verdict-inside';
    const id = 'exec-late-inside-1';
    const ins = await postTrace(body(id, arm, { tags: ['dispatcher_used:goal-host'] }));
    expect(ins.status).toBe(200);
    executionRows.get(id)!.executed_at = new Date(INSIDE);
    const reach = await postReach(id, { reached: false });
    expect(reach.status).toBe(200);
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
  });
});

describe('CONTROL — judged at its own time outside the window, the arm keeps its blame', () => {
  test('the same failure with no stated time is judged at arrival: beta once', async () => {
    const arm = 'fixture-vessel:replayed-no-time';
    const ins = await postTrace(body('exec-replay-3', arm, failed(OUTAGE_FAILURE)));
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 1, lines: 1 });
  });

  test('a late reached:false on a row executed after the window: beta once', async () => {
    const arm = 'fixture-vessel:late-verdict-outside';
    const id = 'exec-late-outside-1';
    const ins = await postTrace(body(id, arm, { tags: ['dispatcher_used:goal-host'] }));
    executionRows.get(id)!.executed_at = new Date(now - 60_000);
    await postReach(id, { reached: false });
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 1, lines: 1 });
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and this node\'s pool, and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
