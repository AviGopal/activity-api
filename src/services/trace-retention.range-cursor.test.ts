/**
 * [MUST-FAIL] The range drain's persisted cursor: it survives a restart, and it is dropped whenever a row below it
 * may have become deletable. The cost-scaled must-fail (a 160k protected head) is trace-retention.range-cursor.scale.test.ts;
 * this file pins the controls on a small store, on a real engine with the live DDL (test/support/real-surreal.ts).
 *
 *   - RESTART: a pass on a freshly imported module (no in-process state) resumes from the stored cursor and logs
 *     "range_drain start=<executed_at> source=stored"; the cursor is on trace_store_counters:execution;
 *   - RELEASE (evidence ref): closing the ref that protects a head row sends the next pass to the floor
 *     (source=reset:protection_released) and that pass deletes the row;
 *   - RELEASE (label): removing a label shrinks the protected list, with the same effect;
 *   - RESCAN: after policy.rescanPasses resumed passes the next pass starts at the floor (source=reset:rescan);
 *   - no protected row is ever deleted.
 * Never skipped: if the engine cannot start, every test fails with the cause.
 */
import { describe, test, expect, afterAll, spyOn } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const DAY = 86_400_000;
const HOT_MS = 2 * 3600_000;
const HEAD = 1200;
const FREE = 600;
const pad = (i: number) => String(i).padStart(6, '0');
const iso = (ms: number) => new Date(ms).toISOString();

type Mod = typeof import('./trace-retention');
let rs: RealSurreal | null = null;
const restores: Array<() => void> = [];
const infos: string[] = [];
let ready: Promise<void> | null = null;

const exec = (id: string, at: number, extra = '') =>
  `{id:'${id}', activity_id:'cursor_probe', success:true, duration_ms:1, cost_usd:0.0, tokens_in:0, tokens_out:0, input_impulses:[], output_impulses:[], account_id_version:0, org_id:'o', created_at:d'${iso(at)}', executed_at:d'${iso(at)}'${extra}}`;

async function setup(): Promise<void> {
  rs = await startRealSurreal();
  await rs.connectModuleClient();
  const { logger } = await import('../utils/logger');
  const i = spyOn(logger, 'info').mockImplementation(((msg: string) => { infos.push(msg); }) as typeof logger.info);
  const w = spyOn(logger, 'warn').mockImplementation((() => {}) as typeof logger.warn);
  restores.push(() => i.mockRestore(), () => w.mockRestore());
  const base = Date.now() - 40 * DAY;
  // The head, oldest first: h_000000 and every 6th row cited by an open evidence ref, h_000001 labelled, the rest graded.
  const rows: string[] = [];
  const refs: string[] = [];
  for (let k = 0; k < HEAD; k++) {
    const id = `h_${pad(k)}`;
    if (k % 6 === 0) { rows.push(exec(id, base + k * 1000)); refs.push(`{execution_id:'${id}', source:'gap', ref:'cursor', open:true}`); }
    else if (k === 1) rows.push(exec(id, base + k * 1000));
    else rows.push(exec(id, base + k * 1000, k % 2 === 0 ? `, reached:${k % 4 === 0}` : `, tags:['reach_graded:true']`));
  }
  for (let k = 0; k < FREE; k++) rows.push(exec(`u_${pad(k)}`, base + (HEAD + k) * 1000));
  for (let i = 0; i < rows.length; i += 1000) await rs.sql(`INSERT INTO execution [${rows.slice(i, i + 1000).join(',')}] RETURN NONE;`);
  await rs.sql(`INSERT INTO trace_evidence_ref [${refs.join(',')}] RETURN NONE;`);
  await rs.sql(`INSERT INTO goal_verification_labels {execution_id:'h_000001', org_id:'o', goal:'g', activity_id:'cursor_probe', verdict:'achieved', confidence:1.0, labeler:'automated'} RETURN NONE;`);
}
function engine(): Promise<void> { ready ??= setup(); return ready; }
afterAll(async () => { for (const r of restores.reverse()) r(); await rs?.stop(); });

async function one<T = unknown>(sql: string): Promise<T> {
  return (await rs!.sql(sql)).at(-1)!.result as T;
}
async function total(): Promise<number> {
  return Number((await one<Array<{ c: number }>>('SELECT count() AS c FROM execution GROUP ALL;'))[0]?.c ?? 0);
}
async function exists(id: string): Promise<boolean> {
  return (await one<unknown[]>(`SELECT VALUE id FROM execution:${id};`)).length > 0;
}
/** Protected rows still present: cited and labelled rows fetched BY ID, graded rows by a table scan. */
async function protectedCount(): Promise<number> {
  const ref = await one<number>(`LET $p = array::union((SELECT VALUE execution_id FROM goal_verification_labels), (SELECT VALUE execution_id FROM trace_evidence_ref WHERE open != false));
    LET $t = array::map($p, |$e| type::thing('execution', $e)); RETURN array::len((SELECT VALUE id FROM $t));`);
  const graded = await one<Array<{ c: number }>>(`SELECT count() AS c FROM execution WHERE reached != NONE OR tags CONTAINS 'reach_graded:true' GROUP ALL;`);
  return Number(ref) + Number(graded[0]?.c ?? 0);
}
let n = 0;
async function runPass(m: Mod, target: number, rescanPasses = 100): Promise<{ start: string; deleted: number }> {
  const from = infos.length;
  const before = await total();
  await m.drainColdByRange({
    cutIso: iso(Date.now() - HOT_MS), target, budgetUntil: Date.now() + 60_000,
    policy: { batch: 200, minBatch: 10, pauseMs: 0, stmtTimeoutS: 20, restMs: 0, phaseBudgetMs: 60_000, rescanPasses } as any,
  });
  const start = infos.slice(from).find((l) => l.startsWith('[trace-retention] range_drain start=')) ?? '(none)';
  const deleted = before - await total();
  console.log(`[cursor] pass ${++n}: ${start} | deleted ${deleted}`);
  return { start, deleted };
}
const STORED = /^\[trace-retention\] range_drain start=\d{4}-\d\d-\d\dT\S+ source=stored$/;

describe('[MUST-FAIL] the range drain cursor is persisted and dropped when protection is released (real SurrealDB)', () => {
  let protBefore = 0;

  test('RESTART: a pass on a freshly imported module resumes from the stored cursor', async () => {
    await engine();
    protBefore = await protectedCount();
    expect(protBefore).toBe(HEAD);
    const p1 = await runPass(await import('./trace-retention'), 100);
    expect(p1.start).toBe('[trace-retention] range_drain start=FLOOR source=reset:none');
    expect(p1.deleted).toBeGreaterThan(0);
    const row = await one<Array<{ floor: unknown; prot: unknown; passes: unknown }>>(
      'SELECT drain_floor AS floor, drain_floor_prot AS prot, drain_floor_passes AS passes FROM trace_store_counters:execution;');
    expect(row[0]?.floor).toBeDefined();
    expect(row[0]?.prot).toBe(HEAD / 6 + 1);
    expect(row[0]?.passes).toBe(0);
    const p2 = await runPass(await import('./trace-retention.ts?restart-a'), 100);
    expect(p2.start).toMatch(STORED);
    expect(p2.deleted).toBeGreaterThan(0);
    expect(await protectedCount()).toBe(protBefore);
  }, 120_000);

  test('RELEASE (evidence ref): closing the ref on the oldest head row resets the next pass to the floor, which deletes it', async () => {
    await engine();
    expect(await exists('h_000000')).toBe(true);
    await rs!.sql(`UPDATE trace_evidence_ref SET open = false WHERE execution_id = 'h_000000';`);
    const p = await runPass(await import('./trace-retention.ts?restart-b'), 100);
    expect(p.start).toBe('[trace-retention] range_drain start=FLOOR source=reset:protection_released');
    expect(await exists('h_000000')).toBe(false);
    expect(await protectedCount()).toBe(protBefore - 1);
    // The cursor is stored again under the new protected set: the next pass resumes.
    expect((await runPass(await import('./trace-retention'), 50)).start).toMatch(STORED);
  }, 120_000);

  test('RELEASE (label): removing the label on a head row shrinks the protected list; the next pass starts at the floor and deletes it', async () => {
    await engine();
    expect(await exists('h_000001')).toBe(true);
    await rs!.sql(`DELETE goal_verification_labels WHERE execution_id = 'h_000001';`);
    const p = await runPass(await import('./trace-retention'), 50);
    expect(p.start).toBe('[trace-retention] range_drain start=FLOOR source=reset:protection_released');
    expect(await exists('h_000001')).toBe(false);
    expect(await protectedCount()).toBe(protBefore - 2);
  }, 120_000);

  test('RESCAN: after policy.rescanPasses resumed passes the next pass starts at the floor', async () => {
    await engine();
    const M = await import('./trace-retention');
    expect((await runPass(M, 20, 1)).start).toMatch(STORED); // the floor pass before it stored 0 resumed passes
    const p = await runPass(M, 20, 1);
    expect(p.start).toBe('[trace-retention] range_drain start=FLOOR source=reset:rescan');
    expect(p.deleted).toBeGreaterThan(0);
    expect((await runPass(M, 20, 1)).start).toMatch(STORED); // the cadence restarts
    expect(await protectedCount()).toBe(protBefore - 2); // no protected row was deleted by any pass
  }, 120_000);
});
