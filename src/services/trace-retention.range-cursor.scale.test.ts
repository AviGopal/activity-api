/**
 * [MUST-FAIL, COST-SCALED] The range drain resumes from a PERSISTED cursor instead of re-reading the protected head.
 *
 * Measured live: node 1 range_drain passes of 43-252 s removing 2-116 rows (39 s for 63 rows at width 2000); the hub
 * ~294 s per pass removing 0 at a ~61k surplus, re-entered ~60 s later (~80% DB duty). The cause, in code: every call
 * of drainColdByRange started $lo at DRAIN_FLOOR_ISO and stepped over all-protected ranges only within the call, so
 * each pass re-read the whole protected head before it reached anything deletable. An in-memory cursor would not
 * help either: pull-sync converges restart the process.
 *
 * The store (the live DDL, every index): a 50,000-row protected head (40,000 graded rows, 10,000 rows cited by open
 * trace_evidence_ref rows, all older than anything else) and 5,000 unprotected rows above it. (A first version used a
 * 160k head + 40k free rows, with the same verdicts on both trees (161x fewer rows on pass 2), but its seed took up to
 * 4 min on a loaded host against the harness's 600 s engine limit; inserts cost ~1 ms a row on the live DDL whatever
 * the transport.)
 *   - MUST-FAIL: after a pass deletes its target, a SECOND pass, run on a freshly imported module (a simulated restart,
 *     same DB), reads >= 10x fewer range rows than the first, still deletes unprotected rows, and logs that it resumed
 *     from the stored cursor ("range_drain start=<executed_at> source=stored"). CONTROL: no protected row is deleted.
 * The release, rescan and restart controls run on a small store in trace-retention.range-cursor.test.ts.
 * Separately named (*.scale.test.ts): the seed takes ~20-60 s with host load and a floor pass reads the whole head.
 * It runs in the normal suite and is never skipped.
 */
import { describe, test, expect, afterAll, spyOn } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const DAY = 86_400_000;
const HOT_MS = 2 * 3600_000;
const GRADED = 40_000;
const CITED = 10_000;
const FREE = 5_000;
const pad = (i: number) => String(i).padStart(6, '0');
const iso = (ms: number) => new Date(ms).toISOString();

type Mod = typeof import('./trace-retention');
let rs: RealSurreal | null = null;
let held: any;
const restores: Array<() => void> = [];
/** Range-drain batch summaries, in order, tagged with the pass that issued them. */
const batches: Array<{ pass: number; scanned: number; deleted: number }> = [];
const infos: string[] = [];
let pass = 0;
let ready: Promise<void> | null = null;

const exec = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
  id, activity_id: 'cursor_scale_probe', success: true, duration_ms: 1, cost_usd: 0.5, tokens_in: 0, tokens_out: 0, input_impulses: [], output_impulses: [],
  account_id_version: 0, org_id: 'o', created_at: new Date(at), executed_at: new Date(at), ...extra,
});
/** Seed over the SDK's WebSocket connection, rows bound as a parameter, 5000 per statement. */
async function insert(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  for (let i = 0; i < rows.length; i += 5000) await rs!.sdk.query(`INSERT INTO ${table} $rows RETURN NONE`, { rows: rows.slice(i, i + 5000) });
}

async function setup(): Promise<void> {
  rs = await startRealSurreal();
  held = await rs.connectModuleClient();
  const orig = held.queryAll;
  held.queryAll = async (sql: string, params?: Record<string, unknown>) => {
    const r = await orig.call(held, sql, params);
    if (/LET \$ts = \(SELECT VALUE executed_at FROM execution/.test(sql)) {
      const out = (Array.isArray(r) ? r : []).filter((x: any) => x && typeof x === 'object' && 'deleted' in x).pop() as any;
      batches.push({ pass, scanned: Number(out?.scanned ?? 0), deleted: Number(out?.deleted ?? 0) });
    }
    return r;
  };
  restores.push(() => { held.queryAll = orig; });
  const { logger } = await import('../utils/logger');
  const i = spyOn(logger, 'info').mockImplementation(((msg: string) => { infos.push(msg); }) as typeof logger.info);
  const w = spyOn(logger, 'warn').mockImplementation((() => {}) as typeof logger.warn);
  restores.push(() => i.mockRestore(), () => w.mockRestore());

  const now = Date.now();
  const base = now - 40 * DAY;
  const started = Date.now();
  // The head: every 5th row cited by an open evidence ref, the rest graded (reached, or the reach_graded tag).
  const head = GRADED + CITED;
  const rows: Array<Record<string, unknown>> = [];
  const refs: Array<Record<string, unknown>> = [];
  for (let k = 0, c = 0; k < head; k++) {
    const id = `h_${pad(k)}`;
    if (k % 5 === 0 && c < CITED) { rows.push(exec(id, base + k * 1000)); refs.push({ execution_id: id, source: 'gap', ref: 'cursor', open: true }); c++; }
    else rows.push(exec(id, base + k * 1000, k % 2 === 0 ? { reached: k % 4 === 0 } : { tags: ['reach_graded:true'] }));
  }
  await insert('execution', rows);
  await insert('trace_evidence_ref', refs);
  expect(refs.length).toBe(CITED);
  await insert('execution', Array.from({ length: FREE }, (_, k) => exec(`u_${pad(k)}`, base + head * 1000 + k * 1000)));
  console.log(`[cursor] seeded ${head + FREE} executions (${head} protected head, ${CITED} open refs) in ${Date.now() - started} ms`);
}
function engine(): Promise<void> { ready ??= setup(); return ready; }
afterAll(async () => { for (const r of restores.reverse()) r(); await rs?.stop(); });

async function one<T = unknown>(sql: string): Promise<T> {
  return (await rs!.sql(sql)).at(-1)!.result as T;
}
/** Protected rows still present: cited rows fetched BY ID, graded rows by a table scan (no indexed COUNT). */
async function protectedCount(): Promise<number> {
  const cited = await one<number>(`LET $t = array::map((SELECT VALUE execution_id FROM trace_evidence_ref WHERE open != false), |$e| type::thing('execution', $e));
    RETURN array::len((SELECT VALUE id FROM $t));`);
  const graded = await one<Array<{ c: number }>>(`SELECT count() AS c FROM execution WHERE reached != NONE OR tags CONTAINS 'reach_graded:true' GROUP ALL;`);
  return Number(cited) + Number(graded[0]?.c ?? 0);
}
async function total(): Promise<number> {
  return Number((await one<Array<{ c: number }>>('SELECT count() AS c FROM execution GROUP ALL;'))[0]?.c ?? 0);
}
const policy = (rescanPasses: number) => ({ batch: 2000, minBatch: 50, pauseMs: 0, stmtTimeoutS: 20, restMs: 0, phaseBudgetMs: 120_000, rescanPasses });
/** One range-drain pass on module `m`: rows it read, rows it deleted, and its start log line. */
async function runPass(m: Mod, target: number, rescanPasses = 100) {
  pass++;
  const infoFrom = infos.length;
  const before = await total();
  const t0 = Date.now();
  const r = await m.drainColdByRange({ cutIso: iso(Date.now() - HOT_MS), target, budgetUntil: Date.now() + 150_000, policy: policy(rescanPasses) as any });
  const mine = batches.filter((b) => b.pass === pass);
  const out = {
    ...r,
    ms: Date.now() - t0,
    read: mine.reduce((a, b) => a + b.scanned, 0),
    deleted: before - await total(),
    start: infos.slice(infoFrom).find((l) => l.startsWith('[trace-retention] range_drain start=')) ?? '(none)',
  };
  console.log(`[cursor] pass ${pass}: ${out.start} | read ${out.read} rows in ${mine.length} batches, deleted ${out.deleted}, stoppedBy ${out.stoppedBy}, ${out.ms} ms`);
  return out;
}

describe('[MUST-FAIL] the range drain resumes from a persisted cursor (real SurrealDB, live DDL)', () => {
  let protBefore = 0;

  test('SCALE: a second pass after a simulated restart reads >= 10x fewer range rows than the first and still deletes', async () => {
    await engine();
    protBefore = await protectedCount();
    expect(protBefore).toBe(GRADED + CITED);
    const M1: Mod = await import('./trace-retention');
    const p1 = await runPass(M1, 1000);
    // A fresh module instance: no in-process state survives, only the database.
    const M2: Mod = await import('./trace-retention.ts?simulated-restart');
    const p2 = await runPass(M2, 1000);
    // The verdict is the RATIO of range rows read, never a time. Pass 1 starts at the floor and reads the whole head;
    // on the parent pass 2 does too (it re-reads >= the head) and fails here.
    expect(p1.read).toBeGreaterThanOrEqual(GRADED + CITED);
    expect(p1.deleted).toBeGreaterThan(0);
    expect(p2.deleted).toBeGreaterThan(0);
    expect(p2.read * 10).toBeLessThanOrEqual(p1.read);
    expect(p1.start).toBe('[trace-retention] range_drain start=FLOOR source=reset:none');
    expect(p2.start).toMatch(/^\[trace-retention\] range_drain start=\d{4}-\d\d-\d\dT\S+ source=stored$/);
    expect(await protectedCount()).toBe(protBefore); // CONTROL: no protected row deleted
  }, 560_000);
});
