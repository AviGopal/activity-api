// A DELEGATED SUB-REQUEST IS JUDGED BY THE OUTER CALLER'S SCOPES (real engine; a SEAM test).
//
// Since 28cfa48a a delegated *_write (impulses.ts delegateWriteToRouter) forwards no credential: it binds the outer
// request's verified context to the Request it builds (bindDelegatedAuth), the sub-app reads it through
// getJwtAuthFromContext, and delegatedSubAppGuard refuses a credential header that has nothing bound. No *_write shape
// delegates to an admin-gated route today (the 14 delegateWriteToRouter targets are fixed paths), so this file builds the
// delegated Request exactly the way delegateWriteToRouter does and sends it to /templates/:templateId/promote on the
// activities sub-app. A delegate added to an admin route later is caught here, not by reading.
//   [MUST-FAIL] a bound outer context WITHOUT templates:admin ⇒ 403 SCOPE_REQUIRED, the template stays proposed.
//   [LAUNDER]   a bound outer context without the scope, plus a granted key's Authorization / X-Internal-Api-Key
//               headers ⇒ still 403, the template stays proposed: a header never stands in for the bound context.
//   [CONTROL]   a bound outer context WITH templates:admin promotes the template.
//   [CONTROL]   an unbound delegated Request carrying a credential header ⇒ 401 UNVERIFIED_DELEGATED_AUTH.
// The direct (non-delegated) caller is judged by test/admin-scope-gates.real.test.ts.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
process.env.DISCOVERY_VESSEL_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, useRealModules, type RealSurreal } from './support/real-surreal';

const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ORG = `organizations:ds-${word()}`;
const MF = `ds-mf-${word()}`;
const LAUNDER = `ds-launder-${word()}`;
const CTL = `ds-ctl-${word()}`;
const UNBOUND = `ds-unbound-${word()}`;

const key = (scopes: string[]) => ({ jwtToken: '', orgId: ORG, authType: 'apikey', keyId: `k-${scopes.join('-')}`, scopes });
const RW = key(['read', 'write']);
const TPL_ADMIN = key(['read', 'write', 'templates:admin']);

let db: RealSurreal | null = null;
let startError = '';
let restoreModules: () => void = () => {};
let activities: { fetch: (req: Request) => Response | Promise<Response> };
let bindDelegatedAuth: (req: Request, ctx: any) => Request;

/** The Request delegateWriteToRouter builds: no credential header, the outer context bound to the object itself. */
function delegated(path: string, outer: Record<string, unknown> | null, headers: Record<string, string> = {}): Request {
  const req = new Request(`http://internal${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  return outer ? bindDelegatedAuth(req, outer) : req;
}
async function promote(id: string, outer: Record<string, unknown> | null, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  // The evidence gate (a cold-start template has no neighbours) is not under test; it is switched off per call, as in
  // admin-scope-gates.real.test.ts, so a passed scope check is observed as an actual promote.
  process.env.PROMOTE_GATE_DISABLED = 'true';
  try {
    const res = await activities.fetch(delegated(`/templates/${id}/promote`, outer, headers));
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } finally {
    delete process.env.PROMOTE_GATE_DISABLED;
  }
}
async function proposed(id: string): Promise<boolean | undefined> {
  const r = await db!.sql(`${USE} SELECT proposed FROM type::thing('activity', '${id}');`);
  return r[r.length - 1].result[0]?.proposed;
}

beforeAll(async () => {
  try {
    await import('../src/lib/posterior-update');
    restoreModules = await useRealModules(['src/lib/tuning-params', 'src/lib/prior-seed', 'src/lib/embedding-lookup-cache', 'src/lib/posterior-aggregator',
      'src/db/paradigm', 'src/websocket/broadcaster', 'src/services/variant-creator']);
    db = await startRealSurreal();
    await db.connectModuleClient();
    activities = (await import('../src/routes/activities')).default;
    bindDelegatedAuth = (await import('../src/middleware/jwtAuth')).bindDelegatedAuth;
    await db.sql([
      USE,
      ...[MF, LAUNDER, CTL, UNBOUND].map((id) =>
        `CREATE type::thing('activity', '${id}') CONTENT { name: '${id}', input_shapes: [], output_shapes: ['y'], execution_type: 'template', scope: 'global', public: true, org_id: '${ORG}', created_at: time::now(), updated_at: time::now(), proposed: true, retired: false, tasks: [] };`),
    ].join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  restoreModules();
  await db?.stop();
});

describe('admin scope on a delegated sub-request (real engine, seam)', () => {
  it('instrument: surreal started and the templates are seeded proposed', async () => {
    expect(startError).toBe('');
    for (const id of [MF, LAUNDER, CTL, UNBOUND]) expect(await proposed(id)).toBe(true);
  }, 60_000);

  it('[MUST-FAIL] a bound outer context without templates:admin ⇒ 403 and the template stays proposed', async () => {
    const r = await promote(MF, RW);
    expect({ status: r.status, code: r.json?.error?.code }).toEqual({ status: 403, code: 'SCOPE_REQUIRED' });
    expect(await proposed(MF)).toBe(true);
  }, 60_000);

  it("[LAUNDER] a bound outer context without the scope plus a granted key's credential headers ⇒ still 403", async () => {
    const r = await promote(LAUNDER, RW, { Authorization: 'Bearer granted-templates-admin-key', 'X-Internal-Api-Key': 'granted-templates-admin-key' });
    expect({ status: r.status, code: r.json?.error?.code }).toEqual({ status: 403, code: 'SCOPE_REQUIRED' });
    expect(await proposed(LAUNDER)).toBe(true);
  }, 60_000);

  it('[CONTROL] a bound outer context with templates:admin promotes the template', async () => {
    const r = await promote(CTL, TPL_ADMIN);
    expect({ status: r.status, success: r.json?.success }).toEqual({ status: 200, success: true });
    expect(await proposed(CTL)).toBe(false);
  }, 60_000);

  it('[CONTROL] an unbound delegated Request carrying a credential header ⇒ 401 UNVERIFIED_DELEGATED_AUTH', async () => {
    const r = await promote(UNBOUND, null, { Authorization: 'Bearer granted-templates-admin-key' });
    expect({ status: r.status, code: r.json?.error?.code }).toEqual({ status: 401, code: 'UNVERIFIED_DELEGATED_AUTH' });
    expect(await proposed(UNBOUND)).toBe(true);
  }, 60_000);
});
