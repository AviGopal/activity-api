/**
 * NO context_thompson_scores alpha/beta WITHOUT A GRADED VERDICT (D8a).
 *
 * The trace insert writes two kinds of cts row: the leaf signature row (applyOutcomeToPosteriors, reach-gated) and the
 * repair-v2 row (signature_version 2, keyed by the caller's metadata.prior_repair_signature). The repair-v2 delta was
 * computed from EXIT STATUS (`status === 'completed' || success`), not from a verdict, so every clean exit of a repair
 * attempt credited alpha on a row the repair boost reads, whether or not the attempt reached; and its UPSERT creates
 * the row, so the first write for any context would start it on exit-status alpha.
 *
 * THE RULE PINNED HERE (rows SEEDED, so a write is visible, not lost to a missing row):
 *   - MUST-FAIL: an ungraded clean exit (no reach tag) changes no cts alpha/beta, repair-v2 or leaf.
 *   - MUST-FAIL: a clean exit judged reached:false charges the repair row beta, not alpha.
 *   - CONTROL: reached:true credits the repair row alpha once and the leaf row alpha; an untagged failure (not-reached)
 *     charges the repair row beta once.
 *
 * Harness: the insert-beta-withheld pattern (spies on the real exports, restored afterAll; no mock.module), with
 * POSTERIOR_COALESCE=0 so each cts delta is applied as its own UPSERT, read back from a recorded cts table.
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
// context_thompson_scores, as rows keyed (template | signature_version | bucket): every UPSERT the cts lane sends
// applies its per-key deltas (${p}_da / ${p}_db) to the row, so a seeded row shows exactly what a write did to it.
const cts = new Map<string, { alpha: number; beta: number }>();
const ctsKey = (tpl: string, ver: number, bucket: string) => `${tpl}|${ver}|${bucket}`;
function applyCts(sql: string, params: any): void {
  if (!/context_thompson_scores/.test(sql) || !/UPSERT/.test(sql) || !params) return;
  for (const k of Object.keys(params)) {
    const m = /^(k\d+)_da$/.exec(k);
    if (!m) continue;
    const p = m[1];
    const key = ctsKey(String(params[`${p}_tpl`]), Number(params[`${p}_ver`]), String(params[`${p}_bucket`]));
    const row = cts.get(key) ?? { alpha: Number(params[`${p}_a0`] ?? 1), beta: Number(params[`${p}_b0`] ?? 1) };
    row.alpha += Number(params[`${p}_da`] ?? 0);
    row.beta += Number(params[`${p}_db`] ?? 0);
    cts.set(key, row);
  }
}
function answer(sql: string, params: any): any {
  queries.push({ sql, params });
  applyCts(sql, params);
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
{
  const orig = logger.info.bind(logger);
  spies.push(spyOn(logger, 'info').mockImplementation(((msg: string, meta?: Row) => {
    infos.push({ msg: String(msg), meta: meta ?? {} });
    return orig(msg, meta as never);
  }) as never));
}

afterAll(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  globalThis.fetch = originalFetch;
  (globalThis as any).WebSocket = originalWebSocket;
});

const executionTracesRouter = (await import('./execution-traces')).default;
const { flushPosteriors } = await import('../lib/posterior-aggregator');
const app = new Hono();
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
const ARM = 'fixture-vessel:repair-attempt-arm';
const REPAIR_SIG = 'a1b2c3d4e5f60718';
const LEAF_SIG = '0f1e2d3c4b5a6978';

function body(executionId: string, extra: Row = {}): Row {
  return {
    execution_id: executionId,
    template_id: ARM,
    activity_id: ARM,
    status: 'completed',
    success: true,
    org_id: ORG,
    duration_ms: 12,
    cost_usd: 0,
    tags: [],
    output_impulse_shapes: ['substrateObservable'],
    execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: true }] },
    metadata: { prior_repair_signature: REPAIR_SIG, state_space_signature: LEAF_SIG, signature_version: 1 },
    ...extra,
  };
}
function seed(): void {
  cts.clear();
  cts.set(ctsKey(ARM, 2, REPAIR_SIG), { alpha: 3, beta: 2 });
  cts.set(ctsKey(ARM, 1, LEAF_SIG), { alpha: 5, beta: 4 });
}
const repairRow = () => cts.get(ctsKey(ARM, 2, REPAIR_SIG))!;
const leafRow = () => cts.get(ctsKey(ARM, 1, LEAF_SIG))!;

describe('MUST-FAIL — an ungraded execution changes no context_thompson_scores alpha/beta', () => {
  test('a clean exit with no reach verdict: the seeded repair-v2 and leaf rows are unchanged', async () => {
    seed();
    const r = await postTrace(body('exec-cts-ungraded-1'));
    expect(r.status).toBe(200);
    expect(repairRow()).toEqual({ alpha: 3, beta: 2 });
    expect(leafRow()).toEqual({ alpha: 5, beta: 4 });
  });

  test('a clean exit judged reached:false charges the repair row beta, not alpha', async () => {
    seed();
    const r = await postTrace(body('exec-cts-notreached-1', { tags: ['reached:false'] }));
    expect(r.status).toBe(200);
    expect(repairRow()).toEqual({ alpha: 3, beta: 3 });
  });
});

describe('CONTROLS — a graded verdict still moves the cts rows, once', () => {
  test('reached:true credits the repair row alpha once and the leaf row alpha', async () => {
    seed();
    const r = await postTrace(body('exec-cts-reached-1', { tags: ['reached:true'] }));
    expect(r.status).toBe(200);
    expect(repairRow()).toEqual({ alpha: 4, beta: 2 });
    expect(leafRow().alpha).toBeGreaterThan(5);
  });

  test('an untagged failure (not-reached) charges the repair row beta once', async () => {
    seed();
    const r = await postTrace(body('exec-cts-failed-1', {
      status: 'failure', success: false,
      execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: false }] },
      failure_mode: { type: 'execution_error', reason: 'resolver threw' },
    }));
    expect(r.status).toBe(200);
    expect(repairRow()).toEqual({ alpha: 3, beta: 3 });
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
