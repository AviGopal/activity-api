import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';
import { Hono } from 'hono';

/**
 * THE TRACE LIST MUST RETURN THE SAME ROWS AS TODAY WITHOUT READING THE WHOLE DEFAULT WINDOW.
 *
 * GET /v2/activities/execution-traces with no dates (the call most callers make: "latest N
 * traces") filters to the last 24 h, materialises every row of that window in a subquery, sorts
 * it, and returns one page. On node 1 2026-10-03 that is ~31k rows fetched (EXPLAIN FULL: Fetch
 * 31,052) to return 100; the route took 58% of activity-api's busy time over 6 h (p50 3 s, p99
 * 14 s, max 30 s) and its cost grows with the window, not with the request rate.
 *
 * The obvious rewrite — `WHERE … executed_at >= $start ORDER BY executed_at DESC LIMIT n` straight
 * on the table — is FAST AND WRONG on SurrealDB 2.3.10/2.4.1/2.5.0: an indexed range ordered DESC
 * with a LIMIT returns the LOWEST rows of the range (the CONTROL below pins this). Dropping the
 * range and ordering the whole org is correct but reads the whole org. A shape that is both
 * correct and bounded on this engine: query a narrow recent window first and widen it (up to the
 * same 24 h) only while it holds fewer than offset+limit rows. The newest N rows of 24 h ARE the
 * newest N rows of any sub-window that holds ≥ N rows, so the page is identical. Any other shape
 * that passes these tests is fine.
 *
 * What is pinned (qa review of TRACE_LIST.md, conditions 1, 2, 3, 4):
 *   - EQUIVALENCE: every request shape returns exactly the rows of a WITH NOINDEX run of today's
 *     semantics (no dates = last 24 h; explicit dates unchanged), newest first, including deep
 *     START offsets and a sparse tenant whose 24 h window holds fewer rows than the limit.
 *   - BOUNDED WORK: a first page with no dates over a dense window costs a fraction of
 *     materialising the window (self-calibrated against that query on the same engine, so the
 *     ratio, not the machine, decides).
 *   - CACHE BYPASS: a request carrying `Cache-Control: no-cache` is never served from the page
 *     cache (callers whose result gates a state change — closures, landing verification,
 *     retention — must be able to read fresh rows).
 * Not pinned here: server-side cancellation (condition 5) and the standing p99 row (condition 8).
 *
 * Gap: performance-inefficiency-execution_traces_list. Needs the `surreal` binary (present in
 * the substrate image); if it is missing the suite FAILS rather than skipping.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
const NS = 'aatest';
const DB = 'learning_loop';
const ORG = 'organizations:o1';
const SPARSE = 'organizations:o3';
let proc: Subprocess | null = null;
let startError = '';
let api: Hono | null = null;
let restoreSurrealConfig: (() => void) | null = null;
let restoreSurrealModule: (() => void) | null = null;

async function sql(text: string): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}

const bare = (id: unknown) => String(id).replace(/^execution:/, '').replace(/^⟨|⟩$/g, '');

/** Newest-first ids by full scan, with today's semantics. `since` defaults to now-24h like the handler. */
async function truth(org: string, limit: number, offset: number, extra = '', since = 'time::now() - 24h'): Promise<string[]> {
  const res = await sql(`SELECT id, executed_at FROM execution WITH NOINDEX WHERE org_id = '${org}' AND executed_at >= ${since} ${extra} ORDER BY executed_at DESC LIMIT ${limit} START ${offset};`);
  const last = res[res.length - 1];
  if (last.status !== 'OK') throw new Error(`truth failed: ${JSON.stringify(last.result)}`);
  return (last.result as any[]).map((r) => bare(r.id));
}

/** The handler, called as an API-key caller of `org` (the path every internal caller takes). */
async function list(org: string, query: string, headers: Record<string, string> = {}): Promise<string[]> {
  const res = await api!.request(`/v2/activities/execution-traces?${query}&__org=${encodeURIComponent(org)}`, { headers });
  const body = (await res.json()) as any;
  if (res.status !== 200) throw new Error(`list ${query}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return (body.executions as any[]).map((e) => bare(e.execution_id ?? e.id));
}

async function engineVersion(): Promise<[number, number, number]> {
  const m = (await (await fetch(`${URL_}/version`)).text()).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error('engine version unreadable');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

beforeAll(async () => {
  const hardStop = setTimeout(() => proc?.kill(), 300_000);
  (hardStop as any).unref?.();
  try {
    proc = spawn(['surreal', 'start', 'memory', '--bind', `127.0.0.1:${PORT}`, '--log', 'none'], { env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: PASS }, stdout: 'ignore', stderr: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${URL_}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error('surreal did not answer /health within 6 s');
    await sql(readFileSync(ROOT + 'sql/schemas/020-paradigm-core-tables.surql', 'utf8'));
    // The live index set: the boolean composites and the success index were removed by these.
    await sql(readFileSync(ROOT + 'sql/migrations/198-remove-boolean-composite-indexes-that-serve-zero.surql', 'utf8'));
    await sql(readFileSync(ROOT + 'sql/migrations/199-remove-boolean-success-index-that-discards-conjuncts.surql', 'utf8'));
    // 40,000 executions one every 3 s ending now (so 28.8k inside the default 24 h): 3/4 in ORG,
    // 1/4 in another org; every 5th fails. Plus a sparse tenant: 30 rows one every 96 min over 48 h.
    // SurrealQL ranges exclude the end.
    await sql(`LET $t0 = time::now() - 120001s; FOR $i IN 0..40000 { CREATE type::thing('execution', 'e' + <string>$i) CONTENT { activity_id: 'a' + <string>($i % 7), input_impulses: [], output_impulses: [], success: $i % 5 != 0, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: IF $i % 4 = 0 { 'organizations:o2' } ELSE { '${ORG}' }, executed_at: $t0 + <duration> (<string>($i * 3) + 's'), created_at: $t0 } };`);
    await sql(`LET $t0 = time::now() - 48h; FOR $i IN 0..30 { CREATE type::thing('execution', 's' + <string>$i) CONTENT { activity_id: 'a1', input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${SPARSE}', executed_at: $t0 + <duration> (<string>($i * 96) + 'm') + 1m, created_at: $t0 } };`);
    process.env.SURREALDB_URL = URL_;
    process.env.SURREALDB_NAMESPACE = NS;
    process.env.SURREALDB_DATABASE = DB;
    process.env.SURREALDB_USERNAME = 'root';
    process.env.SURREALDB_PASSWORD = PASS;
    // In a full-suite run another file may already have imported src/config and connected the
    // shared client: re-point the config object the client reads at connect time and drop any
    // existing connection, and hand both back afterwards.
    const { config } = await import('../src/config');
    const saved = { ...config.surrealdb };
    restoreSurrealConfig = () => Object.assign(config.surrealdb, saved);
    Object.assign(config.surrealdb, { url: URL_, namespace: NS, database: DB, username: 'root', password: PASS, authEnabled: true });
    // ~40 files in this suite mock.module('…/db/surreal') and Bun keeps a module mock for the rest of
    // the process (a later mock.module does not re-point it), so in a full run the client the route
    // holds may be some other file's stub. Load a REAL client under a distinct specifier and, while
    // this file runs, route the held client's query() through it; restore the method afterwards.
    const real = await import('../src/db/surreal.ts?trace-list-bounded-real');
    await real.surrealDB.close();
    const held = (await import('../src/db/surreal')).surrealDB as any;
    const heldQuery = held.query;
    held.query = (...args: any[]) => (real.surrealDB.query as any)(...args);
    restoreSurrealModule = () => { held.query = heldQuery; };
    const traces = (await import('../src/routes/execution-traces')).default;
    // An API-key caller: identity validated upstream, org carried on jwtAuth, no JWT token, so the
    // handler takes its root-credential path with an explicit org_id filter (as node callers do).
    api = new Hono();
    api.use('*', async (c, next) => {
      c.set('jwtAuth' as any, { orgId: c.req.query('__org'), authType: 'apikey' } as any);
      await next();
    });
    api.route('/v2/activities/execution-traces', traces);
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 240_000);

afterAll(async () => {
  try { await (await import('../src/db/surreal.ts?trace-list-bounded-real')).surrealDB.close(); } catch { /* ignore */ }
  restoreSurrealModule?.();
  restoreSurrealConfig?.();
  proc?.kill();
});

describe('trace list: same rows, bounded work', () => {
  it('the instrument is live: surreal started, the live executed_at index exists, rows seeded, the window is dense', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE execution;');
    expect(Object.keys(info[0].result.indexes ?? {})).toContain('idx_execution_executed_at');
    const n = await sql(`SELECT count() AS n FROM execution WITH NOINDEX WHERE org_id = '${ORG}' AND executed_at >= time::now() - 24h GROUP ALL;`);
    expect(n[0].result[0].n).toBeGreaterThan(20_000);
  }, 60_000);

  it('CONTROL: the fixture is sensitive to the engine defect a direct rewrite would hit', async () => {
    const direct = await sql(`SELECT id, executed_at FROM execution WHERE org_id = '${ORG}' AND executed_at >= time::now() - 24h ORDER BY executed_at DESC LIMIT 100;`);
    const ids = (direct[0].result as any[]).map((r) => bare(r.id));
    const [maj, min, pat] = await engineVersion();
    const affected = !(maj === 2 && min === 3 && pat < 8); // measured: 2.3.3 correct; 2.3.10, 2.4.1, 2.5.0 wrong
    expect(JSON.stringify(ids) === JSON.stringify(await truth(ORG, 100, 0))).toBe(!affected);
  }, 60_000);

  it('no dates, first page: the newest 100 of the last 24 h, newest first', async () => {
    expect(await list(ORG, 'limit=100')).toEqual(await truth(ORG, 100, 0));
  }, 60_000);

  it('no dates, small limits and an offset: the same slices of the same order', async () => {
    expect(await list(ORG, 'limit=20')).toEqual(await truth(ORG, 20, 0));
    expect(await list(ORG, 'limit=50&offset=250')).toEqual(await truth(ORG, 50, 250));
  }, 60_000);

  it('no dates, deep page (the offset pagers walk to ~1,900): the same slice', async () => {
    expect(await list(ORG, 'limit=100&offset=1900')).toEqual(await truth(ORG, 100, 1900));
  }, 60_000);

  it('no dates, a filter: success=false and activity_id give the newest matching rows', async () => {
    expect(await list(ORG, 'limit=100&success=false')).toEqual(await truth(ORG, 100, 0, 'AND success = false'));
    expect(await list(ORG, 'limit=30&activity_id=a3')).toEqual(await truth(ORG, 30, 0, "AND activity_id = 'a3'"));
  }, 60_000);

  it('no dates, sparse tenant: every row of the last 24 h and none older, newest first', async () => {
    const want = await truth(SPARSE, 100, 0);
    expect(want.length).toBeGreaterThan(5);
    expect(want.length).toBeLessThan(30);
    expect(await list(SPARSE, 'limit=100')).toEqual(want);
  }, 60_000);

  it('no dates, pages a narrow first window cannot hold: filtered deep pages, the sparse tenant with an offset, the window\'s last rows', async () => {
    // A window that starts narrow must widen until it holds offset+limit MATCHING rows. A fix that
    // narrows without widening (or widens only for offset 0, or only for unfiltered requests) is
    // right on the dense first page and wrong here. success=false is 1 row in 5, activity_id 1 in 7.
    expect(await list(ORG, 'limit=100&offset=1500&success=false')).toEqual(await truth(ORG, 100, 1500, 'AND success = false'));
    expect(await list(ORG, 'limit=40&offset=900&activity_id=a5')).toEqual(await truth(ORG, 40, 900, "AND activity_id = 'a5'"));
    expect(await list(SPARSE, 'limit=5&offset=7')).toEqual(await truth(SPARSE, 5, 7));
    // The oldest rows of the 24 h window: only a window widened to the full 24 h holds them.
    const n = (await sql(`SELECT count() AS n FROM execution WITH NOINDEX WHERE org_id = '${ORG}' AND executed_at >= time::now() - 24h GROUP ALL;`))[0].result[0].n as number;
    const tail = await list(ORG, `limit=100&offset=${n - 150}`);
    const want = await truth(ORG, 100, n - 150);
    // Rows age out of the window between the two reads; the handler may lag truth by a row or two at the edge.
    expect(tail.slice(0, 90)).toEqual(want.slice(0, 90));
    expect(tail.length).toBeGreaterThanOrEqual(95);
  }, 120_000);

  it('explicit dates keep today\'s semantics exactly (window-dependent callers)', async () => {
    const since = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const until = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(await list(ORG, `limit=100&since=${encodeURIComponent(since)}`)).toEqual(await truth(ORG, 100, 0, '', `d'${since}'`));
    expect(await list(ORG, `limit=100&offset=300&start_date=${encodeURIComponent(since)}&end_date=${encodeURIComponent(until)}`))
      .toEqual(await truth(ORG, 100, 300, `AND executed_at <= d'${until}'`, `d'${since}'`));
  }, 60_000);

  it('THE DEFECT: a no-dates first page costs a fraction of materialising the 24 h window', async () => {
    // Reference: what today's query does, run directly on the same engine (materialise + sort).
    const ref: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await sql(`SELECT id, executed_at, metadata, tags FROM (SELECT id, executed_at, metadata, tags FROM execution WHERE org_id = '${ORG}' AND executed_at >= time::now() - 24h) ORDER BY executed_at DESC LIMIT 100;`);
      ref.push(performance.now() - t);
    }
    // The handler, each request a distinct page key so the page cache cannot answer it.
    const got: number[] = [];
    const pages: Array<[number, string[]]> = [];
    for (const lim of [97, 98, 99]) {
      const t = performance.now();
      pages.push([lim, await list(ORG, `limit=${lim}`)]);
      got.push(performance.now() - t);
    }
    // Fast only counts if it is right: a handler that errors or returns nothing must not pass here.
    for (const [lim, page] of pages) expect(page).toEqual(await truth(ORG, lim, 0));
    // Fast only counts if it is right for EVERY page, not just the dense first one: a narrow window
    // that never widens is fast and right at offset 0 and wrong for a deep page or a sparse tenant.
    expect(await list(ORG, 'limit=100&offset=1900')).toEqual(await truth(ORG, 100, 1900));
    expect(await list(ORG, 'limit=60&offset=700&success=false')).toEqual(await truth(ORG, 60, 700, 'AND success = false'));
    expect(await list(SPARSE, 'limit=100')).toEqual(await truth(SPARSE, 100, 0));
    // Measured on 2.3.10: today ≈ 1× the reference; a narrow-first window ≈ 0.05×.
    expect(median(got)).toBeLessThan(median(ref) / 4);
  }, 120_000);

  it('THE DEFECT: Cache-Control: no-cache is never served from the page cache', async () => {
    // The page cache lives 10 s. On a slow machine the entry can expire between the read that
    // fills it and the bypass read, and an expired entry would let today's handler pass. So the
    // bypass read must start within 5 s of the fill; a slower attempt proves nothing and is
    // retried with a fresh key; three slow attempts fail as an instrument problem, never pass.
    let verdict: string[] | null = null;
    let freshId = '';
    for (let attempt = 0; attempt < 3 && verdict === null; attempt++) {
      const act = `cache${attempt}`;
      freshId = `fresh${attempt}`;
      // An explicit start_date: with none, the key carries now-24h bucketed to 10 s, so two reads
      // straddling a bucket boundary miss each other and a stale page is never served to detect.
      const q = `limit=10&activity_id=${act}&start_date=${encodeURIComponent(new Date(Date.now() - 2 * 3_600_000).toISOString())}`;
      await sql(`CREATE type::thing('execution', 'old${attempt}') CONTENT { activity_id: '${act}', input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now() - 1h, created_at: time::now() };`);
      const before = await list(ORG, q);
      const filled = performance.now();
      expect(before).toEqual([`old${attempt}`]);
      await sql(`CREATE type::thing('execution', '${freshId}') CONTENT { activity_id: '${act}', input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now(), created_at: time::now() };`);
      if (performance.now() - filled > 5_000) continue;
      verdict = await list(ORG, q, { 'Cache-Control': 'no-cache' });
    }
    expect(verdict).not.toBeNull();
    expect(verdict![0]).toBe(freshId);
  }, 120_000);
});
