/**
 * NO LEARNING WRITE TO A DEFAULTED ORG, AT THE ROUTE (check-first).
 *
 * POST /v2/activities/execution-traces resolved the trace org as body, then jwt, then session, else 'public'. A trace
 * posted with no org therefore had every learning write keyed on that org aimed at a guessed row: measured, leaf
 * posterior drops split both ways between 'public' and organizations:substrate. The trace itself must still be
 * stored (execution.org_id is a required string; dropping traces is its own harm).
 *
 * THE RULE PINNED HERE:
 *   - a trace with no known org is STORED, under 'public', with metadata.org_defaulted = true on the execution row;
 *   - none of the org-keyed learning writes fire for it: no variant_performance_metrics row created or changed,
 *     no activity_template counter UPDATE, no context_thompson_scores write, no shape-activity score update;
 *   - POST /reach on a stored row carrying metadata.org_defaulted grades no leaf posterior under that org.
 * Controls: the same traces with a known org still write every one of those sinks.
 *
 * Harness: the reach-idle-yield pattern (spies on the real exports, restored afterAll; no mock.module), so nothing
 * here leaks into later files.
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
const executions: Row[] = [];
const shapeScoreCalls: unknown[][] = [];

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
stub(paradigmMod, 'insertExecution', async (e: Row) => { executions.push(e); return null; });
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
stub(paradigmMod, 'updateShapeActivityScores', async (...args: unknown[]) => { shapeScoreCalls.push(args); return null; });

stub(variantCreatorMod, 'autoCreateVariantIfNeeded', async () => null);
stub(variantCreatorMod, 'checkAndRetireTemplate', async () => false);

afterAll(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const executionTracesRouter = (await import('./execution-traces')).default;
const { flushPosteriors } = await import('../lib/posterior-aggregator');

const app = new Hono();
app.route('/v2/activities/execution-traces', executionTracesRouter);

/** Wait until the fire-and-forget credit calls have stopped issuing queries, then drain the aggregator. */
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

const TEMPLATE = 'fixture-vessel:org-probe-arm';

function traceBody(executionId: string, extra: Row = {}): Row {
  return {
    execution_id: executionId,
    template_id: TEMPLATE,
    activity_id: TEMPLATE,
    status: 'completed',
    duration_ms: 10,
    cost_usd: 0.001,
    tags: ['reached:true'],
    input_impulse_shapes: ['fixtureOrgProbeInput'],
    output_impulse_shapes: ['fixtureOrgProbeOutput'],
    metadata: { context_bucket: 'a1b2c3d4' },
    execution_trace: { tasks: [{ id: 't1', resolver: 'llm', resolver_tier: 'llm', success: true }] },
    ...extra,
  };
}

async function postTrace(body: Row): Promise<Response> {
  const res = await app.request('/v2/activities/execution-traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await settle();
  return res;
}

/** Every org-keyed learning write the handler (and the credit call it makes) issued for TEMPLATE. */
function learningWrites() {
  const forTemplate = (q: { params: any }) =>
    q.params?.activity_id === TEMPLATE || q.params?.variant_id === TEMPLATE || q.params?.template_id === TEMPLATE;
  return {
    vpm: queries.filter((q) => /(UPDATE|INSERT INTO)\s+(variant_performance_metrics|\$id)\b/i.test(q.sql) && /variant_performance_metrics|total_executions/i.test(q.sql)).filter(forTemplate),
    activityTemplate: queries.filter((q) => /UPDATE\s+activity_template/i.test(q.sql)).filter(forTemplate),
    context: queries.filter((q) => /context_thompson_scores/i.test(q.sql) && /\b(UPDATE|CREATE|UPSERT|INSERT)\b/i.test(q.sql)).filter(forTemplate),
    shapeScores: shapeScoreCalls.filter((args) => args[0] === TEMPLATE),
  };
}

beforeEach(() => {
  queries.length = 0;
  executionRows.clear();
  executions.length = 0;
  shapeScoreCalls.length = 0;
});

describe('POST /execution-traces with no known org stores the trace and writes no learning row', () => {
  test('CONTROL: a trace with a known org writes every org-keyed learning sink under that org', async () => {
    const res = await postTrace(traceBody('exec-org-known-1', { org_id: 'org-fixture' }));
    expect(res.status).toBe(200);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.org_id).toBe('org-fixture');
    expect((executions[0]!.metadata as Row | undefined)?.org_defaulted).toBeUndefined();
    const w = learningWrites();
    expect(w.vpm.length).toBeGreaterThan(0);
    expect(w.activityTemplate.length).toBeGreaterThan(0);
    expect(w.context.length).toBeGreaterThan(0);
    expect(w.shapeScores).toHaveLength(1);
  });

  test("MUST-FAIL: a trace with no org is stored under 'public' marked org_defaulted", async () => {
    const res = await postTrace(traceBody('exec-org-none-1'));
    expect(res.status).toBe(200);
    expect(executions).toHaveLength(1);
    expect(executions[0]!.org_id).toBe('public');
    expect((executions[0]!.metadata as Row | undefined)?.org_defaulted).toBe(true);
    // the poster's own metadata is kept alongside the marker
    expect((executions[0]!.metadata as Row | undefined)?.context_bucket).toBe('a1b2c3d4');
  });

  test('MUST-FAIL: a trace with no org creates or changes no variant_performance_metrics, activity_template, context or shape-score row', async () => {
    const res = await postTrace(traceBody('exec-org-none-2'));
    expect(res.status).toBe(200);
    const w = learningWrites();
    expect(w.vpm.map((q) => q.sql.trim().split('\n')[0])).toEqual([]);
    expect(w.activityTemplate).toEqual([]);
    expect(w.context).toEqual([]);
    expect(w.shapeScores).toEqual([]);
  });
});

describe('POST /reach on a stored org_defaulted execution grades no leaf posterior', () => {
  function storeExecution(executionId: string, metadata: Row, orgId = 'public'): void {
    executionRows.set(executionId, {
      id: `execution:${executionId}`,
      activity_id: TEMPLATE,
      variant_id: TEMPLATE,
      success: true,
      status: 'completed',
      tags: [],
      cost_usd: 0.001,
      org_id: orgId,
      trace: { tasks: [{ task_id: 't1', resolver: 'llm', resolver_tier: 'llm', status: 'completed' }] },
      metadata,
    });
  }
  async function postReach(executionId: string): Promise<Response> {
    const res = await app.request('/v2/activities/execution-traces/reach', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ execution_id: executionId, reached: true, completion_shapes: ['fixtureOrgProbeOutput'] }),
    });
    await settle();
    return res;
  }
  const leafVpm = () => queries
    .filter((q) => /UPDATE\s+variant_performance_metrics[\s\S]*thompson_alpha\s*=\s*\$new_alpha/i.test(q.sql))
    .filter((q) => q.params?.activity_id === TEMPLATE);

  // Was "a stored row under a real 'public' org is graded". A bare 'public' is never a real org: it is only the
  // fallback literal (identity issues record-form orgs, no producer sends it), and rows stored before the poster fix
  // carry it with no org_defaulted flag. POST /reach now treats it as defaulted
  // (execution-traces.reach-default-org.test.ts); the control is a row under a real org.
  test('CONTROL: a stored row under a real org is graded under it', async () => {
    storeExecution('exec-reach-public-1', { information_yield: 'productive' }, 'organizations:substrate');
    const res = await postReach('exec-reach-public-1');
    expect(res.status).toBe(200);
    expect(leafVpm()).toHaveLength(1);
    expect(leafVpm()[0]!.params.org_id).toBe('organizations:substrate');
  });

  test('MUST-FAIL: a stored row carrying metadata.org_defaulted writes no leaf posterior', async () => {
    storeExecution('exec-reach-defaulted-1', { information_yield: 'productive', org_defaulted: true });
    const res = await postReach('exec-reach-defaulted-1');
    expect(res.status).toBe(200);
    expect(queries.some((q) => /reach_graded:true/.test(q.sql))).toBe(true);
    expect(leafVpm()).toEqual([]);
  });
});
