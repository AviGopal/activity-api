import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';

/**
 * THE SELECTION-OUTCOMES LIST MUST HONOUR start_date / end_date AND RETURN THE NEWEST SELECTIONS.
 *
 * GET /v2/activities/execution-traces/selection-outcomes step 1 reads thompson_selection_log with
 * conditions the handler pushes into `selectionConditions`. The date conditions were written as
 * `sel.selected_at >= …` / `sel.selected_at <= …`; the query has no `sel` alias (it is a plain
 * FROM thompson_selection_log), so `sel.selected_at` is NONE and every date-filtered request
 * returned ZERO rows (measured on SurrealDB 2.3.10 both through the index and WITH NOINDEX).
 * Repairing the field name alone lands on the engine defect pinned by
 * selection-events-newest-first.test.ts: a range on idx_thompson_selection_time plus ORDER BY
 * selected_at DESC plus LIMIT returns the LOWEST rows of the range on 2.3.10/2.4.1/2.5.0. So the
 * newest-first comparison with a WITH NOINDEX run is red both at the alias bug and at an unwrapped
 * repair.
 *
 * The test takes the handler's REAL condition strings and its `const selectionsQuery` template
 * from execution-traces.ts, expands ${selectionWhereClause} exactly as the handler builds it, and
 * runs it on a throwaway in-memory SurrealDB built from the real schema
 * (sql/schemas/011-executions.surql + sql/migrations/031-selection-correlation-id.surql). Any fix shape passes that returns the same rows, as long as
 * the handler keeps the `selectionConditions.push('…')` literals and one `const selectionsQuery`
 * template using ${selectionWhereClause}; a restructure must move this test with it.
 *
 * Needs the `surreal` binary (present in the substrate image). If it is missing the suite FAILS
 * rather than skipping: a silent skip reads as a pass.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
const START = '2026-01-01T00:10:00Z';
const END = '2026-01-01T00:40:00Z';
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

function handlerSource(): string {
  const src = readFileSync(ROOT + 'src/routes/execution-traces.ts', 'utf8');
  const start = src.indexOf("app.get('/selection-outcomes'");
  if (start < 0) throw new Error('selection-outcomes handler not found in execution-traces.ts');
  const end = src.indexOf('\napp.', start + 10);
  return src.slice(start, end > start ? end : undefined);
}

/** The handler's own condition literal for each request param, keyed by the param it binds. */
function handlerConditions(): Record<string, string> {
  const h = handlerSource();
  const out: Record<string, string> = {};
  for (const m of h.matchAll(/selectionConditions\.push\('([^']+)'\)/g)) {
    const bind = m[1].match(/\$(\w+)/);
    if (bind) out[bind[1]] = m[1];
  }
  for (const k of ['activity_id', 'start_date', 'end_date']) {
    if (!out[k]) throw new Error(`selection-outcomes: no selectionConditions.push literal binding $${k}`);
  }
  return out;
}

/** The handler's step-1 template with ${selectionWhereClause} expanded from the given params. */
function handlerQuery(params: string[]): string {
  const h = handlerSource();
  const conds = handlerConditions();
  const qStart = h.indexOf('const selectionsQuery = `');
  if (qStart < 0) throw new Error('selection-outcomes: no `const selectionsQuery` template');
  const body = h.slice(qStart + 'const selectionsQuery = `'.length, h.indexOf('`;', qStart));
  if (!body.includes('${selectionWhereClause}')) throw new Error('selection-outcomes: template no longer uses ${selectionWhereClause}');
  const list = params.map((p) => conds[p]);
  const where = list.length > 0 ? `WHERE ${list.join(' AND ')}` : '';
  const q = body.split('${selectionWhereClause}').join(where);
  if (/\$\{/.test(q)) throw new Error(`selection-outcomes: unexpanded interpolation: ${q}`);
  return q.trim();
}

async function run(q: string, binds: string): Promise<string[]> {
  const res = await sql(`${binds} ${q};`);
  const last = res[res.length - 1];
  if (last.status !== 'OK') throw new Error(`query failed: ${JSON.stringify(last.result)}`);
  return (last.result as any[]).map((r) => String(r.correlation_id));
}
async function truth(conds: string, binds: string, limit: number, offset = 0): Promise<string[]> {
  return run(`SELECT correlation_id, selected_at FROM thompson_selection_log WITH NOINDEX WHERE ${conds} ORDER BY selected_at DESC LIMIT ${limit} START ${offset}`, binds);
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
    // correlation_id (the field step 2 joins on) is added by a migration, not the base schema.
    await sql(readFileSync(ROOT + 'sql/migrations/031-selection-correlation-id.surql', 'utf8'));
    // 3,000 selections one second apart across 3 activities. SurrealQL ranges exclude the end.
    await sql(`FOR $i IN 0..3000 { CREATE thompson_selection_log CONTENT { execution_id: 'x' + <string>$i, correlation_id: 'c' + <string>$i, activity_id: 'a' + <string>($i % 3), thompson_sample: 0.5, alpha: 1.0, beta: 1.0, selection_method: 'thompson_sampling', candidates_count: 3, org_id: 'organizations:o1', selected_at: d'2026-01-01T00:00:00Z' + <duration> (<string>$i + 's') } };`);
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(() => { proc?.kill(); });

const B = `LET $start_date = '${START}'; LET $end_date = '${END}'; LET $limit = 5; LET $offset = 0;`;
const WIN = 'selected_at >= type::datetime($start_date)';

describe('selection-outcomes date window', () => {
  it('the instrument is live: surreal started, the real schema defined idx_thompson_selection_time, rows seeded', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE thompson_selection_log;');
    expect(Object.keys(info[0].result.indexes ?? {})).toContain('idx_thompson_selection_time');
    const n = await sql('SELECT count() AS n FROM thompson_selection_log WITH NOINDEX WHERE correlation_id != NONE GROUP ALL;');
    expect(n[0].result[0].n).toBe(3000);
  }, 60_000);

  it('without a date filter the list is the newest selections and must stay so', async () => {
    expect(await run(handlerQuery([]), B)).toEqual(await truth('true', B, 5));
  }, 60_000);

  it('THE DEFECT: with start_date the list returns the newest selections of the window, newest first', async () => {
    const got = await run(handlerQuery(['start_date']), B);
    expect(got).toEqual(await truth(WIN, B, 5));
  }, 60_000);

  it('THE DEFECT: start_date plus end_date returns the newest selections inside both bounds', async () => {
    const got = await run(handlerQuery(['start_date', 'end_date']), B);
    expect(got).toEqual(await truth(`${WIN} AND selected_at <= type::datetime($end_date)`, B, 5));
  }, 60_000);

  it('THE DEFECT: activity_id plus start_date, second page, is the next slice of the same order', async () => {
    const binds = `${B} LET $activity_id = 'a1'; LET $offset = 5;`;
    const got = await run(handlerQuery(['activity_id', 'start_date']), binds);
    expect(got).toEqual(await truth(`activity_id = $activity_id AND ${WIN}`, binds, 5, 5));
  }, 60_000);
});
