// AN OBSERVE TRACE IS PERSISTED BY POST / AND NOTHING LEARNS FROM IT (real engine).
//
// goal-host's observe dispatch (learning_mode "observe": a probe, a held-out measurement) tags its traces
// learning_mode:observe. POST /reach already records such a verdict without grading it; the insert path did not look:
// an observe-tagged trace inserted with reached:true was graded at insert, counted, edged and broadcast to the
// ribosome. Against a scratch SurrealDB built from the REAL schema and migrations (test/support/real-surreal.ts),
// driving the real route, the real authoritative execution write and the real credit path:
//   [MUST-FAIL] two observe-tagged inserts (reached:true, a parent execution, two modified files), one per decision-
//               outcome path: (i) no correlation tag (the universal recordExecutionDecisionOutcome path) and (ii) a
//               correlation tag naming a SEEDED thompson_selection_log row (the recordDecisionOutcome path). Together
//               they send NO write statement to any learning table (variant_performance_metrics,
//               context_thompson_scores, shape_score_counter, impulse_shape_activity_score, decision_outcome,
//               activity_composition_graph, activity_template), leave the observe arm's rows unchanged, write no
//               decision_outcome under either key, emit no execution_completed (the ribosome's trigger) and forward
//               nothing to co-change learning in their window; both traces persist, with reach_observe:true stamped;
//   [CONTROL]   the same two inserts from a learn dispatch (sent AFTER, in their own window, polled until seen in vpm,
//               cts and BOTH decision_outcome rows, so the observe assertions cannot pass vacuously) write EXACTLY the
//               seven learning tables, forward co-change in their window and are broadcast.
// Redis, the websocket broadcaster (recorded) and variant creation are stubbed; outbound fetch is answered locally
// and recorded (the engine itself is reached over its own WebSocket and Bun.fetch).
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const ORG = 'organizations:insert-observe-probe';
const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const OBS = `ins-obs-arm-${word()}`;
const LEARN = `ins-learn-arm-${word()}`;
const PARENT = `ins-parent-arm-${word()}`;
const SIG = '0a1b2c3d4e5f6071';
const LEARNING_TABLES = ['variant_performance_metrics', 'context_thompson_scores', 'shape_score_counter', 'impulse_shape_activity_score', 'decision_outcome', 'activity_composition_graph', 'activity_template'];
const WRITE = (table: string) => new RegExp(`\\b(UPDATE|UPSERT|CREATE|INSERT|RELATE)\\b[\\s\\S]*\\b${table}\\b`, 'i');

let db: RealSurreal | null = null;
let client: any = null;
let app: Hono | null = null;
let AGG: any;
let LANE: any;
let startError = '';
const spies: Array<{ mockRestore(): void }> = [];
const originalFetch = globalThis.fetch;
const emitted: Array<{ type: string; data?: { execution_id?: string } }> = [];
const fetched: string[] = [];

function exec(id: string, activity: string): string {
  return `CREATE execution:\`${id}\` CONTENT { activity_id: '${activity}', input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now() - 1m, created_at: time::now(), status: 'success', tags: ['dispatcher_used:goal-host'] };`;
}
function vpm(activity: string): string {
  return `CREATE variant_performance_metrics CONTENT { variant_id: '${activity}', activity_id: '${activity}', org_id: '${ORG}', total_executions: 3, successful_executions: 3, failed_executions: 0, success_rate: 1.0, avg_duration_ms: 10.0, avg_cost_usd: 0.0, thompson_alpha: 4.0, thompson_beta: 2.0, total_selections: 3, created_at: time::now(), updated_at: time::now() };`;
}
/** The selection the walk's correlation tag names: recordDecisionOutcome joins it to write decision_outcome. */
function selection(activity: string, cid: string): string {
  return `CREATE thompson_selection_log CONTENT { execution_id: 'sel-${cid}', activity_id: '${activity}', thompson_sample: 0.62, alpha: 4.0, beta: 2.0, selection_method: 'thompson_sampling', org_id: '${ORG}', selected_at: time::now() - 2m, correlation_id: '${cid}' };`;
}
async function decisionOutcome(cid: string): Promise<unknown[]> {
  const r = await db!.sql(`${USE} SELECT correlation_id, activity_id, reached FROM decision_outcome WHERE correlation_id = '${cid}';`);
  return r[r.length - 1].result;
}
function traceBody(execId: string, arm: string, parent: string, tags: string[]): Record<string, unknown> {
  return {
    execution_id: execId,
    template_id: arm,
    activity_id: arm,
    status: 'success',
    success: true,
    org_id: ORG,
    duration_ms: 12,
    cost_usd: 0,
    tags,
    parent_execution_id: parent,
    input_impulse_shapes: ['goal'],
    output_impulse_shapes: ['shellResult'],
    execution_trace: { tasks: [{ id: 't1', resolver: 'vessel', success: true, outputShapes: ['shellResult'] }], filesModified: ['src/a.ts', 'src/b.ts'] },
    metadata: { state_space_signature: SIG, signature_version: 1 },
  };
}
async function state(activity: string) {
  const last = (r: any[]) => r[r.length - 1].result;
  const v = last(await db!.sql(`${USE} SELECT thompson_alpha AS a, thompson_beta AS b, total_executions AS n FROM variant_performance_metrics WHERE variant_id = '${activity}' AND org_id = '${ORG}';`));
  const c = last(await db!.sql(`${USE} SELECT alpha, beta FROM context_thompson_scores WHERE template_id = '${activity}' AND org_id = '${ORG}';`));
  const s = last(await db!.sql(`${USE} SELECT graded FROM shape_score_counter WHERE activity_id = '${activity}';`));
  const i = last(await db!.sql(`${USE} SELECT * FROM impulse_shape_activity_score WHERE activity_id = '${activity}';`));
  return { vpm: v, cts: c, shape: s, shapeActivity: i };
}
async function execRow(id: string): Promise<{ tags: string[] } | undefined> {
  const r = await db!.sql(`${USE} SELECT tags FROM execution:\`${id}\`;`);
  return r[r.length - 1].result[0];
}
async function insert(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await app!.request('/v2/activities/execution-traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as Record<string, unknown>;
}
const tablesWritten = (calls: Array<{ sql: string }>): string[] => LEARNING_TABLES.filter((t) => calls.some((c) => WRITE(t).test(c.sql)));

let obsCalls: Array<{ sql: string }> = [];
let learnCalls: Array<{ sql: string }> = [];
let learnState: Awaited<ReturnType<typeof state>> | null = null;
let obsEmitted: typeof emitted = [];
let obsFetched: string[] = [];
let obsResponses: Array<Record<string, unknown>> = [];
let learnEmitted: typeof emitted = [];
let learnFetched: string[] = [];

beforeAll(async () => {
  try {
    db = await startRealSurreal();
    client = await db.connectModuleClient();
    globalThis.fetch = (async (input: unknown) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const redisMod = await import('../db/redis');
    const broadcasterMod = await import('../websocket/broadcaster');
    const variantCreatorMod = await import('../services/variant-creator');
    const stub = (obj: any, key: string, impl: (...args: any[]) => unknown) => {
      if (obj == null || typeof obj[key] !== 'function') return;
      spies.push(spyOn(obj, key).mockImplementation(impl as never));
    };
    const redisProto = (redisMod as any).RedisClient?.prototype;
    stub(redisProto, 'del', async () => 0);
    stub(redisProto, 'get', async () => null);
    stub(redisProto, 'set', async () => 'OK');
    stub(redisProto, 'sadd', async () => 0);
    stub(redisProto, 'smembers', async () => []);
    stub(redisProto, 'srem', async () => 0);
    stub(redisProto, 'withLock', async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn());
    stub(redisProto, 'getClient', () => null);
    stub((broadcasterMod as any).broadcaster, 'emit', (e: any) => { emitted.push(e); });
    stub(variantCreatorMod, 'autoCreateVariantIfNeeded', async () => null);
    stub(variantCreatorMod, 'checkAndRetireTemplate', async () => false);
    stub(variantCreatorMod, 'checkAndRetireByPosterior', async () => false);
    const ET = (await import('./execution-traces')).default;
    await import('../lib/posterior-update');
    AGG = await import('../lib/posterior-aggregator');
    LANE = await import('../lib/context-posterior-lane');
    app = new Hono();
    app.route('/v2/activities/execution-traces', ET);
    await db.sql(`${USE} ${[vpm(OBS), vpm(LEARN), exec('ins-parent-obs', PARENT), exec('ins-parent-learn', PARENT), selection(OBS, 'ins-obs-corr'), selection(LEARN, 'ins-learn-corr')].join('\n')}`);

    // 1. the observe inserts, alone in their window: one per decision-outcome path
    db.calls.length = 0;
    const e0 = emitted.length, f0 = fetched.length;
    obsResponses = [
      await insert(traceBody('ins-obs-uni', OBS, 'ins-parent-obs', ['dispatcher_used:goal-host', 'learning_mode:observe', 'reached:true'])),
      await insert(traceBody('ins-obs-corr', OBS, 'ins-parent-obs', ['dispatcher_used:goal-host', 'learning_mode:observe', 'reached:true', 'correlation:ins-obs-corr'])),
    ];
    await Bun.sleep(800);
    await AGG.flushPosteriors({ db: client });
    obsCalls = [...db.calls];
    obsEmitted = emitted.slice(e0);
    obsFetched = fetched.slice(f0);
    // 2. the learn twins in their own window, polled until seen in vpm, cts and BOTH decision outcomes (lane drained)
    db.calls.length = 0;
    const e1 = emitted.length, f1 = fetched.length;
    await insert(traceBody('ins-learn-uni', LEARN, 'ins-parent-learn', ['dispatcher_used:goal-host', 'learning_mode:learn', 'reached:true']));
    await insert(traceBody('ins-learn-corr', LEARN, 'ins-parent-learn', ['dispatcher_used:goal-host', 'learning_mode:learn', 'reached:true', 'correlation:ins-learn-corr']));
    for (let n = 0; n < 100; n++) {
      await AGG.flushPosteriors({ db: client });
      learnState = await state(LEARN);
      if (learnState.cts.length > 0 && (learnState.vpm[0]?.a ?? 0) > 4 && LANE.contextLanePendingCount() === 0
        && (await decisionOutcome('ins-learn-corr')).length > 0 && (await decisionOutcome('ins-learn-uni')).length > 0) break;
      await Bun.sleep(150);
    }
    await Bun.sleep(300);
    learnCalls = [...db.calls];
    learnEmitted = emitted.slice(e1);
    learnFetched = fetched.slice(f1);
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  globalThis.fetch = originalFetch;
  await db?.stop();
});

describe('POST / on the real engine: an observe-tagged trace is persisted, and nothing learns from it', () => {
  it('instrument: surreal started; the learn sentinel was seen in vpm AND cts before any observe assertion', async () => {
    expect(startError).toBe('');
    expect(learnState?.cts.length).toBe(1);
    expect(learnState?.vpm[0]?.a).toBeGreaterThan(4);
  }, 60_000);

  it('[MUST-FAIL] the observe inserts write no learning table, credit nothing, broadcast nothing; the traces persist', async () => {
    expect(obsResponses.map((r) => r.stored)).toEqual([true, true]);
    for (const id of ['ins-obs-uni', 'ins-obs-corr']) {
      const row = await execRow(id);
      expect(row?.tags).toContain('learning_mode:observe');
      expect(row?.tags).toContain('reach_observe:true');
    }
    expect(tablesWritten(obsCalls)).toEqual([]);
    const s = await state(OBS);
    expect(s.vpm).toEqual([{ a: 4, b: 2, n: 3 }]);
    expect(s.cts).toEqual([]);
    expect(s.shape).toEqual([]);
    expect(s.shapeActivity).toEqual([]);
    expect(await decisionOutcome('ins-obs-corr')).toEqual([]);
    expect(await decisionOutcome('ins-obs-uni')).toEqual([]);
    expect(obsEmitted.filter((e) => e.type === 'execution_completed')).toEqual([]);
    expect(obsFetched.filter((u) => u.includes('/learning/cochange'))).toEqual([]);
  }, 60_000);

  it('[CONTROL] the learn twins write exactly the seven learning tables, forward co-change and are broadcast', async () => {
    const written = tablesWritten(learnCalls);
    console.log(`[control] learn inserts wrote: ${JSON.stringify(written)}; state: ${JSON.stringify(learnState)}`);
    expect([...written].sort()).toEqual([...LEARNING_TABLES].sort());
    expect(learnState!.vpm[0]!.a).toBeGreaterThan(4);
    expect(learnState!.cts[0]!.alpha).toBeGreaterThan(1);
    expect(learnState!.shape[0]?.graded).toBeGreaterThan(0);
    expect(await decisionOutcome('ins-learn-corr')).toEqual([{ correlation_id: 'ins-learn-corr', activity_id: LEARN, reached: true }]);
    expect((await decisionOutcome('ins-learn-uni')).length).toBe(1);
    expect(learnFetched.filter((u) => u.includes('/learning/cochange')).length).toBe(2);
    expect(learnEmitted.filter((e) => e.type === 'execution_completed').map((e) => e.data?.execution_id).sort()).toEqual(['ins-learn-corr', 'ins-learn-uni']);
  }, 60_000);
});
