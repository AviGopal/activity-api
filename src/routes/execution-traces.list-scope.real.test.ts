/**
 * THE TRACE LIST'S ACCOUNT SCOPE IS ONE ORG EQUALITY, NOT A DISJUNCTION (built SQL, then the real engine).
 *
 * GET /v2/activities/execution-traces, on the root-credential path with a session account, scoped its rows with
 * `((account_id = $account_id OR (account_id IS NONE AND org_id = $org_id)) OR org_id = NULL)`. SurrealDB 2.3.10 answers
 * an OR whose branches are indexed by unioning index scans (idx_execution_account_id, idx_execution_org — the latter is
 * about the whole table) instead of walking the one executed_at range, so one cockpit trace read cost the database tens
 * of seconds. The route's SQL is captured here (the db client is a recorder) and then RUN, with its own parameters,
 * against a scratch SurrealDB carrying the real schema (test/support/real-surreal.ts):
 *   [MUST-FAIL] the account-scoped list query has no OR over org_id / account_id, and it returns exactly the caller's
 *               org rows that carry the caller's account or none (not another org's row that carries the caller's
 *               account); the engine plans it as one idx_execution_executed_at range walk (the old clause's plan, a
 *               union of five index iterations, is printed beside it); the summary projection's inner select no longer
 *               carries the fat columns;
 *               An account match no longer crosses orgs: the old clause let a foreign-org caller carrying the account
 *               see that account's rows in every org;
 *   [CONTROL]   tenant isolation: another org's caller sees none of these rows, another account's rows stay hidden, the
 *               org-only branch is unchanged, and the default projection still returns the wide row.
 */

import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const surrealQueries: { sql: string; params: any }[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => { surrealQueries.push({ sql, params }); return []; },
    getInstance: async () => ({}),
  },
  queryWithAuth: async (_token: string, sql: string, params: any) => { surrealQueries.push({ sql, params }); return []; },
  createAuthenticatedClient: async () => ({}),
}));

mock.module('../db/redis', () => ({
  // `redis` must be exported too (see execution-traces.account-id.test.ts): the replacement outlives this file.
  get redis() { return this.RedisClient.getInstance(); },
  RedisClient: {
    getInstance: () => ({
      del: async () => 0, get: async () => null, set: async () => 'OK', sadd: async () => 0, smembers: async () => [],
      srem: async () => 0, withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(), getClient: () => null,
    }),
  },
}));

mock.module('../websocket/broadcaster', () => ({ broadcaster: { emit: () => {} } }));

const executionTracesRouter = (await import('./execution-traces')).default;

const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ORG_A = `organizations:scope-a-${word()}`;
const ORG_B = `organizations:scope-b-${word()}`;
const ORG_C = `organizations:scope-c-${word()}`;
const ACC = `acc-${word()}`;
const OTHER_ACC = `acc-${word()}`;

function appWithSession(orgId: string, accountId?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('jwtAuth' as any, null);
    c.set('session' as any, { session_id: 's', org_id: orgId, account_id: accountId, project_id: null, api_key: null, latest_job_id: null });
    await next();
  });
  app.route('/v2/activities/execution-traces', executionTracesRouter);
  return app;
}

async function listQuery(orgId: string, accountId?: string, qs = ''): Promise<{ sql: string; params: Record<string, unknown> }> {
  surrealQueries.length = 0;
  const res = await appWithSession(orgId, accountId).request(`/v2/activities/execution-traces${qs}`, { headers: { 'Cache-Control': 'no-cache' } });
  expect(res.status).toBe(200);
  const q = surrealQueries.find((x) => /FROM execution/.test(x.sql) && /ORDER BY executed_at DESC/.test(x.sql));
  expect(q).toBeDefined();
  return q!;
}

let rs: RealSurreal | null = null;
let startError = '';

/** Run the route's own SQL with its own parameters (LET-bound) on the real engine; returns the rows. */
async function run(q: { sql: string; params: Record<string, unknown> }): Promise<any[]> {
  const lets = Object.entries(q.params).map(([k, v]) => `LET $${k} = ${JSON.stringify(v)};`).join('\n');
  const res = await rs!.sql(`${lets}\n${q.sql};`);
  return res[res.length - 1].result as any[];
}
const ids = (rows: any[]) => rows.map((r) => String(r.execution_id)).sort();

function exec(id: string, org: string, account?: string, extra = ''): string {
  return `CREATE execution:\`${id}\` CONTENT { activity_id: 'scope-arm', input_impulses: [], output_impulses: [], success: false, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${org}', ${account ? `account_id: '${account}', ` : ''}executed_at: time::now() - 1h, created_at: time::now(), status: 'failure', tags: ['dispatcher_used:goal-host']${extra} };`;
}
const FAT = `, metadata: { task_count: 3, note: 'x' }, failure_mode: { type: 'execution_error', class: 'deterministic:scope', reason: 'r' }, composition_chain: ['a', 'b'], input_impulse_shapes: ['goal'], output_impulse_shapes: ['shellResult']`;

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.sql([
      exec('sa_none', ORG_A, undefined, FAT), //  org A, no account          -> visible to (A, ACC)
      exec('sa_acc', ORG_A, ACC, FAT), //         org A, the caller's account -> visible
      exec('sa_other', ORG_A, OTHER_ACC), //      org A, another account     -> hidden
      exec('sb_none', ORG_B), //                  org B                       -> hidden
      exec('sb_acc', ORG_B, ACC), //              org B carrying ACC          -> hidden (the old clause let it in)
    ].join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

describe('trace list account scope', () => {
  test('instrument: surreal started and the five rows are seeded', async () => {
    expect(startError).toBe('');
    const n = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE string::starts_with(org_id, 'organizations:scope-');`);
    expect(n[0].result.length).toBe(5);
  }, 60_000);

  test('[MUST-FAIL] the account-scoped query has no OR over org_id / account_id', async () => {
    const q = await listQuery(ORG_A, ACC);
    const where = q.sql.slice(q.sql.indexOf('FROM execution'), q.sql.indexOf('ORDER BY'));
    expect(where).not.toMatch(/\bOR\b/);
    expect(where).toContain('org_id = $org_id');
    expect(q.params.org_id).toBe(ORG_A);
    expect(q.params.account_id).toBe(ACC);
  }, 60_000);

  test('[MUST-FAIL] it returns the caller\'s org rows with the caller\'s account or none, nothing else', async () => {
    expect(ids(await run(await listQuery(ORG_A, ACC)))).toEqual(['sa_acc', 'sa_none']);
  }, 60_000);

  test('[MUST-FAIL] the summary projection\'s inner select leaves the fat columns behind and keeps its scalars', async () => {
    const q = await listQuery(ORG_A, ACC, '?fields=summary');
    const inner = q.sql.slice(q.sql.indexOf('FROM ('), q.sql.indexOf('FROM execution'));
    for (const col of ['composition_chain', 'output_impulse_shapes', 'input_impulse_shapes', 'metadata,', 'failure_mode,'])
      expect(inner).not.toContain(col);
    const rows = await run(q);
    const r = rows.find((x) => x.execution_id === 'sa_acc');
    expect(r.failure_mode_type).toBe('execution_error');
    expect(r.task_count).toBe(3);
    expect(r.tags).toEqual(['dispatcher_used:goal-host']);
    expect('metadata' in r || 'composition_chain' in r || 'failure_mode' in r).toBe(false);
  }, 60_000);

  test('[CONTROL] the default projection still returns the wide row', async () => {
    const rows = await run(await listQuery(ORG_A, ACC));
    const r = rows.find((x) => x.execution_id === 'sa_acc');
    expect(r.metadata).toEqual({ task_count: 3, note: 'x' });
    expect(r.failure_mode.class).toBe('deterministic:scope');
    expect(r.composition_chain).toEqual(['a', 'b']);
    expect(r.input_impulse_shapes).toEqual(['goal']);
    expect(r.task_count).toBe(3);
  }, 60_000);

  test('[MUST-FAIL] an account match never crosses orgs: a foreign-org caller carrying the account sees nothing', async () => {
    // The old clause matched `account_id = $account_id` in ANY org, so this caller saw org A's and org B's ACC rows.
    expect(ids(await run(await listQuery(ORG_C, ACC)))).toEqual([]);
  }, 60_000);

  test('[CONTROL] tenant isolation: a foreign org sees nothing, another account stays hidden', async () => {
    expect(ids(await run(await listQuery(ORG_C)))).toEqual([]);
    expect(ids(await run(await listQuery(ORG_C, `acc-${word()}`)))).toEqual([]);
    expect(ids(await run(await listQuery(ORG_A, OTHER_ACC)))).toEqual(['sa_none', 'sa_other']);
  }, 60_000);

  test('[CONTROL] the org-only branch is unchanged', async () => {
    const q = await listQuery(ORG_B);
    expect(q.sql).toContain('WHERE org_id = $org_id AND executed_at >= type::datetime($start_date)');
    expect(ids(await run(q))).toEqual(['sb_acc', 'sb_none']);
  }, 60_000);

  test('[MUST-FAIL] the engine plans the route\'s scope as ONE executed_at range walk (the old clause\'s plan is printed)', async () => {
    const q = await listQuery(ORG_A, ACC);
    const lets = Object.entries(q.params).map(([k, v]) => `LET $${k} = ${JSON.stringify(v)};`).join('\n');
    const newWhere = q.sql.split('\n').find((l) => l.trim().startsWith('WHERE'))!.trim();
    const oldWhere = 'WHERE ((account_id = $account_id OR (account_id IS NONE AND org_id = $org_id)) OR org_id = NULL) AND executed_at >= type::datetime($start_date)';
    const plans: Record<string, any[]> = {};
    for (const [name, where] of [['old', oldWhere], ['new', newWhere]] as const) {
      const res = await rs!.sql(`${lets}\nSELECT id FROM execution ${where} EXPLAIN;`);
      plans[name] = res[res.length - 1].result;
      console.log(`[plan ${name}] ${where}\n${JSON.stringify(plans[name])}`);
    }
    const iterated = (p: any[]) => p.filter((s) => s.operation === 'Iterate Index').map((s) => s.detail.plan.index);
    expect(iterated(plans.new!)).toEqual(['idx_execution_executed_at']);
  }, 60_000);
});
