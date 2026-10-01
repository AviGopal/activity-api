/**
 * shape_score_counter against a REAL SurrealDB 2.3.3 (lib/shape-score-counter.ts, migration 213).
 *
 * Drives the shipped applyOutcomeToPosteriors (the learner's credit path), the retention sweep, the
 * seed job and getShapeConditionedScores. Runs only with SCRATCH_SURREALDB_URL (loopback, never
 * :8000/:18000) and its own database; skipped otherwise.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'shape_counter_test';
if (SCRATCH) {
  const u = new URL(SCRATCH);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || ['8000', '18000'].includes(u.port)) {
    throw new Error(`refusing non-scratch SurrealDB: ${SCRATCH}`);
  }
  process.env.SURREALDB_URL = SCRATCH;
  process.env.SURREALDB_NAMESPACE = 'activity-system';
  process.env.SURREALDB_DATABASE = TEST_DB;
  process.env.SURREALDB_USERNAME = 'root';
  process.env.SURREALDB_PASSWORD = process.env.SCRATCH_SURREALDB_PASS ?? 'root';
}
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';

const run = SCRATCH ? describe : describe.skip;
const MIGRATION_213 = readFileSync(new URL('../../sql/migrations/213-shape-score-counter.surql', import.meta.url), 'utf8');
const ORG = 'organizations:o';
const SHAPES = ['y', 'x'];

run('shape_score_counter (scratch SurrealDB)', () => {
  let db: typeof import('../db/surreal')['surrealDB'];
  let PU: typeof import('./posterior-update');
  let AGG: typeof import('./posterior-aggregator');
  let P: typeof import('../db/paradigm');
  let SEED: typeof import('../jobs/shape-score-counter-seed');
  let TR: typeof import('../services/trace-retention');
  let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) throw new Error('not the scratch DB — refusing');
    db = (await import('../db/surreal')).surrealDB;
    PU = await import('./posterior-update');
    AGG = await import('./posterior-aggregator');
    P = await import('../db/paradigm');
    SEED = await import('../jobs/shape-score-counter-seed');
    TR = await import('../services/trace-retention');
    ET = (await import('../routes/execution-traces')).default as typeof ET;
    if (typeof PU.applyOutcomeToPosteriors !== 'function' || typeof P.getShapeConditionedScores !== 'function') {
      throw new Error('modules are mocked in this process — run this file on its own');
    }
  });

  beforeEach(async () => {
    await db.query(['execution', 'shape_score_counter', 'shape_score_counted', 'shape_score_counter_seed', 'variant_performance_metrics']
      .map((t) => `REMOVE TABLE IF EXISTS ${t};`).join(' '));
    // Drain any VPM deltas a previous test left in the in-process coalescing buffer (into nothing).
    await AGG.flushPosteriors();
    await db.query('DEFINE TABLE execution SCHEMALESS; DEFINE INDEX idx_execution_executed_at ON execution FIELDS executed_at;');
    await db.query(MIGRATION_213);
  });

  let seq = 0;
  async function exec(o: { id?: string; success: boolean; tags?: string[]; shapes?: string[]; activity?: string; ageMs?: number }) {
    const id = o.id ?? `e${seq++}`;
    await db.query('INSERT INTO execution $r RETURN NONE', { r: {
      id, activity_id: o.activity ?? 'A', org_id: ORG, success: o.success, tags: o.tags ?? [],
      input_impulse_shapes: o.shapes ?? SHAPES, executed_at: new Date(Date.now() - (o.ageMs ?? 3 * 86_400_000)),
    } });
    return id;
  }
  /** The learner's credit call, with exactly the arguments the execution-traces routes pass. */
  async function grade(id: string, o: { success: boolean; tags?: string[]; occasion: 'insert' | 'reach'; activity?: string }) {
    await PU.applyOutcomeToPosteriors(
      { activity_id: o.activity ?? 'A', success: o.success, failure_mode: null, execution_id: id, tags: o.tags, grading_occasion: o.occasion },
      db, ORG,
    );
  }
  /** The REAL late-verdict route (POST /execution-traces/reach); its credit call is fire-and-forget. */
  async function reachPatch(id: string, reached: boolean) {
    const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ execution_id: id, reached }) });
    const body = await res.json() as { success?: boolean; updated?: number };
    expect([res.status, body.success]).toEqual([200, true]);
    await new Promise((r) => setTimeout(r, 300));
  }
  const counter = async (activity = 'A') =>
    (await db.query<Record<string, number>>('SELECT * FROM shape_score_counter WHERE activity_id = $a', { a: activity }))[0];
  async function vpm(activity = 'A') {
    await AGG.flushPosteriors();
    return (await db.query<{ thompson_alpha: number; thompson_beta: number }>(
      'SELECT thompson_alpha, thompson_beta FROM variant_performance_metrics WHERE variant_id = $a', { a: activity }))[0];
  }
  const vpmRow = (activity = 'A') => db.query(
    'CREATE variant_performance_metrics CONTENT { variant_id: $a, org_id: $o, thompson_alpha: 1.0, thompson_beta: 1.0, updated_at: time::now() }',
    { a: activity, o: ORG });
  const posterior = async () => {
    const r = await P.getShapeConditionedScores(ORG, ['A'], SHAPES);
    const row = r.data.find((d) => d.activity_id === 'A');
    return row ? [row.alpha, row.beta] : null;
  };

  test('MUST-FAIL GUARD: a completed but NOT-REACHED execution counts f, never s; an ungraded success counts nothing', async () => {
    const a = await exec({ success: true, tags: ['reached:false'] });
    await grade(a, { success: true, tags: ['reached:false'], occasion: 'insert' });
    const b = await exec({ success: true });                 // exited 0, no verdict: ungraded
    await grade(b, { success: true, occasion: 'insert' });
    const c = await exec({ success: true, tags: ['dispatcher_used:goal-host'] }); // awaiting its verdict
    await grade(c, { success: true, tags: ['dispatcher_used:goal-host'], occasion: 'insert' });
    const k = await counter();
    expect([k?.graded, k?.reached, k?.not_reached]).toEqual([1, 0, 1]);
  });

  test('IDEMPOTENT: replaying the same grading leaves the count unchanged', async () => {
    const a = await exec({ success: true, tags: ['reached:true'] });
    for (let i = 0; i < 3; i++) await grade(a, { success: true, tags: ['reached:true'], occasion: 'insert' });
    const k = await counter();
    expect([k?.graded, k?.reached]).toEqual([1, 1]);
  });

  test('REGRADE not-reached -> reached (late /reach): counted again, and counter and VPM agree', async () => {
    await vpmRow();
    const a = await exec({ success: false });
    await grade(a, { success: false, occasion: 'insert' });                          // failed: not-reached, beta
    // The late verdict, with exactly the arguments POST /execution-traces/reach passes (gradedTags =
    // pre-patch tags + the verdict tag, occasion 'reach'). See the ROUTE tests for the route itself.
    await grade(a, { success: false, tags: ['reached:true'], occasion: 'reach' });
    const k = await counter();
    const v = await vpm();
    expect([k?.reached, k?.not_reached]).toEqual([1, 1]);
    expect(k?.alpha_sum).toBeCloseTo(v!.thompson_alpha - 1, 6);
    expect(k?.beta_sum).toBeCloseTo(v!.thompson_beta - 1, 6);
  });

  test('UNGRADED -> GRADED late verdict: counted once, by the late verdict, and counter and VPM agree', async () => {
    await vpmRow();
    const a = await exec({ success: true, tags: ['dispatcher_used:goal-host'] });
    await grade(a, { success: true, tags: ['dispatcher_used:goal-host'], occasion: 'insert' });
    expect(await counter()).toBeUndefined();
    expect(await vpm()).toMatchObject({ thompson_alpha: 1, thompson_beta: 1 });
    await grade(a, { success: true, tags: ['dispatcher_used:goal-host', 'reached:true'], occasion: 'reach' });
    const k = await counter();
    const v = await vpm();
    expect([k?.graded, k?.reached, k?.not_reached]).toEqual([1, 1, 0]);
    expect(k?.alpha_sum).toBeCloseTo(v!.thompson_alpha - 1, 6);
    expect(k?.beta_sum).toBeCloseTo(v!.thompson_beta - 1, 6);
  });

  test('ROUTE: after a real POST /execution-traces/reach, the counter and VPM still agree', async () => {
    await vpmRow();
    const a = await exec({ success: true, tags: ['dispatcher_used:goal-host'] });
    await grade(a, { success: true, tags: ['dispatcher_used:goal-host'], occasion: 'insert' });
    await reachPatch(a, true);
    await reachPatch(a, true); // a retried patch
    const k = await counter();
    const v = await vpm();
    expect(k?.alpha_sum ?? 0).toBeCloseTo(v!.thompson_alpha - 1, 6);
    expect(k?.beta_sum ?? 0).toBeCloseTo(v!.thompson_beta - 1, 6);
  });

  /** Was pinned as test.failing before d0 fixed the /reach pre-read (it never found the row). */
  test('ROUTE: a late reached verdict through POST /reach is graded once, into VPM and the counter', async () => {
    await vpmRow();
    const a = await exec({ success: true, tags: ['dispatcher_used:goal-host'] });
    await grade(a, { success: true, tags: ['dispatcher_used:goal-host'], occasion: 'insert' });
    await reachPatch(a, true);
    await reachPatch(a, true); // a retried patch credits nothing more
    const k = await counter();
    const v = await vpm();
    expect([k?.graded, k?.reached, k?.not_reached]).toEqual([1, 1, 0]);
    expect(v!.thompson_alpha).toBeGreaterThan(1);
    expect(k?.alpha_sum).toBeCloseTo(v!.thompson_alpha - 1, 6);
    expect(k?.beta_sum).toBeCloseTo(v!.thompson_beta - 1, 6);
  });

  test('CONSUMER: getShapeConditionedScores reads the counter — Beta(reached+1, not_reached+1), exact then subset', async () => {
    for (const ok of [true, true, true, false]) {
      const id = await exec({ success: ok, tags: [ok ? 'reached:true' : 'reached:false'] });
      await grade(id, { success: ok, tags: [ok ? 'reached:true' : 'reached:false'], occasion: 'insert' });
    }
    expect(await posterior()).toEqual([4, 2]);
    const sub = await P.getShapeConditionedScores(ORG, ['A'], ['x', 'y', 'z']);
    expect(sub.data.map((d) => [d.shape_signature, d.alpha, d.beta])).toEqual([[['x', 'y'], 4, 2]]);
  });

  test('qa CASE: retention deleting every FAILURE of a group (successes survive) leaves the posterior unchanged', async () => {
    const ids: string[] = [];
    // oldest first: f f s s
    for (const [i, ok] of [false, false, true, true].entries()) {
      const id = await exec({ success: ok, tags: [ok ? 'reached:true' : 'reached:false'], ageMs: 3 * 86_400_000 - i * 1000 });
      ids.push(id);
      await grade(id, { success: ok, tags: [ok ? 'reached:true' : 'reached:false'], occasion: 'insert' });
    }
    expect(await posterior()).toEqual([3, 3]);
    const cfg = { ...TR.loadTraceRetentionConfig({} as NodeJS.ProcessEnv), enabled: true, dryRun: false, activities: [], overrides: {},
      autoDiscover: false, globalCeiling: 2, globalCeilingBytes: 0, globalCeilingEnabled: true, orphanReapEnabled: false,
      ceilingPerSweepCap: 1_000_000, ceilingBudgetMs: 60_000, hotWindowMs: 3_600_000 };
    await TR.runTraceRetentionSweep(cfg);
    expect((await db.query<{ count: number }>('SELECT count() FROM execution GROUP ALL'))[0]?.count).toBe(2);
    expect(await posterior()).toEqual([3, 3]);
  });

  test('PRUNE: retention deletes the counting markers of the executions it deletes, in the same transaction', async () => {
    const old: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await exec({ success: false, ageMs: 3 * 86_400_000 - i * 1000 });
      old.push(id);
      await grade(id, { success: false, occasion: 'insert' });
    }
    const keep = await exec({ success: false, ageMs: 60_000 });
    await grade(keep, { success: false, occasion: 'insert' });
    expect((await db.query<{ count: number }>('SELECT count() FROM shape_score_counted GROUP ALL'))[0]?.count).toBe(6);
    const cfg = { ...TR.loadTraceRetentionConfig({} as NodeJS.ProcessEnv), enabled: true, dryRun: false, activities: [], overrides: {},
      autoDiscover: false, globalCeiling: 1, globalCeilingBytes: 0, globalCeilingEnabled: true, orphanReapEnabled: false,
      ceilingPerSweepCap: 1_000_000, ceilingBudgetMs: 60_000, hotWindowMs: 3_600_000 };
    await TR.runTraceRetentionSweep(cfg);
    const left = await db.query<string>('SELECT VALUE eid FROM shape_score_counted');
    expect(left).toEqual([keep]);
    expect((await counter())?.not_reached).toBe(6); // the counter itself is never decremented
  });

  test('CONCURRENCY: concurrent gradings (incl. duplicates) of one group make ONE counter row with exact counts', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await exec({ success: i % 3 !== 0, tags: [i % 3 !== 0 ? 'reached:true' : 'reached:false'] }));
    const calls = [...ids, ...ids].map((id, j) => grade(id, {
      success: (j % 12) % 3 !== 0, tags: [(j % 12) % 3 !== 0 ? 'reached:true' : 'reached:false'], occasion: 'insert' }));
    await Promise.allSettled(calls);
    const rows = await db.query<Record<string, number>>('SELECT * FROM shape_score_counter');
    const marked = (await db.query<{ count: number }>('SELECT count() FROM shape_score_counted GROUP ALL'))[0]?.count ?? 0;
    expect(rows.length).toBe(1);
    expect(rows[0]!.graded).toBe(marked); // every counted grading has exactly one marker, none twice
    expect(marked).toBe(12);
    expect([rows[0]!.reached, rows[0]!.not_reached]).toEqual([8, 4]);
  });

  test('SEED: replays classifyReach over retained executions; re-run safe; skips what the live path counted', async () => {
    await exec({ success: true, tags: ['reached:true'] });
    await exec({ success: true, tags: ['reached:false'] });
    await exec({ success: false });                                  // failure: not-reached
    await exec({ success: true });                                   // ungraded: not counted
    await exec({ success: true, tags: ['reached:true'], shapes: [] }); // unshaped: not counted
    // Late tag ONLY — persisted by the /reach mirror but never graded (no reach_graded:true): VPM never
    // received it, so the seed must not count it either.
    const lateOnly = await exec({ success: true, tags: ['dispatcher_used:goal-host', 'reached:true'] });
    await db.query('UPDATE type::thing("execution", $id) SET completion_shapes = []', { id: lateOnly });
    // Ungraded at insert (goal-host walk, never patched): not counted.
    await exec({ success: true, tags: ['dispatcher_used:goal-host'] });
    // Positive control: a late verdict that WAS credited (reach_graded:true) is seeded, as 'reach'.
    const credited = await exec({ success: true, tags: ['dispatcher_used:goal-host', 'reach_graded:true', 'reached:true'] });
    await db.query('UPDATE type::thing("execution", $id) SET completion_shapes = []', { id: credited });
    const live = await exec({ success: true, tags: ['reached:true'] });
    await grade(live, { success: true, tags: ['reached:true'], occasion: 'insert' }); // already counted live
    const r1 = await SEED.runShapeCounterSeedTick({ pageSize: 50 });
    expect(r1.done).toBe(true);
    let k = await counter();
    expect([k?.graded, k?.reached, k?.not_reached]).toEqual([5, 3, 2]);
    const markerOf = async (id: string) => (await db.query<{ occasions: string[] }>(
      'SELECT occasions FROM type::thing("shape_score_counted", $id)', { id }))[0]?.occasions ?? null;
    expect(await markerOf(lateOnly)).toBeNull();
    expect(await markerOf(credited)).toEqual(['reach']);
    expect(await SEED.runShapeCounterSeedTick()).toMatchObject({ done: true, scanned: 0 });
    await db.query('UPDATE shape_score_counter_seed:v1 SET done = false, cursor = NONE'); // force a full re-run
    await SEED.runShapeCounterSeedTick({ pageSize: 2 });
    k = await counter();
    expect([k?.graded, k?.reached, k?.not_reached]).toEqual([5, 3, 2]);
  });
});
