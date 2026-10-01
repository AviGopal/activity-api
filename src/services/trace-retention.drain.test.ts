/**
 * The set-based ceiling drain, run against a REAL SurrealDB — never a mirrored loop.
 *
 * The valve's guarantees are properties of statements the database executes (range bounds, a
 * count-then-delete transaction, ties at a boundary), so a fake that grants them for free proves
 * nothing. These tests run the shipped runTraceRetentionSweep / runCeilingDrainTick against a
 * THROWAWAY SurrealDB named by SCRATCH_SURREALDB_URL (e.g. `surreal start --bind
 * 127.0.0.1:28911 --user root --pass scratch memory`, then SCRATCH_SURREALDB_URL=http://127.0.0.1:28911
 * SCRATCH_SURREALDB_PASS=scratch bun test src/services/trace-retention.drain.test.ts).
 *
 * Without that variable the suite is SKIPPED, never pointed anywhere else: it deletes rows, so
 * it refuses any URL that is not loopback, refuses the substrate's own DB ports, and uses its own
 * database name, and it re-checks the resolved client config before the first statement.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'retention_drain_test';
if (SCRATCH) {
  const u = new URL(SCRATCH);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || ['8000', '18000'].includes(u.port)) {
    throw new Error(`refusing non-scratch SurrealDB for a destructive test: ${SCRATCH}`);
  }
  process.env.SURREALDB_URL = SCRATCH;
  process.env.SURREALDB_NAMESPACE = 'activity-system';
  process.env.SURREALDB_DATABASE = TEST_DB;
  process.env.SURREALDB_USERNAME = 'root';
  process.env.SURREALDB_PASSWORD = process.env.SCRATCH_SURREALDB_PASS ?? 'root';
}

import { describe, test, expect, beforeAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { readFileSync } from 'fs';

const COUNTER_MIGRATION = readFileSync(new URL('../../sql/migrations/213-shape-score-counter.surql', import.meta.url), 'utf8');

const run = SCRATCH ? describe : describe.skip;

type Mod = typeof import('./trace-retention');
let M: Mod;
let db: typeof import('../db/surreal')['surrealDB'];
let clearTuning: () => void;
let P: typeof import('../db/paradigm');
let PU: typeof import('../lib/posterior-update');

const DAY = 86_400_000;
const HOT_MS = 2 * 3600_000;

async function q<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
  return db.query<T>(sql, params);
}
async function total(): Promise<number> {
  const r = await q<{ count: number }>('SELECT count() FROM execution GROUP ALL');
  return Number(r[0]?.count ?? 0);
}
async function setTuning(name: string, value: number): Promise<void> {
  await q('UPSERT type::thing("substrate_tuning_param", $name) SET name = $name, `value` = $value', { name, value });
}

/**
 * `cold` rows spread over the past days (oldest first), PAIRED so every timestamp is shared by two
 * rows — a boundary tie at every step, which is what an off-by-one `<=` would over-delete — plus
 * `hot` rows inside the hot window.
 */
async function seed(cold: number, hot: number, opts: { allSameTs?: boolean } = {}): Promise<void> {
  const now = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < cold; i++) {
    const ts = opts.allSameTs ? now - 3 * DAY : now - 3 * DAY + Math.floor(i / 2) * 1000;
    rows.push({ id: `c${String(i).padStart(6, '0')}`, activity_id: 'a', success: true, executed_at: new Date(ts) });
  }
  for (let i = 0; i < hot; i++) {
    rows.push({ id: `h${String(i).padStart(6, '0')}`, activity_id: 'a', success: true, executed_at: new Date(now - 60_000 + i) });
  }
  for (let i = 0; i < rows.length; i += 500) await q('INSERT INTO execution $rows RETURN NONE', { rows: rows.slice(i, i + 500) });
}

function cfgFor(cap: number, over: Partial<ReturnType<Mod['loadTraceRetentionConfig']>> = {}) {
  return {
    ...M.loadTraceRetentionConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    dryRun: false,
    hotWindowMs: HOT_MS,
    activities: [],
    overrides: {},
    autoDiscover: false,
    globalCeiling: cap,
    globalCeilingBytes: 0,
    globalCeilingEnabled: true,
    orphanReapEnabled: false,
    ceilingPerSweepCap: 1_000_000,
    ceilingBudgetMs: 60_000,
    ...over,
  };
}

/** Every SQL text the valve sends, through either client entry point. */
let sent: string[] = [];
let origAll: (sql: string, p?: Record<string, unknown>) => Promise<unknown[]>;
let spies: Array<{ mockRestore: () => void }> = [];

run('set-based ceiling drain (real SurrealDB)', () => {
  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) {
      throw new Error(`client resolved ${config.surrealdb.url}/${config.surrealdb.database}, not the scratch DB — refusing`);
    }
    M = await import('./trace-retention');
    db = (await import('../db/surreal')).surrealDB;
    if (typeof (db as { queryAll?: unknown }).queryAll !== 'function') {
      throw new Error('../db/surreal is mocked in this process — run this file on its own');
    }
    const TP = await import('../lib/tuning-params');
    const TC = await import('../lib/telemetry-class');
    clearTuning = () => { TP.__clearTuningParamCache(); TP.__clearTuningParamListCache(); TC.__clearTelemetryClassCache(); };
    P = await import('../db/paradigm');
    PU = await import('../lib/posterior-update');
  });

  beforeEach(async () => {
    await q('REMOVE TABLE IF EXISTS shape_score_counter; REMOVE TABLE IF EXISTS shape_score_counted; REMOVE TABLE IF EXISTS shape_score_counter_seed; REMOVE TABLE IF EXISTS execution; REMOVE TABLE IF EXISTS substrate_tuning_param; REMOVE TABLE IF EXISTS trace_store_counters;');
    await q('DEFINE TABLE execution SCHEMALESS; DEFINE INDEX idx_execution_executed_at ON execution FIELDS executed_at; DEFINE INDEX idx_execution_activity ON execution FIELDS activity_id;');
    // The repo's own counter migration (d2), not a copy.
    await q(COUNTER_MIGRATION);
    await q('REMOVE TABLE IF EXISTS variant_performance_metrics; DEFINE TABLE substrate_tuning_param SCHEMALESS;');
    await setTuning('TRACE_RETENTION_DRAIN_BATCH', 40);
    await setTuning('TRACE_RETENTION_DRAIN_PAUSE_MS', 0);
    clearTuning();
    sent = [];
    const origQ = db.query.bind(db);
    const origA = db.queryAll.bind(db);
    origAll = origA;
    spies = [
      spyOn(db, 'query').mockImplementation(((sql: string, p?: Record<string, unknown>) => { sent.push(sql); return origQ(sql, p); }) as typeof db.query),
      spyOn(db, 'queryAll').mockImplementation(((sql: string, p?: Record<string, unknown>) => { sent.push(sql); return origA(sql, p); }) as typeof db.queryAll),
      spyOn(db, 'queryRaw').mockImplementation(((sql: string) => { sent.push(`RAW:${sql}`); throw new Error('queryRaw must not be used'); }) as typeof db.queryRaw),
    ];
  });
  afterEach(() => { for (const s of spies) s.mockRestore(); });

  const deleteStatements = () => sent.filter((s) => /\bDELETE\b/.test(s) && /execution/.test(s) && !/execution_trace_content/.test(s));

  test('over cap reaches EXACTLY the cap across several ticks, never below', async () => {
    await seed(1000, 0);
    const cfg = cfgFor(700, { ceilingPerSweepCap: 110 });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      await M.runTraceRetentionSweep(cfg);
      seen.push(await total());
    }
    // 110 per tick: 890, 780, 700 (clamped to the cap), then a no-op at the cap.
    expect(seen).toEqual([890, 780, 700, 700]);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(700);
  });

  test('at the cap the valve is a no-op: no delete statement, nothing removed', async () => {
    await seed(500, 0);
    await M.runTraceRetentionSweep(cfgFor(500));
    expect(await total()).toBe(500);
    expect(deleteStatements()).toEqual([]);
  });

  test('one row over the cap removes exactly that one row (node-1 steady state)', async () => {
    await seed(501, 0);
    await M.runTraceRetentionSweep(cfgFor(500));
    expect(await total()).toBe(500);
  });

  test('rows inside the hot window are kept even when the store stays over the cap', async () => {
    await seed(300, 200);
    await M.runTraceRetentionSweep(cfgFor(50));
    const left = await q<{ count: number }>(
      'SELECT count() FROM execution WHERE executed_at < type::datetime($cut) GROUP ALL',
      { cut: new Date(Date.now() - HOT_MS).toISOString() },
    );
    expect(Number(left[0]?.count ?? 0)).toBe(0); // every cold row went
    expect(await total()).toBe(200); // every hot row stayed, although 200 > 50
    expect(M.getLastCeilingOutcome()?.stoppedBy).toBe('empty');
  });

  test('deletes are SET-BASED: statements scale with batches, not rows', async () => {
    await seed(1000, 0);
    await M.runTraceRetentionSweep(cfgFor(200)); // 800 rows at batch 40
    expect(await total()).toBe(200);
    // ~20 batch transactions (ties at each boundary roll into the next batch, so a few more);
    // one-id-per-statement would be 800.
    expect(deleteStatements().length).toBeLessThanOrEqual(30);
    // The id-list path only mops up a final tie the range cannot split — never the bulk.
    expect(sent.filter((s) => /DELETE \$ids/.test(s)).length).toBeLessThanOrEqual(2);
  });

  test('the per-tick time budget bounds the work, and the next tick resumes', async () => {
    await seed(1000, 0);
    await setTuning('TRACE_RETENTION_DRAIN_PAUSE_MS', 60);
    clearTuning();
    await M.runTraceRetentionSweep(cfgFor(0 + 100, { ceilingBudgetMs: 150 }));
    const after = await total();
    const removed = 1000 - after;
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThanOrEqual(5 * 40); // a 150ms budget at 60ms pauses fits a handful of batches, not 900 rows
    expect(M.getLastCeilingOutcome()).toEqual({ remaining: after - 100, stoppedBy: 'budget' });
    // A valve-only drain tick picks up exactly where the budget stopped.
    await setTuning('TRACE_RETENTION_DRAIN_PAUSE_MS', 0);
    clearTuning();
    const tick = await M.runCeilingDrainTick(cfgFor(100));
    expect(tick.remaining).toBe(0);
    expect(await total()).toBe(100);
  });

  test('a batch killed after its DELETE ran is rolled back whole, and the drain still lands exactly on the cap', async () => {
    await seed(600, 0);
    // The 4th batch dies inside its transaction AFTER the DELETE executed (a kill / server abort
    // mid-batch). The whole batch must roll back — no partial delete — and the drain continues.
    let calls = 0;
    let beforeKilled = -1;
    let afterKilled = -1;
    spies.push(spyOn(db, 'queryAll').mockImplementation((async (sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/BEGIN TRANSACTION/.test(sql) && ++calls === 4) {
        beforeKilled = await total();
        const killed = sql.replace(/(DELETE execution WHERE executed_at < \$b RETURN NONE TIMEOUT \d+s;)/, '$1\nTHROW "killed mid-batch";');
        expect(killed).toContain('THROW');
        try {
          return await origAll(killed, p);
        } finally {
          afterKilled = await total();
        }
      }
      return origAll(sql, p);
    }) as typeof db.queryAll));
    await M.runTraceRetentionSweep(cfgFor(100));
    expect(beforeKilled).toBeGreaterThan(100);
    expect(afterKilled).toBe(beforeKilled); // nothing of the killed batch was applied
    expect(await total()).toBe(100);
  });

  test('a failing batch is retried narrower and the sweep still converges exactly', async () => {
    await seed(400, 0);
    let calls = 0;
    spies.push(spyOn(db, 'queryAll').mockImplementation(((sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/BEGIN TRANSACTION/.test(sql) && ++calls === 2) return Promise.reject(new Error('The operation timed out.'));
      return origAll(sql, p);
    }) as typeof db.queryAll));
    await M.runTraceRetentionSweep(cfgFor(100));
    expect(await total()).toBe(100);
  });

  test('a batch of IDENTICAL timestamps cannot be split by a range — falls back to ids, still exact', async () => {
    await seed(300, 0, { allSameTs: true });
    await M.runTraceRetentionSweep(cfgFor(100));
    expect(await total()).toBe(100);
  });

  test('ONE batch statement never deletes past the cold cutoff, however large its allowance', async () => {
    await seed(30, 200);
    const cut = new Date(Date.now() - HOT_MS).toISOString();
    const r = await M.runDrainBatch(cut, 1000, 1_000_000, 20);
    expect(r).toEqual({ fetched: 30, counted: 30, deleted: 30 });
    expect(await total()).toBe(200);
  });

  test('ONE batch statement refuses a range larger than its allowance and deletes nothing', async () => {
    await seed(100, 0);
    const cut = new Date(Date.now() - HOT_MS).toISOString();
    // 50 timestamps in hand -> the range below their max holds 48 rows (pairs tie at the max), allowance 10.
    const r = await M.runDrainBatch(cut, 50, 10, 20);
    expect(r.deleted).toBe(0);
    expect(r.counted).toBeGreaterThan(10);
    expect(await total()).toBe(100);
    // One short of the range: still nothing (the guard is exact, not approximate).
    const r1 = await M.runDrainBatch(cut, 50, r.counted - 1, 20);
    expect(r1.deleted).toBe(0);
    expect(await total()).toBe(100);
    // Exactly at the allowance it deletes.
    const r2 = await M.runDrainBatch(cut, 50, r.counted, 20);
    expect(r2.deleted).toBe(r.counted);
    expect(await total()).toBe(100 - r.counted);
  });

  test('dry run deletes nothing and reports what a real run would delete', async () => {
    await seed(400, 50);
    const r = await M.runTraceRetentionSweep(cfgFor(100, { dryRun: true }));
    expect(await total()).toBe(450);
    expect(deleteStatements()).toEqual([]);
    const g = r.results.find((x) => x.activityId === '__global_ceiling__');
    expect(g?.deletedEstimate).toBe(350);
    expect(g?.deletedActual).toBeNull();
  });

  // ── Shape-conditioned evidence survives the drain (shape_score_counter, migration 213) ─────────

  const ORG = 'organizations:o';
  /**
   * Shaped rows for one group, oldest first, `pattern` = 's' (reached) / 'f' (not-reached) per row,
   * each GRADED through the learner's real credit path; plus `hot` unshaped filler.
   */
  async function seedGroup(pattern: string, opts: { activity?: string; shapes?: string[]; hot?: number; sameTs?: boolean } = {}) {
    const now = Date.now();
    const rows: Array<Record<string, unknown>> = [];
    [...pattern].forEach((ch, i) => rows.push({
      id: `${opts.activity ?? 'A'}_${String(i).padStart(4, '0')}`,
      activity_id: opts.activity ?? 'A', org_id: ORG, success: ch === 's', tags: [ch === 's' ? 'reached:true' : 'reached:false'],
      input_impulse_shapes: opts.shapes ?? ['y', 'x'],
      executed_at: new Date(opts.sameTs ? now - 3 * DAY : now - 3 * DAY + i * 1000),
    }));
    for (let i = 0; i < (opts.hot ?? 0); i++) {
      rows.push({ id: `hot_${i}`, activity_id: 'Z', org_id: ORG, success: true, input_impulse_shapes: [],
        executed_at: new Date(now - 60_000 + i) });
    }
    for (let i = 0; i < rows.length; i += 500) await q('INSERT INTO execution $rows RETURN NONE', { rows: rows.slice(i, i + 500) });
    for (const r of rows.filter((x) => (x.input_impulse_shapes as string[]).length > 0)) {
      await PU.applyOutcomeToPosteriors({ activity_id: r.activity_id as string, success: r.success as boolean, failure_mode: null,
        execution_id: r.id as string, tags: r.tags as string[], grading_occasion: 'insert' }, db, ORG);
    }
  }
  async function posterior(activity = 'A', shapes = ['x', 'y']) {
    const r = await P.getShapeConditionedScores(ORG, [activity], shapes);
    const row = r.data.find((x) => x.activity_id === activity);
    return row ? { alpha: row.alpha, beta: row.beta, total: row.total_executions } : null;
  }
  const markerCount = async () => Number((await q<{ count: number }>('SELECT count() FROM shape_score_counted GROUP ALL'))[0]?.count ?? 0);

  test('COUNTER: draining a group completely leaves its posterior identical, and its markers go with it', async () => {
    await seedGroup('ssfsfs', { hot: 20 });
    const before = await posterior();
    expect(before).toEqual({ alpha: 5, beta: 3, total: 6 });
    await M.runTraceRetentionSweep(cfgFor(20));
    expect(await total()).toBe(20);
    expect(await posterior()).toEqual(before);
    expect(await markerCount()).toBe(0);
  });

  test('COUNTER (qa case): retiring every FAILURE of a group while its successes survive leaves the posterior identical', async () => {
    await seedGroup('ffss', { hot: 2 });
    const before = await posterior();
    expect(before).toEqual({ alpha: 3, beta: 3, total: 4 });
    await M.runTraceRetentionSweep(cfgFor(4)); // retires f f through the set-based range path
    expect(await total()).toBe(4);
    expect(await posterior()).toEqual(before);
    expect(await markerCount()).toBe(2); // the two survivors' markers remain, the retired two are gone
  });

  test('COUNTER: an all-success group keeps its posterior after a partial drain', async () => {
    await seedGroup('ssssss', { hot: 2 });
    const before = await posterior();
    expect(before).toEqual({ alpha: 7, beta: 1, total: 6 });
    await M.runTraceRetentionSweep(cfgFor(5));
    expect(await total()).toBe(5);
    expect(await posterior()).toEqual(before);
  });

  test('COUNTER: the id-list path (identical timestamps) keeps the posterior and prunes its markers', async () => {
    await seedGroup('sffsssfs', { hot: 5, sameTs: true });
    const before = await posterior();
    await M.runTraceRetentionSweep(cfgFor(5));
    expect(await total()).toBe(5);
    expect(sent.some((x) => /DELETE \$ids RETURN NONE TIMEOUT 20s/.test(x) && /shape_score_counted/.test(x))).toBe(true);
    expect(await posterior()).toEqual(before);
    expect(await markerCount()).toBe(0);
  });

  test('COUNTER: the stratified reservoir sweep keeps the posterior and prunes its markers', async () => {
    await seedGroup('s'.repeat(30) + 'fffff');
    const before = await posterior();
    await M.runTraceRetentionSweep(cfgFor(1_000_000, { activities: ['A'], defaultSuccessCap: 10, defaultFailureCap: 10 }));
    expect(await total()).toBe(15);
    expect(await posterior()).toEqual(before);
    expect(await markerCount()).toBe(15);
  });

  test('COUNTER: concurrent drain batches on one group leave the counter untouched and prune exactly the deleted markers', async () => {
    await seedGroup('sf'.repeat(60));
    const before = await posterior();
    const cut = new Date(Date.now() - HOT_MS).toISOString();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => M.runDrainBatch(cut, 20, 1000, 20)));
    const deleted = results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.deleted : 0), 0);
    expect(deleted).toBeGreaterThan(0);
    expect(await total()).toBe(120 - deleted);
    expect(await markerCount()).toBe(120 - deleted); // one marker per surviving execution, none for the deleted
    expect(await posterior()).toEqual(before);
    expect((await q('SELECT * FROM shape_score_counter')).length).toBe(1);
  });

  // ── Telemetry class first (migration 215: TRACE_RETENTION_TELEMETRY_ACTIVITIES, data) ──────────

  const TELE = 'auth_resolve_v1';
  /** `tele` telemetry rows that are NEWER than `other` gradable rows (both cold), plus optional hot telemetry. */
  async function seedMixed(tele: number, other: number, hotTele = 0) {
    const now = Date.now();
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < other; i++) rows.push({ id: `g${String(i).padStart(5, '0')}`, activity_id: 'gradable', success: true, executed_at: new Date(now - 5 * DAY + i * 1000) });
    for (let i = 0; i < tele; i++) rows.push({ id: `t${String(i).padStart(5, '0')}`, activity_id: TELE, success: false, tags: ['telemetry:auth'], executed_at: new Date(now - 1 * DAY + i * 1000) });
    for (let i = 0; i < hotTele; i++) rows.push({ id: `th${i}`, activity_id: TELE, success: false, tags: ['telemetry:auth'], executed_at: new Date(now - 60_000 + i) });
    for (let i = 0; i < rows.length; i += 500) await q('INSERT INTO execution $rows RETURN NONE', { rows: rows.slice(i, i + 500) });
  }
  const countOf = async (aid: string) => Number((await q<{ count: number }>('SELECT count() FROM execution WHERE activity_id = $a GROUP ALL', { a: aid }))[0]?.count ?? 0);
  async function declare(list: string | null) {
    await q('DELETE substrate_tuning_param WHERE name = "TRACE_RETENTION_TELEMETRY_ACTIVITIES"');
    if (list !== null) await q('CREATE substrate_tuning_param SET name = "TRACE_RETENTION_TELEMETRY_ACTIVITIES", `value` = $v', { v: list });
    clearTuning(); // stands in for the 30 s TTL
  }

  test('TELEMETRY FIRST: declared telemetry rows drain before OLDER gradable rows, and never past the cap', async () => {
    await seedMixed(300, 300);
    await declare(TELE);
    await M.runTraceRetentionSweep(cfgFor(400)); // surplus 200
    expect(await countOf(TELE)).toBe(100);
    expect(await countOf('gradable')).toBe(300); // the older gradable rows were not touched
    expect(await total()).toBe(400);
  });

  test('NON-TELEMETRY KEEP AGE ORDER: once telemetry is gone, the oldest gradable rows go next', async () => {
    await seedMixed(300, 300);
    await declare(TELE);
    await M.runTraceRetentionSweep(cfgFor(200)); // surplus 400 = 300 telemetry + 100 oldest gradable
    expect(await countOf(TELE)).toBe(0);
    expect(await countOf('gradable')).toBe(200);
    const left = await q<string>('SELECT VALUE meta::id(id) FROM execution WHERE activity_id = "gradable"');
    expect(left.sort()[0]).toBe('g00100'); // g00000..g00099 (the 100 oldest) are exactly the ones removed
  });

  test('DATA, NOT CODE: with no declaration the drain is purely age-ordered; authoring the row changes what drains', async () => {
    await seedMixed(300, 300);
    await declare(null);
    await M.runTraceRetentionSweep(cfgFor(500)); // surplus 100 → the 100 OLDEST, which are gradable
    expect([await countOf(TELE), await countOf('gradable')]).toEqual([300, 200]);
    await declare(TELE); // a tuning row, no code edit
    await M.runTraceRetentionSweep(cfgFor(400)); // surplus 100 → telemetry first
    expect([await countOf(TELE), await countOf('gradable')]).toEqual([200, 200]);
    await declare('some-other-id'); // re-declared: auth_resolve_v1 is no longer telemetry-class
    await M.runTraceRetentionSweep(cfgFor(300)); // surplus 100 → age order again: 100 oldest gradable
    expect([await countOf(TELE), await countOf('gradable')]).toEqual([200, 100]);
  });

  test('TELEMETRY in the hot window is kept, like every other row', async () => {
    await seedMixed(50, 0, 30);
    await declare(TELE);
    await M.runTraceRetentionSweep(cfgFor(1));
    expect(await countOf(TELE)).toBe(30);
  });

  test('COUNTER INVARIANT: draining telemetry leaves the reach-graded shape counter unchanged; telemetry is never counted', async () => {
    await declare(TELE);
    await seedGroup('ssfsf', { hot: 0 });            // gradable, counted through the real credit path
    // A shaped telemetry execution graded through the same credit path (it takes β live via the
    // ungraded-failure arm): declared and accepted telemetry-class, so the counter must not count it.
    await q('INSERT INTO execution $r RETURN NONE', { r: { id: 'tshaped', activity_id: TELE, org_id: ORG, success: false, tags: ['telemetry:auth'], input_impulse_shapes: ['y', 'x'], executed_at: new Date(Date.now() - 2 * DAY) } });
    await PU.applyOutcomeToPosteriors({ activity_id: TELE, success: false, failure_mode: null, execution_id: 'tshaped', tags: ['telemetry:auth', 'reached:false'], grading_occasion: 'insert' }, db, ORG);
    // A stale counting marker on a telemetry row (as if its counter row were gone): it must go with the row.
    await q('INSERT INTO execution $r RETURN NONE', { r: { id: 'tpre', activity_id: TELE, org_id: ORG, success: false, tags: ['telemetry:auth'], executed_at: new Date(Date.now() - 2 * DAY) } });
    await q('UPSERT shape_score_counted:tpre SET eid = "tpre", occasions = ["insert"], verdicts = ["not-reached"], counted_at = time::now()');
    await seedMixed(200, 0);
    const counterBefore = await q('SELECT * FROM shape_score_counter');
    const before = await posterior();
    expect((counterBefore as Array<Record<string, unknown>>).map((r) => r['activity_id'])).toEqual(['A']);
    await M.runTraceRetentionSweep(cfgFor(5));
    expect(await countOf(TELE)).toBe(0);
    expect(await q('SELECT * FROM shape_score_counter')).toEqual(counterBefore);
    expect(await posterior()).toEqual(before);
    expect(await q('SELECT VALUE eid FROM shape_score_counted WHERE eid = "tpre"')).toEqual([]); // pruned with its row
  });

  // ── The declaration is a deletion lever: ids with reach-graded evidence are refused ────────────

  const warnSpy = async <T,>(fn: () => Promise<T>) => {
    const { logger } = await import('../utils/logger');
    const seen: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    const sp = spyOn(logger, 'warn').mockImplementation(((msg: string, meta?: Record<string, unknown>) => { seen.push({ msg, meta: meta ?? {} }); }) as typeof logger.warn);
    try { await fn(); } finally { sp.mockRestore(); }
    return seen;
  };
  const vpmRow = (alpha: number, beta: number, org = ORG) => q(
    'CREATE variant_performance_metrics CONTENT { variant_id: $v, org_id: $o, thompson_alpha: $a, thompson_beta: $b, total_executions: 10, updated_at: time::now() }',
    { v: TELE, o: org, a: alpha, b: beta });

  test('GUARD: a declared id with reach CREDIT (VPM alpha > 1) is refused — logged, not drained first', async () => {
    await seedMixed(300, 300);
    await vpmRow(5, 3);
    await declare(TELE);
    const warns = await warnSpy(() => M.runTraceRetentionSweep(cfgFor(400)));
    expect([await countOf(TELE), await countOf('gradable')]).toEqual([300, 100]); // age order: the 200 older gradable rows went
    const refusal = warns.find((w) => w.meta['event'] === 'telemetry_class_refused');
    expect(refusal?.meta['activity_id']).toBe(TELE);
    expect(String(refusal?.meta['reason'])).toContain('thompson_alpha');
  });

  test('GUARD: a declared id with shape-counter rows is refused', async () => {
    await seedMixed(300, 300);
    await q('UPSERT type::thing("shape_score_counter", [$a, $o, ["x"]]) SET activity_id = $a, org_id = $o, shape_signature = ["x"], graded += 1, not_reached += 1', { a: TELE, o: ORG });
    await declare(TELE);
    const warns = await warnSpy(() => M.runTraceRetentionSweep(cfgFor(400)));
    expect([await countOf(TELE), await countOf('gradable')]).toEqual([300, 100]);
    expect(String(warns.find((w) => w.meta['event'] === 'telemetry_class_refused')?.meta['reason'])).toContain('shape_score_counter');
  });

  test('GUARD: auth_resolve_v1-like (alpha 1, huge failedByTask beta, org unknown, no counter rows) is still drained first', async () => {
    await seedMixed(300, 300);
    await vpmRow(1, 424903.25, 'unknown');
    await declare(TELE);
    const warns = await warnSpy(() => M.runTraceRetentionSweep(cfgFor(400)));
    expect([await countOf(TELE), await countOf('gradable')]).toEqual([100, 300]);
    expect(warns.some((w) => w.meta['event'] === 'telemetry_class_refused')).toBe(false);
  });

  test('GUARD fails CLOSED: if the evidence cannot be read, the declaration is refused', async () => {
    await seedMixed(300, 300);
    await declare(TELE);
    spies.push(spyOn(db, 'queryAll').mockImplementation((async (sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/shape_score_counter WHERE activity_id = \$aid/.test(sql)) throw new Error('store unreadable');
      return origAll(sql, p);
    }) as typeof db.queryAll));
    const warns = await warnSpy(() => M.runTraceRetentionSweep(cfgFor(400)));
    expect([await countOf(TELE), await countOf('gradable')]).toEqual([300, 100]);
    expect(String(warns.find((w) => w.meta['event'] === 'telemetry_class_refused')?.meta['reason'])).toContain('fail closed');
  });

  // ── Type widening (value is float | string): each reader refuses the other type, loudly ─────────

  test('TYPES: a numeric reader refuses a string row (env/default stands, logged); a list reader refuses a number', async () => {
    const TP = await import('../lib/tuning-params');
    await q('CREATE substrate_tuning_param SET name = "TYPES_PROBE_NUM", `value` = "2000"');
    await q('CREATE substrate_tuning_param SET name = "SOME_LIST", `value` = 0.6');
    clearTuning();
    const warns = await warnSpy(async () => {
      expect(await TP.getTuningParam("TYPES_PROBE_NUM", undefined, 77)).toBe(77);
      expect(await TP.getTuningParamList('SOME_LIST')).toEqual([]);
    });
    expect(warns.map((w) => w.meta['event']).sort()).toEqual(['tuning_param_list_type_mismatch', 'tuning_param_type_mismatch']);
  });

  test('CLIENT PATH: a drain batch goes through queryAll and survives an auth drop (reconnect + retry)', async () => {
    await seed(50, 0);
    await total(); // connected
    const inst = (db as unknown as { db: { query: (...a: unknown[]) => Promise<unknown> } }).db;
    const realQuery = inst.query.bind(inst);
    let dropped = 0;
    inst.query = async (...a: unknown[]) => {
      if (dropped === 0 && /BEGIN TRANSACTION/.test(String(a[0]))) {
        dropped++;
        throw new Error('Anonymous access not allowed');
      }
      return realQuery(...a);
    };
    const r = await M.runDrainBatch(new Date(Date.now() - HOT_MS).toISOString(), 20, 1000, 20);
    expect(dropped).toBe(1);
    expect(r.deleted).toBeGreaterThan(0);
    expect(await total()).toBe(50 - r.deleted);
    expect(sent.some((x) => x.startsWith('RAW:'))).toBe(false);
  });
});
