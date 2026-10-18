// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

/**
 * thompson_posterior's signature count AT SCALE, through the route, against a REAL SurrealDB carrying the schema
 * init-database.ts builds. The sibling file proves the count is right on five rows; this one proves it finishes.
 *
 * Why: the count was `SELECT <count over a subquery> AS sigs FROM execution WHERE activity_id = …`, which re-runs the
 * subquery once per execution of the variant (O(N²)). That shape was reverted once for not finishing within 150 s on
 * real arms (each call left a runaway query burning DB CPU), then re-landed with a two-row test. A row count that small
 * cannot see a quadratic, so this file seeds an arm with thousands of executions and bounds the call's wall time.
 *
 * It also seeds many executions of OTHER arms in the same org: on 2.3.10 a scan whose WHERE is
 * `activity_id = $v AND (account_id = … OR (account_id IS NONE AND org_id = …))` is planned as a union that
 * iterates every account-less row, so a single scan in that form is linear in the TABLE, not in the arm.
 *
 * The small-store control runs FIRST, before the scale seed, so it reads the same route on a store where even the
 * quadratic query answers. Needs `surreal` on PATH; if it is missing the instrument test FAILS rather than skipping.
 *
 * EVERY FAILURE IS NAMED. A hook that outlives its timeout, or a promise abandoned by a test and rejected later (when
 * afterAll stops the engine), is reported as a bare "(fail) (unnamed)" that a gate cannot attribute; on a loaded host
 * the 25k-row seed and an engine slow to exit are exactly those. So the start and both seeds race their own bound
 * (inside their test or hook's timeout) and fail by name, every abandoned promise has a catch, and afterAll's timeout
 * covers waiting out an abandoned start, then stop()'s SIGTERM wait plus the SIGKILL.
 */

const ORG = 'organizations:sigscale-probe';
const XORG = 'organizations:sigscale-other';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const BIG = `sigscale-big-${word()}`;
const SMALL = `sigscale-small-${word()}`;
const BIG_ROWS = 5000;
const BIG_SIGS = 50;
const OTHER_ROWS = 20000;
const WALL_BOUND_MS = 2000; // with the fix
const CAP_MS = 10_000; // the quadratic query is abandoned here, so a regression fails instead of hanging the file
const START_BOUND_MS = 180_000; // engine start + schema + small seed, inside beforeAll's 240 s
const SEED_BOUND_MS = 180_000; // the scale seed, inside its test's 240 s

let rs: RealSurreal | null = null;
let db: any = null;
let startError = '';
let routes: any = null;
let starting: Promise<void> | null = null;

// `n` executions of `activity` (a SurrealQL expression over $i) in `org`, signature `prefix-<i % mod>`.
function seed(activity: string, org: string, n: number, prefix: string, mod: number): string {
  return `INSERT INTO execution array::map(array::range(0, ${n}), |$i| { activity_id: ${activity}, input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${org}', executed_at: time::now() - 1h, created_at: time::now(), status: 'success', signature: '${prefix}-' + <string>($i % ${mod}), signature_version: 1 }) RETURN NONE;`;
}
function vpm(activity: string, n: number): string {
  return `CREATE variant_performance_metrics CONTENT { variant_id: '${activity}', activity_id: '${activity}', org_id: '${ORG}', total_executions: ${n}, successful_executions: ${n}, failed_executions: 0, success_rate: 1.0, avg_duration_ms: 10.0, avg_cost_usd: 0.0, thompson_alpha: ${n + 1}.0, thompson_beta: 1.0, total_selections: ${n}, created_at: time::now(), updated_at: time::now() };`;
}
async function counts(): Promise<Record<string, number>> {
  // GROUP BY over the whole table, not a filtered count(): on 2.3.10 an indexed count() can drop residual predicates.
  const r = await rs!.sql(`SELECT activity_id, org_id, count() AS n FROM execution GROUP BY activity_id, org_id;`);
  const out: Record<string, number> = {};
  for (const g of r[0].result) {
    const key = `${String(g.activity_id).startsWith('sigscale-other-') ? 'other' : g.activity_id}@${g.org_id}`;
    out[key] = (out[key] ?? 0) + g.n;
  }
  return out;
}

async function posterior(activity: string): Promise<Record<string, any>> {
  const a = new Hono();
  a.use('*', async (c, next) => {
    // apikey: executeAsAuth sends through the module client, which the harness routes to the real engine.
    c.set('jwtAuth', { orgId: ORG, projectId: undefined, projectIds: undefined, instanceId: undefined, authType: 'apikey' } as any);
    await next();
  });
  a.route('/v2/impulses', routes);
  const res = await a.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer: { type: 'thompson_posterior', activity_variant_id: activity } }),
  });
  const body = (await res.json()) as { content?: string };
  return JSON.parse(String(body.content ?? '{}')).content ?? {};
}

// Race `p` against `ms`; past it, throw a message that names what overran. The loser is caught, never left to reject unhandled.
async function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms / 1000} s (host under load?)`)), ms); });
  try { return await Promise.race([p, over]); } finally { clearTimeout(timer); }
}

async function timed(activity: string): Promise<{ ms: number; p: Record<string, any> | null }> {
  const t0 = performance.now();
  const call = posterior(activity);
  call.catch(() => {}); // abandoned at the cap, it rejects when afterAll stops the engine
  const p = await Promise.race([call, Bun.sleep(CAP_MS).then(() => null)]);
  return { ms: Math.round(performance.now() - t0), p };
}

// The execution scans the route's count statement issued (each must carry its server-side TIMEOUT).
function countScans(): Array<{ sql: string; params: Record<string, unknown> | undefined }> {
  return rs!.calls
    .filter((c) => /^\s*RETURN array::len/.test(c.sql))
    .flatMap((c) => [...c.sql.matchAll(/SELECT [^()]*?FROM execution [^()]*?TIMEOUT \d+m?s/g)].map((m) => ({ sql: m[0], params: c.params })));
}

beforeAll(async () => {
  try {
    starting = (async () => {
      rs = await startRealSurreal();
      db = await rs.connectModuleClient();
      routes = (await import('./impulses')).default;
      // The small store: 4 signatures over 8 rows, plus another arm's and another org's rows that must not count.
      await rs.sql([
        seed(`'${SMALL}'`, ORG, 8, 'small', 4),
        seed(`'sigscale-other-' + <string>($i % 3)`, ORG, 30, 'oth', 30),
        seed(`'${SMALL}'`, XORG, 6, 'xorg', 6),
        vpm(SMALL, 8),
      ].join('\n'));
    })();
    await bounded(starting, START_BOUND_MS, 'engine start and small-store seed');
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => {
  // A start abandoned at its bound may still bring an engine up: wait for it (bounded) so stop() sees it, never orphan it.
  await bounded(starting ?? Promise.resolve(), 15_000, 'abandoned engine start').catch(() => {});
  await rs?.stop();
}, 45_000);

describe('thompson_posterior signature count at scale on the real engine', () => {
  it('instrument: surreal started, small store seeded', async () => {
    expect(startError).toBe('');
    expect(await counts()).toEqual({ [`${SMALL}@${ORG}`]: 8, [`other@${ORG}`]: 30, [`${SMALL}@${XORG}`]: 6 });
  }, 60_000);

  it('control (small store): the count is right and other arms and orgs are excluded', async () => {
    const { ms, p } = await timed(SMALL);
    expect(p).not.toBeNull();
    expect(p!.scope).toBe('org');
    expect(p!.signatures_aggregated).toBe(4);
    console.log(`[sigscale] small store: ${ms} ms, signatures_aggregated=${p!.signatures_aggregated}`);
  }, 60_000);

  it(`an arm with ${BIG_ROWS} executions over ${BIG_SIGS} signatures answers within ${WALL_BOUND_MS} ms with the right count`, async () => {
    const t0 = performance.now();
    await bounded(rs!.sql([
      seed(`'${BIG}'`, ORG, BIG_ROWS, 'big', BIG_SIGS),
      seed(`'sigscale-other-' + <string>($i % 200)`, ORG, OTHER_ROWS, 'oth', 30),
      seed(`'${BIG}'`, XORG, 300, 'xorg', 20),
      vpm(BIG, BIG_ROWS),
    ].join('\n')), SEED_BOUND_MS, `the ${BIG_ROWS + OTHER_ROWS + 300}-row scale seed`);
    const c = await counts();
    expect(c[`${BIG}@${ORG}`]).toBe(BIG_ROWS);
    expect(c[`other@${ORG}`]).toBe(OTHER_ROWS + 30);
    console.log(`[sigscale] seeded ${BIG_ROWS + OTHER_ROWS + 300} rows in ${Math.round(performance.now() - t0)} ms`);

    const { ms, p } = await timed(BIG);
    console.log(`[sigscale] big arm: ${p ? `${ms} ms, signatures_aggregated=${p.signatures_aggregated}` : `no answer within ${CAP_MS} ms`}`);
    if (!p) throw new Error(`thompson_posterior did not answer within ${CAP_MS} ms for an arm with ${BIG_ROWS} executions`);
    expect(ms).toBeLessThan(WALL_BOUND_MS);
    expect(p.scope).toBe('org');
    // exactly 50: another arm's 30 signatures or another org's 20 leaking in would read 80 or 70; the warn fallback 1.
    expect(p.signatures_aggregated).toBe(BIG_SIGS);
  }, 240_000);

  it('the count statement scans execution once, by the variant index alone, under a live server-side TIMEOUT', async () => {
    const scans = countScans();
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans) {
      // the scan the planner runs: one index iterator on activity_id, no union, no table scan.
      const plan = await db.query(`${s.sql.replace(/ TIMEOUT \d+m?s$/, '')} EXPLAIN`, s.params);
      const iterators = (plan as any[]).filter((op) => String(op.operation).startsWith('Iterate'));
      expect(iterators.map((op) => `${op.operation}:${op.detail?.plan?.index ?? ''}`)).toEqual(['Iterate Index:idx_execution_activity']);
    }
    // the clause is live: the same statement with a timeout it cannot meet REJECTS (the warn path), never answers 0.
    const call = rs!.calls.filter((c) => /^\s*RETURN array::len/.test(c.sql)).pop()!;
    await expect(db.query(call.sql.replace(/TIMEOUT \d+m?s/g, 'TIMEOUT 1ns'), call.params)).rejects.toThrow(/timeout/i);
  }, 60_000);
});
