// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const { runTraceAggregateReport } = await import('./trace-aggregate-report');

/**
 * traceAggregateReport's failure-class dimension, checked against a REAL SurrealDB carrying the
 * schema init-database.ts builds (sql/*, sql/schemas/*, sql/migrations/*).
 *
 * Why not a fake DB: the sibling file trace-aggregate-report.failure-class.test.ts checks the SQL
 * TEXT (`toContain('metadata.verdict_class')`). a79e70c went green on that style of check while
 * grouping and filtering on `failure_class` and `reason`, which the SCHEMAFULL `execution` table
 * does not have: every row grouped under NONE and every filter matched nothing in production. A
 * path named in a comment, or in the wrong clause, or on a column that does not exist, passes a
 * text check and fails here, because here the answer is counted from rows.
 *
 * Where a failure class lives on a stored execution (src/lib/failure-class.ts, execution-traces.ts):
 *   - the late /reach verdict writes `metadata.verdict_class` (never failure_mode);
 *   - the insert path writes `failure_mode.class` beside `failure_mode.type`.
 * The class of a row is the late verdict when present, else the insert-time class.
 *
 * The class tokens are generated per run (canonical `deterministic:<token>` form), so no fixed
 * string can be special-cased: only reading the two real locations reproduces the counts.
 *
 * Needs the `surreal` binary on PATH (present in the substrate image); if it is missing the
 * instrument test FAILS rather than skipping.
 */

const ORG = 'organizations:agg-probe';
const OTHER_ORG = 'organizations:agg-other';
const AUTH = { orgId: ORG, authType: 'apikey' as const };

const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const tok = (p: string) => `deterministic:${p}-${word()}`;

// Classes, by where the fixture stores them.
const K_VERDICT = tok('late'); //       metadata.verdict_class only (late verdict, failure_mode NONE)
const K_INSERT = tok('insert'); //      failure_mode.class only
const K_BOTH_VERDICT = tok('wins'); //  metadata.verdict_class on rows that ALSO carry ...
const K_BOTH_INSERT = tok('loses'); //  ... this failure_mode.class (the verdict wins on those rows)
// Reason text the insert path recorded on the K_INSERT rows (a reason_contains target).
const REASON_TEXT = `upstream ${word()} refused`;
// Goal hashes (metadata.goal_hash), per class.
const G = Array.from({ length: 5 }, () => word());
const UNTIL_ACTIVITY = `until-probe-${word()}`;

let rs: RealSurreal | null = null;
let startError = '';
let db: any = null;

function exec(o: {
  org?: string; at?: string; success: boolean; activity?: string; status?: string;
  metadata?: Record<string, unknown>; failure_mode?: Record<string, unknown>;
}): string {
  const fields = [
    `activity_id: '${o.activity ?? 'agg-a'}'`, 'input_impulses: []', 'output_impulses: []', `success: ${o.success}`,
    'duration_ms: 10', 'cost_usd: 0.0', 'tokens_in: 0', 'tokens_out: 0', `org_id: '${o.org ?? ORG}'`,
    `executed_at: ${o.at ?? 'time::now() - 1h'}`, 'created_at: time::now()',
    `status: '${o.status ?? (o.success ? 'success' : 'failure')}'`,
  ];
  if (o.metadata) fields.push(`metadata: ${JSON.stringify(o.metadata)}`);
  if (o.failure_mode) fields.push(`failure_mode: ${JSON.stringify(o.failure_mode)}`);
  return `CREATE execution CONTENT { ${fields.join(', ')} };`;
}

/** Sum of the report's row values, optionally only for some keys. Independent of matched_total. */
const sumRows = (r: { rows: Array<{ key: string; value: number }> }) => r.rows.reduce((s, x) => s + x.value, 0);
/** The report's rows as a key -> value map, without the unclassed bucket. */
function keyed(r: { rows: Array<{ key: string; value: number }> }): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of r.rows) if (x.key !== '(none)' && x.key !== 'null' && x.key !== 'NONE') m[x.key] = x.value;
  return m;
}
const noneBucket = (r: { rows: Array<{ key: string; value: number }> }) =>
  r.rows.filter((x) => x.key === '(none)' || x.key === 'null' || x.key === 'NONE').reduce((s, x) => s + x.value, 0);

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    db = rs.sdk;
    const s: string[] = [];
    // In the 24 h window, in ORG:
    for (const g of [G[0], G[1], G[2], G[2]]) // 4 late-verdict rows; insert path left failure_mode NONE
      s.push(exec({ success: false, activity: 'agg-late', metadata: { verdict_class: K_VERDICT, goal_hash: g, reach_reason: 'judged not reached' } }));
    for (const g of [G[3], G[3], G[4]]) // 3 insert-time rows
      s.push(exec({ success: false, activity: 'agg-insert', metadata: { goal_hash: g }, failure_mode: { type: 'execution_error', class: K_INSERT, reason: `step 2: ${REASON_TEXT} (attempt ${word()})` } }));
    for (let i = 0; i < 2; i++) // 2 rows carrying both: the late verdict wins
      s.push(exec({ success: false, activity: 'agg-both', metadata: { verdict_class: K_BOTH_VERDICT }, failure_mode: { type: 'execution_error', class: K_BOTH_INSERT, reason: 'resolver said no' } }));
    s.push(exec({ success: false, activity: 'agg-loses-alone', failure_mode: { type: 'execution_error', class: K_BOTH_INSERT, reason: 'resolver said no' } }));
    for (let i = 0; i < 2; i++) // 2 unclassed failures (no class anywhere)
      s.push(exec({ success: false, activity: 'agg-unclassed', failure_mode: { type: 'execution_error' } }));
    for (let i = 0; i < 5; i++) s.push(exec({ success: true, activity: 'agg-ok' })); // 5 successes
    // Out of scope: another org, and older than the default window.
    for (let i = 0; i < 3; i++) s.push(exec({ org: OTHER_ORG, success: false, activity: 'agg-late', metadata: { verdict_class: K_VERDICT, goal_hash: G[0] }, failure_mode: { type: 'execution_error', class: K_INSERT, reason: REASON_TEXT } }));
    for (let i = 0; i < 2; i++) s.push(exec({ at: 'time::now() - 30h', success: false, activity: 'agg-late', metadata: { verdict_class: K_VERDICT, goal_hash: G[1] } }));
    // The until_hours_ago probe: one row each at now-1h, now-50h, now-100h.
    for (const h of [1, 50, 100]) s.push(exec({ at: `time::now() - ${h}h`, success: false, activity: UNTIL_ACTIVITY, failure_mode: { type: 'execution_error', class: K_INSERT, reason: 'until probe' } }));
    await rs.sql(s.join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

describe('trace aggregate over the real execution schema', () => {
  it('instrument: surreal started, the real execution schema carries metadata, failure_mode and status, rows seeded', async () => {
    expect(startError).toBe('');
    const info = await rs!.sql('INFO FOR TABLE execution;');
    const fields = Object.keys(info[0].result.fields ?? {});
    for (const f of ['metadata', 'failure_mode', 'status', 'executed_at', 'org_id', 'success']) expect(fields).toContain(f);
    const n = await rs!.sql(`SELECT count() AS n FROM execution WHERE org_id = '${ORG}' GROUP ALL;`);
    expect(n[0].result[0].n).toBe(22);
  }, 60_000);

  it('context (not a check): this schema has no failure_class or reason column, so a query naming them reads NONE', async () => {
    // a79e70c grouped and filtered on these two names. A fix may add such a column by migration;
    // this case only documents the tree it was written against and is not in any gap check.
    const info = await rs!.sql('INFO FOR TABLE execution;');
    const fields = Object.keys(info[0].result.fields ?? {});
    expect(fields).not.toContain('failure_class');
    expect(fields).not.toContain('reason');
  }, 60_000);

  it('control: group_by status keys rows by the stored status, scoped to the caller org and the window', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'status', limit: 50 }, AUTH);
    expect(keyed(r)).toEqual({ failure: 13, success: 5 });
  }, 60_000);

  it('control: group_by activity_id with failure_count counts only failures in the window', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'failure_count', limit: 50 }, AUTH);
    expect(keyed(r)).toEqual({ 'agg-late': 4, 'agg-insert': 3, 'agg-both': 2, 'agg-loses-alone': 1, 'agg-unclassed': 2, [UNTIL_ACTIVITY]: 1 });
  }, 60_000);
});

describe('trace aggregate c1 (real schema): group expressions per dimension', () => {
  it('group_by failure_class counts every failure under its class, read from metadata.verdict_class or failure_mode.class', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'failure_class', metric: 'failure_count', limit: 50 }, AUTH);
    expect(r.group_by).toBe('failure_class');
    // K_INSERT also carries the until-probe row at now-1h.
    expect(keyed(r)).toEqual({ [K_VERDICT]: 4, [K_INSERT]: 4, [K_BOTH_VERDICT]: 2, [K_BOTH_INSERT]: 1 });
    // Failures with no class anywhere may form one unclassed bucket, never more than they are.
    expect(noneBucket(r)).toBeLessThanOrEqual(2);
    expect(sumRows(r) - noneBucket(r)).toBe(11);
  }, 60_000);

  it('a row carrying both a late verdict and an insert-time class counts under the late verdict only', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'failure_class', metric: 'count', limit: 50 }, AUTH);
    const m = keyed(r);
    expect(m[K_BOTH_VERDICT]).toBe(2);
    expect(m[K_BOTH_INSERT]).toBe(1); // only the row whose class lives in failure_mode alone
    expect(m[K_VERDICT]).toBe(4); // a late verdict on a row whose failure_mode is NONE still counts
  }, 60_000);

  it('group_by goal_hash keys failures by metadata.goal_hash and total_groups is the distinct-goal count', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'goal_hash', metric: 'failure_count', limit: 2 }, AUTH);
    expect(r.group_by).toBe('goal_hash');
    expect(r.total_groups - (noneBucket(r) > 0 ? 1 : 0)).toBe(5);
    const all = await runTraceAggregateReport(db, { group_by: 'goal_hash', metric: 'failure_count', limit: 50 }, AUTH);
    expect(keyed(all)).toEqual({ [G[0]]: 1, [G[1]]: 1, [G[2]]: 2, [G[3]]: 2, [G[4]]: 1 });
    expect(r.rows.length).toBe(2);
    expect(r.truncated).toBe(true);
  }, 60_000);
});
