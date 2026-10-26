// THE DATABASE- AND TEMPLATE-ADMIN SURFACES REQUIRE A NAMED SCOPE, NOT ONLY AUTHENTICATION (real engine).
//
// db_admin (DDL, apply_migration, REMOVE TABLE via reconcile), /internal/fts-rebuild, and the template lifecycle routes
// (/templates/retire-malformed, /templates/auto-promote, /templates/:templateId/promote) admitted any authenticated
// caller. They now require db:admin or templates:admin (or admin) on an API key (src/lib/admin-scopes.ts). The schema
// and the rows are read back from a scratch SurrealDB carrying the real schema (test/support/real-surreal.ts).
//   [MUST-FAIL] a [read, write] key's db_admin create_index ⇒ 403, and the table's indexes are unchanged.
//   [MUST-FAIL] a person's on-behalf-of token carrying `admin` ⇒ db_admin 403, indexes unchanged.
//   [MUST-FAIL] a [read, write] key's retire-malformed (dry_run:false) ⇒ 403, the malformed template not retired.
//   [MUST-FAIL] a [read, write] key's /templates/:id/promote ⇒ 403, the template still proposed.
//   [MUST-FAIL] a [read, write] key's auto-promote and fts-rebuild ⇒ 403.
//   [CONTROL]   db:admin and admin keys run create_index (the index exists); a templates:admin key passes the
//               retire-malformed gate, promotes the proposed template and runs auto-promote; a [read, write] key's label
//               write still lands (the demo's label path needs no admin scope).
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
process.env.DISCOVERY_VESSEL_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, useRealModules, type RealSurreal } from './support/real-surreal';

const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ORG = `organizations:sg-${word()}`;
const MALFORMED = `sg-malformed-${word()}`;
const PROPOSED = `sg-proposed-${word()}`;

type Caller = Record<string, unknown> | null;
const key = (scopes: string[]): Caller => ({ jwtToken: '', orgId: ORG, authType: 'apikey', keyId: `k-${scopes.join('-')}`, scopes });
const RW = key(['read', 'write']);
const DB_ADMIN = key(['read', 'write', 'db:admin']);
const ADMIN = key(['read', 'write', 'admin']);
const TPL_ADMIN = key(['read', 'write', 'templates:admin']);
const OBO_ADMIN: Caller = { jwtToken: 'x.y.z', orgId: ORG, authType: 'jwt', keyId: 'k-obo', scopes: ['admin'], obo: { node: 'n', shape: 'db_admin', actorKeyId: 'k-surface', callerType: 'session' } };

let db: RealSurreal | null = null;
let startError = '';
let restoreModules: () => void = () => {};
let caller: Caller = RW;
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

async function post(path: string, body: unknown, as: Caller): Promise<{ status: number; json: any }> {
  caller = as;
  const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const dbAdmin = (pointer: Record<string, unknown>, as: Caller) => post('/v2/impulses/resolve', { pointer: { type: 'db_admin', ...pointer } }, as);
async function indexes(): Promise<string[]> {
  const r = await db!.sql(`${USE} INFO FOR TABLE impulse_relevance_metrics;`);
  return Object.keys(r[r.length - 1].result.indexes ?? {}).sort();
}
async function activity(id: string): Promise<{ proposed?: boolean; retired?: boolean } | undefined> {
  const r = await db!.sql(`${USE} SELECT proposed, retired FROM type::thing('activity', '${id}');`);
  return r[r.length - 1].result[0];
}
const createIndex = (name: string) => ({ operation: 'create_index', name, table: 'impulse_relevance_metrics', fields: ['impulse_id'], concurrent: false });

beforeAll(async () => {
  try {
    await import('../src/lib/posterior-update');
    restoreModules = await useRealModules(['src/lib/tuning-params', 'src/lib/prior-seed', 'src/lib/embedding-lookup-cache', 'src/lib/posterior-aggregator',
      'src/db/paradigm', 'src/websocket/broadcaster', 'src/services/variant-creator']);
    db = await startRealSurreal();
    await db.connectModuleClient();
    const impulses = (await import('../src/routes/impulses')).default;
    const activities = (await import('../src/routes/activities')).default;
    const { Hono } = await import('hono');
    const h = new Hono();
    h.use('*', async (c, next) => { (c as any).set('jwtAuth', caller); await next(); });
    h.route('/v2/impulses', impulses);
    h.route('/v2/activities', activities);
    app = h;
    await db.sql([
      USE,
      // A learned composition whose task outputs an activity id: retire-malformed's 'activity-id-as-output-shape'.
      `CREATE type::thing('activity', '${MALFORMED}') CONTENT { name: '${MALFORMED}', input_shapes: [], output_shapes: ['x'], execution_type: 'template', scope: 'global', public: true, org_id: '${ORG}', created_at: time::now(), updated_at: time::now(), retired: false, tasks: [{ id: 't1', resolver: 'llm', outputShapes: ['activity:other'] }] };`,
      `CREATE type::thing('activity', '${PROPOSED}') CONTENT { name: '${PROPOSED}', input_shapes: [], output_shapes: ['y'], execution_type: 'template', scope: 'global', public: true, org_id: '${ORG}', created_at: time::now(), updated_at: time::now(), proposed: true, retired: false, tasks: [] };`,
    ].join('\n'));
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  restoreModules();
  await db?.stop();
});

describe('admin scope gates (real engine)', () => {
  it('instrument: surreal started and the templates are seeded', async () => {
    expect(startError).toBe('');
    expect((await activity(MALFORMED))?.retired).toBe(false);
    expect((await activity(PROPOSED))?.proposed).toBe(true);
  }, 60_000);

  it('[MUST-FAIL] a [read, write] key: db_admin create_index ⇒ 403 and the schema is unchanged', async () => {
    const before = await indexes();
    const r = await dbAdmin(createIndex(`idx_sg_rw_${word()}`), RW);
    expect(r.status).toBe(403);
    expect(r.json.required_scope).toBe('db:admin');
    expect(await indexes()).toEqual(before);
  }, 60_000);

  it("[MUST-FAIL] a person's on-behalf-of token carrying admin: db_admin ⇒ 403 and the schema is unchanged", async () => {
    const before = await indexes();
    const r = await dbAdmin(createIndex(`idx_sg_obo_${word()}`), OBO_ADMIN);
    expect(r.status).toBe(403);
    expect(await indexes()).toEqual(before);
  }, 60_000);

  it('[MUST-FAIL] a [read, write] key: retire-malformed ⇒ 403 and the malformed template is not retired', async () => {
    const r = await post('/v2/activities/templates/retire-malformed', { dry_run: false }, RW);
    expect(r.status).toBe(403);
    expect((await activity(MALFORMED))?.retired).toBe(false);
  }, 60_000);

  it('[MUST-FAIL] a [read, write] key: /templates/:id/promote ⇒ 403 and the template stays proposed', async () => {
    const r = await post(`/v2/activities/templates/${PROPOSED}/promote`, {}, RW);
    expect(r.status).toBe(403);
    expect((await activity(PROPOSED))?.proposed).toBe(true);
  }, 60_000);

  it('[MUST-FAIL] a [read, write] key: auto-promote and fts-rebuild ⇒ 403', async () => {
    expect((await post('/v2/activities/templates/auto-promote', { dry_run: true }, RW)).status).toBe(403);
    expect((await post('/v2/activities/internal/fts-rebuild', {}, RW)).status).toBe(403);
  }, 60_000);

  it('[CONTROL] db:admin and admin keys run create_index and the indexes exist', async () => {
    const a = `idx_sg_dba_${word()}`;
    const b = `idx_sg_adm_${word()}`;
    expect((await dbAdmin(createIndex(a), DB_ADMIN)).status).toBe(200);
    expect((await dbAdmin(createIndex(b), ADMIN)).status).toBe(200);
    expect(await indexes()).toEqual(expect.arrayContaining([a, b]));
  }, 60_000);

  it('[CONTROL] a templates:admin key passes the retire-malformed gate', async () => {
    // The gate admits it. What the sweep then does is the route's own behaviour, unchanged here: on the root path it
    // currently answers 500 "{} is not iterable" (it iterates rows[0], a single record), at the parent as well.
    const r = await post('/v2/activities/templates/retire-malformed', { dry_run: true }, TPL_ADMIN);
    expect(r.status).not.toBe(403);
    expect(r.json?.error?.code).not.toBe('SCOPE_REQUIRED');
  }, 60_000);

  it('[CONTROL] smoke: a templates:admin key promotes the proposed template and runs auto-promote', async () => {
    // The evidence gate (a cold-start template has no neighbours) is not what is under test: it is switched off for
    // this one call, the way its shadow-mode tuning does, so the promote itself is observed.
    process.env.PROMOTE_GATE_DISABLED = 'true';
    try {
      const r = await post(`/v2/activities/templates/${PROPOSED}/promote`, {}, TPL_ADMIN);
      expect(r.status).toBe(200);
      expect(r.json.success).toBe(true);
    } finally {
      delete process.env.PROMOTE_GATE_DISABLED;
    }
    expect((await activity(PROPOSED))?.proposed).toBe(false);
    expect((await post('/v2/activities/templates/auto-promote', { dry_run: true }, TPL_ADMIN)).status).toBe(200);
  }, 60_000);

  it("[CONTROL] smoke: a [read, write] key's automated label write still lands", async () => {
    const id = `sg-label-${word()}`;
    const r = await post('/v2/impulses/resolve', { pointer: { type: 'goal_verification_label_write', goal: 'g', execution_id: id, activity_id: 'activity:x', verdict: 'achieved', confidence: 0.9, labeler: 'automated' } }, RW);
    expect(r.status).toBe(200);
    const rows = await db!.sql(`${USE} SELECT org_id FROM goal_verification_labels WHERE execution_id = '${id}';`);
    expect(rows[rows.length - 1].result.length).toBe(1);
  }, 60_000);
});
