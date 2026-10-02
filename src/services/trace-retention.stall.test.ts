/**
 * The hub stall of 2026-10-01, reproduced against a REAL SurrealDB (same scratch guard as
 * trace-retention.drain.test.ts: SCRATCH_SURREALDB_URL, loopback only, never the substrate's ports,
 * its own database; skipped without it).
 *
 * On the hub the sweep logged its over-ceiling warning, then spent itself in the per-activity
 * reservoir (validator-dispatch, ~3 rows/s, no budget) and never reached the valve, so the declared
 * telemetry class (auth_resolve_v1, 68% of the store) was never drained and every later tick logged
 * only "already in flight". These tests pin the repaired properties:
 *   - over the ceiling the valve (telemetry first) runs BEFORE the per-activity reservoir;
 *   - the per-activity reservoir and the aux reap are time-budgeted;
 *   - a statement that runs past its TIMEOUT, or an await that never returns, is logged and
 *     abandoned, the sweep ENDS, and the in-flight flag is released;
 *   - the shape-counter seed skips the telemetry class and yields while the drain has surplus.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'retention_stall_test';
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
let SEED: typeof import('../jobs/shape-score-counter-seed');
let db: typeof import('../db/surreal')['surrealDB'];
let logger: typeof import('../utils/logger')['logger'];
let clearTuning: () => void;

const DAY = 86_400_000;
const HOT_MS = 2 * 3600_000;
const TELE = 'auth_resolve_v1';
const STRATUM = 'validator-dispatch';

async function q<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
  return db.query<T>(sql, params);
}
const countOf = async (aid: string) =>
  Number((await q<{ count: number }>('SELECT count() FROM execution WITH INDEX idx_execution_activity WHERE activity_id = $aid GROUP ALL', { aid }))[0]?.count ?? 0);
async function setTuning(name: string, value: number | string): Promise<void> {
  await q('UPSERT type::thing("substrate_tuning_param", $name) SET name = $name, `value` = $value', { name, value });
}

/** Hub-shaped: cold rows of the configured stratum OLDER than cold telemetry rows, plus hot rows. */
async function seedHubShape(stratum: number, tele: number, hot = 0): Promise<void> {
  const now = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < stratum; i++) rows.push({ id: `v${String(i).padStart(6, '0')}`, activity_id: STRATUM, success: true, executed_at: new Date(now - 5 * DAY + i * 1000) });
  for (let i = 0; i < tele; i++) rows.push({ id: `t${String(i).padStart(6, '0')}`, activity_id: TELE, success: false, tags: ['telemetry:auth'], executed_at: new Date(now - 1 * DAY + i * 1000) });
  for (let i = 0; i < hot; i++) rows.push({ id: `h${i}`, activity_id: 'other', success: true, executed_at: new Date(now - 60_000 + i) });
  for (let i = 0; i < rows.length; i += 500) await q('INSERT INTO execution $rows RETURN NONE', { rows: rows.slice(i, i + 500) });
}

function cfgFor(cap: number, over: Partial<ReturnType<Mod['loadTraceRetentionConfig']>> = {}) {
  return {
    ...M.loadTraceRetentionConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    dryRun: false,
    hotWindowMs: HOT_MS,
    activities: [STRATUM],
    overrides: {},
    autoDiscover: false,
    globalCeiling: cap,
    globalCeilingBytes: 0,
    globalCeilingEnabled: true,
    orphanReapEnabled: false,
    ceilingPerSweepCap: 1_000_000,
    ceilingBudgetMs: 60_000,
    deleteBatchSize: 25,
    defaultSuccessCap: 10,
    defaultFailureCap: 10,
    ...over,
  };
}

let sent: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];
let infos: Array<{ msg: string; meta: Record<string, unknown> }> = [];
let warns: Array<{ msg: string; meta: Record<string, unknown> }> = [];
let origQ: typeof db.query;
let origA: typeof db.queryAll;

run('trace-retention stall repair (real SurrealDB)', () => {
  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) {
      throw new Error(`client resolved ${config.surrealdb.url}/${config.surrealdb.database}, not the scratch DB — refusing`);
    }
    M = await import('./trace-retention');
    SEED = await import('../jobs/shape-score-counter-seed');
    db = (await import('../db/surreal')).surrealDB;
    logger = (await import('../utils/logger')).logger;
    if (typeof (db as { queryAll?: unknown }).queryAll !== 'function') {
      throw new Error('../db/surreal is mocked in this process — run this file on its own');
    }
    const TP = await import('../lib/tuning-params');
    const TC = await import('../lib/telemetry-class');
    clearTuning = () => { TP.__clearTuningParamCache(); TP.__clearTuningParamListCache(); TC.__clearTelemetryClassCache(); };
  });

  beforeEach(async () => {
    M.__setDrainPressureForTest(null, false);
    M.__resetStrataCursorForTest();
    await q('REMOVE TABLE IF EXISTS shape_score_counter; REMOVE TABLE IF EXISTS shape_score_counted; REMOVE TABLE IF EXISTS shape_score_counter_seed; REMOVE TABLE IF EXISTS execution; REMOVE TABLE IF EXISTS substrate_tuning_param; REMOVE TABLE IF EXISTS trace_store_counters; REMOVE TABLE IF EXISTS variant_performance_metrics;');
    await q('DEFINE TABLE execution SCHEMALESS; DEFINE INDEX idx_execution_executed_at ON execution FIELDS executed_at; DEFINE INDEX idx_execution_activity ON execution FIELDS activity_id;');
    await q(COUNTER_MIGRATION);
    await q('DEFINE TABLE substrate_tuning_param SCHEMALESS;');
    await setTuning('TRACE_RETENTION_DRAIN_BATCH', 40);
    await setTuning('TRACE_RETENTION_DRAIN_PAUSE_MS', 0);
    await setTuning('TRACE_RETENTION_TELEMETRY_ACTIVITIES', TELE);
    clearTuning();
    sent = []; infos = []; warns = [];
    origQ = db.query.bind(db);
    origA = db.queryAll.bind(db);
    spies = [
      spyOn(db, 'query').mockImplementation(((sql: string, p?: Record<string, unknown>) => { sent.push(sql); return origQ(sql, p); }) as typeof db.query),
      spyOn(db, 'queryAll').mockImplementation(((sql: string, p?: Record<string, unknown>) => { sent.push(sql); return origA(sql, p); }) as typeof db.queryAll),
      spyOn(logger, 'info').mockImplementation(((msg: string, meta?: Record<string, unknown>) => { infos.push({ msg, meta: meta ?? {} }); }) as typeof logger.info),
      spyOn(logger, 'warn').mockImplementation(((msg: string, meta?: Record<string, unknown>) => { warns.push({ msg, meta: meta ?? {} }); }) as typeof logger.warn),
    ];
  });
  afterEach(() => { for (const s of spies) s.mockRestore(); M.__setDrainPressureForTest(null, false); });

  const phases = () => infos.filter((i) => i.msg === '[trace-retention] phase').map((i) => i.meta);

  test('ORDER: over the ceiling the telemetry-first valve deletes BEFORE the per-activity reservoir issues a single delete', async () => {
    await seedHubShape(400, 600, 20);
    await M.runTraceRetentionSweep(cfgFor(500)); // surplus 520: all of it telemetry
    const firstTele = sent.findIndex((s) => /WITH INDEX idx_execution_activity WHERE activity_id = \$aid/.test(s) && /DELETE \$__ids/.test(s));
    const firstStratumDelete = sent.findIndex((s) => /DELETE \$ids RETURN NONE/.test(s));
    expect(firstTele).toBeGreaterThanOrEqual(0);
    expect(firstStratumDelete).toBeGreaterThan(firstTele);
    expect(await countOf(TELE)).toBe(80); // 600 - 520: the valve took its surplus from telemetry only
    // Phase log names every phase with its time and rows, valve first.
    const names = phases().map((p) => p['phase']);
    expect(names.indexOf('valve:telemetry_drain')).toBeLessThan(names.indexOf('strata'));
    const tele = phases().find((p) => p['phase'] === 'valve:telemetry_drain')!;
    expect(tele['removed']).toBe(520);
    expect(typeof tele['ms']).toBe('number');
    for (const k of ['select_ms', 'delete_ms', 'prune_ms']) expect(typeof tele[k]).toBe('number');
  });

  test('BUDGET: a slow per-activity reservoir stops at its phase budget instead of holding the sweep', async () => {
    await seedHubShape(2000, 0);
    await setTuning('TRACE_RETENTION_PHASE_BUDGET_MS', 1000);
    clearTuning();
    // The hub's ~8 s per 25-row reservoir delete, scaled down: 300 ms per stratum delete.
    spies.push(spyOn(db, 'queryAll').mockImplementation((async (sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/DELETE \$ids RETURN NONE/.test(sql)) await new Promise((r) => setTimeout(r, 300));
      return origA(sql, p);
    }) as typeof db.queryAll));
    const t0 = Date.now();
    await M.runTraceRetentionSweep(cfgFor(1_000_000)); // under the ceiling: only the reservoir runs
    const took = Date.now() - t0;
    const strata = phases().find((p) => p['phase'] === 'strata')!;
    expect(strata['stoppedBy']).toBe('budget');
    expect(Number(strata['removed'])).toBeGreaterThan(0);
    expect(Number(strata['removed'])).toBeLessThan(1990 - 10); // nowhere near the stratum's 1990-row target
    expect(took).toBeLessThan(5000);
    expect(M.getSweepPhase()).toBeNull(); // in-flight released
  });

  test('ROTATION + MARKER: a stratum that eats the whole budget cannot starve the strata after it; skipped strata say so', async () => {
    // Two cold strata: A (listed first) alone exceeds the phase budget; B is never reached in list order.
    const now = Date.now();
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2000; i++) rows.push({ id: `a${i}`, activity_id: 'stratum-a', success: true, executed_at: new Date(now - 5 * DAY + i * 1000) });
    for (let i = 0; i < 200; i++) rows.push({ id: `b${i}`, activity_id: 'stratum-b', success: true, executed_at: new Date(now - 5 * DAY + i * 1000) });
    for (let i = 0; i < rows.length; i += 500) await q('INSERT INTO execution $rows RETURN NONE', { rows: rows.slice(i, i + 500) });
    await setTuning('TRACE_RETENTION_PHASE_BUDGET_MS', 1000);
    clearTuning();
    spies.push(spyOn(db, 'queryAll').mockImplementation((async (sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/DELETE \$ids RETURN NONE/.test(sql)) await new Promise((r) => setTimeout(r, 300));
      return origA(sql, p);
    }) as typeof db.queryAll));
    const cfg = cfgFor(1_000_000, { activities: ['stratum-a', 'stratum-b'] });

    const r1 = await M.runTraceRetentionSweep(cfg);
    const b1 = r1.results.filter((r) => r.activityId === 'stratum-b');
    expect(b1.length).toBe(2);
    for (const r of b1) { expect(r.skipped).toBe('budget'); expect(r.coldCount).toBeNull(); }
    const aSwept = r1.results.find((r) => r.activityId === 'stratum-a' && r.status === 'success')!;
    expect(aSwept.skipped).toBeUndefined();
    expect(aSwept.coldCount).toBe(2000);
    const p1 = phases().filter((p) => p['phase'] === 'strata').at(-1)!;
    expect(p1['stoppedBy']).toBe('budget');
    expect(p1['skippedForBudget']).toBe(3); // a/failure, b/success, b/failure
    // A alone exhausted the budget it started with: the next sweep starts one PAST it.
    expect(M.__getStrataResumeAtForTest()).toBe('stratum-b');

    const r2 = await M.runTraceRetentionSweep(cfg);
    const bSwept = r2.results.find((r) => r.activityId === 'stratum-b' && r.status === 'success')!;
    expect(bSwept.skipped).toBeUndefined();
    expect(bSwept.coldCount).toBe(200);
    expect(Number(bSwept.deletedActual)).toBeGreaterThan(0);
    expect(phases().filter((p) => p['phase'] === 'strata').at(-1)!['startedAt']).toBe('stratum-b');
    expect(await countOf('stratum-b')).toBeLessThan(200);
  }, 30_000);

  test('MARKER: a sweep that finishes inside its budget reports no skipped strata and clears the cursor', async () => {
    await seedHubShape(50, 0);
    const r = await M.runTraceRetentionSweep(cfgFor(1_000_000));
    expect(r.results.every((x) => x.skipped === undefined && typeof x.coldCount === 'number')).toBe(true);
    expect(phases().find((p) => p['phase'] === 'strata')!['skippedForBudget']).toBe(0);
    expect(M.__getStrataResumeAtForTest()).toBeNull();
  });

  test('TIMEOUT: a telemetry statement forced past its TIMEOUT is logged, rolled back, and the sweep ENDS', async () => {
    await seedHubShape(0, 600);
    await setTuning('TRACE_RETENTION_DRAIN_STMT_TIMEOUT_S', 1);
    await setTuning('TRACE_RETENTION_DRAIN_MIN_BATCH', 40);
    clearTuning();
    // Force the candidate select to be slow ON THE SERVER: a per-row predicate costing ~10 ms that never
    // matches, so the select walks every row; without its TIMEOUT it would run ~6 s and return nothing.
    spies.push(spyOn(db, 'queryAll').mockImplementation(((sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      const slow = sql.replace(
        /AND executed_at < type::datetime\(\$cut\) LIMIT \$n TIMEOUT/,
        'AND executed_at < type::datetime($cut) AND array::len(array::range(0, 3000000)) < 0 LIMIT $n TIMEOUT',
      );
      return origA(slow, p);
    }) as typeof db.queryAll));
    const t0 = Date.now();
    const r = await M.runTraceRetentionSweep(cfgFor(100));
    expect(r.skipped).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(30_000);
    const failed = warns.filter((w) => w.msg.includes('telemetry batch failed'));
    expect(failed.length).toBeGreaterThanOrEqual(1);
    // Inside BEGIN/COMMIT the SDK surfaces the LATER statement's "failed transaction", not the
    // timeout itself; the batch's own ms (>= the 1 s TIMEOUT, far under the ~6 s unbounded run)
    // is what tells the two apart in the log.
    expect(String(failed[0]!.meta['error'])).toMatch(/timeout|timed out|failed transaction/i);
    expect(Number(failed[0]!.meta['ms'])).toBeGreaterThanOrEqual(900);
    expect(Number(failed[0]!.meta['ms'])).toBeLessThan(4000);
    const tele = phases().find((p) => p['phase'] === 'valve:telemetry_drain')!;
    expect(tele['stoppedBy']).toBe('failed');
    expect(tele['removed']).toBe(0); // every timed-out batch rolled back whole
    // The valve did not hang on it: the age-ordered range path ran next and took the surplus.
    expect(Number(phases().find((p) => p['phase'] === 'valve:range_drain')?.['removed'])).toBeGreaterThan(400);
    expect(await countOf(TELE)).toBe(100);
    expect(M.getSweepPhase()).toBeNull();
    // The flag was released: the next sweep runs instead of logging "already in flight".
    spies.pop()!.mockRestore();
    const next = await M.runTraceRetentionSweep(cfgFor(100));
    expect(next.skipped).toBeUndefined();
  }, 60_000);

  test('DEADLINE: an await that never returns is abandoned at the client deadline; the sweep ends and logs it', async () => {
    await seedHubShape(0, 300);
    await setTuning('TRACE_RETENTION_DRAIN_STMT_TIMEOUT_S', 1); // deadline = 3 x 1 s + 10 s grace
    clearTuning();
    let hung = 0;
    spies.push(spyOn(db, 'queryAll').mockImplementation(((sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/DELETE \$__ids/.test(sql) && hung++ === 0) return new Promise<unknown[]>(() => {}); // a silent socket
      return origA(sql, p);
    }) as typeof db.queryAll));
    const r = await M.runTraceRetentionSweep(cfgFor(100));
    expect(r.skipped).toBeUndefined();
    const failed = warns.find((w) => w.msg.includes('telemetry batch failed'));
    expect(String(failed?.meta['error'])).toContain('deadline exceeded');
    expect(await countOf(TELE)).toBe(100); // the drain continued after the abandoned batch
    expect(M.getSweepPhase()).toBeNull();
  }, 60_000);

  test('IN-FLIGHT LINE names the phase the running sweep is in', async () => {
    await seedHubShape(0, 300);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    spies.push(spyOn(db, 'queryAll').mockImplementation((async (sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/DELETE \$__ids/.test(sql)) await gate;
      return origA(sql, p);
    }) as typeof db.queryAll));
    const running = M.runTraceRetentionSweep(cfgFor(100));
    await new Promise((r) => setTimeout(r, 300));
    const skipped = await M.runTraceRetentionSweep(cfgFor(100));
    expect(skipped.skippedReason).toBe('in_flight');
    const line = infos.find((i) => i.msg.includes('already in flight'));
    expect((line?.meta['inFlightPhase'] as { name: string } | null)?.name).toBe('valve:telemetry_drain');
    release();
    await running;
  });

  test('ROLLUP: the bounded watermark read and UPSERTs (TIMEOUT clauses) run on the server and advance the watermark', async () => {
    await q('REMOVE TABLE IF EXISTS reach_history;');
    const now = Date.now();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, activity_id: 'graded', success: true, reached: i % 2 === 0, executed_at: new Date(now - DAY + i * 1000) }));
    await q('INSERT INTO execution $rows RETURN NONE', { rows });
    const r = await M.rollupReachHistory();
    expect(r).toEqual({ scanned: 5, weeks: expect.any(Number) });
    expect(r!.weeks).toBeGreaterThanOrEqual(1);
    expect(warns.some((w) => w.msg.includes('rollup failed'))).toBe(false);
    const wk = await q<{ reached: number; total: number }>('SELECT reached, total FROM reach_history WHERE week != NONE');
    expect(wk.reduce((n, x) => n + x.total, 0)).toBe(5);
    expect(wk.reduce((n, x) => n + x.reached, 0)).toBe(3);
    const wm = (await q<{ last_executed_at?: unknown }>('SELECT last_executed_at FROM reach_history:__watermark__'))[0];
    expect(wm?.last_executed_at).toBeTruthy();
    for (const k of ['watermark read', 'week upsert', 'watermark upsert']) {
      expect(sent.some((x) => /TIMEOUT \d+s/.test(x) && (k === 'watermark read' ? /SELECT last_executed_at FROM reach_history/.test(x) : k === 'week upsert' ? /UPSERT reach_history:\[/.test(x) : /UPSERT reach_history:__watermark__/.test(x)))).toBe(true);
    }
    // Incremental: a second run sees nothing new past the watermark.
    expect(await M.rollupReachHistory()).toEqual({ scanned: 0, weeks: 0 });
  });

  // ── shape-counter seed (gap: shape-counter-seed-replays-telemetry-and-competes-with-the-drain) ──

  const ORG = 'organizations:o';
  async function seedGradable(): Promise<void> {
    const now = Date.now();
    const rows = [
      // Telemetry-class rows that WOULD count if replayed (shaped, reached tag): the live path never counts them.
      ...Array.from({ length: 30 }, (_, i) => ({ id: `ts${i}`, activity_id: TELE, org_id: ORG, success: true, tags: ['reached:true'], input_impulse_shapes: ['x'], executed_at: new Date(now - 3 * DAY + i * 1000) })),
      ...Array.from({ length: 20 }, (_, i) => ({ id: `gs${i}`, activity_id: 'gradable', org_id: ORG, success: true, tags: ['reached:true'], input_impulse_shapes: ['x'], executed_at: new Date(now - 3 * DAY + 500_000 + i * 1000) })),
    ];
    await q('INSERT INTO execution $rows RETURN NONE', { rows });
  }
  const counterFor = async (aid: string) =>
    Number((await q<{ graded: number }>('SELECT graded FROM shape_score_counter WHERE activity_id = $aid', { aid }))[0]?.graded ?? 0);

  test('SEED skips the accepted telemetry class: telemetry rows are neither replayed nor counted', async () => {
    await seedGradable();
    const r = await SEED.runShapeCounterSeedTick({ pageSize: 50 });
    expect(r.yielded).toBeUndefined();
    expect(r.done).toBe(true);
    expect(r.scanned).toBe(20); // only the gradable rows came back from the page
    expect(await counterFor('gradable')).toBe(20);
    expect(await counterFor(TELE)).toBe(0);
  });

  test('SEED yields while the drain reports surplus or a sweep is in flight, and resumes after', async () => {
    await seedGradable();
    M.__setDrainPressureForTest(1_967_460);
    const y = await SEED.runShapeCounterSeedTick({ pageSize: 50 });
    expect(y.yielded).toBe(true);
    expect(y.scanned).toBe(0);
    expect(infos.some((i) => i.msg.includes('yielding to the trace-retention drain'))).toBe(true);
    M.__setDrainPressureForTest(0, true);
    expect((await SEED.runShapeCounterSeedTick({ pageSize: 50 })).yielded).toBe(true);
    // Surplus the drain cannot shrink (all of it hot) is no reason to wait.
    M.__setDrainPressureForTest(500, false, { remaining: 500, stoppedBy: 'empty' });
    expect((await SEED.runShapeCounterSeedTick({ pageSize: 50 })).yielded).toBeUndefined();
    expect(await counterFor('gradable')).toBe(20);
  });

  test('SEED treats a FAILED valve like an empty one: a drain that cannot delete is no reason to wait', async () => {
    await seedGradable();
    M.__setDrainPressureForTest(500, false, { remaining: 500, stoppedBy: 'failed' });
    expect(M.getDrainPressure().drainCanProgress).toBe(false);
    const r = await SEED.runShapeCounterSeedTick({ pageSize: 50 });
    expect(r.yielded).toBeUndefined();
    expect(await counterFor('gradable')).toBe(20);
    // A budget-stopped valve IS still progressing: the seed waits on it.
    M.__setDrainPressureForTest(500, false, { remaining: 500, stoppedBy: 'budget' });
    expect(M.getDrainPressure().drainCanProgress).toBe(true);
  });

  test('VALVE reports failed when its id-fallback candidate read fails, instead of throwing out of the sweep', async () => {
    // A head of identical timestamps the range path cannot split forces the id loop.
    const at = new Date(Date.now() - 2 * DAY);
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, activity_id: 'same-ts', success: true, executed_at: at }));
    await q('INSERT INTO execution $rows RETURN NONE', { rows });
    await setTuning('TRACE_RETENTION_TELEMETRY_ACTIVITIES', 'none-declared');
    await setTuning('TRACE_RETENTION_DRAIN_MIN_BATCH', 40);
    clearTuning();
    spies.push(spyOn(db, 'query').mockImplementation(((sql: string, p?: Record<string, unknown>) => {
      sent.push(sql);
      if (/^SELECT id FROM execution WHERE executed_at < type::datetime\(\$cut\)/.test(sql.trim())) return Promise.reject(new Error('simulated store refusal'));
      return origQ(sql, p);
    }) as typeof db.query));
    const r = await M.runTraceRetentionSweep(cfgFor(50, { activities: [] }));
    expect(r.skipped).toBeUndefined();
    const sel = sent.find((s) => /^SELECT id FROM execution WHERE executed_at/.test(s.trim()));
    expect(sel).toBeDefined(); // the range path reported needs_ids, so the id loop ran
    expect(sel).toMatch(/LIMIT \$batch TIMEOUT \d+s/);
    expect(warns.some((w) => w.msg.includes('id-fallback select FAILED'))).toBe(true);
    expect(M.getLastCeilingOutcome()?.stoppedBy).toBe('failed');
    expect(M.getDrainPressure().drainCanProgress).toBe(false);
    expect(M.getSweepPhase()).toBeNull();
  });

  test('SEED never yields forever: past maxYieldMs it runs a tick despite pressure, then the streak restarts', async () => {
    await seedGradable();
    M.__setDrainPressureForTest(1_000_000); // a drain that never finishes
    const y1 = await SEED.runShapeCounterSeedTick({ pageSize: 50, maxYieldMs: 1000 });
    expect(y1.yielded).toBe(true);
    const since = (await q<{ yield_since?: unknown }>('SELECT yield_since FROM shape_score_counter_seed:v1'))[0]?.yield_since;
    expect(since).toBeTruthy();
    expect((await SEED.runShapeCounterSeedTick({ pageSize: 50, maxYieldMs: 1000 })).yielded).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    const ran = await SEED.runShapeCounterSeedTick({ pageSize: 50, maxYieldMs: 1000 });
    expect(ran.yielded).toBeUndefined();
    expect(ran.scanned).toBe(20);
    expect(warns.some((w) => w.msg.includes('yield cap reached'))).toBe(true);
    expect(await counterFor('gradable')).toBe(20);
    // The working tick cleared the streak stamp.
    expect((await q<{ yield_since?: unknown }>('SELECT yield_since FROM shape_score_counter_seed:v1'))[0]?.yield_since ?? null).toBeNull();
  });

  test('SEED reads the surplus the VALVE measured (not a copy): a real over-ceiling sweep makes it yield', async () => {
    await seedHubShape(0, 300, 200); // 200 hot rows: the store stays over a 50-row ceiling after the drain
    await M.runTraceRetentionSweep(cfgFor(50, { activities: [] }));
    expect(M.getDrainPressure().surplus).toBeGreaterThan(0);
    expect((await SEED.runShapeCounterSeedTick({ pageSize: 50 })).yielded).toBeUndefined(); // stoppedBy 'empty': cannot progress
    M.__setDrainPressureForTest(null);
    await q('DELETE execution; DELETE shape_score_counter_seed;');
    await seedHubShape(0, 300);
    await M.runTraceRetentionSweep(cfgFor(50, { activities: [], ceilingPerSweepCap: 40 })); // budgeted: surplus left
    expect(M.getDrainPressure().surplus).toBe(210);
    expect((await SEED.runShapeCounterSeedTick({ pageSize: 50 })).yielded).toBe(true);
    // A DRY-RUN valve measures surplus but deletes nothing: no reason to wait on it.
    M.__setDrainPressureForTest(null);
    await M.runCeilingDrainTick(cfgFor(50, { activities: [], dryRun: true }));
    expect(M.getDrainPressure().surplus).toBeGreaterThan(0);
    expect((await SEED.runShapeCounterSeedTick({ pageSize: 50 })).yielded).toBeUndefined();
    await q('DELETE shape_score_counter_seed');
    // A valve-only drain tick (no full sweep, no pressure check) measures it too.
    M.__setDrainPressureForTest(null);
    await M.runCeilingDrainTick(cfgFor(50, { activities: [], ceilingPerSweepCap: 40 }));
    expect(M.getDrainPressure().surplus).toBe(170);
    expect((await SEED.runShapeCounterSeedTick({ pageSize: 50 })).yielded).toBe(true);
  });
});
