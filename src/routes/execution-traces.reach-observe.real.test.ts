// AN OBSERVE VERDICT IS RECORDED BY POST /reach AND GRADES NOTHING (real engine).
//
// goal-host's observe dispatch (learning_mode "observe": a probe, a held-out measurement) delivered its reach verdict
// to POST /reach like any other, and /reach graded it into the arm's posteriors on arrival: a probe taught the learner.
// goal-host now sends learning_mode:"observe" on the verdict (and the trace carries the dispatch's learning_mode:observe
// tag). Against a scratch SurrealDB built from the REAL schema and migrations (test/support/real-surreal.ts), driving
// the real route and the real applyOutcomeToPosteriors.
//
// NO VACUOUS PASS. Grading is fire-and-forget and the cts write follows an awaited prior seed, so "no row yet" proves
// nothing on its own. Every observe assertion is made only AFTER a learn SENTINEL verdict, sent after the observe one,
// has been seen landing in BOTH vpm and cts (bounded poll, flushing the aggregator): whatever the observe verdict would
// have written was enqueued before the sentinel's.
//   [MUST-FAIL] learning_mode:"observe" ⇒ vpm and cts unchanged; the verdict (reached, reached:true) is recorded and
//               the row marked reach_observe:true;
//   [MUST-FAIL] a later /reach for the same execution WITHOUT the field (a spool drain) still grades nothing;
//   [MUST-FAIL] a trace tagged learning_mode:observe is not graded even when the verdict omits the field;
//   [CONTROL]   each sentinel (a learn verdict) credits α in vpm and cts.
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
const SENT = [1, 2, 3].map((i) => `sentinel-${i}-arm-${word()}`);
const SIG = 'a1b2c3d4e5f60718';

let db: RealSurreal | null = null;
let client: any = null;
let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let AGG: any;
let LANE: any;
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
  return (await res.json()) as Record<string, unknown>;
}
/** Send a learn sentinel verdict and poll (bounded) until it is seen in vpm AND cts with the cts lane drained. */
async function settleOnSentinel(i: number): Promise<{ vpm: Array<{ a: number }>; cts: Array<{ alpha: number }> }> {
  await reach({ execution_id: `sentinel-${i + 1}`, reached: true, completion_shapes: ['shellResult'], goal_hash: `gh-sent-${i}` });
  let s = await state(SENT[i]!);
  for (let n = 0; n < 100; n++) {
    await AGG.flushPosteriors({ db: client });
    s = await state(SENT[i]!);
    if (s.cts.length > 0 && (s.vpm[0]?.a ?? 0) > 4 && LANE.contextLanePendingCount() === 0) break;
    await Bun.sleep(150);
  }
  return s;
}

beforeAll(async () => {
  try {
    db = await startRealSurreal();
    client = await db.connectModuleClient();
    ET = (await import('./execution-traces')).default as typeof ET;
    await import('../lib/posterior-update');
    AGG = await import('../lib/posterior-aggregator');
    LANE = await import('../lib/context-posterior-lane');
    await db.sql(`${USE} ${[
      exec('obs-1', OBS, ['dispatcher_used:goal-host']), vpm(OBS),
      exec('obs-tagged-1', TAGGED, ['dispatcher_used:goal-host', 'learning_mode:observe']), vpm(TAGGED),
      ...SENT.flatMap((arm, i) => [exec(`sentinel-${i + 1}`, arm, ['dispatcher_used:goal-host']), vpm(arm)]),
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

  it('[MUST-FAIL] learning_mode:"observe" ⇒ vpm and cts unchanged (after the sentinel credited); recorded and marked', async () => {
    const j = await reach({ execution_id: 'obs-1', reached: true, completion_shapes: ['shellResult'], goal_hash: 'gh-obs', learning_mode: 'observe' });
    expect(Number(j.updated)).toBeGreaterThan(0);
    const sent = await settleOnSentinel(0);
    expect(sent.cts.length).toBe(1);            // [CONTROL] the learn sentinel landed in both tables first
    expect(sent.vpm[0]!.a).toBeGreaterThan(4);
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
    const sent = await settleOnSentinel(1);
    expect(sent.cts.length).toBe(1);
    const s = await state(OBS);
    expect(s.vpm).toEqual([{ a: 4, b: 2 }]);
    expect(s.cts).toEqual([]);
  }, 60_000);

  it('[MUST-FAIL] a trace tagged learning_mode:observe is not graded even when the verdict omits the field', async () => {
    await reach({ execution_id: 'obs-tagged-1', reached: false, completion_shapes: [], reason: 'hollow' });
    const sent = await settleOnSentinel(2);
    expect(sent.cts.length).toBe(1);
    const s = await state(TAGGED);
    expect(s.vpm).toEqual([{ a: 4, b: 2 }]);
    expect(s.cts).toEqual([]);
    expect((await row('obs-tagged-1')).reached).toBe(false);
  }, 60_000);

  it('[CONTROL] every learn sentinel credited α on its arm and its signature row, and was stamped graded', async () => {
    for (let i = 0; i < SENT.length; i++) {
      const s = await state(SENT[i]!);
      expect(s.vpm[0]!.a).toBeGreaterThan(4);
      expect(s.cts.length).toBe(1);
      expect(s.cts[0]!.alpha).toBeGreaterThan(1);
      expect((await row(`sentinel-${i + 1}`)).tags).toContain('reach_graded:true');
    }
  }, 60_000);
});
