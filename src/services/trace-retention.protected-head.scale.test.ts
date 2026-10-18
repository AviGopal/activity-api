/**
 * [MUST-FAIL, COST-SCALED] The telemetry batch and the id loop delete unprotected rows when the oldest rows they
 * read are protected evidence, on a production-sized store.
 *
 * GAP: the-retention-telemetry-batch-and-id-loop-still-test-protection-per-row-so-their-batches-time-out-scanning-
 * protected-rows. 22457fe moved the range drain off the per-row `meta::id(id) NOTINSIDE $__prot` test; its two sibling
 * call sites kept it. Measured on this harness (2.3.10, the live DDL, 18.5k label ids): ~1.5 ms per row read, so a
 * telemetry batch whose head is 18.5k labelled rows took 29 s and an id-loop page 37 s, past the 20 s statement TIMEOUT.
 * EXPLAIN also showed both selects were FULL TABLE SCANS: the unary `!` in their graded test makes the 2.3.10 planner
 * fall back ("unary expressions not supported"), WITH INDEX or not. Live effect: the sweep spent its budget deleting 0.
 *
 * The store (the live execution DDL, every index): 400,000 executions, 59% protected.
 *   - 18,500 rows of a general activity at ONE timestamp, the oldest in the store, cited by open trace_evidence_ref
 *     rows (a tie group the range drain cannot split, so it hands the valve to the id loop), ids sorting first;
 *   - 100,000 rows of a declared telemetry activity, the first 18,500 in record-id order labelled;
 *   - 200,000 graded rows (reached, or the reach_graded tag) and 81,500 unprotected general rows.
 * One telemetry drain and one sweep's id loop must each complete every statement under the 20 s TIMEOUT, delete
 * unprotected rows, keep every protected row, and step over the protected head without re-reading it. A plan control
 * EXPLAINs the shipped selects and requires the index, the class check that catches the next unary predicate.
 *
 * Separately named (*.scale.test.ts) because the seed alone takes ~2.5 min. It runs in the normal suite and on its own;
 * it is NEVER skipped: if the engine cannot start or seed, every test fails with the cause.
 */
import { describe, test, expect, afterAll, spyOn } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const DAY = 86_400_000;
const HOT_MS = 2 * 3600_000;
const TIMEOUT_MS = 20_000; // the drain policy's live statement TIMEOUT (TRACE_RETENTION_DRAIN_STMT_TIMEOUT_S default)
const TELE = 'telemetry_scale_probe_v1';
const GEN = 'general_scale_probe';
const HEAD = 18_500;
const pad = (i: number) => String(i).padStart(6, '0');

type Mod = typeof import('./trace-retention');
let rs: RealSurreal | null = null;
let M: Mod;
let held: any;
const restores: Array<() => void> = [];
/** Every statement the code under test sent through the module client, with its wall time. */
const timed: Array<{ sql: string; params: Record<string, unknown>; ms: number; ok: boolean }> = [];
const warns: string[] = [];
const infos: Array<{ msg: string; meta: Record<string, unknown> }> = [];
let ready: Promise<void> | null = null;

async function insert(table: string, rows: string[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) await rs!.sql(`INSERT INTO ${table} [${rows.slice(i, i + 1000).join(',')}] RETURN NONE;`);
}
const iso = (ms: number) => new Date(ms).toISOString();
const exec = (id: string, aid: string, at: number, extra = '') =>
  `{id:'${id}', activity_id:'${aid}', success:true, duration_ms:1, cost_usd:0.0, tokens_in:0, tokens_out:0, input_impulses:[], output_impulses:[], account_id_version:0, org_id:'o', created_at:d'${iso(at)}', executed_at:d'${iso(at)}'${extra}}`;

async function setup(): Promise<void> {
  rs = await startRealSurreal();
  held = await rs.connectModuleClient();
  for (const m of ['query', 'queryAll'] as const) {
    const orig = held[m];
    held[m] = async (sql: string, params?: Record<string, unknown>) => {
      const t0 = Date.now();
      try { const r = await orig.call(held, sql, params); timed.push({ sql, params: params ?? {}, ms: Date.now() - t0, ok: true }); return r; }
      catch (e) { timed.push({ sql, params: params ?? {}, ms: Date.now() - t0, ok: false }); throw e; }
    };
    restores.push(() => { held[m] = orig; });
  }
  const { logger } = await import('../utils/logger');
  const w = spyOn(logger, 'warn').mockImplementation(((msg: string) => { warns.push(msg); }) as typeof logger.warn);
  const i = spyOn(logger, 'info').mockImplementation(((msg: string, meta?: Record<string, unknown>) => { infos.push({ msg, meta: meta ?? {} }); }) as typeof logger.info);
  restores.push(() => w.mockRestore(), () => i.mockRestore());
  M = await import('./trace-retention');

  const now = Date.now();
  const t0 = now - 30 * DAY;
  const started = Date.now();
  // The tie head: oldest timestamp in the store, ids sorting first, every row cited by an open evidence ref.
  await insert('execution', Array.from({ length: HEAD }, (_, k) => exec(`a_${pad(k)}`, GEN, t0)));
  await insert('trace_evidence_ref', Array.from({ length: HEAD }, (_, k) => `{execution_id:'a_${pad(k)}', source:'gap', ref:'scale', open:true}`));
  // Telemetry: 100k rows, the first 18.5k in record-id order labelled.
  await insert('execution', Array.from({ length: 100_000 }, (_, k) => exec(`t_${pad(k)}`, TELE, now - 20 * DAY + ((k * 7919) % 100_000) * 1000)));
  await insert('goal_verification_labels', Array.from({ length: HEAD }, (_, k) =>
    `{execution_id:'t_${pad(k)}', org_id:'o', goal:'g', activity_id:'${TELE}', verdict:'achieved', confidence:1.0, labeler:'automated'}`));
  // Graded rows (half by the reached verdict, half by the reach_graded tag) interleaved with unprotected rows.
  await insert('execution', Array.from({ length: 200_000 }, (_, k) => exec(`m_${pad(k)}`, 'graded_scale_probe', now - 25 * DAY + k * 2000,
    k % 2 === 0 ? `, reached:${k % 4 === 0}` : `, tags:['reach_graded:true', 'reached:true']`)));
  await insert('execution', Array.from({ length: 81_500 }, (_, k) => exec(`u_${pad(k)}`, GEN, now - 25 * DAY + k * 2000 + 1000)));
  await rs.sql(`UPDATE substrate_tuning_param SET \`value\` = '${TELE}' WHERE name = 'TRACE_RETENTION_TELEMETRY_ACTIVITIES';`);
  console.log(`[scale] seeded 400000 executions, ${HEAD} labels, ${HEAD} open refs in ${Date.now() - started} ms`);
}
function engine(): Promise<void> {
  ready ??= setup();
  return ready;
}
afterAll(async () => { for (const r of restores.reverse()) r(); await rs?.stop(); });

async function one<T = unknown>(sql: string): Promise<T> {
  const res = await rs!.sql(sql);
  return res.at(-1)!.result as T;
}
/** Protected rows still present: labelled/open-ref rows fetched BY ID, graded rows by a table scan (no indexed COUNT). */
async function protectedCount(): Promise<number> {
  const refs = await one<number>(`LET $p = array::union((SELECT VALUE execution_id FROM goal_verification_labels), (SELECT VALUE execution_id FROM trace_evidence_ref WHERE open != false));
    LET $t = array::map($p, |$e| type::thing('execution', $e)); RETURN array::len((SELECT VALUE id FROM $t));`);
  const graded = await one<Array<{ c: number }>>(`SELECT count() AS c FROM execution WHERE reached != NONE OR tags CONTAINS 'reach_graded:true' GROUP ALL;`);
  return Number(refs) + Number(graded[0]?.c ?? 0);
}
async function total(): Promise<number> {
  const r = await one<Array<{ c: number }>>('SELECT count() AS c FROM execution GROUP ALL;');
  return Number(r[0]?.c ?? 0);
}
const isTelemetryBatch = (sql: string) => /WITH INDEX idx_execution_activity WHERE activity_id = \$aid/.test(sql) && /DELETE \$__ids/.test(sql);
const isIdLoopSelect = (sql: string) => sql.trim().startsWith('SELECT id FROM execution WHERE executed_at < type::datetime($cut)');
/** The id-loop cursor as a comparable pair (the parent sends none). */
const cursorOf = (p: Record<string, unknown>) => [Date.parse(String(p['lo'] ?? '')), p['after'] == null ? '' : String(p['after'])] as const;
const strictlyIncreasing = (xs: ReadonlyArray<readonly [number, string]>) =>
  xs.every((x, k) => k === 0 || x[0] > xs[k - 1]![0] || (x[0] === xs[k - 1]![0] && x[1] > xs[k - 1]![1]));

let teleSql: { sql: string; params: Record<string, unknown> } | null = null;
let idSql: { sql: string; params: Record<string, unknown> } | null = null;

describe('[MUST-FAIL] retention steps over a protected head at production size (real SurrealDB, live DDL)', () => {
  test('SCALE telemetry: one drain call deletes unprotected rows, every batch under the TIMEOUT, the labelled head never re-read', async () => {
    await engine();
    const protBefore = await protectedCount();
    const totalBefore = await total();
    expect(protBefore).toBe(HEAD * 2 + 200_000);
    expect(totalBefore).toBe(400_000);
    const from = timed.length;
    const t0 = Date.now();
    const r = await M.drainTelemetryClass({
      cutIso: iso(Date.now() - HOT_MS),
      target: 3000,
      budgetUntil: Date.now() + 45_000,
      policy: { batch: 2000, minBatch: 50, pauseMs: 0, stmtTimeoutS: TIMEOUT_MS / 1000, restMs: 0, phaseBudgetMs: 120_000, rescanPasses: 12 },
    });
    const wall = Date.now() - t0;
    const batches = timed.slice(from).filter((c) => isTelemetryBatch(c.sql));
    teleSql = batches[0] ?? null;
    const maxMs = Math.max(0, ...batches.map((b) => b.ms));
    const deleted = totalBefore - await total();
    console.log(`[scale] telemetry drain: wall ${wall} ms, removed ${r.removed}, deleted ${deleted}, stoppedBy ${r.stoppedBy}, batches ${batches.length}, max batch ${maxMs} ms, failed ${batches.filter((b) => !b.ok).length}`);
    expect(r.activities).toEqual([TELE]);
    expect(batches.filter((b) => !b.ok).length).toBe(0); // no batch rolled back on its TIMEOUT
    expect(maxMs).toBeLessThan(TIMEOUT_MS);
    expect(r.removed).toBe(3000);
    expect(r.stoppedBy).toBe('target');
    expect(deleted).toBe(r.removed);
    expect(await protectedCount()).toBe(protBefore); // CONTROL: no protected row deleted
    // CONTROL: the labelled head was stepped over, not re-read: the cursor strictly advances, and the batch count is
    // bounded by the head at the drain's width (250 doubling to 2000) plus the deleting batches.
    const afters = batches.map((b) => (b.params['after'] == null ? '' : String(b.params['after'])));
    expect(afters[0]).toBe('');
    expect(afters.every((a, k) => k === 0 || a > afters[k - 1]!)).toBe(true);
    expect(batches.length).toBeLessThanOrEqual(16);
  }, 480_000);

  test('SCALE id loop: one sweep hands the tie head to the id loop, which deletes unprotected rows, every page under the TIMEOUT, never re-reading', async () => {
    await engine();
    // Telemetry off for this sweep (the declared id is vetted, so a declared one would drain first).
    await rs!.sql(`UPDATE substrate_tuning_param SET \`value\` = 'none-declared' WHERE name = 'TRACE_RETENTION_TELEMETRY_ACTIVITIES';`);
    const TP = await import('../lib/tuning-params');
    const TC = await import('../lib/telemetry-class');
    TP.__clearTuningParamCache(); TP.__clearTuningParamListCache(); TC.__clearTelemetryClassCache();
    M.__setDrainPressureForTest(null, false);
    M.__resetStrataCursorForTest();
    const protBefore = await protectedCount();
    const totalBefore = await total();
    const from = timed.length;
    const infoFrom = infos.length;
    const t0 = Date.now();
    await M.runTraceRetentionSweep({
      ...M.loadTraceRetentionConfig({} as NodeJS.ProcessEnv),
      enabled: true, dryRun: false, hotWindowMs: HOT_MS, activities: [], overrides: {}, autoDiscover: false,
      globalCeiling: 1000, globalCeilingBytes: 0, globalCeilingEnabled: true, orphanReapEnabled: false,
      ceilingPerSweepCap: 500, ceilingBudgetMs: 120_000, deleteBatchSize: 25,
    });
    const wall = Date.now() - t0;
    const pages = timed.slice(from).filter((c) => isIdLoopSelect(c.sql));
    idSql = pages[0] ?? null;
    const maxMs = Math.max(0, ...pages.map((p) => p.ms));
    const deleted = totalBefore - await total();
    const range = infos.slice(infoFrom).find((i) => i.msg === '[trace-retention] phase' && i.meta['phase'] === 'valve:range_drain')?.meta;
    const outcome = M.getLastCeilingOutcome();
    console.log(`[scale] id loop sweep: wall ${wall} ms, deleted ${deleted}, range stoppedBy ${range?.['stoppedBy']}, valve stoppedBy ${outcome?.stoppedBy}, pages ${pages.length}, max page ${maxMs} ms, failed ${pages.filter((p) => !p.ok).length}`);
    // The range drain could not split the tie head and handed the valve to the id loop on its first batch.
    expect(range?.['stoppedBy']).toBe('needs_ids');
    expect(Number(range?.['removed'])).toBe(0);
    expect(pages.filter((p) => !p.ok).length).toBe(0);
    expect(warns.some((w) => w.includes('id-fallback select FAILED'))).toBe(false);
    expect(maxMs).toBeLessThan(TIMEOUT_MS);
    expect(deleted).toBe(500);
    expect(outcome?.stoppedBy).toBe('target');
    expect(await protectedCount()).toBe(protBefore); // CONTROL: no protected row deleted
    // CONTROL: every page starts past the last one (the tie head is read once), and the page count is bounded by the
    // head at the policy width plus the 25-row deleting pages.
    const width = (await M.loadDrainPolicy()).batch;
    expect(strictlyIncreasing(pages.map((p) => cursorOf(p.params)))).toBe(true);
    expect(pages.length).toBeLessThanOrEqual(Math.ceil(HEAD / width) + 500 / 25 + 2);
  }, 480_000);

  test('PLAN control: the shipped telemetry and id-loop selects are planned on their index, not a table scan', async () => {
    await engine();
    expect(teleSql).not.toBeNull();
    expect(idSql).not.toBeNull();
    const teleSelect = teleSql!.sql.match(/\((SELECT VALUE id FROM execution WITH INDEX idx_execution_activity WHERE [^\n]*? TIMEOUT \d+s)\);/)?.[1];
    expect(teleSelect).toBeDefined();
    const plan = async (sql: string, params: Record<string, unknown>) =>
      JSON.stringify(await rs!.sdk.query(`${sql} EXPLAIN`, { __prot: [], ...params }));
    const tp = await plan(teleSelect!, teleSql!.params);
    const ip = await plan(idSql!.sql.trim(), idSql!.params);
    console.log(`[scale] telemetry select plan ${tp}`);
    console.log(`[scale] id-loop select plan ${ip}`);
    expect(tp).toContain('"index":"idx_execution_activity"');
    expect(tp).not.toContain('Iterate Table');
    expect(ip).toContain('"index":"idx_execution_executed_at"');
    expect(ip).not.toContain('Iterate Table');
  }, 480_000);
});
