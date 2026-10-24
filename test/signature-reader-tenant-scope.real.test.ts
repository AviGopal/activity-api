/**
 * THE SIGNATURE READER'S TENANT SCOPE IS ONE ORG EQUALITY, NOT A DISJUNCTION (captured SQL, then the real engine).
 *
 * executionTraceWithSignatures, on the API-key path every vessel caller takes, scoped its reads with
 * `(account_id = $account_id OR (account_id IS NONE AND org_id = $orgId))`. The read was already bounded in the
 * request: since defaults to 24 h, limit to 100 (max 500), and the window predicate and LIMIT are in the SQL. The
 * cost was the plan. SurrealDB 2.3.10 answers that disjunction with a union of index iterations on `execution`
 * (idx_execution_account_id twice, idx_execution_org, which covers about the whole table, and the executed_at
 * range), with a FULL TABLE SCAN on v_paradigm_execution_traces, and with idx_impulse_org (every impulse of the org)
 * beside the id lookup on `impulse`. One windowed read walked the trace store twice and ran for minutes on a
 * contended database while its callers had given up. The reader's own statements are captured here and EXPLAINed,
 * with their own parameters, on a scratch SurrealDB carrying the real schema (test/support/real-surreal.ts):
 *   [MUST-FAIL] no statement the reader issues has an OR over org_id / account_id; the execution read plans as the
 *               single idx_execution_executed_at range, the view read as an index range (not a table scan), the
 *               impulse read on idx_impulse_id alone; an account match no longer crosses orgs.
 *   [CONTROL]   the request bounds hold on both trees (LIMIT $lim within the cap and the executed_at window on every
 *               windowed statement, a 24 h default); the rows a caller sees in its own org are the rows it saw before
 *               (null account and session account alike); another org and another account stay hidden; an
 *               execution_id point read is unchanged.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from './support/real-surreal';
import { runExecutionTraceWithSignatures } from '../src/routes/execution-trace-with-signatures';

const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ORG_A = `organizations:sig-a-${word()}`;
const ORG_B = `organizations:sig-b-${word()}`;
const ACC = `acc-${word()}`;
const OTHER_ACC = `acc-${word()}`;
const MAX_LIMIT = 500;

let rs: RealSurreal | null = null;
let sdk: any = null;
let startError = '';

function exec(id: string, org: string, account?: string, age = '1h'): string {
  return `CREATE execution:\`${id}\` CONTENT { activity_id: 'sig-arm', input_impulses: ['impulse:sig_${id}'], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${org}', ${account ? `account_id: '${account}', ` : ''}executed_at: time::now() - ${age}, created_at: time::now(), status: 'success' };`;
}

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    sdk = rs.sdk;
    await rs.sql([
      exec('sa_none', ORG_A), //               org A, no account           -> visible to (A, any account or none)
      exec('sa_acc', ORG_A, ACC), //           org A, the caller's account  -> visible to (A, ACC)
      exec('sa_other', ORG_A, OTHER_ACC), //   org A, another account      -> hidden from (A, ACC) and (A, none)
      exec('sa_old', ORG_A, undefined, '48h'), // org A, outside the 24 h default window -> hidden
      exec('sb_none', ORG_B), //               org B                        -> hidden from org A
      exec('sb_acc', ORG_B, ACC), //           org B carrying ACC           -> hidden (the disjunction let it in)
    ].join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

const apikey = (orgId: string, accountId: string | null) => ({ orgId, accountId, authType: 'apikey' as const });

/** Run the reader through the recorded SDK connection; returns its statements and the execution ids it answered. */
async function read(orgId: string, accountId: string | null, input: Record<string, unknown> = {}) {
  rs!.calls.length = 0;
  const rep = await runExecutionTraceWithSignatures(sdk, input, apikey(orgId, accountId));
  const ids = [...new Set(rep.traces.map((t) => String(t.execution_id).replace(/^execution:/, '').replace(/^⟨|⟩$/g, '')))].sort();
  return { rep, ids, calls: rs!.calls.slice() };
}

const over = (calls: { sql: string }[], table: string) => calls.filter((c) => new RegExp(`FROM ${table}\\b`).test(c.sql));
/** The WHERE that follows `FROM <table>` in a captured statement (the filter the engine plans on that table): up to the
 *  paren that closes its subquery, or ORDER BY / LIMIT at its own depth. */
function innerWhere(sql: string, table: string): string {
  const rest = sql.slice(sql.lastIndexOf(`FROM ${table}`) + `FROM ${table}`.length);
  const w = rest.slice(rest.indexOf('WHERE'));
  let depth = 0;
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '(') depth++;
    else if (w[i] === ')') { if (depth === 0) return w.slice(0, i).trim(); depth--; }
    else if (depth === 0 && /^(ORDER BY|LIMIT)\b/.test(w.slice(i))) return w.slice(0, i).trim();
  }
  return w.trim();
}
async function plan(table: string, where: string, params: Record<string, unknown>): Promise<any[]> {
  const lets = Object.entries(params).map(([k, v]) => `LET $${k} = ${JSON.stringify(v)};`).join('\n');
  const res = await rs!.sql(`${lets}\nSELECT id FROM ${table} ${where} EXPLAIN;`);
  const p = res[res.length - 1].result as any[];
  console.log(`[plan ${table}] ${where}\n${JSON.stringify(p)}`);
  return p;
}
const iterated = (p: any[]) => p.filter((s) => s.operation === 'Iterate Index').map((s) => s.detail.plan.index);
const scanned = (p: any[]) => p.some((s) => s.operation === 'Iterate Table');

describe('executionTraceWithSignatures tenant scope', () => {
  test('instrument: surreal started and the six rows are seeded (live table and view)', async () => {
    expect(startError).toBe('');
    const n = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE string::starts_with(org_id, 'organizations:sig-');`);
    expect(n[0].result.length).toBe(6);
    const v = await rs!.sql(`SELECT execution_id FROM v_paradigm_execution_traces WITH NOINDEX WHERE string::starts_with(org_id, 'organizations:sig-');`);
    expect(v[0].result.length).toBe(6);
  }, 60_000);

  test('[MUST-FAIL] no statement the reader issues has an OR over org_id / account_id', async () => {
    for (const acc of [ACC, null]) {
      const { calls } = await read(ORG_A, acc);
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.sql).not.toMatch(/\bOR\b[^;]*\b(org_id|account_id)\b|\b(org_id|account_id)\b[^;]*\bOR\b/);
      }
      expect(over(calls, 'execution').some((c) => c.sql.includes('org_id = $orgId'))).toBe(true);
    }
  }, 60_000);

  test('[MUST-FAIL] the execution window read plans as ONE executed_at range walk', async () => {
    const { calls } = await read(ORG_A, ACC);
    const q = over(calls, 'execution').find((c) => /executed_at >= type::datetime\(\$since\)/.test(c.sql))!;
    expect(q).toBeDefined();
    expect(iterated(await plan('execution', innerWhere(q.sql, 'execution'), q.params!))).toEqual(['idx_execution_executed_at']);
  }, 60_000);

  test('[MUST-FAIL] the legacy view window read is an index range, not a table scan', async () => {
    const { calls } = await read(ORG_A, ACC);
    const q = over(calls, 'v_paradigm_execution_traces').find((c) => /executed_at >= type::datetime\(\$since\)/.test(c.sql))!;
    expect(q).toBeDefined();
    const p = await plan('v_paradigm_execution_traces', innerWhere(q.sql, 'v_paradigm_execution_traces'), q.params!);
    expect(scanned(p)).toBe(false);
    expect(iterated(p).length).toBe(1);
  }, 60_000);

  test('[MUST-FAIL] the impulse read is planned on idx_impulse_id alone', async () => {
    const { calls } = await read(ORG_A, ACC);
    const q = over(calls, 'impulse')[0]!;
    expect(q).toBeDefined();
    expect(iterated(await plan('impulse', innerWhere(q.sql, 'impulse'), q.params!))).toEqual(['idx_impulse_id']);
  }, 60_000);

  test('[MUST-FAIL] an account match never crosses orgs', async () => {
    // The disjunction matched `account_id = $account_id` in ANY org, so this caller also saw org B's ACC row.
    expect((await read(ORG_A, ACC)).ids).toEqual(['sa_acc', 'sa_none']);
    // ... and the point read answered org A's ACC execution to an org B caller carrying the same account.
    expect((await read(ORG_B, ACC, { execution_id: 'sa_acc', limit: 1 })).ids).toEqual([]);
  }, 60_000);

  test('[CONTROL] the request bounds: LIMIT within the cap and the executed_at window on every windowed statement', async () => {
    const before = Date.now();
    const { rep, calls } = await read(ORG_A, null);
    const since = Date.parse(rep.filtered_by.since);
    expect(Math.abs(before - 24 * 3600_000 - since)).toBeLessThan(60_000);
    expect(rep.filtered_by.limit).toBeLessThanOrEqual(MAX_LIMIT);
    const windowed = [...over(calls, 'execution'), ...over(calls, 'v_paradigm_execution_traces')].filter((c) => /\bLIMIT\b/.test(c.sql));
    expect(windowed.length).toBe(2);
    for (const c of windowed) {
      expect(c.sql).toMatch(/executed_at >= type::datetime\(\$since\)/);
      expect(c.sql).toMatch(/LIMIT \$lim/);
      expect(c.params!.lim as number).toBeLessThanOrEqual(MAX_LIMIT);
    }
    await expect(runExecutionTraceWithSignatures(sdk, { limit: MAX_LIMIT + 1 }, apikey(ORG_A, null))).rejects.toMatchObject({ status: 400 });
  }, 60_000);

  test('[CONTROL] the rows a caller sees in its own org are unchanged; other orgs and accounts stay hidden', async () => {
    expect((await read(ORG_A, null)).ids).toEqual(['sa_none']);
    expect((await read(ORG_A, OTHER_ACC)).ids).toEqual(['sa_none', 'sa_other']);
    expect((await read(ORG_B, null)).ids).toEqual(['sb_none']);
    expect((await read(`organizations:sig-c-${word()}`, null)).ids).toEqual([]);
    expect((await read(ORG_A, null, { since: new Date(Date.now() - 72 * 3600_000).toISOString() })).ids).toEqual(['sa_none', 'sa_old']);
  }, 60_000);

  test('[CONTROL] an execution_id point read is unchanged', async () => {
    expect((await read(ORG_A, ACC, { execution_id: 'sa_acc', limit: 1 })).ids).toEqual(['sa_acc']);
    expect((await read(ORG_A, null, { execution_id: 'sa_acc', limit: 1 })).ids).toEqual([]);
    expect((await read(ORG_A, null, { execution_id: 'sa_none', limit: 1 })).ids).toEqual(['sa_none']);
  }, 60_000);
});
