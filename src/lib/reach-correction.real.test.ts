// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';
import { classifyReach } from './reach-classify';

/**
 * A recorded correction retracts a LATCHED reach:false to ungraded, on a REAL SurrealDB with the schema
 * init-database.ts builds (the correction is SQL on the SCHEMAFULL `execution` table: a field the table does
 * not carry, or a SET order the engine does not honour, cannot survive this).
 *
 * The latched row is seeded exactly as POST /reach leaves a light-dispatch clean completion it graded
 * reached:false: tags dispatcher_used:light-dispatch + reach_graded:true + reached:false, `reached` false,
 * completion_shapes [] (the mirror's mark). No verdict_class: light-dispatch sends no reason.
 *
 * MUST-FAIL: the corrected row reads ungraded through classifyReach and through every consumer of the verdict:
 * the `reached` column readers (grouped-execution-stats, the trace hydrate, the reach-history rollup), the
 * shape-counter seed, retention compaction, and a redelivered /reach. CONTROLS: an unlatched row, a reached
 * row and a failed row are refused and untouched; re-applying is a no-op; the inverse restores; no posterior
 * row (variant_performance_metrics, context_thompson_scores, shape_score_counter) changes. Needs `surreal` on
 * PATH; if it is missing the instrument test FAILS rather than skipping.
 */

const ORG = 'organizations:reach-correction-probe';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ACT = `rc-arm-${word()}`;
const E = {
  latched: `rc-latched-${word()}`,
  unlatched: `rc-unlatched-${word()}`,
  reached: `rc-reached-${word()}`,
  failed: `rc-failed-${word()}`,
};
const LIST = [E.latched];
const listSha = (ids: string[]) => createHash('sha256').update([...new Set(ids)].sort().map((i) => `${i}\n`).join('')).digest('hex');
const SHA = listSha(LIST);
const PROV = { list_sha: SHA, rule: 'light-dispatch all-of: every declared output shape produced', commit: 'abc1234' };
const OP = { role: 'admin', scopes: ['admin'], orgId: ORG, keyId: 'op' };
const NODE = 'rc-node';

let rs: RealSurreal | null = null;
let db: any = null;
let startError = '';
let RC: typeof import('./reach-correction') | null = null;
let posteriorsBefore = '';

function exec(id: string, o: { success: boolean; tags: string[]; reached: boolean | null; patched: boolean }): string {
  return `CREATE type::thing('execution', '${id}') CONTENT { activity_id: '${ACT}', input_impulses: [], output_impulses: [], success: ${o.success}, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now() - 1h, created_at: time::now(), status: '${o.success ? 'completed' : 'failed'}', tags: ${JSON.stringify(o.tags)}, metadata: { dispatcher_used: 'light-dispatch' }${o.reached === null ? '' : `, reached: ${o.reached}`}${o.patched ? ', completion_shapes: []' : ''} };`;
}
const LD = 'dispatcher_used:light-dispatch';

async function row(id: string): Promise<any> {
  const r = await rs!.sql(`SELECT meta::id(id) AS eid, activity_id, org_id, success, tags, reached, completion_shapes, metadata FROM type::thing('execution', '${id}');`);
  return r[0].result[0];
}
async function posteriors(): Promise<string> {
  const r = await rs!.sql([
    'SELECT * FROM variant_performance_metrics ORDER BY id;',
    'SELECT * FROM context_thompson_scores ORDER BY id;',
    'SELECT * FROM shape_score_counter ORDER BY id;',
    'SELECT * FROM shape_score_counted ORDER BY id;',
  ].join('\n'));
  return JSON.stringify(r.map((s) => s.result));
}
const correct = (id: string, extra: Record<string, unknown> = {}) =>
  RC!.applyReachCorrection(db, { execution_id: id, correction_of: 'reach:false', provenance: PROV, ...extra } as any);

/** A fake authorization read: this node's development-vessel answering with `records`. */
function authDeps(records: Array<Record<string, unknown>>) {
  return {
    db,
    node: () => NODE,
    auth: {
      poolResolveUrl: 'http://127.0.0.1:8090/v2/impulses/resolve',
      nowMs: () => Date.now(),
      fetch: async () => new Response(JSON.stringify({ body: { impulses: records } }), { status: 200 }),
    },
  } as any;
}
const record = (listSha256: string, o: Record<string, unknown> = {}) => ({
  shape: 'posteriorReplayAuthorization', status: 'open', updated_at: new Date().toISOString(),
  body: { node: NODE, list_sha256: listSha256, review_by: new Date(Date.now() + 86_400_000).toISOString() },
  attested: { by: 'operator' }, attested_verified: true, ...o,
});

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    db = await rs.connectModuleClient();
    await rs.sql([
      exec(E.latched, { success: true, tags: [LD, 'reach_graded:true', 'reached:false'], reached: false, patched: true }),
      exec(E.unlatched, { success: true, tags: [LD, 'reached:false'], reached: false, patched: true }),
      exec(E.reached, { success: true, tags: [LD, 'reach_graded:true', 'reached:true'], reached: true, patched: true }),
      exec(E.failed, { success: false, tags: [LD, 'reach_graded:true', 'reached:false'], reached: false, patched: true }),
      `CREATE variant_performance_metrics CONTENT { variant_id: '${ACT}', activity_id: '${ACT}', org_id: '${ORG}', total_executions: 4, successful_executions: 3, failed_executions: 1, success_rate: 0.75, avg_duration_ms: 10.0, avg_cost_usd: 0.0, thompson_alpha: 2.0, thompson_beta: 4.0, total_selections: 4, created_at: time::now(), updated_at: time::now() };`,
      `CREATE context_thompson_scores CONTENT { template_id: '${ACT}', org_id: '${ORG}', context_bucket: 'b0', alpha: 2.0, beta: 4.0, n_observations: 4 };`,
    ].join('\n'));
    RC = await import('./reach-correction');
    // The decision outcomes the latched verdicts fed, written by their own writer (the universal capture path).
    const { recordExecutionDecisionOutcome } = await import('./decision-credit');
    for (const id of [E.latched, E.unlatched]) {
      await recordExecutionDecisionOutcome(db, { executionId: id, activityId: ACT, orgId: ORG, success: true, reached: false });
    }
    posteriorsBefore = await posteriors();
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

describe('a recorded correction retracts a latched reach:false (real engine)', () => {
  it('instrument: surreal started; the latched row reads not-reached before any correction', async () => {
    expect(startError).toBe('');
    const r = await row(E.latched);
    expect(r.reached).toBe(false);
    expect(classifyReach({ success: r.success, execution_id: r.eid, activity_id: r.activity_id, tags: r.tags })).toBe('not-reached');
    expect(JSON.parse(posteriorsBefore)[0].length).toBe(1);
    expect(JSON.parse(posteriorsBefore)[1].length).toBe(1);
  }, 60_000);

  it('MUST-FAIL (pure): classifyReach reads a retracted reach:false as ungraded', () => {
    expect(classifyReach({ success: true, tags: [LD, 'reach_graded:true', 'reached:false', `reach_retracted:${SHA}`] })).toBe('ungraded');
    // A real reach is never hidden by the tag; an empty suffix is no retraction.
    expect(classifyReach({ success: true, tags: ['reached:true', `reach_retracted:${SHA}`] })).toBe('reached');
    expect(classifyReach({ success: true, tags: ['reached:false', 'reach_retracted:'] })).toBe('not-reached');
  });

  it('MUST-FAIL: the correction retracts the latched row, with provenance, and it reads ungraded', async () => {
    expect(await correct(E.latched)).toEqual({ execution_id: E.latched, status: 'retracted' });
    const r = await row(E.latched);
    expect(r.reached ?? null).toBe(null);
    expect(r.tags).toContain(`reach_retracted:${SHA}`);
    expect(r.tags).toContain('reach_graded:true'); // still protected evidence for retention
    expect(classifyReach({ success: r.success, execution_id: r.eid, activity_id: r.activity_id, tags: r.tags })).toBe('ungraded');
    expect(r.metadata.reach_retraction).toMatchObject({ list_sha: SHA, rule: PROV.rule, commit: PROV.commit, prior_reached: false });
    const sv = r.metadata.superseded_verdicts;
    expect(sv.length).toBe(1);
    expect(sv[0]).toMatchObject({ superseded_by: `correction:${SHA}`, correction_of: 'reach:false', prior_reached: false, provenance: PROV });
    expect(r.metadata.dispatcher_used).toBe('light-dispatch');
  }, 60_000);

  it('MUST-FAIL: every consumer reads the retracted row as ungraded', async () => {
    // grouped-execution-stats (the reach-rate report the gap sweep's falsifier reads): reached = true / reached != NONE.
    const { runGroupedExecutionStats } = await import('../routes/grouped-execution-stats');
    // It takes the raw SDK connection (one result set per statement), as its resolver passes it.
    const stats = await runGroupedExecutionStats(rs!.sdk, { activity_id: ACT, window_hours: 24 }, { orgId: ORG, authType: 'apikey' });
    expect({ count: stats.rows[0]?.count, graded: stats.graded_count, reached: stats.reached_count, ungraded: stats.ungraded_count })
      .toEqual({ count: 4, graded: 3, reached: 1, ungraded: 1 });
    // The trace list / detail hydrate: the column is the verdict, null is "not graded".
    const { hydrateReachedVerdicts } = await import('../routes/execution-traces');
    const hydrated = await hydrateReachedVerdicts([{ execution_id: E.latched }, { execution_id: E.unlatched }], (sql, p) => db.query(sql, p));
    expect(hydrated.map((h: any) => h.reached)).toEqual([null, false]);
    // The shape-score counter's seed replay: neither occasion is graded for the retracted row.
    const { seedGradings } = await import('./shape-score-counter');
    const r = await row(E.latched);
    expect(seedGradings({ eid: r.eid, activity_id: r.activity_id, org_id: r.org_id, success: r.success, tags: r.tags, completion_shapes: r.completion_shapes })).toEqual([]);
    const f = await row(E.failed);
    expect(seedGradings({ eid: f.eid, activity_id: f.activity_id, org_id: f.org_id, success: f.success, tags: f.tags, completion_shapes: f.completion_shapes }).map((g) => g.verdict))
      .toEqual(['not-reached', 'not-reached']);
    // The reach-history rollup (reached != NONE): the retracted row is not folded in.
    const { rollupReachHistory, COMPACT_SQL } = await import('../services/trace-retention') as any;
    const roll = await rollupReachHistory();
    expect(roll?.scanned).toBe(3);
    // Retention compaction: the retracted row's observation is no verdict, and says why.
    await rs!.sql(`LET $ids = [type::thing('execution', '${E.latched}'), type::thing('execution', '${E.unlatched}')];\n${COMPACT_SQL('$ids')}`);
    const obs = (await rs!.sql(`SELECT execution_id, observation, instrument, retraction FROM execution_observation ORDER BY execution_id;`))[0].result;
    const byId = Object.fromEntries(obs.map((o: any) => [o.execution_id, o]));
    expect(byId[E.latched].observation ?? null).toBe(null);
    expect(byId[E.latched].instrument).toBe('reach_retracted');
    expect(byId[E.latched].retraction.list_sha).toBe(SHA);
    expect(byId[E.unlatched]).toMatchObject({ observation: false, instrument: 'reach_verdict' });
  }, 120_000);

  it('MUST-FAIL: a redelivered reach:false on the retracted row is held, not re-latched', async () => {
    const routes = (await import('../routes/execution-traces')).default;
    const a = new Hono();
    a.route('/', routes);
    const res = await a.request('/reach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ execution_id: E.latched, reached: false }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, updated: 1, retracted: true });
    const r = await row(E.latched);
    expect(r.reached ?? null).toBe(null);
    expect(classifyReach({ success: r.success, tags: r.tags })).toBe('ungraded');
  }, 60_000);

  it('CONTROL: re-applying is a no-op (no second history entry)', async () => {
    expect(await correct(E.latched)).toEqual({ execution_id: E.latched, status: 'already_retracted' });
    expect((await row(E.latched)).metadata.superseded_verdicts.length).toBe(1);
  }, 60_000);

  it('CONTROL: an unlatched, a reached and a failed row are refused and untouched', async () => {
    const before = await Promise.all([E.unlatched, E.reached, E.failed].map(row));
    expect(((await correct(E.unlatched)) as any).refused).toBe('not_latched');
    expect(((await correct(E.reached)) as any).refused).toBe('reached_true');
    expect(((await correct(E.failed)) as any).refused).toBe('failed_execution');
    expect(((await correct('rc-no-such-row')) as any).refused).toBe('no_such_execution');
    expect(((await correct(E.latched, { correction_of: 'reach:true' })) as any).refused).toBe('bad_request');
    expect(await Promise.all([E.unlatched, E.reached, E.failed].map(row))).toEqual(before);
    expect(classifyReach({ success: true, tags: before[0].tags })).toBe('not-reached');
    expect(classifyReach({ success: true, tags: before[1].tags })).toBe('reached');
  }, 60_000);

  it('CONTROL: the inverse restores the verdict and records it; a second inverse is a no-op', async () => {
    expect(await correct(E.latched, { inverse: true })).toEqual({ execution_id: E.latched, status: 'restored' });
    const r = await row(E.latched);
    expect(r.reached).toBe(false);
    expect(r.tags).not.toContain(`reach_retracted:${SHA}`);
    expect(r.metadata.reach_retraction ?? null).toBe(null);
    expect(classifyReach({ success: r.success, tags: r.tags })).toBe('not-reached');
    const sv = r.metadata.superseded_verdicts;
    expect(sv.length).toBe(2);
    expect(sv[1]).toMatchObject({ superseded_by: `inverse-correction:${SHA}`, correction_of: `reach_retracted:${SHA}`, retraction: { list_sha: SHA } });
    expect(await correct(E.latched, { inverse: true })).toEqual({ execution_id: E.latched, status: 'not_retracted' });
    // And it can be retracted again through the same path.
    expect(await correct(E.latched)).toEqual({ execution_id: E.latched, status: 'retracted' });
  }, 60_000);

  it('dry_run SELECTS the frozen list read-only: the latched clean completion only, with its sha', async () => {
    await correct(E.latched, { inverse: true });
    const writesBefore = rs!.calls.length;
    const since = new Date(Date.now() - 3 * 3600_000).toISOString();
    const r = await RC!.resolveReachCorrection({ type: 'reachCorrection', since }, OP as any, authDeps([]));
    expect(r.status).toBe(200);
    const b = (r.body as any).body;
    expect({ ids: b.execution_ids, sha: b.list_sha, excluded: b.excluded }).toEqual({ ids: LIST, sha: SHA, excluded: { failed_execution: 1, already_retracted: 0 } });
    expect(rs!.calls.slice(writesBefore).every((c) => !/\b(UPDATE|UPSERT|CREATE|DELETE|INSERT)\b/i.test(c.sql))).toBe(true);
    expect((await RC!.resolveReachCorrection({ type: 'reachCorrection', since }, { role: 'user', scopes: [] } as any, authDeps([]))).body).toMatchObject({ refused: 'not_operator' });
  }, 60_000);

  it('apply needs the list sha AND an authorization record for THAT list (per list: another list\'s newer record does not shadow it)', async () => {
    const since = new Date(Date.now() - 3 * 3600_000).toISOString();
    const apply = (deps: any, o: Record<string, unknown> = {}) => RC!.resolveReachCorrection({ type: 'reachCorrection', mode: 'apply', execution_ids: LIST, correction_of: 'reach:false', provenance: PROV, ...o }, OP as any, deps);
    expect((await apply(authDeps([]))).body).toMatchObject({ refused: 'apply_requires_authorization' });
    expect((await apply(authDeps([record(SHA)]), { execution_ids: [E.latched, E.unlatched] })).body).toMatchObject({ refused: 'list_sha_mismatch' });
    expect((await row(E.latched)).reached).toBe(false);
    const betaListRecord = record('b'.repeat(64), { updated_at: new Date(Date.now() + 1000).toISOString(), body: { node: NODE, list_sha256: 'b'.repeat(64), eligibility_sha256: 'c'.repeat(64), review_by: new Date(Date.now() + 86_400_000).toISOString() } });
    const ok = await apply(authDeps([betaListRecord, record(SHA)]));
    expect(ok.status).toBe(200);
    expect((ok.body as any).body.counts).toEqual({ retracted: 1 });
    expect(classifyReach({ success: true, tags: (await row(E.latched)).tags })).toBe('ungraded');
    // The dry run no longer offers the retracted row.
    const again = (await RC!.resolveReachCorrection({ type: 'reachCorrection', since }, OP as any, authDeps([]))).body as any;
    expect({ n: again.body.count, excluded: again.body.excluded }).toEqual({ n: 0, excluded: { failed_execution: 1, already_retracted: 1 } });
  }, 60_000);

  it('MUST-FAIL: a row re-graded reached:true after its retraction is NOT restored by the inverse (skipped_regraded)', async () => {
    const id = `rc-regraded-${word()}`;
    const sha = listSha([id]);
    const prov = { ...PROV, list_sha: sha };
    await rs!.sql(exec(id, { success: true, tags: [LD, 'reach_graded:true', 'reached:false'], reached: false, patched: true }));
    expect(await RC!.applyReachCorrection(db, { execution_id: id, correction_of: 'reach:false', provenance: prov })).toEqual({ execution_id: id, status: 'retracted' });
    const routes = (await import('../routes/execution-traces')).default;
    const a = new Hono();
    a.route('/', routes);
    const res = await a.request('/reach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ execution_id: id, reached: true }) });
    expect(res.status).toBe(200);
    const regraded = await row(id);
    expect({ reached: regraded.reached, verdict: classifyReach({ success: true, tags: regraded.tags }) }).toEqual({ reached: true, verdict: 'reached' });
    expect(await RC!.applyReachCorrection(db, { execution_id: id, correction_of: 'reach:false', provenance: prov, inverse: true })).toEqual({ execution_id: id, status: 'skipped_regraded' });
    const after = await row(id);
    expect({ reached: after.reached, verdict: classifyReach({ success: true, tags: after.tags }) }).toEqual({ reached: true, verdict: 'reached' });
    expect(after.metadata.superseded_verdicts.length).toBe(regraded.metadata.superseded_verdicts.length);
  }, 60_000);

  it('MUST-FAIL: the retracted execution\'s decision_outcome reach is cleared to null, with the same provenance', async () => {
    const outcome = async (id: string) => (await rs!.sql(`SELECT reached, outcome_success, predicted_success, reach_correction FROM type::thing('decision_outcome', '${id}');`))[0].result[0];
    const d = await outcome(E.latched);
    expect(d.reached ?? null).toBe(null);
    expect(d.reach_correction).toMatchObject({ correction_of: 'reach:false', list_sha: SHA, rule: PROV.rule, commit: PROV.commit, prior_reached: false });
    expect(d.outcome_success).toBe(true);
    // decision-calibration reads it as an unknown reach, not a not-reached outcome.
    const { aggregateDecisionCalibration } = await import('../routes/execution-traces');
    const rows = (await rs!.sql(`SELECT activity_id, source, predicted_success, outcome_success, reached, executed_at, created_at FROM decision_outcome WHERE activity_id = '${ACT}';`))[0].result;
    expect(aggregateDecisionCalibration(rows, 1)[0]).toMatchObject({ decisions: 2, reached_known: 1, actual_reach_rate: 0 });
    // CONTROL: the unlatched execution's row is untouched.
    const u = await outcome(E.unlatched);
    expect({ reached: u.reached, corr: u.reach_correction ?? null }).toEqual({ reached: false, corr: null });
    // Re-applying keeps the provenance; the inverse restores the reach and marks the correction undone; again retracts.
    expect(await correct(E.latched)).toEqual({ execution_id: E.latched, status: 'already_retracted' });
    expect((await outcome(E.latched)).reach_correction.at).toEqual(d.reach_correction.at);
    expect(await correct(E.latched, { inverse: true })).toEqual({ execution_id: E.latched, status: 'restored' });
    const back = await outcome(E.latched);
    expect({ reached: back.reached, inverse: back.reach_correction.inverse, predicted: back.predicted_success }).toEqual({ reached: false, inverse: true, predicted: d.predicted_success });
    expect(await correct(E.latched)).toEqual({ execution_id: E.latched, status: 'retracted' });
    expect((await outcome(E.latched)).reached ?? null).toBe(null);
  }, 60_000);

  it('CONTROL: NO posterior row changed (variant_performance_metrics, context_thompson_scores, shape counter)', async () => {
    expect(await posteriors()).toBe(posteriorsBefore);
  }, 60_000);
});
