import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import { newestFirstSql, hasRangeOn } from '../src/lib/newest-first-sql';

/**
 * newestFirstSql() MUST RETURN THE SAME ROWS AS A WITH NOINDEX RUN OF THE SAME FILTER.
 *
 * On SurrealDB 2.3.10 (also 2.4.1 and 2.5.0; 2.3.3 is correct) a range on an indexed field plus
 * ORDER BY that field DESC plus LIMIT returns the LOWEST rows of the range. newestFirstSql() is the
 * shared wrap (filter inside a subquery, sort/limit/page outside) the latent readers use. This test
 * runs the builder's SQL on a throwaway in-memory SurrealDB against a table with a single-field
 * index and a compound (prefix, time) index on the order field, for every filter shape the readers
 * build, and compares with WITH NOINDEX. A CONTROL pins that the fixture is sensitive to the defect.
 * Gap: surrealdb-2-3-10-returns-the-lowest-rows-for-an-indexed-range-ordered-desc-with-a-limit.
 *
 * Needs the `surreal` binary (present in the substrate image). If it is missing the suite FAILS
 * rather than skipping: a silent skip reads as a pass.
 */

const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
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
async function ids(q: string): Promise<string[]> {
  const res = await sql(`LET $since = d'2026-01-01T00:10:00Z'; LET $until = d'2026-01-01T00:40:00Z'; LET $g = 'g1'; LET $lim = 5; LET $off = 5; ${q};`);
  const last = res[res.length - 1];
  if (last.status !== 'OK') throw new Error(`query failed: ${q}: ${JSON.stringify(last.result)}`);
  return (last.result as any[]).map((r) => String(r.k));
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
    proc = spawn(['surreal', 'start', 'memory', '--bind', `127.0.0.1:${PORT}`, '--log', 'none'], { env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: PASS }, stdout: 'ignore', stderr: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${URL_}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error('surreal did not answer /health within 6 s');
    await sql(`
      DEFINE TABLE ev SCHEMALESS;
      DEFINE INDEX ev_t ON ev FIELDS t;
      DEFINE INDEX ev_g_t ON ev FIELDS g, t;
      DEFINE INDEX ev_ok ON ev FIELDS ok;
      FOR $i IN 0..3000 { CREATE ev CONTENT { k: 'k' + <string>$i, g: 'g' + <string>($i % 3), ok: $i % 2 = 0, t: d'2026-01-01T00:00:00Z' + <duration> (<string>$i + 's') } };
    `);
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(() => { proc?.kill(); });

const SHAPES: Array<[string, string[], boolean]> = [
  ['single-field range', ['t >= $since'], false],
  ['range with a strict bound', ['t > $since'], false],
  ['range with both bounds', ['t >= $since', 't <= $until'], false],
  ['range plus an equality on another indexed field', ['ok = true', 't >= $since'], false],
  ['compound prefix plus range', ['g = $g', 't >= $since'], false],
  ['tenant disjunction plus range', ['(g = $g OR g = "g2")', 't >= $since'], false],
  ['single-field range, second page', ['t >= $since'], true],
  ['no range on the order field', ['g = $g'], false],
  ['no filter at all', [], false],
];

describe('newestFirstSql NOINDEX equivalence', () => {
  it('the instrument is live: surreal started and rows seeded', async () => {
    expect(startError).toBe('');
    const n = await sql('SELECT count() AS n FROM ev WITH NOINDEX GROUP ALL;');
    expect(n[0].result[0].n).toBe(3000);
  }, 60_000);

  it('CONTROL: the unwrapped single-field form differs from NOINDEX where the engine has the defect', async () => {
    const direct = await ids('SELECT k, t FROM ev WHERE t >= $since ORDER BY t DESC LIMIT $lim');
    const scan = await ids('SELECT k, t FROM ev WITH NOINDEX WHERE t >= $since ORDER BY t DESC LIMIT $lim');
    const [maj, min, pat] = await engineVersion();
    const affected = !(maj === 2 && min === 3 && pat < 8); // measured: 2.3.3 correct; 2.3.10, 2.4.1, 2.5.0 wrong
    expect(JSON.stringify(direct) === JSON.stringify(scan)).toBe(!affected);
  }, 60_000);

  for (const [name, where, paged] of SHAPES) {
    it(`${name}: the builder returns the NOINDEX rows, newest first`, async () => {
      const q = newestFirstSql({ fields: 'k, t', from: 'ev', where, orderBy: 't', limit: '$lim', start: paged ? '$off' : undefined });
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const truth = await ids(`SELECT k, t FROM ev WITH NOINDEX ${w} ORDER BY t DESC LIMIT $lim${paged ? ' START $off' : ''}`);
      expect(truth.length).toBe(5);
      expect(await ids(q)).toEqual(truth);
    }, 60_000);
  }

  it('the wrap is applied exactly when a condition is a range on the order field', () => {
    expect(hasRangeOn('t', ['t >= $since'])).toBe(true);
    expect(hasRangeOn('t', ['x = 1', 't<$u'])).toBe(true);
    expect(hasRangeOn('executed_at', ['executed_at > type::datetime($s)'])).toBe(true);
    expect(hasRangeOn('t', ['g = $g'])).toBe(false);
    expect(hasRangeOn('t', ['tt >= $x', 'a.t >= $x'])).toBe(false);
    expect(hasRangeOn('execution_count', ['execution_count >= $minExecutions'])).toBe(true);
    expect(newestFirstSql({ fields: 'k, t', from: 'ev', where: ['g = $g'], orderBy: 't', limit: 5 })).not.toContain('(SELECT');
    expect(newestFirstSql({ fields: 'k, t', from: 'ev', where: ['t >= $s'], orderBy: 't', limit: 5 })).toContain('(SELECT');
  });
});
