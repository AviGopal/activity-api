import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

/**
 * THE SELECTION-EVENTS LIST MUST RETURN THE NEWEST SELECTIONS IN ITS WINDOW, NOT THE OLDEST.
 *
 * GET /v2/activities/execution-traces/selection-events builds
 *   SELECT * FROM thompson_selection_log WHERE selected_at >= type::datetime($start_date) [AND …]
 *   ORDER BY selected_at DESC LIMIT $limit START $offset
 * On SurrealDB 2.3.10 (also 2.4.1 and 2.5.0; 2.3.3 is correct) a range on an indexed field
 * (idx_thompson_selection_time) plus ORDER BY that field DESC plus LIMIT returns the LOWEST rows of
 * the range: the limit is applied to the ascending index scan before the sort. Verified live on
 * node 1 2026-10-03 against WITH NOINDEX (the 24h-OLDEST rows came back). Gap:
 * surrealdb-2-3-10-returns-the-lowest-rows-for-an-indexed-range-ordered-desc-with-a-limit.
 *
 * The test takes the handler's REAL query template from execution-traces.ts, expands its
 * ${whereClause} exactly as the handler builds it, and runs it on a throwaway in-memory SurrealDB
 * built from the real schema (sql/schemas/011-executions.surql), comparing with a WITH NOINDEX run
 * of the same filter. Any fix shape passes that returns the same rows (e.g. a subquery filtered
 * inside and sorted and limited outside), as long as the handler keeps one `const query` template
 * using ${whereClause}; a restructure must move this test with it.
 *
 * Needs the `surreal` binary (present in the substrate image). If it is missing the suite FAILS
 * rather than skipping: a silent skip reads as a pass.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
const START = '2026-01-01T00:10:00Z';
let proc: Subprocess | null = null;
let startError = '';

async function sql(text: string): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': 't', 'surreal-db': 't', Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}

/** The handler's query template with ${whereClause} expanded from the given conditions. */
function handlerQuery(conditions: string[]): string {
  const src = readFileSync(ROOT + 'src/routes/execution-traces.ts', 'utf8');
  const start = src.indexOf("app.get('/selection-events'");
  if (start < 0) throw new Error("selection-events handler not found in execution-traces.ts");
  const qStart = src.indexOf('const query = `', start);
  if (qStart < 0) throw new Error('selection-events: no `const query` template');
  const body = src.slice(qStart + 'const query = `'.length, src.indexOf('`;', qStart));
  if (!body.includes('${whereClause}')) throw new Error('selection-events: query template no longer uses ${whereClause}');
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const q = body.split('${whereClause}').join(where);
  if (/\$\{/.test(q)) throw new Error(`selection-events: unexpanded interpolation: ${q}`);
  return q.trim();
}

const ids = (rows: any[]) => rows.map((r) => String(r.id));
async function run(q: string, binds: string): Promise<string[]> {
  const res = await sql(`${binds} ${q};`);
  const last = res[res.length - 1];
  if (last.status !== 'OK') throw new Error(`query failed: ${JSON.stringify(last.result)}`);
  return ids(last.result);
}
async function truth(conds: string, binds: string, limit: number, offset = 0): Promise<string[]> {
  return run(`SELECT id, selected_at FROM thompson_selection_log WITH NOINDEX WHERE ${conds} ORDER BY selected_at DESC LIMIT ${limit} START ${offset}`, binds);
}

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
    await sql(readFileSync(ROOT + 'sql/schemas/011-executions.surql', 'utf8'));
    // 3,000 selections one second apart across 3 activities. SurrealQL ranges exclude the end.
    await sql(`FOR $i IN 0..3000 { CREATE thompson_selection_log CONTENT { execution_id: 'x' + <string>$i, activity_id: 'a' + <string>($i % 3), thompson_sample: 0.5, alpha: 1.0, beta: 1.0, selection_method: 'thompson_sampling', org_id: 'organizations:o1', selected_at: d'2026-01-01T00:00:00Z' + <duration> (<string>$i + 's') } };`);
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(() => { proc?.kill(); });

const B = `LET $start_date = '${START}'; LET $limit = 5; LET $offset = 0;`;

describe('selection-events newest-first window', () => {
  it('the instrument is live: surreal started, the real schema defined idx_thompson_selection_time, rows seeded', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE thompson_selection_log;');
    expect(Object.keys(info[0].result.indexes ?? {})).toContain('idx_thompson_selection_time');
    const n = await sql('SELECT count() AS n FROM thompson_selection_log WITH NOINDEX GROUP ALL;');
    expect(n[0].result[0].n).toBe(3000);
  }, 60_000);

  it('CONTROL: the fixture is sensitive to the engine defect where the engine has it', async () => {
    const direct = await run(`SELECT id, selected_at FROM thompson_selection_log WHERE selected_at >= type::datetime('${START}') ORDER BY selected_at DESC LIMIT 5`, '');
    const scan = await truth(`selected_at >= type::datetime('${START}')`, '', 5);
    const [maj, min, pat] = await engineVersion();
    const affected = !(maj === 2 && min === 3 && pat < 8); // measured: 2.3.3 correct; 2.3.10, 2.4.1, 2.5.0 wrong
    expect(JSON.stringify(direct) === JSON.stringify(scan)).toBe(!affected);
  }, 60_000);

  it('THE DEFECT: with start_date the list returns the newest selections, newest first', async () => {
    const got = await run(handlerQuery(['selected_at >= type::datetime($start_date)']), B);
    expect(got).toEqual(await truth('selected_at >= type::datetime($start_date)', B, 5));
  }, 60_000);

  it('THE DEFECT: a later page with start_date is the next slice of the same order', async () => {
    const binds = `LET $start_date = '${START}'; LET $limit = 5; LET $offset = 5;`;
    const got = await run(handlerQuery(['selected_at >= type::datetime($start_date)']), binds);
    expect(got).toEqual(await truth('selected_at >= type::datetime($start_date)', binds, 5, 5));
  }, 60_000);

  it('THE DEFECT: activity_id plus start_date returns the newest selections of that activity, newest first', async () => {
    const binds = `${B} LET $activity_id = 'a1';`;
    const conds = ['activity_id = $activity_id', 'selected_at >= type::datetime($start_date)'];
    const got = await run(handlerQuery(conds), binds);
    expect(got).toEqual(await truth(conds.join(' AND '), binds, 5));
  }, 60_000);

  it('without any filter the list is already correct and must stay so', async () => {
    const got = await run(handlerQuery([]), B);
    expect(got).toEqual(await truth('true', B, 5));
  }, 60_000);
});
