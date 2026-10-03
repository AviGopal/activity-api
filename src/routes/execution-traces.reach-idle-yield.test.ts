/**
 * Check-first: an idle tick posted through POST /reach must not move the posterior.
 *
 * THE CLASS. An execution whose stored trace says `metadata.information_yield === "idle"`
 * did nothing (nothing eligible, nothing done). posterior-update's credit path already
 * refuses to grade such a trace (skipVariantUpdate on information_yield idle). But the
 * late-verdict route POST /execution-traces/reach re-reads the execution row and hands
 * applyOutcomeToPosteriors a trace WITHOUT that row's metadata, so the idle skip can never
 * apply on this path, and every idle tick whose caller posts reach:true earns alpha. A
 * dormant arm then reads as healthy as a working one.
 *
 * SEAM COVERED. The real route handler (default export of ./execution-traces, mounted on a
 * bare Hono app, no server entry, no port) driving the REAL applyOutcomeToPosteriors and the
 * real coalescing aggregator. Only the DB (and the exports execution-traces.account-id.test.ts
 * stubs) is replaced, by spies on the real exports that are restored afterwards. The DB stub is
 * a small fixture store: the pre-read of
 * `type::thing('execution', $execution_id)` returns the fixture row PROJECTED onto the
 * columns the SELECT actually names, exactly as SurrealDB would. So the test covers the
 * dropped-metadata joint end to end: a repair has to both fetch the row's metadata and
 * carry it into the credit call; passing a field the pre-read never selects stays red.
 *
 * OBSERVABLE. Posterior movement is read off the writes the credit path issues:
 * `UPDATE variant_performance_metrics SET thompson_alpha = $new_alpha, thompson_beta =
 * $new_beta` (synchronous path, or the aggregator flush, which this test drains) and any
 * context_thompson_scores write. With no stored metrics row the decayed baseline is (1,1).
 *
 * GENERALITY. Fixtures are invented, topic-agnostic arms with different template ids and
 * output shapes (a scan-like and a report-like tick), so a repair keyed to one detector,
 * one id or one shape cannot turn this green. Controls pin that productive executions and
 * executions with no information_yield still move alpha (reach:true) or beta (reach:false)
 * through the same route (reach:true by one unit of graded-yield evidence, reach:false by one
 * unit of beta), exactly as they do today.
 */

import { describe, test, expect, spyOn, beforeEach, afterAll } from 'bun:test';
import { Hono } from 'hono';

process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

type Row = Record<string, unknown>;
const queries: { sql: string; params: any }[] = [];
const executionRows = new Map<string, Row>();

/** Resolve a dotted path (`trace.tasks`) on a row. */
function pick(row: Row, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Row)[part];
  }
  return cur;
}

/** Project a row onto a SurrealQL SELECT column list (`a, b.c AS d, *`). */
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

function answer(sql: string, params: any): any {
  queries.push({ sql, params });
  const sel = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+type::thing\(\s*'execution'\s*,\s*\$execution_id\s*\)/i.exec(sql);
  if (sel) {
    const row = executionRows.get(String(params?.execution_id));
    return row ? [project(row, sel[1])] : [];
  }
  return [];
}

// NO mock.module here. bun applies a module replacement to the whole test process and it outlives
// this file, so a factory that omits an export breaks every later file importing it
// (mock-module-completeness.test.ts), and even a complete one swaps real singletons under other
// files. Instead spy on the REAL exports this route reaches, with the same stub behaviour the
// factories had, and put every one back in afterAll. Real modules are loaded with await import()
// so they see the env set above.
const surrealMod = await import('../db/surreal');
const redisMod = await import('../db/redis');
const broadcasterMod = await import('../websocket/broadcaster');
const paradigmMod = await import('../db/paradigm');
const variantCreatorMod = await import('../services/variant-creator');

const spies: Array<{ mockRestore(): void }> = [];
/** Spy on `obj[key]` if it is a function there. In a full run an earlier file's mock.module may
 *  have replaced the module with a factory lacking `key`; skipping keeps this file loadable. */
function stub(obj: any, key: string, impl: (...args: any[]) => unknown): void {
  if (obj == null || typeof obj[key] !== 'function') return;
  spies.push(spyOn(obj, key).mockImplementation(impl as never));
}

// DB: the fixture store answers every query; a real connection is refused so nothing un-stubbed
// (queryRaw) can reach a server.
stub(surrealMod.surrealDB, 'query', async (sql: string, params: any) => answer(sql, params));
stub(surrealMod.surrealDB, 'queryAll', async (sql: string, params: any) => answer(sql, params));
stub(surrealMod.surrealDB, 'getInstance', async () => ({}));
stub(surrealMod.surrealDB, 'connect', async () => { throw new Error('SurrealDB is not available in this test'); });
stub(surrealMod, 'queryWithAuth', async (_token: string, sql: string, params: any) => answer(sql, params));
stub(surrealMod, 'createAuthenticatedClient', async () => ({}));

// Redis: the prototype covers both the `redis` export and RedisClient.getInstance().
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
stub(paradigmMod, 'insertExecution', async () => null);
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
stub(paradigmMod, 'normalizeActivityId', (id: string) =>
  id.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''));
stub(paradigmMod, 'updateShapeActivityScores', async () => null);

stub(variantCreatorMod, 'autoCreateVariantIfNeeded', async () => null);
stub(variantCreatorMod, 'checkAndRetireTemplate', async () => false);

afterAll(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const executionTracesRouter = (await import('./execution-traces')).default;
const { flushPosteriors } = await import('../lib/posterior-aggregator');

const app = new Hono();
app.route('/v2/activities/execution-traces', executionTracesRouter);

/** A stored execution row as the insert path persists it (metadata is a top-level column). */
function storeExecution(executionId: string, templateId: string, outputShape: string, metadata?: Row): void {
  executionRows.set(executionId, {
    id: `execution:${executionId}`,
    activity_id: templateId,
    variant_id: templateId,
    success: true,
    status: 'completed',
    tags: [],
    cost_usd: 0.001,
    org_id: 'org-fixture',
    output_impulse_shapes: [outputShape],
    // A stochastic task, so the all_deterministic tier skip can never be why a write is absent.
    trace: { tasks: [{ task_id: 't1', resolver: 'llm', resolver_tier: 'llm', status: 'completed' }] },
    ...(metadata ? { metadata } : {}),
  });
}

/** Wait until the fire-and-forget credit call has stopped issuing queries, then drain the aggregator. */
async function settle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    let last = -1;
    let stableSince = Date.now();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (queries.length !== last) { last = queries.length; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 150) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await flushPosteriors();
  }
}

async function postReach(executionId: string, reached: boolean, completionShapes: string[]): Promise<Response> {
  const res = await app.request('/v2/activities/execution-traces/reach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ execution_id: executionId, reached, completion_shapes: completionShapes }),
  });
  await settle();
  return res;
}

/** The posterior writes for one arm: thompson (alpha, beta) as written, plus any v1 context row write. */
function posteriorWrites(templateId: string) {
  const vpm = queries
    .filter((q) => /UPDATE\s+variant_performance_metrics[\s\S]*thompson_alpha\s*=\s*\$new_alpha/i.test(q.sql))
    .filter((q) => q.params?.activity_id === templateId)
    .map((q) => ({ alpha: q.params.new_alpha as number, beta: q.params.new_beta as number }));
  const context = queries.filter((q) => /context_thompson_scores/i.test(q.sql) && /\b(UPDATE|CREATE|UPSERT|INSERT)\b/i.test(q.sql));
  return { vpm, context };
}

/** Did the route actually grade this execution (the reach_graded marker), so absence of a write means a skip, not a miss? */
function markedGraded(executionId: string): boolean {
  return queries.some((q) => /reach_graded:true/.test(q.sql) && q.params?.execution_id === executionId);
}

beforeEach(() => {
  queries.length = 0;
  executionRows.clear();
});

describe('an idle tick posted through POST /reach does not move the posterior', () => {
  test('a scan-like idle tick posted reached true leaves alpha and beta unchanged', async () => {
    storeExecution('exec-idle-scan-1', 'fixture-vessel:periodic-scan-alpha', 'fixtureScanFindings', { information_yield: 'idle' });
    const res = await postReach('exec-idle-scan-1', true, ['fixtureScanFindings']);
    expect(res.status).toBe(200);
    expect(markedGraded('exec-idle-scan-1')).toBe(true);
    const w = posteriorWrites('fixture-vessel:periodic-scan-alpha');
    expect(w.vpm).toEqual([]);
    expect(w.context).toEqual([]);
  });

  test('a report-like idle tick posted reached true leaves alpha and beta unchanged', async () => {
    storeExecution('exec-idle-report-1', 'other-fixture-vessel:digest-report-beta', 'fixtureDigestReport', { information_yield: 'idle', note: 'nothing eligible' });
    const res = await postReach('exec-idle-report-1', true, ['fixtureDigestReport']);
    expect(res.status).toBe(200);
    expect(markedGraded('exec-idle-report-1')).toBe(true);
    const w = posteriorWrites('other-fixture-vessel:digest-report-beta');
    expect(w.vpm).toEqual([]);
    expect(w.context).toEqual([]);
  });

  test('an idle tick posted reached false leaves alpha and beta unchanged', async () => {
    storeExecution('exec-idle-scan-2', 'fixture-vessel:periodic-scan-alpha', 'fixtureScanFindings', { information_yield: 'idle' });
    const res = await postReach('exec-idle-scan-2', false, []);
    expect(res.status).toBe(200);
    expect(markedGraded('exec-idle-scan-2')).toBe(true);
    const w = posteriorWrites('fixture-vessel:periodic-scan-alpha');
    expect(w.vpm).toEqual([]);
    expect(w.context).toEqual([]);
  });

  test('control: a productive tick posted reached true moves alpha by one unit of graded evidence', async () => {
    storeExecution('exec-productive-1', 'fixture-vessel:periodic-scan-alpha', 'fixtureScanFindings', { information_yield: 'productive' });
    const res = await postReach('exec-productive-1', true, ['fixtureScanFindings']);
    expect(res.status).toBe(200);
    const w = posteriorWrites('fixture-vessel:periodic-scan-alpha');
    expect(w.vpm).toHaveLength(1);
    // Graded-yield credit: one unit of evidence split y / (1 - y) with y > 0.5, so alpha moves and
    // outweighs any beta share (today: +0.75 / +0.25 for these fixtures).
    expect(w.vpm[0]!.alpha).toBeGreaterThan(1);
    expect(w.vpm[0]!.alpha - 1).toBeGreaterThan(w.vpm[0]!.beta - 1);
    expect(w.vpm[0]!.alpha + w.vpm[0]!.beta).toBeCloseTo(3, 6);
  });

  test('control: a tick with no information_yield posted reached true moves alpha by one unit of graded evidence', async () => {
    storeExecution('exec-noyield-1', 'other-fixture-vessel:digest-report-beta', 'fixtureDigestReport');
    const res = await postReach('exec-noyield-1', true, ['fixtureDigestReport']);
    expect(res.status).toBe(200);
    const w = posteriorWrites('other-fixture-vessel:digest-report-beta');
    expect(w.vpm).toHaveLength(1);
    // Graded-yield credit: one unit of evidence split y / (1 - y) with y > 0.5, so alpha moves and
    // outweighs any beta share (today: +0.75 / +0.25 for these fixtures).
    expect(w.vpm[0]!.alpha).toBeGreaterThan(1);
    expect(w.vpm[0]!.alpha - 1).toBeGreaterThan(w.vpm[0]!.beta - 1);
    expect(w.vpm[0]!.alpha + w.vpm[0]!.beta).toBeCloseTo(3, 6);
  });

  test('control: a productive tick posted reached false moves beta and not alpha', async () => {
    storeExecution('exec-productive-2', 'other-fixture-vessel:digest-report-beta', 'fixtureDigestReport', { information_yield: 'productive' });
    const res = await postReach('exec-productive-2', false, []);
    expect(res.status).toBe(200);
    const w = posteriorWrites('other-fixture-vessel:digest-report-beta');
    expect(w.vpm).toHaveLength(1);
    expect(w.vpm[0]!.beta).toBeGreaterThan(1);
    expect(w.vpm[0]!.alpha).toBe(1);
  });
});
