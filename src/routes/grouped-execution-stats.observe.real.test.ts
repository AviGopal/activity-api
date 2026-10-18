// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const { runGroupedExecutionStats } = await import('./grouped-execution-stats');

/**
 * AN OBSERVE VERDICT IS NOT A REACH STATISTIC (real engine).
 *
 * goal-host's observe dispatch (learning_mode "observe": a probe, a held-out measurement) tags its traces
 * learning_mode:observe, and POST /reach still writes the `reached` column on them (it records the verdict; it only
 * skips the learning). groupedExecutionStats counts reached / graded straight from that column, filtering only
 * telemetry:/satisfier: rows, so probes entered reach_rate and graded_count, which the gap sweep's falsifiers read.
 *
 * Against a scratch SurrealDB with the real schema (test/support/real-surreal.ts), counted from rows:
 *   [MUST-FAIL] observe rows (learning_mode:observe or reach_observe:true) with reached true/false are counted in
 *               neither reached_count nor graded_count;
 *   [CONTROL]   learn rows are counted, including one whose tags field is ABSENT (NONE) and one with tags [] (`NONE
 *               CONTAINSANY [...]` must not drop legacy untagged rows), and the existing telemetry exclusion still holds.
 */

const ORG = 'organizations:ges-observe-probe';
const AUTH = { orgId: ORG, authType: 'apikey' as const };
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ARM = `ges-arm-${word()}`;

let rs: RealSurreal | null = null;
let startError = '';
let db: any = null;

function exec(reached: boolean, tags?: string[]): string {
  const fields = [
    `activity_id: '${ARM}'`, 'input_impulses: []', 'output_impulses: []', 'success: true',
    'duration_ms: 10', 'cost_usd: 0.0', 'tokens_in: 0', 'tokens_out: 0', `org_id: '${ORG}'`,
    'executed_at: time::now() - 1h', 'created_at: time::now()', "status: 'success'", `reached: ${reached}`,
  ];
  if (tags) fields.push(`tags: ${JSON.stringify(tags)}`);
  return `CREATE execution CONTENT { ${fields.join(', ')} };`;
}

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    db = rs.sdk;
    await rs.sql([
      // learn: 2 reached (one with the tags field ABSENT, i.e. NONE), 2 not reached (one with tags [])
      exec(true, ['dispatcher_used:goal-host', 'reached:true']), exec(true), exec(false, ['learning_mode:learn', 'reached:false']), exec(false, []),
      // observe: 3 reached, 2 not reached, either observe tag
      exec(true, ['learning_mode:observe', 'reached:true']), exec(true, ['reach_observe:true']), exec(true, ['learning_mode:observe']),
      exec(false, ['learning_mode:observe', 'reached:false']), exec(false, ['reach_observe:true', 'reached:false']),
      // telemetry (already excluded): 1 not reached
      exec(false, ['telemetry:auth', 'reached:false']),
    ].join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

describe('grouped execution stats exclude observe verdicts', () => {
  it('instrument: surreal started, all 10 rows seeded, one with tags NONE (field absent) and one with tags []', async () => {
    expect(startError).toBe('');
    const n = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}';`);
    expect(n[0].result.length).toBe(10);
    const none = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}' AND tags IS NONE;`);
    expect(none[0].result.length).toBe(1);
    const empty = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}' AND tags = [];`);
    expect(empty[0].result.length).toBe(1);
  }, 60_000);

  it('[MUST-FAIL] reached_count and graded_count count only the learn rows', async () => {
    const r = await runGroupedExecutionStats(db, { activity_id: ARM }, AUTH);
    expect(r.reached_count).toBe(2); // includes the NONE-tags row
    expect(r.graded_count).toBe(4);  // includes the NONE-tags and []-tags rows
    expect(r.reach_rate).toBeCloseTo(2 / 4, 6);
  }, 60_000);

  it('[CONTROL] the observe exclusion is a bound parameter on a binary predicate', async () => {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const spy = { query: async (sql: string, params: Record<string, unknown>) => { calls.push({ sql, params }); return [[]]; } };
    await runGroupedExecutionStats(spy as never, { activity_id: ARM }, AUTH);
    const reach = calls.filter((c) => /reached (= true|!= NONE)/.test(c.sql));
    expect(reach.length).toBe(2);
    for (const c of reach) {
      expect(c.sql).toContain('(tags CONTAINSANY $observe_tags) = false');
      expect(c.params.observe_tags).toEqual(['learning_mode:observe', 'reach_observe:true']);
    }
  }, 60_000);
});
