import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';
import { Surreal } from 'surrealdb';
import { runExecutionTraceWithSignatures } from '../src/routes/execution-trace-with-signatures';

/**
 * THE SIGNATURE READER MUST RETURN THE NEWEST EXECUTIONS IN ITS WINDOW, NOT THE OLDEST.
 *
 * runExecutionTraceWithSignatures() -> queryExecutions() step 1 builds
 *   SELECT id, executed_at FROM execution WHERE executed_at >= type::datetime($since) [AND …]
 *   ORDER BY executed_at DESC LIMIT $lim
 * On SurrealDB 2.3.10 (also 2.4.1 and 2.5.0; 2.3.3 is correct) a range on an indexed field
 * (idx_execution_executed_at) plus ORDER BY that field DESC plus LIMIT returns the LOWEST rows of
 * the range: the limit is applied to the ascending index scan before the sort. Verified live on
 * node 1 2026-10-03 against WITH NOINDEX on the jwt (no app-side tenant clause) and success_only
 * paths; the apikey path's tenant disjunction plans a table scan and is correct, so it is pinned as
 * a guard. The ribosome and signature readers consume this list. Gap:
 * surrealdb-2-3-10-returns-the-lowest-rows-for-an-indexed-range-ordered-desc-with-a-limit.
 *
 * The test calls the REAL exported reader with a client connected to a throwaway in-memory
 * SurrealDB built from the real schema (sql/schemas/020-paradigm-core-tables.surql) and compares
 * the returned execution ids with a WITH NOINDEX run of the same filter. Any fix shape passes that
 * returns the same rows (e.g. the filtered ids in a subquery, sorted and limited outside it).
 *
 * Needs the `surreal` binary (present in the substrate image). If it is missing the suite FAILS
 * rather than skipping: a silent skip reads as a pass.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
const NS = 'aatest';
const DB = 'learning_loop';
const ORG = 'organizations:o1';
const SINCE = '2026-01-01T00:10:00Z';
let proc: Subprocess | null = null;
let startError = '';
let db: Surreal | null = null;

async function sql(text: string): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}

/** Newest-first execution ids matching the reader's filter, by full scan. */
async function truth(limit: number, extra = ''): Promise<string[]> {
  const res = await sql(`SELECT id, executed_at FROM execution WITH NOINDEX WHERE executed_at >= type::datetime('${SINCE}') ${extra} ORDER BY executed_at DESC LIMIT ${limit};`);
  return (res[res.length - 1].result as any[]).map((r) => String(r.id).replace(/^execution:/, '').replace(/^⟨|⟩$/g, ''));
}

const got = (rep: { traces: Array<{ execution_id: string }> }) =>
  rep.traces.map((t) => String(t.execution_id).replace(/^execution:/, '').replace(/^⟨|⟩$/g, ''));

async function engineVersion(): Promise<[number, number, number]> {
  const m = (await (await fetch(`${URL_}/version`)).text()).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error('engine version unreadable');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

beforeAll(async () => {
  const hardStop = setTimeout(() => proc?.kill(), 180_000);
  (hardStop as any).unref?.();
  try {
    proc = spawn(['surreal', 'start', 'memory', '--bind', `127.0.0.1:${PORT}`, '--user', 'root', '--pass', PASS, '--log', 'none'], { stdout: 'ignore', stderr: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${URL_}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error('surreal did not answer /health within 6 s');
    await sql(readFileSync(ROOT + 'sql/schemas/020-paradigm-core-tables.surql', 'utf8'));
    // 3,000 executions one second apart; every 2nd succeeds. SurrealQL ranges exclude the end.
    await sql(`FOR $i IN 0..3000 { CREATE type::thing('execution', 'e' + <string>$i) CONTENT { activity_id: 'a' + <string>($i % 3), input_impulses: [], output_impulses: [], success: $i % 2 = 0, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: d'2026-01-01T00:00:00Z' + <duration> (<string>$i + 's'), created_at: d'2026-01-01T00:00:00Z' + <duration> (<string>$i + 's') } };`);
    db = new Surreal();
    await db.connect(`${URL_}/rpc`);
    await db.signin({ username: 'root', password: PASS });
    await db.use({ namespace: NS, database: DB });
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(async () => { try { await db?.close(); } catch { /* ignore */ } proc?.kill(); });

describe('signature reader newest-first window', () => {
  it('the instrument is live: surreal started, the real schema defined idx_execution_executed_at, rows seeded', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE execution;');
    expect(Object.keys(info[0].result.indexes ?? {})).toContain('idx_execution_executed_at');
    const n = await sql('SELECT count() AS n FROM execution WITH NOINDEX GROUP ALL;');
    expect(n[0].result[0].n).toBe(3000);
  }, 60_000);

  it('CONTROL: the fixture is sensitive to the engine defect where the engine has it', async () => {
    const direct = await sql(`SELECT id, executed_at FROM execution WHERE executed_at >= type::datetime('${SINCE}') ORDER BY executed_at DESC LIMIT 5;`);
    const scan = await sql(`SELECT id, executed_at FROM execution WITH NOINDEX WHERE executed_at >= type::datetime('${SINCE}') ORDER BY executed_at DESC LIMIT 5;`);
    const same = JSON.stringify(direct[0].result.map((r: any) => String(r.id))) === JSON.stringify(scan[0].result.map((r: any) => String(r.id)));
    const [maj, min, pat] = await engineVersion();
    const affected = !(maj === 2 && min === 3 && pat < 8); // measured: 2.3.3 correct; 2.3.10, 2.4.1, 2.5.0 wrong
    expect(same).toBe(!affected);
  }, 60_000);

  it('THE DEFECT: jwt path returns the newest executions in the window, newest first', async () => {
    const rep = await runExecutionTraceWithSignatures(db as Surreal, { since: SINCE, limit: 5 }, { orgId: ORG, authType: 'jwt' });
    expect(got(rep)).toEqual(await truth(5));
  }, 60_000);

  it('apikey path returns the newest executions of the tenant, newest first, and must stay so', async () => {
    const rep = await runExecutionTraceWithSignatures(db as Surreal, { since: SINCE, limit: 5 }, { orgId: ORG, accountId: null, authType: 'apikey' });
    expect(got(rep)).toEqual(await truth(5, `AND org_id = '${ORG}'`));
  }, 60_000);

  it('THE DEFECT: success_only path returns the newest successful executions, newest first', async () => {
    const rep = await runExecutionTraceWithSignatures(db as Surreal, { since: SINCE, limit: 5, success_only: true }, { orgId: ORG, authType: 'jwt' });
    expect(got(rep)).toEqual(await truth(5, 'AND success = true'));
  }, 60_000);

  it('an execution_id point lookup is unaffected and must stay so', async () => {
    const rep = await runExecutionTraceWithSignatures(db as Surreal, { execution_id: 'e42', limit: 1 }, { orgId: ORG, authType: 'jwt' });
    expect(got(rep)).toEqual(['e42']);
  }, 60_000);
});
