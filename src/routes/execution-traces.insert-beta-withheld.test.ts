/**
 * A TRACE THE CALLER MARKS beta_withheld MOVES NO POSTERIOR AT INSERT (check-first).
 *
 * goal-host decides to withhold β for a not-reached walk whose last pick is a satisfier (no oracle owns the goal
 * class, or α was structurally unreachable) and logs "NOT REACHED but β WITHHELD for satisfier:<x>". It then persists
 * the satisfier trace as status "failed" with no reach tag. POST / of this route classifies that trace ungraded (a
 * hollow satellite) and hands it to applyOutcomeToPosteriors, whose ungraded-failure arm blames it anyway: the call
 * always passes `tasks`, so the trace has task evidence, and it never passes task_count, so `(task_count ?? 0) === 0`.
 * Measured: "posterior variant update APPLIED {reach_verdict: ungraded, beta_delta: 1}" about 19 ms after the
 * withhold, 590 of 602 withholds on one node. POST /reach already honours beta_withheld (and its reach_withheld:true
 * finality marker); the insert path did not.
 *
 * THE RULE PINNED HERE (one finality rule for both paths):
 *   - A trace inserted with beta_withheld (body field `beta_withheld: true`, or tag `beta_withheld:true`; reason from
 *     `beta_withheld_reason` or tag `beta_withheld_reason:<r>`) that is not reached gets NO α and NO β on its arm,
 *     one `[insert] β WITHHELD by caller` line (execution id, arm, reason), and the tag reach_withheld:true on its row.
 *   - A later POST /reach for that execution without the flag therefore applies nothing either.
 *   - No flag: unchanged. A failed satisfier still takes β=1; a reached trace still takes α; a reached trace
 *     ignores the flag.
 *
 * Harness: the org-defaulted pattern (spies on the real exports, restored afterAll; no mock.module). The posterior
 * delta is read from the credit path's own APPLIED / SKIPPED lines, which name the arm and both deltas whatever the
 * coalescing mode. A network guard fails any fetch outside the stub origin and any WebSocket.
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

const ORG = 'organizations:test';
const SAT_ARM = 'satisfier:substrateObservable';
const WHY = 'alpha-unreachable-non-deterministic-no-edge';

/** A satisfier durable trace as goal-host persists it after withholding β: failed, no reach tag. */
function satisfierBody(executionId: string, extra: Row = {}): Row {
  return {
    execution_id: executionId,
    template_id: SAT_ARM,
    activity_id: SAT_ARM,
    status: 'failure',
    success: false,
    org_id: ORG,
    duration_ms: 12,
    cost_usd: 0,
    tags: ['surface:mcp'],
    output_impulse_shapes: ['substrateObservable'],
    execution_trace: { tasks: [{ id: 't1', resolver: 'vessel', success: false }] },
    failure_mode: { type: 'execution_error', reason: 'goal not reached' },
    ...extra,
  };
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
const withheldLines = (from: number) => infos.slice(from).filter((i) => i.msg.includes('[insert] β WITHHELD by caller'));

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

describe('MUST-FAIL — a withheld satisfier insert moves no posterior and is marked final', () => {
  test('tag-borne flag: no α, no β on the arm; one WITHHELD line; the row carries reach_withheld:true', async () => {
    const id = 'walk-satisfier-3-1791378965133';
    const r = await postTrace(satisfierBody(id, { tags: ['surface:mcp', 'beta_withheld:true', `beta_withheld_reason:${WHY}`] }));
    expect(r.status).toBe(200);
    expect(appliedTo(SAT_ARM, r.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
    const w = withheldLines(r.from);
    expect(w.length).toBe(1);
    expect(w[0]!.meta).toMatchObject({ execution_id: id, activity_id: SAT_ARM, reason: WHY });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.tags).toEqual(expect.arrayContaining(['reach_withheld:true']));
  });

  test('body-borne flag (beta_withheld + beta_withheld_reason fields) is honoured the same way', async () => {
    const id = 'walk-satisfier-4-1791378965200';
    const r = await postTrace(satisfierBody(id, { tags: [], beta_withheld: true, beta_withheld_reason: 'no-oracle-for-goal-class' }));
    expect(r.status).toBe(200);
    expect(appliedTo(SAT_ARM, r.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
    const w = withheldLines(r.from);
    expect(w.length).toBe(1);
    expect(w[0]!.meta).toMatchObject({ execution_id: id, activity_id: SAT_ARM, reason: 'no-oracle-for-goal-class' });
    expect(executions[0]!.tags).toEqual(['reach_withheld:true']);
  });
});

describe('MUST-FAIL — a withheld insert is final against a later unflagged POST /reach', () => {
  test('satisfier: insert then /reach reached:false without the flag ⇒ zero total delta on the arm', async () => {
    // NOTE: /reach never grades a satellite (walk-satisfier-* / satisfier:*), so the /reach half alone is a no-op
    // at base too; the total is what was wrong (the insert took β=1).
    const id = 'walk-satisfier-5-1791378965300';
    const ins = await postTrace(satisfierBody(id, { tags: ['beta_withheld:true', `beta_withheld_reason:${WHY}`] }));
    const reach = await postReach(id, { reached: false });
    expect(reach.status).toBe(200);
    expect(appliedTo(SAT_ARM, ins.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
  });

  test('engine trace awaiting its verdict: withheld at insert ⇒ the later unflagged /reach applies nothing', async () => {
    const arm = 'fixture-vessel:withheld-engine-arm';
    const id = 'exec-engine-withheld-1';
    const ins = await postTrace(satisfierBody(id, {
      template_id: arm,
      activity_id: arm,
      tags: ['dispatcher_used:goal-host', 'beta_withheld:true', `beta_withheld_reason:${WHY}`],
    }));
    expect(ins.status).toBe(200);
    expect(appliedTo(arm, ins.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
    expect(executionRows.get(id)?.tags).toEqual(expect.arrayContaining(['reach_withheld:true']));
    const reach = await postReach(id, { reached: false });
    expect(reach.status).toBe(200);
    expect(appliedTo(arm, reach.from)).toEqual({ alpha: 0, beta: 0, lines: 0 });
    expect(infos.slice(reach.from).some((i) => i.msg.includes('caller withheld this verdict earlier (reach_withheld:true)'))).toBe(true);
    expect(executionRows.get(id)?.tags).not.toContain('reach_graded:true');
  });
});

describe('CONTROLS — no flag, behaviour unchanged', () => {
  test('a genuine failed satisfier insert (no flag) ⇒ β=1 on the arm, no WITHHELD line, no reach_withheld tag', async () => {
    const r = await postTrace(satisfierBody('walk-satisfier-6-1791378965400'));
    expect(r.status).toBe(200);
    expect(appliedTo(SAT_ARM, r.from)).toEqual({ alpha: 0, beta: 1, lines: 1 });
    expect(withheldLines(r.from)).toEqual([]);
    expect(executions[0]!.tags ?? []).not.toContain('reach_withheld:true');
  });

  test('explicit beta_withheld:false ⇒ β=1 as before', async () => {
    const r = await postTrace(satisfierBody('walk-satisfier-7-1791378965500', { beta_withheld: false }));
    expect(appliedTo(SAT_ARM, r.from)).toEqual({ alpha: 0, beta: 1, lines: 1 });
    expect(withheldLines(r.from)).toEqual([]);
  });

  test('a reached insert ⇒ α on the arm', async () => {
    const arm = 'fixture-vessel:reached-arm';
    const r = await postTrace(satisfierBody('exec-reached-1', {
      template_id: arm, activity_id: arm, status: 'completed', success: true, failure_mode: undefined,
      tags: ['reached:true'], execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: true }] },
    }));
    const d = appliedTo(arm, r.from);
    expect(d.lines).toBe(1);
    expect(d.alpha).toBeGreaterThan(0);
    expect(d.alpha).toBeGreaterThan(d.beta);
  });

  test('a reached insert ignores beta_withheld ⇒ α, no WITHHELD line, no reach_withheld tag', async () => {
    const arm = 'fixture-vessel:reached-arm-2';
    const r = await postTrace(satisfierBody('exec-reached-2', {
      template_id: arm, activity_id: arm, status: 'completed', success: true, failure_mode: undefined,
      tags: ['reached:true', 'beta_withheld:true'], execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: true }] },
    }));
    expect(appliedTo(arm, r.from).alpha).toBeGreaterThan(0);
    expect(withheldLines(r.from)).toEqual([]);
    expect(executions[0]!.tags ?? []).not.toContain('reach_withheld:true');
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
