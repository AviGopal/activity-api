// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../support/real-surreal';

const pu = await import('../../src/lib/posterior-update');
const agg = await import('../../src/lib/posterior-aggregator');

/**
 * CHAIN CREDIT IS WRITTEN UNDER THE PRODUCER'S ORG, checked against a REAL SurrealDB carrying the schema
 * init-database.ts builds (the same harness as chain-credit-ancestor-lookup.real-schema.check.ts).
 *
 * On node 1 (2026-10-07) 41 of 42 sampled no-row drops carried org 'public': a consumer posted with no org lands
 * under the 'public' fallback, its producers' variant rows live under the substrate org, and the ancestor delta was
 * written under the consumer's org, so the UPDATE matched nothing. This check runs the real lookup (the producer's
 * own execution row, including its org_id) and the real coalesced flush against real rows:
 *   - a failed composite posted under 'public' moves the consumed producer's beta on ITS org's row;
 *   - a producer whose variant row exists only under another org is a counted ANCESTOR drop that names the org it
 *     tried and the orgs present.
 * (A producer row with no org cannot exist here: execution.org_id is TYPE string. The stubbed
 * src/lib/chain-credit-producer-org.test.ts pins that no-default-org branch.)
 *
 * Needs the `surreal` binary on PATH; if it is missing every test FAILS rather than skipping.
 * NOT IN TEST DISCOVERY (named .check.ts, run by path: `bun test ./test/lib/chain-credit-producer-org.real-schema.check.ts`),
 * for the reason the sibling check states: the pull-sync gate cannot start a real SurrealDB.
 */

const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const W = word();
const PRODUCER_ORG = `organizations:producer-${W}`;
const OTHER_ORG = `organizations:other-${W}`;
const PROD_EXEC = `exec-prod-${W}`; //   consumed producer; its variant row is under PRODUCER_ORG
const AWAY_EXEC = `exec-away-${W}`; //   consumed producer whose variant row exists only under OTHER_ORG
const PROD_VAR = `satisfier:producer-${W}`;
const AWAY_VAR = `satisfier:away-${W}`;

let rs: RealSurreal | null = null;
let startError = '';

function execRow(id: string, variant: string, org: string): string {
  return `CREATE type::thing('execution', '${id}') CONTENT { activity_id: '${variant}', variant_id: '${variant}', input_impulses: [], output_impulses: [],
    success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${org}', executed_at: time::now() - 1h,
    created_at: time::now(), status: 'success' };`;
}
function vpmRow(variant: string, org: string): string {
  return `CREATE variant_performance_metrics CONTENT { variant_id: '${variant}', activity_id: '${variant}', org_id: '${org}',
    total_executions: 10, successful_executions: 5, failed_executions: 5, success_rate: 0.5, avg_duration_ms: 10.0,
    avg_cost_usd: 0.0, thompson_alpha: 1.0, thompson_beta: 1.0, total_selections: 10, confidence_interval: 0.0,
    sample_size: 10, is_deprecated: false, created_at: time::now(), updated_at: time::now() };`;
}
async function beta(variant: string, org: string): Promise<number> {
  const r = await rs!.sql(`SELECT thompson_beta FROM variant_performance_metrics WHERE variant_id = '${variant}' AND org_id = '${org}';`);
  return Number(r[0]?.result?.[0]?.thompson_beta ?? NaN);
}
/** A failed composite (the consumer rejected the output) posted under the 'public' fallback org. */
async function failedCompositeUnderPublic(producer: string): Promise<void> {
  await pu.propagateCreditAlongChain(
    { activity_id: `leaf-${W}`, composition_chain: [producer], success: false, failure_mode: { type: 'verifier_negative' }, consumed_producers: [producer] } as any,
    (rs as any).moduleClient,
    'public',
  );
  await agg.flushPosteriors();
}

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    (rs as any).moduleClient = await rs.connectModuleClient();
    await rs.sql([
      execRow(PROD_EXEC, PROD_VAR, PRODUCER_ORG), execRow(AWAY_EXEC, AWAY_VAR, PRODUCER_ORG),
      vpmRow(PROD_VAR, PRODUCER_ORG), vpmRow(AWAY_VAR, OTHER_ORG),
    ].join('\n'));
  } catch (e) {
    startError = e instanceof Error ? e.message : String(e);
  }
}, 300_000);
afterAll(async () => { await rs?.stop(); });

describe("chain credit is written under the producer's org (real SurrealDB)", () => {
  it('instrument: a real SurrealDB with the real schema started, and the fixture rows exist', async () => {
    expect(startError).toBe('');
    expect(await beta(PROD_VAR, PRODUCER_ORG)).toBe(1);
    expect(await beta(AWAY_VAR, OTHER_ORG)).toBe(1);
  });

  it("MUST-FAIL: a failed composite posted under 'public' moves the consumed producer's beta on its own org's row", async () => {
    expect(startError).toBe('');
    const before = await beta(PROD_VAR, PRODUCER_ORG);
    await failedCompositeUnderPublic(PROD_EXEC);
    expect(await beta(PROD_VAR, PRODUCER_ORG)).toBeGreaterThan(before + 0.1);
  });

  it('MUST-FAIL: a producer whose row exists only under another org is a counted ancestor drop naming both orgs', async () => {
    expect(startError).toBe('');
    const byKind0 = (agg as any).posteriorDeltasDroppedNoRowByKind?.() ?? { ancestor: NaN };
    await failedCompositeUnderPublic(AWAY_EXEC);
    expect(agg.posteriorDeltasDroppedNoRowByKind().ancestor).toBe(byKind0.ancestor + 1);
    expect(agg.recentNoRowDrops().at(-1)).toEqual(expect.objectContaining({
      variant_id: AWAY_VAR, org_tried: PRODUCER_ORG, orgs_present: [OTHER_ORG], kinds: ['ancestor'],
    }));
    expect(await beta(AWAY_VAR, OTHER_ORG)).toBe(1); // nothing was written to a guessed row
  });
});
