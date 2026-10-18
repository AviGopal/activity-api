// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

/**
 * thompson_posterior's `signatures_aggregated`, through the route, against a REAL SurrealDB carrying
 * the schema init-database.ts builds.
 *
 * Why a real engine: the count query had one closing paren too many, so SurrealDB rejected it on every
 * call and the catch reported 1 — "aggregated over one signature" for every arm. It also selected
 * `shape_signature`, a column the SCHEMAFULL `execution` table does not have (the stored per-execution
 * signature is `signature`, migration 157), so even a balanced query read one distinct NONE. Both
 * defects are invisible to a text check and to a mocked DB; this file counts from rows. The paren fix
 * was landed and reverted before; a revert of either half turns the 2 below back into 1.
 *
 * The posterior row lives in ORG (execution.org_id cannot be NONE, so the org branch is the one real
 * rows reach). Needs `surreal` on PATH; if it is missing the instrument test FAILS rather than skipping.
 */

const ORG = 'organizations:sigagg-probe';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const TWO = `sigagg-two-${word()}`;
const ONE = `sigagg-one-${word()}`;
const sig = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

let rs: RealSurreal | null = null;
let startError = '';
let routes: any = null;

function exec(activity: string, signature: string): string {
  return `CREATE execution CONTENT { activity_id: '${activity}', input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now() - 1h, created_at: time::now(), status: 'success', signature: '${signature}', signature_version: 1 };`;
}
function vpm(activity: string, n: number): string {
  return `CREATE variant_performance_metrics CONTENT { variant_id: '${activity}', activity_id: '${activity}', org_id: '${ORG}', total_executions: ${n}, successful_executions: ${n}, failed_executions: 0, success_rate: 1.0, avg_duration_ms: 10.0, avg_cost_usd: 0.0, thompson_alpha: ${n + 1}.0, thompson_beta: 1.0, total_selections: ${n}, created_at: time::now(), updated_at: time::now() };`;
}

async function posterior(activity: string): Promise<Record<string, any>> {
  const a = new Hono();
  a.use('*', async (c, next) => {
    // apikey: executeAsAuth sends through the module client, which the harness routes to the real engine.
    c.set('jwtAuth', { orgId: ORG, projectId: undefined, projectIds: undefined, instanceId: undefined, authType: 'apikey' } as any);
    await next();
  });
  a.route('/v2/impulses', routes);
  const res = await a.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer: { type: 'thompson_posterior', activity_variant_id: activity } }),
  });
  const body = (await res.json()) as { content?: string };
  return JSON.parse(String(body.content ?? '{}')).content ?? {};
}

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.connectModuleClient();
    routes = (await import('./impulses')).default;
    const a = sig(), b = sig();
    await rs.sql([exec(TWO, a), exec(TWO, b), exec(TWO, a), vpm(TWO, 3), exec(ONE, a), exec(ONE, a), vpm(ONE, 2)].join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);

afterAll(async () => { await rs?.stop(); });

describe('thompson_posterior signatures_aggregated on the real engine', () => {
  it('instrument: surreal started, rows seeded with their signature', async () => {
    expect(startError).toBe('');
    const r = await rs!.sql(`SELECT count() AS n FROM execution WHERE org_id = '${ORG}' AND signature != NONE GROUP ALL;`);
    expect(r[0].result[0].n).toBe(5);
  }, 60_000);

  it('an arm whose executions carry two distinct signatures reports signatures_aggregated 2', async () => {
    const p = await posterior(TWO);
    expect(p.scope).toBe('org');
    expect(p.posterior_source).toBe('stored');
    expect(p.signatures_aggregated).toBe(2);
  }, 60_000);

  it('control: an arm with one signature across its executions reports 1', async () => {
    const p = await posterior(ONE);
    expect(p.scope).toBe('org');
    expect(p.signatures_aggregated).toBe(1);
  }, 60_000);
});
