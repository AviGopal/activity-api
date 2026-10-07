// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

const pu = await import('./posterior-update');
const agg = await import('./posterior-aggregator');

/**
 * CHAIN CREDIT MUST REACH THE ANCESTOR'S VARIANT ROW, checked against a REAL SurrealDB carrying the
 * schema init-database.ts builds.
 *
 * propagateCreditAlongChain maps each ancestor EXECUTION id to the variant that ran it, then writes
 * the decayed delta to that variant's variant_performance_metrics row. The map was read from
 * v_paradigm_execution_traces, a materialized view built out of band (migration 212). In production
 * that view stopped following writes at 2026-09-28 (0 rows for 10-06 against 22,402 executions),
 * so every lookup missed, the code fell back to the execution id itself, and the UPDATE
 * `WHERE variant_id = <execution id>` matched no row: every chain credit since then was dropped
 * while the provenance feeding it was right. The stubbed-DB checks of this function could not see
 * that: their fake answered every query with [] and asserted writes to the execution ids.
 *
 * Production's state is reproduced by REMOVING the view after the schema is built (a fresh engine
 * builds it live, so with the view in place the old lookup works: that is the CONTROL). Ids and
 * variant names are generated per run, so no fixed string can be special-cased.
 *
 * Needs the `surreal` binary on PATH (present in the substrate image); if it is missing every test
 * FAILS rather than skipping.
 *
 * NOT IN TEST DISCOVERY (named .check.ts, run by path: `bun test ./src/lib/chain-credit-ancestor-lookup.real-schema.check.ts`).
 * The pull-sync gate cannot start a real SurrealDB (the instruments of every real-schema file sit in
 * its failing baseline), so in the corpus these tests would be new red the gate refuses. The gated
 * check of the same rule is chain-credit-ancestor-lookup.test.ts; this file is the evidence that
 * the lookup query is valid against the real schema, which a fake db cannot give.
 */

const ORG = 'organizations:chain-probe';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const W = word();
const PROD_EXEC = `exec-prod-${W}`; //   the consumed producer, variant_id set on its row
const PLAN_EXEC = `exec-plan-${W}`; //   an ancestor that was NOT consumed
const NOVAR_EXEC = `exec-novar-${W}`; // a consumed producer whose row has no variant_id (activity_id stands in)
const GHOST_EXEC = `exec-ghost-${W}`; // a consumed ancestor with NO execution row at all
const PROD_VAR = `satisfier:producer-${W}`;
const PLAN_VAR = `plan-${W}`;
const NOVAR_ACT = `satisfier:novar-${W}`;

let rs: RealSurreal | null = null;
let startError = '';

function execRow(id: string, activity: string, variant: string | null): string {
  const f = [
    `activity_id: '${activity}'`, 'input_impulses: []', 'output_impulses: []', 'success: true', 'duration_ms: 10',
    'cost_usd: 0.0', 'tokens_in: 0', 'tokens_out: 0', `org_id: '${ORG}'`, 'executed_at: time::now() - 1h',
    'created_at: time::now()', "status: 'success'",
  ];
  if (variant) f.push(`variant_id: '${variant}'`);
  return `CREATE type::thing('execution', '${id}') CONTENT { ${f.join(', ')} };`;
}
function vpmRow(variant: string): string {
  return `CREATE variant_performance_metrics CONTENT { variant_id: '${variant}', activity_id: '${variant}', org_id: '${ORG}',
    total_executions: 10, successful_executions: 5, failed_executions: 5, success_rate: 0.5, avg_duration_ms: 10.0,
    avg_cost_usd: 0.0, thompson_alpha: 1.0, thompson_beta: 1.0, total_selections: 10, confidence_interval: 0.0,
    sample_size: 10, is_deprecated: false, created_at: time::now(), updated_at: time::now() };`;
}
async function beta(variant: string): Promise<number> {
  const r = await rs!.sql(`SELECT thompson_beta FROM variant_performance_metrics WHERE variant_id = '${variant}' AND org_id = '${ORG}';`);
  return Number(r[0]?.result?.[0]?.thompson_beta ?? NaN);
}
async function resetBetas(): Promise<void> {
  await rs!.sql(`UPDATE variant_performance_metrics SET thompson_alpha = 1.0, thompson_beta = 1.0, updated_at = time::now() WHERE org_id = '${ORG}';`);
}
/** A failed composite (the consumer rejected the output) whose chain is root-first. */
async function failedComposite(chain: string[], consumed: string[]): Promise<void> {
  await pu.propagateCreditAlongChain(
    { activity_id: `leaf-${W}`, composition_chain: chain, success: false, failure_mode: { type: 'verifier_negative' }, consumed_producers: consumed } as any,
    rs!.moduleClient as any,
    ORG,
  );
  await agg.flushPosteriors();
}

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    (rs as any).moduleClient = await rs.connectModuleClient();
    await rs.sql([
      execRow(PROD_EXEC, PROD_VAR, PROD_VAR), execRow(PLAN_EXEC, PLAN_VAR, PLAN_VAR), execRow(NOVAR_EXEC, NOVAR_ACT, null),
      vpmRow(PROD_VAR), vpmRow(PLAN_VAR), vpmRow(NOVAR_ACT),
    ].join('\n'));
  } catch (e) {
    startError = e instanceof Error ? e.message : String(e);
  }
}, 300_000);
afterAll(async () => { await rs?.stop(); });

describe('chain credit reaches the ancestor variant row (real SurrealDB)', () => {
  it('instrument: a real SurrealDB with the real schema started, and the fixture rows exist', async () => {
    expect(startError).toBe('');
    expect(await beta(PROD_VAR)).toBe(1);
    const ex = await rs!.sql(`SELECT count() AS n FROM execution WHERE org_id = '${ORG}' GROUP ALL;`);
    expect(Number(ex[0]?.result?.[0]?.n)).toBe(3);
  });

  it('CONTROL: with the view live (a fresh engine), a consumed producer of a failed composite gets beta on its row', async () => {
    expect(startError).toBe('');
    await resetBetas();
    await failedComposite([PROD_EXEC, PLAN_EXEC], [PROD_EXEC]);
    expect(await beta(PROD_VAR)).toBeGreaterThan(1.1);
    expect(await beta(PLAN_VAR)).toBe(1); // not consumed: neither credited nor blamed
  });

  describe('the view as production has it (absent / not following writes)', () => {
    beforeAll(async () => {
      if (!rs) return;
      await rs.sql('REMOVE TABLE IF EXISTS v_paradigm_execution_traces;');
      await resetBetas();
    });

    it('MUST-FAIL: a consumed producer of a failed composite gets beta on ITS variant row, resolved from execution', async () => {
      expect(startError).toBe('');
      await resetBetas();
      await failedComposite([PROD_EXEC, PLAN_EXEC], [PROD_EXEC]);
      expect(await beta(PROD_VAR)).toBeGreaterThan(1.1);
      expect(await beta(PLAN_VAR)).toBe(1);
    });

    it('MUST-FAIL: a producer row with no variant_id is credited to its activity_id, as the view defines variant_id', async () => {
      expect(startError).toBe('');
      await resetBetas();
      await failedComposite([NOVAR_EXEC, PLAN_EXEC], [NOVAR_EXEC]);
      expect(await beta(NOVAR_ACT)).toBeGreaterThan(1.1);
    });

    it('MUST-FAIL: an ancestor with no execution row writes nothing and is counted as a miss', async () => {
      expect(startError).toBe('');
      const misses = (pu as any).chainCreditAncestorMisses;
      expect(typeof misses).toBe('function');
      const m0 = misses(); const d0 = agg.posteriorDeltasDroppedNoRow();
      await failedComposite([GHOST_EXEC, PLAN_EXEC], [GHOST_EXEC]);
      expect(misses()).toBe(m0 + 1);
      expect(agg.posteriorDeltasDroppedNoRow()).toBe(d0); // no delta was even sent toward a row
    });
  });
});
