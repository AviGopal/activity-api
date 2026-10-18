// AN OBSERVE VERDICT IS RECORDED BY POST /reach AND GRADES NOTHING (real engine).
//
// goal-host's observe dispatch (learning_mode "observe": a probe, a held-out measurement) delivered its reach verdict
// to POST /reach like any other, and /reach graded it into the arm's posteriors on arrival: a probe taught the learner.
// goal-host now sends learning_mode:"observe" on the verdict (and the trace carries the dispatch's learning_mode:observe
// tag). Against a scratch SurrealDB built from the REAL schema and migrations (test/support/real-surreal.ts), driving
// the real route and the real applyOutcomeToPosteriors, then flushing the posterior aggregator:
//   [MUST-FAIL] an observe verdict (body field) leaves variant_performance_metrics and context_thompson_scores
//               unchanged, while the verdict itself (reached, reached:true tag) is recorded and the row is marked
//               reach_observe:true;
//   [MUST-FAIL] a later /reach for the same execution WITHOUT the field (a spool drain) still grades nothing;
//   [MUST-FAIL] a trace tagged learning_mode:observe is not graded even when the verdict omits the field;
//   [CONTROL]   a learn verdict (field absent) on a twin arm still credits α in both tables.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const ORG = 'organizations:reach-observe-probe';
const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const OBS = `obs-arm-${word()}`;
const TAGGED = `obs-tagged-arm-${word()}`;
const LEARN = `learn-arm-${word()}`;
const SIG = 'a1b2c3d4e5f60718';

let db: RealSurreal | null = null;
let client: any = null;
let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let AGG: any;
let startError = '';

function exec(id: string, activity: string, tags: string[]): string {
  return `CREATE execution:\`${id}\` CONTENT { activity_id: '${activity}', input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now() - 1m, created_at: time::now(), status: 'success', signature: '${SIG}', signature_version: 1, tags: ${JSON.stringify(tags)} };`;
}
function vpm(activity: string): string {
  return `CREATE variant_performance_metrics CONTENT { variant_id: '${activity}', activity_id: '${activity}', org_id: '${ORG}', total_executions: 3, successful_executions: 3, failed_executions: 0, success_rate: 1.0, avg_duration_ms: 10.0, avg_cost_usd: 0.0, thompson_alpha: 4.0, thompson_beta: 2.0, total_selections: 3, created_at: time::now(), updated_at: time::now() };`;
}
async function state(activity: string): Promise<{ vpm: Array<{ a: number; b: number }>; cts: Array<{ alpha: number; beta: number }> }> {
  const v = await db!.sql(`${USE} SELECT thompson_alpha AS a, thompson_beta AS b FROM variant_performance_metrics WHERE variant_id = '${activity}' AND org_id = '${ORG}';`);
  const c = await db!.sql(`${USE} SELECT alpha, beta FROM context_thompson_scores WHERE template_id = '${activity}' AND org_id = '${ORG}';`);
  return { vpm: v[v.length - 1].result, cts: c[c.length - 1].result };
}
async function row(id: string): Promise<{ reached: unknown; tags: string[] }> {
  const r = await db!.sql(`${USE} SELECT reached, tags FROM execution:\`${id}\`;`);
  return r[r.length - 1].result[0];
}
async function reach(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  const j = (await res.json()) as Record<string, unknown>;
  // grading is fire-and-forget: let it run, then flush every coalesced posterior delta to the engine
  await Bun.sleep(400);
  await AGG.flushPosteriors({ db: client });
  await AGG.flushPosteriors({ db: client });
  return j;
}

beforeAll(async () => {
  try {
    db = await startRealSurreal();
    client = await db.connectModuleClient();
    ET = (await import('./execution-traces')).default as typeof ET;
    await import('../lib/posterior-update');
    AGG = await import('../lib/posterior-aggregator');
    await db.sql(`${USE} ${[
      exec('obs-1', OBS, ['dispatcher_used:goal-host']), vpm(OBS),
      exec('obs-tagged-1', TAGGED, ['dispatcher_used:goal-host', 'learning_mode:observe']), vpm(TAGGED),
      exec('learn-1', LEARN, ['dispatcher_used:goal-host']), vpm(LEARN),
    ].join('\n')}`);
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => { await db?.stop(); });

describe('POST /reach on the real engine: an observe verdict is recorded, not graded', () => {
  it('instrument: surreal started and the arms are seeded', async () => {
    expect(startError).toBe('');
    expect((await state(OBS)).vpm).toEqual([{ a: 4, b: 2 }]);
  }, 60_000);

  it('[MUST-FAIL] learning_mode:"observe" ⇒ vpm and cts unchanged; the verdict is recorded and marked', async () => {
    const j = await reach({ execution_id: 'obs-1', reached: true, completion_shapes: ['shellResult'], goal_hash: 'gh-obs', learning_mode: 'observe' });
    expect(Number(j.updated)).toBeGreaterThan(0);
    const s = await state(OBS);
    expect(s.vpm).toEqual([{ a: 4, b: 2 }]);
    expect(s.cts).toEqual([]);
    const r = await row('obs-1');
    expect(r.reached).toBe(true);
    expect(r.tags).toContain('reached:true');
    expect(r.tags).toContain('reach_observe:true');
    expect(r.tags).not.toContain('reach_graded:true');
  }, 60_000);

  it('[MUST-FAIL] a later /reach for the same execution without the field still grades nothing', async () => {
    await reach({ execution_id: 'obs-1', reached: true, completion_shapes: ['shellResult'] });
    const s = await state(OBS);
    expect(s.vpm).toEqual([{ a: 4, b: 2 }]);
    expect(s.cts).toEqual([]);
  }, 60_000);

  it('[MUST-FAIL] a trace tagged learning_mode:observe is not graded even when the verdict omits the field', async () => {
    await reach({ execution_id: 'obs-tagged-1', reached: false, completion_shapes: [], reason: 'hollow' });
    const s = await state(TAGGED);
    expect(s.vpm).toEqual([{ a: 4, b: 2 }]);
    expect(s.cts).toEqual([]);
    expect((await row('obs-tagged-1')).reached).toBe(false);
  }, 60_000);

  it('[CONTROL] a learn verdict still credits α on the arm and its signature row', async () => {
    await reach({ execution_id: 'learn-1', reached: true, completion_shapes: ['shellResult'], goal_hash: 'gh-learn' });
    const s = await state(LEARN);
    expect(s.vpm.length).toBe(1);
    expect(s.vpm[0]!.a).toBeGreaterThan(4);
    expect(s.cts.length).toBe(1);
    expect(s.cts[0]!.alpha).toBeGreaterThan(1);
    expect((await row('learn-1')).tags).toContain('reach_graded:true');
  }, 60_000);
});
