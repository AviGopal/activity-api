// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const { runTraceAggregateReport } = await import('./trace-aggregate-report');

/**
 * AN OBSERVE EXECUTION IS NOT COUNTED BY THE TRACE AGGREGATE (real engine).
 *
 * goal-host's observe dispatch (learning_mode "observe": a probe, a held-out measurement) tags its traces
 * learning_mode:observe, and POST / and POST /reach stamp reach_observe:true on a row they recorded as observe
 * (lib/reach-classify.ts isObserveTrace). classifyReach answers 'ungraded' for such a row, but this report never
 * calls classifyReach: it counts failure classes straight from the rows (metadata.verdict_class, failure_mode.class),
 * so an observe probe's failure entered the failure-class counts the gap detectors read.
 *
 * Against a scratch SurrealDB with the real schema (test/support/real-surreal.ts), counted from rows:
 *   [MUST-FAIL] observe rows carrying a failure class (late verdict class or insert-time class, tagged
 *               learning_mode:observe or reach_observe:true) are counted under no class, in no metric;
 *   [CONTROL]   learn rows of the same class are counted (including a row whose tags field is ABSENT, i.e. NONE, and
 *               one with tags []: `NONE CONTAINSANY [...]` must not drop legacy untagged rows), and the observe tags
 *               are bound as a parameter on a binary predicate (no unary `!`: SurrealDB 2.3.10 full-scans on it).
 */

const ORG = 'organizations:agg-observe-probe';
const AUTH = { orgId: ORG, authType: 'apikey' as const };
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const K_LATE = `deterministic:obs-late-${word()}`;
const K_INSERT = `deterministic:obs-insert-${word()}`;

let rs: RealSurreal | null = null;
let startError = '';
let db: any = null;

function exec(o: { success: boolean; activity: string; tags?: string[]; metadata?: Record<string, unknown>; failure_mode?: Record<string, unknown> }): string {
  const fields = [
    `activity_id: '${o.activity}'`, 'input_impulses: []', 'output_impulses: []', `success: ${o.success}`,
    'duration_ms: 10', 'cost_usd: 0.0', 'tokens_in: 0', 'tokens_out: 0', `org_id: '${ORG}'`,
    'executed_at: time::now() - 1h', 'created_at: time::now()', `status: '${o.success ? 'success' : 'failure'}'`,
  ];
  if (o.tags) fields.push(`tags: ${JSON.stringify(o.tags)}`);
  if (o.metadata) fields.push(`metadata: ${JSON.stringify(o.metadata)}`);
  if (o.failure_mode) fields.push(`failure_mode: ${JSON.stringify(o.failure_mode)}`);
  return `CREATE execution CONTENT { ${fields.join(', ')} };`;
}
const keyed = (r: { rows: Array<{ key: string; value: number }> }): Record<string, number> =>
  Object.fromEntries(r.rows.map((x) => [x.key, x.value]));

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    db = rs.sdk;
    const s: string[] = [];
    // LEARN rows: 2 late-class (one with the tags field ABSENT, i.e. NONE), 2 insert-class (one with tags []).
    s.push(exec({ success: false, activity: 'agg-learn', tags: ['dispatcher_used:goal-host', 'reached:false'], metadata: { verdict_class: K_LATE } }));
    s.push(exec({ success: false, activity: 'agg-learn', metadata: { verdict_class: K_LATE } }));
    s.push(exec({ success: false, activity: 'agg-learn', tags: ['learning_mode:learn'], failure_mode: { type: 'execution_error', class: K_INSERT, reason: 'x' } }));
    s.push(exec({ success: false, activity: 'agg-learn', tags: [], failure_mode: { type: 'execution_error', class: K_INSERT, reason: 'x' } }));
    // OBSERVE rows of the same classes: 3 late-class, 2 insert-class, either observe tag.
    for (const tag of ['learning_mode:observe', 'reach_observe:true', 'learning_mode:observe'])
      s.push(exec({ success: false, activity: 'agg-observe', tags: ['dispatcher_used:goal-host', tag, 'reached:false'], metadata: { verdict_class: K_LATE } }));
    for (const tag of ['learning_mode:observe', 'reach_observe:true'])
      s.push(exec({ success: false, activity: 'agg-observe', tags: [tag], failure_mode: { type: 'execution_error', class: K_INSERT, reason: 'x' } }));
    // An observe success, for the count metric.
    s.push(exec({ success: true, activity: 'agg-observe', tags: ['learning_mode:observe', 'reached:true'] }));
    await rs.sql(s.join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

describe('trace aggregate excludes observe executions', () => {
  it('instrument: surreal started, all 10 rows seeded, one with tags NONE (field absent) and one with tags []', async () => {
    expect(startError).toBe('');
    const n = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}';`);
    expect(n[0].result.length).toBe(10);
    // tags is option<array<string>> (migration 157): an absent field is NONE, and NULL is not storable in an option.
    const none = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}' AND tags IS NONE;`);
    expect(none[0].result.length).toBe(1);
    const empty = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}' AND tags = [];`);
    expect(empty[0].result.length).toBe(1);
  }, 60_000);

  it('[MUST-FAIL] group_by failure_class counts only the learn rows of each class', async () => {
    const r = await runTraceAggregateReport(db, { group_by: 'failure_class', metric: 'failure_count', limit: 50 }, AUTH);
    expect(keyed(r)).toEqual({ [K_LATE]: 2, [K_INSERT]: 2 }); // the NONE-tags and []-tags learn rows are counted
  }, 60_000);

  it('[MUST-FAIL] a failure_class filter and the count metric exclude observe rows too', async () => {
    const late = await runTraceAggregateReport(db, { group_by: 'activity_id', failure_class: K_LATE, limit: 50 }, AUTH);
    expect(keyed(late)).toEqual({ 'agg-learn': 2 });
    const all = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'count', limit: 50 }, AUTH);
    expect(keyed(all)).toEqual({ 'agg-learn': 4 });
  }, 60_000);

  it('[CONTROL] the predicate is binary and the observe tags are a bound parameter', async () => {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const spy = { query: async (sql: string, params: Record<string, unknown>) => { calls.push({ sql, params }); return [[]]; } };
    await runTraceAggregateReport(spy as never, { group_by: 'failure_class', metric: 'failure_count' }, AUTH);
    expect(calls[0]!.sql).toContain('(tags CONTAINSANY $observe_tags) = false');
    expect(calls[0]!.sql).not.toMatch(/!\s*\(?\s*tags/);
    expect(calls[0]!.params.observe_tags).toEqual(['learning_mode:observe', 'reach_observe:true']);
  }, 60_000);
});
