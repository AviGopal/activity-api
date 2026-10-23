// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, useRealModules, type RealSurreal } from '../../test/support/real-surreal';

/**
 * variant_performance_metrics lookups must match a PREFIXED org_id (real engine).
 *
 * The stored org_id is `organizations:<org>` on nearly every row and account_id is NONE on all. Both
 * the retire path (checkAndRetireByPosterior) and getVariantScores' fallback bound the STRIPPED org and
 * compared it to the raw column, so they matched only legacy bare rows: retire-by-posterior returned
 * false on "no row" for almost every arm and retired nothing. Against a scratch SurrealDB built from
 * the real schema, with the thresholds read from real substrate_tuning_param rows (30 / 0.05):
 *   [MUST-FAIL] an arm with a prefixed-org row, >= 30 runs and posterior mean < 0.05 retires on its
 *               next graded failure (the activity record carries retired = true);
 *   [MUST-FAIL] getVariantScores' fallback returns a prefixed-org row;
 *   [CONTROL]   0.25 over 40 runs is not retired; a bare-org row still matches; a prefixed row of a
 *               DIFFERENT org is not matched (the tenant scope still scopes); 29 runs, a mean of
 *               exactly 0.05, an already-retired arm and an arm with no activity record are not retired;
 *   [AGREEMENT] the read-only dry-run (RETIREMENT_DRY_RUN_SQL) names exactly the arms the retire path
 *               retires, so the count it gives before landing is the count landing would produce.
 * The function is driven directly, not through the trace route: the route's gate (a graded failure)
 * is unchanged and is pinned by its own tests.
 */

const ORG = 'organizations:vpm-prefix-probe';
const OTHER = 'organizations:vpm-prefix-other';
const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const W = word();
const ARM = {
  prefixedBad: `vpmp-bad-${W}`, // prefixed org, 40 runs, mean 1/41
  healthy: `vpmp-ok-${W}`, // prefixed org, 40 runs, mean 0.25
  bare: `vpmp-bare-${W}`, // BARE org, 40 runs, mean 1/41
  otherOrg: `vpmp-other-${W}`, // prefixed, DIFFERENT org, bad
  fewRuns: `vpmp-few-${W}`, // 29 runs, bad
  atFloor: `vpmp-floor-${W}`, // mean exactly 0.05
  retired: `vpmp-retired-${W}`, // already retired
  noRecord: `vpmp-norec-${W}`, // metrics row, no activity record
};

let rs: RealSurreal | null = null;
let startError = '';
let restoreModules: () => void = () => {};
let VC: typeof import('./variant-creator') | null = null;
let PD: typeof import('../db/paradigm') | null = null;
let PR: typeof import('../lib/posterior-retirement') | null = null;

function vpm(arm: string, org: string, runs: number, alpha: number, beta: number): string {
  return `CREATE variant_performance_metrics CONTENT { variant_id: '${arm}', activity_id: '${arm}', org_id: '${org}', total_executions: ${runs}, successful_executions: 0, failed_executions: ${runs}, success_rate: 0.0, avg_duration_ms: 10.0, avg_cost_usd: 0.0, thompson_alpha: ${alpha}, thompson_beta: ${beta}, total_selections: ${runs}, created_at: time::now(), updated_at: time::now() };`;
}
function activity(arm: string, retired: boolean): string {
  return `CREATE activity:\`${arm}\` CONTENT { name: '${arm}', execution_type: 'template', scope: 'org', org_id: '${ORG}', input_shapes: [], output_shapes: [], public: false, created_at: time::now(), updated_at: time::now(), retired: ${retired} };`;
}
async function retiredFlag(arm: string): Promise<unknown> {
  const r = await rs!.sql(`${USE} SELECT VALUE retired FROM activity:\`${arm}\`;`);
  return r[r.length - 1].result[0];
}

beforeAll(async () => {
  try {
    restoreModules = await useRealModules(['src/lib/tuning-params', 'src/lib/posterior-retirement', 'src/db/paradigm', 'src/services/variant-creator']);
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    await rs.sql(`${USE}
      CREATE substrate_tuning_param CONTENT { name: 'RETIREMENT_MIN_EXECUTIONS', value: 30.0 };
      CREATE substrate_tuning_param CONTENT { name: 'RETIREMENT_SUCCESS_FLOOR', value: 0.05 };
      ${vpm(ARM.prefixedBad, ORG, 40, 1, 40)}
      ${vpm(ARM.healthy, ORG, 40, 10, 30)}
      ${vpm(ARM.bare, 'vpm-prefix-probe', 40, 1, 40)}
      ${vpm(ARM.otherOrg, OTHER, 40, 1, 40)}
      ${vpm(ARM.fewRuns, ORG, 29, 1, 40)}
      ${vpm(ARM.atFloor, ORG, 40, 1, 19)}
      ${vpm(ARM.retired, ORG, 40, 1, 40)}
      ${vpm(ARM.noRecord, ORG, 40, 1, 40)}
      ${activity(ARM.prefixedBad, false)}
      ${activity(ARM.healthy, false)}
      ${activity(ARM.bare, false)}
      ${activity(ARM.otherOrg, false)}
      ${activity(ARM.fewRuns, false)}
      ${activity(ARM.atFloor, false)}
      ${activity(ARM.retired, true)}
    `);
    PR = await import('../lib/posterior-retirement');
    VC = await import('./variant-creator');
    PD = await import('../db/paradigm');
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 120_000);

afterAll(async () => {
  await rs?.stop();
  restoreModules();
});

describe('variant_performance_metrics org-prefix matching (real engine)', () => {
  let dryRunArms: string[] = [];

  it('the engine started', () => {
    expect(startError).toBe('');
  });

  it('[AGREEMENT, before any retirement] the dry-run names exactly the arms that should retire', async () => {
    const r = await rs!.sql(`${USE}
      LET $org_id = '${ORG}'; LET $account_id = NULL; LET $min_executions = 30; LET $success_floor = 0.05;
      ${PR!.RETIREMENT_DRY_RUN_SQL};`);
    dryRunArms = (r[r.length - 1].result as Array<{ arm: string }>).map((x) => x.arm).sort();
    // The bare-org row is the same tenant: both spellings of the org name it.
    expect(dryRunArms).toEqual([ARM.bare, ARM.prefixedBad].sort());
  });

  it('[MUST-FAIL] a prefixed-org arm with >= 30 runs and mean < 0.05 retires on its next graded failure', async () => {
    expect(await VC!.checkAndRetireByPosterior(`activity:⟨${ARM.prefixedBad}⟩`, ORG, null)).toBe(true);
    expect(await retiredFlag(ARM.prefixedBad)).toBe(true);
  });

  it('[MUST-FAIL] the same holds when the caller passes the org bare', async () => {
    // Reset and retry with the bare spelling: either form a caller binds must reach the prefixed row.
    await rs!.sql(`${USE} UPDATE activity:\`${ARM.prefixedBad}\` SET retired = false;`);
    expect(await VC!.checkAndRetireByPosterior(ARM.prefixedBad, 'vpm-prefix-probe', null)).toBe(true);
  });

  it('[MUST-FAIL] getVariantScores falls back to a prefixed-org row and finds it', async () => {
    const res = await PD!.getVariantScores([ARM.prefixedBad, ARM.healthy], ORG, null, null);
    expect(res.data.map((d) => d.activity_id).sort()).toEqual([ARM.prefixedBad, ARM.healthy].sort());
  });

  it('[CONTROL] getVariantScores still finds a BARE-org row, and not another org\'s', async () => {
    const res = await PD!.getVariantScores([ARM.bare, ARM.otherOrg], ORG, null, null);
    expect(res.data.map((d) => d.activity_id)).toEqual([ARM.bare]);
  });

  it('[CONTROL] a BARE-org row still matches the retire path', async () => {
    expect(await VC!.checkAndRetireByPosterior(ARM.bare, ORG, null)).toBe(true);
    expect(await retiredFlag(ARM.bare)).toBe(true);
  });

  it('[CONTROL] 0.25 over 40 runs is not retired', async () => {
    expect(await VC!.checkAndRetireByPosterior(ARM.healthy, ORG, null)).toBe(false);
    expect(await retiredFlag(ARM.healthy)).toBe(false);
  });

  it('[CONTROL] another org\'s prefixed row is not matched', async () => {
    expect(await VC!.checkAndRetireByPosterior(ARM.otherOrg, ORG, null)).toBe(false);
    expect(await retiredFlag(ARM.otherOrg)).toBe(false);
  });

  it('[CONTROL] 29 runs, a mean of exactly 0.05, an already-retired arm and a missing record are not retired', async () => {
    expect(await VC!.checkAndRetireByPosterior(ARM.fewRuns, ORG, null)).toBe(false);
    expect(await VC!.checkAndRetireByPosterior(ARM.atFloor, ORG, null)).toBe(false);
    expect(await VC!.checkAndRetireByPosterior(ARM.retired, ORG, null)).toBe(false);
    expect(await VC!.checkAndRetireByPosterior(ARM.noRecord, ORG, null)).toBe(false);
    expect(await retiredFlag(ARM.fewRuns)).toBe(false);
    expect(await retiredFlag(ARM.atFloor)).toBe(false);
  });

  it('[AGREEMENT, after] once those arms retired, the dry-run names nothing in the tenant', async () => {
    const r = await rs!.sql(`${USE}
      LET $org_id = '${ORG}'; LET $account_id = NULL; LET $min_executions = 30; LET $success_floor = 0.05;
      ${PR!.RETIREMENT_DRY_RUN_SQL};`);
    expect(r[r.length - 1].result).toEqual([]);
  });
});
