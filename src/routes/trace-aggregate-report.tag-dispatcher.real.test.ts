// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const { runTraceAggregateReport } = await import('./trace-aggregate-report');

/**
 * ONE AGGREGATE IN PLACE OF A PAGED TRACE WINDOW (real engine).
 *
 * boredom-vessel's posterior fetchers (fetchPosteriorsForSignature, fetchDispatcherPosteriors) page the whole 24 h trace
 * list and count, in JS, only the traces tagged `state_signature:<sig>`: per template, and per `dispatcher_used:*` tag,
 * with success = status success|completed OR success = true, observe traces included (the list route has no observe
 * filter). The aggregate could not answer that: it had no tag filter, no tag dimension, a fixed success rule and a
 * fixed observe exclusion. Against a scratch SurrealDB with the real schema (test/support/real-surreal.ts), counted
 * from rows, the same fixture is counted by the report and by a copy of bv's own loop:
 *   [MUST-FAIL] tag + group_by_tag + success_rule status_or_flag + exclude_observe false give bv's per-template and
 *               per-dispatcher counts; success_rule reached counts the stored verdict; a malformed new parameter is
 *               refused (measured false), never dropped;
 *   [CONTROL]   development-vessel's two call shapes (trace-window-counts.ts) and the default call count the same rows and
 *               send the same SQL and parameters as before; an unknown parameter is ignored.
 */

const ORG = 'organizations:agg-tag-probe';
const OTHER_ORG = 'organizations:agg-tag-other';
const AUTH = { orgId: ORG, authType: 'apikey' as const };
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const SIG = `state_signature:${word()}`;
const OTHER_SIG = `state_signature:${word()}`;
const A = `tpl-a-${word()}`;
const B = `tpl-b-${word()}`;

interface Row { activity: string; success: boolean; status?: string; tags: string[]; reached?: boolean; org?: string; at?: string }
const GH = 'dispatcher_used:goal-host';
const LD = 'dispatcher_used:light-dispatch';
const FIXTURE: Row[] = [
  { activity: A, success: true, status: 'success', tags: [SIG, GH], reached: true },
  { activity: A, success: false, status: 'completed', tags: [GH, SIG], reached: false }, // status says success, flag says no
  { activity: A, success: false, status: 'failure', tags: [SIG, GH, 'reached:false'] },
  { activity: A, success: true, status: 'success', tags: [SIG, LD] },
  { activity: A, success: false, status: 'failure', tags: [SIG] }, //                 no dispatcher tag
  { activity: B, success: true, tags: [SIG, LD] }, //                                 status field absent (NONE)
  { activity: B, success: false, tags: [SIG, LD] }, //                                status NONE, a failure
  { activity: B, success: false, status: 'failure', tags: [SIG, GH, 'learning_mode:observe'] }, // observe
  // Not at this signature, or not in the window, or another tenant: never counted under the tag.
  { activity: A, success: true, status: 'success', tags: [OTHER_SIG, GH] },
  { activity: A, success: true, status: 'success', tags: [SIG, GH], at: 'time::now() - 30h' },
  { activity: A, success: true, status: 'success', tags: [SIG, GH], org: OTHER_ORG },
];

let rs: RealSurreal | null = null;
let startError = '';
let db: any = null;

function exec(o: Row): string {
  const fields = [
    `activity_id: '${o.activity}'`, 'input_impulses: []', 'output_impulses: []', `success: ${o.success}`,
    'duration_ms: 10', 'cost_usd: 0.0', 'tokens_in: 0', 'tokens_out: 0', `org_id: '${o.org ?? ORG}'`,
    `executed_at: ${o.at ?? 'time::now() - 1h'}`, 'created_at: time::now()', `tags: ${JSON.stringify(o.tags)}`,
  ];
  if (o.status) fields.push(`status: '${o.status}'`);
  if (o.reached !== undefined) fields.push(`reached: ${o.reached}`);
  return `CREATE execution CONTENT { ${fields.join(', ')} };`;
}

/** bv's loop (boredom-vessel src/index.ts fetchDispatcherPosteriors), over the rows the list route would return. */
function bvReference(listed: Row[], sigTag: string) {
  const cells = new Map<string, { alpha: number; beta: number; samples: number }>();
  for (const t of listed) {
    if (!t.tags.includes(sigTag)) continue;
    let dispatcher: string | null = null;
    for (const tag of t.tags) {
      if (tag === GH) { dispatcher = 'goal-host'; break; }
      if (tag === LD) { dispatcher = 'light-dispatch'; break; }
    }
    const success = t.status === 'success' || t.status === 'completed' || t.success === true;
    const k = `${t.activity}|${dispatcher}`;
    const cell = cells.get(k) ?? { alpha: 0, beta: 0, samples: 0 };
    if (success) cell.alpha += 1; else cell.beta += 1;
    cell.samples += 1;
    cells.set(k, cell);
  }
  return cells;
}
const listedRows = FIXTURE.filter((r) => (r.org ?? ORG) === ORG && !r.at);

type Report = { rows: Array<{ key: string; value: number; tag_value?: string | null }> };
const byPair = (r: Report): Record<string, number> => Object.fromEntries(r.rows.map((x) => [`${x.key}|${x.tag_value}`, x.value]));
const keyed = (r: Report): Record<string, number> => Object.fromEntries(r.rows.map((x) => [x.key, x.value]));

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    db = rs.sdk;
    await rs.sql(FIXTURE.map(exec).join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

const BV = { group_by: 'activity_id', tag: SIG, group_by_tag: 'dispatcher_used', exclude_observe: false, success_rule: 'status_or_flag', limit: 20000 };

describe('trace aggregate: tag filter, tag dimension, success rule, observe switch', () => {
  it('instrument: surreal started and all fixture rows seeded', async () => {
    expect(startError).toBe('');
    const n = await rs!.sql(`SELECT id FROM execution WITH NOINDEX WHERE org_id = '${ORG}';`);
    expect(n[0].result.length).toBe(FIXTURE.length - 1);
  }, 60_000);

  it('[MUST-FAIL] bv\'s call counts samples and successes per (template, dispatcher) exactly as bv\'s loop does', async () => {
    const samples = await runTraceAggregateReport(db, { ...BV, metric: 'count' }, AUTH);
    const alpha = await runTraceAggregateReport(db, { ...BV, metric: 'success_count' }, AUTH);
    expect(samples.measured).toBe(true);
    expect(samples.truncated).toBe(false);
    expect(byPair(samples)).toEqual({
      [`${A}|goal-host`]: 3, [`${A}|light-dispatch`]: 1, [`${A}|null`]: 1, [`${B}|light-dispatch`]: 2, [`${B}|goal-host`]: 1,
    });
    expect(byPair(alpha)).toEqual({ [`${A}|goal-host`]: 2, [`${A}|light-dispatch`]: 1, [`${B}|light-dispatch`]: 1 });
    // The same numbers bv's own loop computes from the listed rows.
    const ref = bvReference(listedRows, SIG);
    const refSamples = Object.fromEntries([...ref].map(([k, c]) => [k, c.samples]));
    const refAlpha = Object.fromEntries([...ref].filter(([, c]) => c.alpha > 0).map(([k, c]) => [k, c.alpha]));
    expect(byPair(samples)).toEqual(refSamples);
    expect(byPair(alpha)).toEqual(refAlpha);
    // failure_count under the same rule is the complement (bv's beta).
    const beta = await runTraceAggregateReport(db, { ...BV, metric: 'failure_count' }, AUTH);
    const refBeta = Object.fromEntries([...ref].filter(([, c]) => c.beta > 0).map(([k, c]) => [k, c.beta]));
    expect(byPair(beta)).toEqual(refBeta);
    expect(beta.success_rule).toBe('status_or_flag');
    expect(beta.tag).toBe(SIG);
  }, 60_000);

  it('[MUST-FAIL] the tag filter alone narrows per-template counts; observe rows count only when asked', async () => {
    const def = await runTraceAggregateReport(db, { group_by: 'activity_id', tag: SIG, limit: 50 }, AUTH);
    expect(keyed(def)).toEqual({ [A]: 5, [B]: 2 }); // the observe row is excluded by default
    const all = await runTraceAggregateReport(db, { group_by: 'activity_id', tag: SIG, exclude_observe: false, limit: 50 }, AUTH);
    expect(keyed(all)).toEqual({ [A]: 5, [B]: 3 });
    expect(all.exclude_observe).toBe(false);
  }, 60_000);

  it('[MUST-FAIL] success_rule reached counts the stored verdict; a row with no verdict is neither', async () => {
    const ok = await runTraceAggregateReport(db, { group_by: 'activity_id', tag: SIG, metric: 'success_count', success_rule: 'reached' }, AUTH);
    const ko = await runTraceAggregateReport(db, { group_by: 'activity_id', tag: SIG, metric: 'failure_count', success_rule: 'reached' }, AUTH);
    expect(keyed(ok)).toEqual({ [A]: 1 });
    expect(keyed(ko)).toEqual({ [A]: 1 });
  }, 60_000);

  it('[MUST-FAIL] a malformed new parameter is refused, never dropped', async () => {
    for (const [bad, reason] of [
      [{ tag: 42 }, 'invalid_tag'], [{ tag: '' }, 'invalid_tag'],
      [{ group_by_tag: 'dispatcher used' }, 'invalid_group_by_tag'],
      [{ exclude_observe: 'false' }, 'invalid_exclude_observe'],
      [{ success_rule: 'status' }, 'unserved_success_rule'],
    ] as const) {
      const r = await runTraceAggregateReport(db, { group_by: 'activity_id', ...bad }, AUTH);
      expect(r.measured).toBe(false);
      expect(r.reason).toBe(reason);
      expect(r.rows).toEqual([]);
    }
  }, 60_000);

  it('[CONTROL] development-vessel\'s two call shapes and the default call count the same rows', async () => {
    const dvCount = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'count', window_hours: 24, limit: 20000 }, AUTH);
    const dvOk = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'success_count', window_hours: 24, limit: 20000 }, AUTH);
    expect(keyed(dvCount)).toEqual({ [A]: 6, [B]: 2 }); // every in-window learn row of the org, any signature
    expect(keyed(dvOk)).toEqual({ [A]: 3, [B]: 1 }); // success = true
    for (const r of [dvCount, dvOk]) {
      expect(Object.keys(r).sort()).toEqual(['empty', 'generated_at', 'group_by', 'matched_total', 'measured', 'metric', 'query_ms', 'rows', 'shape', 'total_groups', 'truncated', 'until_hours_ago', 'window_hours']);
      for (const row of r.rows) expect(Object.keys(row).sort()).toEqual(['key', 'value']);
    }
  }, 60_000);

  it('[CONTROL] an unknown parameter is ignored: same rows as without it', async () => {
    const plain = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'count', limit: 50 }, AUTH);
    const extra = await runTraceAggregateReport(db, { group_by: 'activity_id', metric: 'count', limit: 50, bogus_param: 'x', tags: ['y'] }, AUTH);
    expect(extra.rows).toEqual(plain.rows);
    expect(extra.measured).toBe(true);
    expect('bogus_param' in extra).toBe(false);
  }, 60_000);

  it('[CONTROL] dv\'s call shapes send the same SQL and parameters as before', async () => {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const spy = { query: async (sql: string, params: Record<string, unknown>) => { calls.push({ sql, params }); return [[{ activity_id: 'x', value: 2 }]]; } };
    const outs = [];
    for (const metric of ['count', 'success_count'])
      outs.push(await runTraceAggregateReport(spy as never, { group_by: 'activity_id', metric, window_hours: 24, limit: 20000 }, AUTH));
    outs.push(await runTraceAggregateReport(spy as never, {}, AUTH));
    const sqlOf = (extra: string) => `
    SELECT activity_id, count() AS value
    FROM execution
    WHERE executed_at >= type::datetime($since)${extra} AND (tags CONTAINSANY $observe_tags) = false AND org_id = $orgId
    GROUP BY activity_id
  `;
    expect(calls.map((c) => c.sql)).toEqual([sqlOf(''), sqlOf(' AND success = true'), sqlOf('')]);
    for (const c of calls) {
      expect(Object.keys(c.params).sort()).toEqual(['observe_tags', 'orgId', 'since']);
      expect(c.params.observe_tags).toEqual(['learning_mode:observe', 'reach_observe:true']);
    }
    for (const o of outs) {
      const { generated_at: _g, query_ms: _q, ...rest } = o;
      expect(JSON.stringify(rest)).toBe(JSON.stringify({
        shape: 'traceAggregateReport', metric: o.metric, group_by: 'activity_id', window_hours: 24, until_hours_ago: 0,
        rows: [{ key: 'x', value: 2 }], total_groups: 1, truncated: false, empty: false, measured: true, matched_total: 2,
      }));
    }
  }, 60_000);
});
