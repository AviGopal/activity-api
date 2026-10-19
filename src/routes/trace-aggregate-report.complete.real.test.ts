// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';
import { OBSERVE_TRACE_TAGS } from '../lib/reach-classify';

const { runTraceAggregateReport } = await import('./trace-aggregate-report');

/**
 * A 30-DAY PER-TEMPLATE COUNT IS COMPLETE, AND A CAPPED ONE SAYS SO (real engine).
 *
 * development-vessel's reachable-unlearned report and health tick count executions per template over 720 h with
 * {group_by: activity_id, window_hours: 720}. The group cap was 1000, below the number of distinct activity_ids such a
 * window holds, so every one of those reads came back truncated=true and both reports logged their counts UNMEASURED.
 *
 * Against a scratch SurrealDB with the real schema (test/support/real-surreal.ts), counted from rows:
 *   [MUST-FAIL] 1,201 distinct activity_ids in the window come back as 1,201 rows with truncated=false;
 *   [CONTROL]   one busy template's count and success_count equal a hand count read WITH NOINDEX over the same tenant
 *               scope and window (SurrealDB 2.3.10 can drop the other predicates of an indexed count, so the ground
 *               truth must not use an index), and rows in another org, outside the window or observe-tagged are not
 *               counted;
 *   [HONESTY]   asked for fewer groups than exist, the report sets truncated=true and still names every group in
 *               total_groups;
 *   [PLAN]      the aggregate's plan is neither an index-only count nor a fallback full scan (the two 2.3.10 traps).
 */

const ORG = 'organizations:agg-complete-probe';
const OTHER_ORG = 'organizations:agg-complete-other';
const AUTH = { orgId: ORG, authType: 'apikey' as const };
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const RUN = word();
const BUSY = `agg-busy-${RUN}`;
const SINGLES = 1200;

let rs: RealSurreal | null = null;
let startError = '';
let db: any = null;

function exec(o: { activity: string; success: boolean; org?: string; at?: string; tags?: string[] }): string {
  const fields = [
    `activity_id: '${o.activity}'`, 'input_impulses: []', 'output_impulses: []', `success: ${o.success}`,
    'duration_ms: 10', 'cost_usd: 0.0', 'tokens_in: 0', 'tokens_out: 0', `org_id: '${o.org ?? ORG}'`,
    `executed_at: ${o.at ?? 'time::now() - 2h'}`, 'created_at: time::now()', `status: '${o.success ? 'success' : 'failure'}'`,
  ];
  if (o.tags) fields.push(`tags: ${JSON.stringify(o.tags)}`);
  return `CREATE execution CONTENT { ${fields.join(', ')} };`;
}

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    db = rs.sdk;
    const s: string[] = [];
    // 1,200 templates that ran once each in the window: more groups than the old cap.
    for (let i = 0; i < SINGLES; i++) s.push(exec({ activity: `agg-single-${RUN}-${i}`, success: i % 3 !== 0, at: `time::now() - ${1 + (i % 600)}h` }));
    // The busy template: 5 successes and 2 failures in scope, spread over the window.
    for (const h of [1, 30, 200, 400, 700]) s.push(exec({ activity: BUSY, success: true, at: `time::now() - ${h}h` }));
    for (const h of [5, 650]) s.push(exec({ activity: BUSY, success: false, at: `time::now() - ${h}h` }));
    // Out of scope for the busy template: another org, older than 720 h, and an observe probe.
    for (let i = 0; i < 3; i++) s.push(exec({ activity: BUSY, success: true, org: OTHER_ORG }));
    for (const h of [721, 740, 900]) s.push(exec({ activity: BUSY, success: true, at: `time::now() - ${h}h` }));
    s.push(exec({ activity: BUSY, success: true, tags: [OBSERVE_TRACE_TAGS[0]!] }));
    await rs.sql(s.join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

/** Ground truth: rows counted one by one WITH NOINDEX, in the same tenant scope and window the report reads. */
async function handCount(extra: string): Promise<number> {
  const since = new Date(Date.now() - 720 * 3600_000).toISOString();
  const r = await rs!.sql(
    `SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}' AND activity_id = '${BUSY}' ` +
    `AND executed_at >= <datetime>'${since}' AND (tags CONTAINSANY ${JSON.stringify([...OBSERVE_TRACE_TAGS])}) = false ${extra};`,
  );
  return (r[0].result as unknown[]).length;
}

describe('a 720 h per-template count over the real execution schema', () => {
  it('instrument: surreal started and every planted row is stored', async () => {
    expect(startError).toBe('');
    const r = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}';`);
    expect((r[0].result as unknown[]).length).toBe(SINGLES + 7 + 3 + 1);
  }, 60_000);

  it('[MUST-FAIL] more than 1000 templates in the window: every group is returned and truncated is false', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'count', window_hours: 720, limit: 20000 }, AUTH);
    expect(r.measured).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.total_groups).toBe(SINGLES + 1);
    expect(r.rows.length).toBe(SINGLES + 1);
  }, 120_000);

  it('[CONTROL] the busy template count and success_count equal a NOINDEX hand count in the same scope', async () => {
    const all = await handCount('');
    const ok = await handCount('AND success = true');
    expect(all).toBe(7);
    expect(ok).toBe(5);
    const count = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'count', window_hours: 720, limit: 20000 }, AUTH);
    const success = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'success_count', window_hours: 720, limit: 20000 }, AUTH);
    expect(count.rows.find((x) => x.key === BUSY)?.value).toBe(all);
    expect(success.rows.find((x) => x.key === BUSY)?.value).toBe(ok);
    expect(count.matched_total).toBe(SINGLES + all);
  }, 120_000);

  it('[HONESTY] asked for fewer groups than exist, the report says truncated and names the true group total', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'count', window_hours: 720, limit: 1000 }, AUTH);
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBe(1000);
    expect(r.total_groups).toBe(SINGLES + 1);
    // desc order keeps the busiest group, so a capped read still carries its true value.
    expect(r.rows[0]).toEqual({ key: BUSY, value: 7 });
  }, 120_000);

  it('[PLAN] the aggregate is planned neither as an index-only count nor as a fallback scan', async () => {
    rs!.calls.length = 0;
    await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'success_count', window_hours: 720, limit: 20000 }, AUTH);
    const call = rs!.calls.find((c) => /GROUP BY activity_id/.test(c.sql));
    expect(call).toBeDefined();
    const plan = await db.query(`${call!.sql.trim()} EXPLAIN`, call!.params);
    const text = JSON.stringify(plan);
    console.log(`[plan] ${text.slice(0, 1200)}`);
    expect(text).not.toContain('Iterate Index Count');
    expect(text).not.toContain('Fallback');
  }, 120_000);
});
