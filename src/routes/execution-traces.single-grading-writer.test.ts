/**
 * ONE EXECUTION IS GRADED ONCE: the trace insert and the late POST /reach never both credit it (D8a).
 *
 * POST / grades a trace at insert whenever applyOutcomeToPosteriors hands it a verdict: it arrived with its reach tag
 * (reached:true / reached:false), or it failed with no pending verdict (classifyReach's failure arm), or the
 * ungraded-failure arm blames it. POST /reach then graded the SAME execution again: its double-count guard is the
 * reach_graded:true stamp, which only /reach itself writes, so a row the insert graded arrived unstamped and was
 * credited a second time (two writers, one execution: α twice for a reached trace, β twice for a failed one).
 *
 * THE RULE PINNED HERE:
 *   - MUST-FAIL: a trace inserted with reached:true and then patched reached:true credits α exactly ONCE.
 *   - MUST-FAIL: an untagged failed trace (not-reached at insert) then patched reached:false charges β exactly ONCE.
 *   - CONTROL: a goal-host walk awaiting its verdict is graded by /reach alone: reached:true credits α once,
 *     reached:false charges β once, and the insert moves nothing.
 *   - CONTROL: a poster cannot pre-empt the late verdict by sending the insert marker itself.
 *   - MUST-FAIL (D1): a top-level goal-host walk awaiting its verdict with a FAILED task is not blamed at insert and not
 *     stamped; its late reached:true credits α once and β 0. CONTROL: a child run (parent_execution_id set) that
 *     inherits the goal-host tag keeps the ungraded-failure arm's β and is stamped.
 *   - MUST-FAIL (D4): when the insert's learning block throws before the grading is handed off, the row is left
 *     unstamped (the stamp is withdrawn) and the late reached:true credits α once.
 *
 * Harness: the insert-beta-withheld pattern (spies on the real exports, restored afterAll; no mock.module). Deltas
 * are read from the credit path's own ENQUEUED / APPLIED / PARTIAL lines, which name the arm and both deltas.
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
const FAILED: Row = {
  status: 'failure', success: false,
  execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: false }] },
  failure_mode: { type: 'execution_error', reason: 'resolver threw' },
};

describe('MUST-FAIL — an execution the insert graded is not graded again by the late verdict', () => {
  test('inserted reached:true, then POST /reach reached:true ⇒ α credited exactly once', async () => {
    const arm = 'fixture-vessel:once-reached-arm';
    const id = 'exec-once-reached-1';
    const ins = await postTrace(body(id, arm, { tags: ['reached:true'] }));
    expect(ins.status).toBe(200);
    const reach = await postReach(id, { reached: true });
    expect(reach.status).toBe(200);
    const d = appliedTo(arm, ins.from);
    expect(d.lines).toBe(1);
    expect(d.alpha).toBeGreaterThan(0);
  });

  test('untagged failure (not-reached at insert), then POST /reach reached:false ⇒ β charged exactly once', async () => {
    const arm = 'fixture-vessel:once-failed-arm';
    const id = 'exec-once-failed-1';
    const ins = await postTrace(body(id, arm, FAILED));
    expect(ins.status).toBe(200);
    const reach = await postReach(id, { reached: false });
    expect(reach.status).toBe(200);
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 1, lines: 1 });
    expect(infos.slice(reach.from).some((i) => i.msg.includes('insert path already graded this trace'))).toBe(true);
  });
});

describe('CONTROLS — the late verdict is the one grading of a walk awaiting it', () => {
  test('goal-host walk, no reach tag: insert moves nothing; POST /reach reached:true credits α once', async () => {
    const arm = 'fixture-vessel:awaiting-reached-arm';
    const id = 'exec-awaiting-reached-1';
    const ins = await postTrace(body(id, arm, { tags: ['dispatcher_used:goal-host'] }));
    expect(appliedTo(arm, ins.from).lines).toBe(0);
    const reach = await postReach(id, { reached: true });
    expect(reach.status).toBe(200);
    const d = appliedTo(arm, ins.from);
    expect(d.lines).toBe(1);
    expect(d.alpha).toBeGreaterThan(0);
  });

  test('goal-host walk, no reach tag: POST /reach reached:false charges β once', async () => {
    const arm = 'fixture-vessel:awaiting-failed-arm';
    const id = 'exec-awaiting-failed-1';
    const ins = await postTrace(body(id, arm, { tags: ['dispatcher_used:goal-host'] }));
    const reach = await postReach(id, { reached: false });
    expect(reach.status).toBe(200);
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 1, lines: 1 });
  });

  test('a poster-supplied insert marker on an awaiting walk does not block its late verdict', async () => {
    const arm = 'fixture-vessel:forged-marker-arm';
    const id = 'exec-forged-marker-1';
    const ins = await postTrace(body(id, arm, { tags: ['dispatcher_used:goal-host', 'insert_graded:true'] }));
    expect(appliedTo(arm, ins.from).lines).toBe(0);
    await postReach(id, { reached: true });
    const d = appliedTo(arm, ins.from);
    expect(d.lines).toBe(1);
    expect(d.alpha).toBeGreaterThan(0);
  });
});

describe('MUST-FAIL (D1) — a walk awaiting its verdict is graded by /reach alone, beta included', () => {
  test('goal-host walk, top-level, failed task, no reach tag; then reached:true ⇒ α once, β 0, no insert stamp', async () => {
    const arm = 'fixture-vessel:awaiting-failed-task-arm';
    const id = 'exec-awaiting-failed-task-1';
    const ins = await postTrace(body(id, arm, { ...FAILED, tags: ['dispatcher_used:goal-host'] }));
    expect(ins.status).toBe(200);
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
    expect(executionRows.get(id)?.tags ?? []).not.toContain('insert_graded:true');
    const reach = await postReach(id, { reached: true });
    expect(reach.status).toBe(200);
    const d = appliedTo(arm, ins.from);
    expect(d.lines).toBe(1);
    expect(d.alpha).toBeGreaterThan(0);
    expect(d.beta).toBeLessThan(d.alpha);
    expect(infos.slice(ins.from).filter((i) => HANDED_TO_VPM.has(i.msg) && i.meta.activity_id === arm && Number(i.meta.beta_delta) >= 1)).toEqual([]);
  });
});

describe('CONTROL (D1) — a child run that inherits the goal-host tag keeps its blame', () => {
  test('lifecycle-subscriber shape (parent_execution_id set), failed task ⇒ β 1 at insert and stamped', async () => {
    const arm = 'fixture-vessel:subscriber-failed-task-arm';
    const id = 'exec-subscriber-failed-task-1';
    const ins = await postTrace(body(id, arm, { ...FAILED, tags: ['dispatcher_used:goal-host'], parent_execution_id: 'exec-parent-walk-1' }));
    expect(ins.status).toBe(200);
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 1, lines: 1 });
    expect(executionRows.get(id)?.tags ?? []).toContain('insert_graded:true');
  });
});

describe('MUST-FAIL (D4) — a learning block that throws before grading leaves the row unstamped', () => {
  test('inserted reached:true, learning block throws; then reached:true ⇒ α credited once, by /reach', async () => {
    const arm = 'fixture-vessel:learning-throws-arm';
    const id = 'exec-learning-throws-1';
    throwOnLearningRead.add(arm);
    try {
      const ins = await postTrace(body(id, arm, { tags: ['reached:true'] }));
      expect(ins.status).toBe(200);
      expect(appliedTo(arm, ins.from).lines).toBe(0);
      expect(executionRows.get(id)?.tags ?? []).not.toContain('insert_graded:true');
      const reach = await postReach(id, { reached: true });
      expect(reach.status).toBe(200);
      const d = appliedTo(arm, ins.from);
      expect(d.lines).toBe(1);
      expect(d.alpha).toBeGreaterThan(0);
    } finally { throwOnLearningRead.delete(arm); }
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
