// A DECLINED OUTCOME SENT TO POST /reach IS PERSISTED ON THE REAL SCHEMA (real engine).
//
// The recorder test (execution-traces.reach-declined.test.ts) pins the route's decisions; this one pins that its writes
// are valid against the REAL schema and migrations (test/support/real-surreal.ts): `execution` is SCHEMAFULL, so a
// statement that names a field the table does not declare, or writes into metadata wrongly, would be dropped or fail
// silently and the decline would be lost while the route answered 200.
//   [MUST-FAIL] outcome:'declined' ⇒ the row carries declined:<class> and metadata.decline {class, reason_text,
//               decliner_id}; reached stays NONE; no reached:* or reach_graded tag; the arm's vpm row is unchanged.
//   [MUST-FAIL] the same decline redelivered ⇒ idempotent, updated 1, the row unchanged.
//   [MUST-FAIL] another org's caller ⇒ 403, the row unchanged.
//   [MUST-FAIL] a decline after a reached:false verdict was graded ⇒ 409, the row unchanged.
//   [CONTROL]   a row with no decline keeps its tags and metadata as seeded.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, useRealModules, type RealSurreal } from '../../test/support/real-surreal';

const ORG = 'organizations:reach-declined-probe';
const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ARM = `declined-arm-${word()}`;
const DECLINE = { class: 'decomposition_refused', reason_text: 'needs_information: no edit site named', decliner_id: 'satisfier:gapDecomposition' };

let db: RealSurreal | null = null;
let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let startError = '';
let restoreModules: () => void = () => {};
let callerOrg = ORG;

function exec(id: string): string {
  return `CREATE execution:\`${id}\` CONTENT { activity_id: '${ARM}', input_impulses: [], output_impulses: [], success: false, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now() - 1m, created_at: time::now(), status: 'failed', tags: ['dispatcher_used:goal-host'] };`;
}
async function row(id: string): Promise<{ reached: unknown; tags: string[]; metadata: any }> {
  const r = await db!.sql(`${USE} SELECT reached, tags, metadata FROM execution:\`${id}\`;`);
  return r[r.length - 1].result[0];
}
async function arm(): Promise<Array<{ a: number; b: number }>> {
  const v = await db!.sql(`${USE} SELECT thompson_alpha AS a, thompson_beta AS b FROM variant_performance_metrics WHERE variant_id = '${ARM}' AND org_id = '${ORG}';`);
  return v[v.length - 1].result;
}
async function reach(body: Record<string, unknown>, org = ORG): Promise<{ status: number; json: Record<string, unknown> }> {
  callerOrg = org;
  const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  try {
    await import('../lib/posterior-update');
    restoreModules = await useRealModules(['src/lib/tuning-params', 'src/lib/prior-seed', 'src/lib/embedding-lookup-cache', 'src/lib/posterior-aggregator',
      'src/db/paradigm', 'src/websocket/broadcaster', 'src/services/variant-creator']);
    db = await startRealSurreal();
    await db.connectModuleClient();
    const routes = (await import('./execution-traces')).default;
    const { Hono } = await import('hono');
    const h = new Hono();
    h.use('*', async (c, next) => { (c as any).set('jwtAuth', { jwtToken: 't', orgId: callerOrg, authType: 'apikey', keyId: 'k' }); await next(); });
    h.route('/', routes);
    ET = h;
    await db.sql(`${USE} ${exec('declined-1')} ${exec('plain-1')} ${exec('graded-1')} ${exec('foreign-1')} CREATE variant_performance_metrics CONTENT { variant_id: '${ARM}', activity_id: '${ARM}', org_id: '${ORG}', total_executions: 3, successful_executions: 2, failed_executions: 1, success_rate: 0.66, avg_duration_ms: 10.0, avg_cost_usd: 0.0, thompson_alpha: 4.0, thompson_beta: 2.0, total_selections: 3, created_at: time::now(), updated_at: time::now() };`);
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  restoreModules();
  await db?.stop();
});

describe('POST /reach on the real engine: a declined outcome is persisted, ungraded', () => {
  it('instrument: surreal started and the rows are seeded', async () => {
    expect(startError).toBe('');
    expect((await row('declined-1')).tags).toEqual(['dispatcher_used:goal-host']);
    expect(await arm()).toEqual([{ a: 4, b: 2 }]);
  }, 60_000);

  it('[MUST-FAIL] outcome:declined ⇒ declined:<class> + metadata.decline on the row, reached NONE, nothing graded', async () => {
    const r = await reach({ execution_id: 'declined-1', outcome: 'declined', decline: DECLINE });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, outcome: 'declined', declined: DECLINE.class, updated: 1 });
    const x = await row('declined-1');
    expect(x.tags).toEqual(expect.arrayContaining(['dispatcher_used:goal-host', `declined:${DECLINE.class}`]));
    expect(x.tags.some((t) => t.startsWith('reached:') || t === 'reach_graded:true')).toBe(false);
    expect(x.metadata?.decline).toEqual(DECLINE);
    expect(x.reached ?? null).toBe(null);
    expect(await arm()).toEqual([{ a: 4, b: 2 }]);
  }, 60_000);

  it('[MUST-FAIL] the same decline redelivered is idempotent and leaves the row as it was', async () => {
    const before = await row('declined-1');
    const r = await reach({ execution_id: 'declined-1', outcome: 'declined', decline: DECLINE });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, updated: 1, idempotent: true });
    expect(await row('declined-1')).toEqual(before);
  }, 60_000);

  it("[MUST-FAIL] another org's caller ⇒ 403, the row unchanged", async () => {
    const before = await row('foreign-1');
    const r = await reach({ execution_id: 'foreign-1', outcome: 'declined', decline: DECLINE }, 'organizations:someone-else');
    expect(r.status).toBe(403);
    expect(await row('foreign-1')).toEqual(before);
  }, 60_000);

  it('[MUST-FAIL] a decline after a graded reached:false ⇒ 409, the row unchanged', async () => {
    const g = await reach({ execution_id: 'graded-1', reached: false, completion_shapes: [] });
    expect(g.status).toBe(200);
    await Bun.sleep(300);
    const before = await row('graded-1');
    expect(before.tags).toEqual(expect.arrayContaining(['reach_graded:true', 'reached:false']));
    const r = await reach({ execution_id: 'graded-1', outcome: 'declined', decline: DECLINE });
    expect(r.status).toBe(409);
    expect(await row('graded-1')).toEqual(before);
  }, 60_000);

  it('[CONTROL] a row with no decline keeps its tags and metadata as seeded', async () => {
    const x = await row('plain-1');
    expect(x.tags).toEqual(['dispatcher_used:goal-host']);
    expect(x.metadata?.decline).toBeUndefined();
  }, 60_000);
});
