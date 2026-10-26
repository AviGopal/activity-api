// A DELEGATED *_write RUNS UNDER THE OUTER REQUEST'S VERIFIED AUTH, AND ITS ORG IS THAT AUTH'S (real engine).
//
// POST /v2/impulses/resolve serves 13 `*_write` shapes by fetching a sub-app (activities.ts, execution-traces.ts)
// in-process. The sub-app has no auth middleware: the delegate used to forward the Bearer header (which nothing inside
// checked) and let a caller-set body.org_id win, so an authenticated caller of one org wrote learning rows into any
// org it named, and a direct sub-app fetch with a made-up header did the same. Rows are read back from a scratch
// SurrealDB carrying the real schema (test/support/real-surreal.ts).
//   [MUST-FAIL] an org-A caller's impulseRelevance_write naming org B in the body ⇒ 403 ORG_MISMATCH, no row anywhere.
//   [MUST-FAIL] a direct sub-app fetch with a forged Bearer header and body org B (no verified context) ⇒ 401, no row.
//   [MUST-FAIL] activityExecutionTrace_write by an authenticated caller lands under the caller's org (the handler saw
//               no authenticated org and refused every delegated trace with a body org).
//   [CONTROL]   an org-A caller's impulseRelevance_write with no body org lands one row under org A, as before; the
//               same org spelled without the record prefix in the body is accepted and lands under that org.
//   [CONTROL]   an unauthenticated resolve is refused 401 and writes nothing; a same-org read is unchanged.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, useRealModules, type RealSurreal } from './support/real-surreal';

const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ORG_A = `organizations:dw-a-${word()}`;
const ORG_B = `organizations:dw-b-${word()}`;

let db: RealSurreal | null = null;
let startError = '';
let restoreModules: () => void = () => {};
let authed: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let anon: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let activitiesRouter: { fetch: (req: Request) => Response | Promise<Response> };

async function relevanceRows(impulseId: string): Promise<Array<{ org_id: string }>> {
  const r = await db!.sql(`${USE} SELECT org_id FROM impulse_relevance_metrics WHERE impulse_id = '${impulseId}';`);
  return r[r.length - 1].result;
}
async function executionRows(executionId: string): Promise<Array<{ org_id: string }>> {
  const r = await db!.sql(`${USE} SELECT org_id FROM execution WHERE execution_id = '${executionId}' OR id = type::thing('execution', '${executionId}');`);
  return r[r.length - 1].result;
}
const relevance = (impulseId: string, extra: Record<string, unknown> = {}) => ({
  impulse_id: impulseId, activity_variant_id: `dw-variant-${impulseId}`, was_loaded: true, execution_succeeded: true, ...extra,
});
async function resolve(app: typeof authed, pointer: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const res = await app.request('/v2/impulses/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pointer }) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  try {
    await import('../src/lib/posterior-update');
    restoreModules = await useRealModules(['src/lib/tuning-params', 'src/lib/prior-seed', 'src/lib/embedding-lookup-cache', 'src/lib/posterior-aggregator',
      'src/db/paradigm', 'src/websocket/broadcaster', 'src/services/variant-creator']);
    db = await startRealSurreal();
    await db.connectModuleClient();
    const impulses = (await import('../src/routes/impulses')).default;
    activitiesRouter = (await import('../src/routes/activities')).default as any;
    const { Hono } = await import('hono');
    const a = new Hono();
    a.use('*', async (c, next) => { (c as any).set('jwtAuth', { jwtToken: 't', orgId: ORG_A, authType: 'apikey', keyId: 'k-a', scopes: ['read', 'write'] }); await next(); });
    a.route('/v2/impulses', impulses);
    authed = a;
    const u = new Hono();
    u.route('/v2/impulses', impulses);
    anon = u;
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  restoreModules();
  await db?.stop();
});

describe('delegated *_write auth (real engine)', () => {
  it('instrument: surreal started', () => {
    expect(startError).toBe('');
  });

  it("[MUST-FAIL] an org-A caller naming org B in the body is refused 403 and writes nothing", async () => {
    const id = `dw-cross-${word()}`;
    const r = await resolve(authed, { type: 'impulseRelevance_write', relevanceData: relevance(id, { org_id: ORG_B }) });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).toContain('ORG_MISMATCH');
    expect(await relevanceRows(id)).toEqual([]);
  }, 60_000);

  it('[MUST-FAIL] a direct sub-app fetch with a forged Bearer header and body org B is refused 401 and writes nothing', async () => {
    const id = `dw-forged-${word()}`;
    const res = await activitiesRouter.fetch(new Request('http://internal/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer forged.not.verified' },
      body: JSON.stringify(relevance(id, { org_id: ORG_B })),
    }));
    expect(res.status).toBe(401);
    expect(await relevanceRows(id)).toEqual([]);
  }, 60_000);

  it("[MUST-FAIL] activityExecutionTrace_write lands under the authenticated caller's org", async () => {
    const id = `dw-trace-${word()}`;
    const r = await resolve(authed, {
      type: 'activityExecutionTrace_write',
      traceData: { execution_id: id, template_id: `dw-tmpl-${word()}`, success: true, duration_ms: 5, tasks: [] },
    });
    expect(r.status).toBe(200);
    const rows = await executionRows(id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.org_id === ORG_A)).toBe(true);
  }, 60_000);

  it('[CONTROL] an org-A delegated write with no body org lands one row under org A', async () => {
    const id = `dw-same-${word()}`;
    const r = await resolve(authed, { type: 'impulseRelevance_write', relevanceData: relevance(id) });
    expect(r.status).toBe(200);
    expect(await relevanceRows(id)).toEqual([{ org_id: ORG_A }]);
  }, 60_000);

  it('[CONTROL] the same org spelled without the record prefix is accepted and lands under that org', async () => {
    const id = `dw-bare-${word()}`;
    const bare = (o: string) => o.replace(/^organizations:/, '');
    const r = await resolve(authed, { type: 'impulseRelevance_write', relevanceData: relevance(id, { org_id: bare(ORG_A) }) });
    expect(r.status).toBe(200);
    const rows = await relevanceRows(id);
    expect(rows.length).toBe(1);
    expect(bare(rows[0]!.org_id)).toBe(bare(ORG_A));
  }, 60_000);

  it('[CONTROL] an unauthenticated resolve is refused 401 and writes nothing', async () => {
    const id = `dw-anon-${word()}`;
    const r = await resolve(anon, { type: 'impulseRelevance_write', relevanceData: relevance(id, { org_id: ORG_B }) });
    expect(r.status).toBe(401);
    expect(await relevanceRows(id)).toEqual([]);
  }, 60_000);

  it('[CONTROL] a same-org read sees the row the same-org write stored', async () => {
    const id = `dw-read-${word()}`;
    expect((await resolve(authed, { type: 'impulseRelevance_write', relevanceData: relevance(id) })).status).toBe(200);
    const r = await resolve(authed, { type: 'impulseRelevance', activityId: `dw-variant-${id}` });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(String(r.json.content)).toContain(`dw-variant-${id}`);
  }, 60_000);
});
