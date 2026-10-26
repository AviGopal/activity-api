// EVERY LEGIT CALLER OF THE SCOPE-GATED ADMIN SURFACES SUCCEEDS END TO END WITH THE SCOPES ITS KEY IS GRANTED (real engine).
//
// The five callers found at the fleet's dev heads all send the node's fleet key (substrate-default, METABOB_API_KEY).
// The companion grant gives that key db:admin and templates:admin; each caller's request is replayed here exactly as
// its code sends it (body, query string, wrapped impulse form), as that key, against a scratch SurrealDB carrying the
// real schema (test/support/real-surreal.ts):
//   1. the substrate's db-maintenance tick: db_admin diagnose, then a concrete create_index (wrapped impulse form);
//   2. development-vessel's trace-store reconcile: db_admin reconcile_trace_store, dry_run:false, under a valid lease;
//   3. boredom-vessel's auto-promote tick: POST /templates/auto-promote with its fixed body;
//   4. development-vessel's reachable-unlearned report: POST /templates/auto-promote?dry_run=true;
//   5. goal-host's auto-draft promote: POST /templates/:id/promote with body {}.
//   [CONTROL] each one succeeds as the granted fleet key;
//   [CONTROL] the same requests as the fleet key BEFORE the grant ([read, write]) are refused 403 SCOPE_REQUIRED, which
//             is what the companion grant must land ahead of.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
process.env.DISCOVERY_VESSEL_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRealSurreal, useRealModules, type RealSurreal } from './support/real-surreal';

const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const FLEET_ORG = 'organizations:substrate';
const PROPOSED = `sc-proposed-${word()}`;
const LEASE_TOKEN = `lease-${word()}`;

const fleetKey = (scopes: string[]) => ({ jwtToken: '', orgId: FLEET_ORG, authType: 'apikey', keyId: 'k-substrate-default', scopes });
const GRANTED = fleetKey(['read', 'write', 'db:admin', 'templates:admin']);
const UNGRANTED = fleetKey(['read', 'write']);

let db: RealSurreal | null = null;
let startError = '';
let restoreModules: () => void = () => {};
let caller: Record<string, unknown> = GRANTED;
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let leaseDir = '';
const savedLeasePath = process.env.MAINTENANCE_LEASE_PATH;

async function post(path: string, body: string, as: Record<string, unknown>): Promise<{ status: number; json: any }> {
  caller = as;
  const res = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
// db-maintenance-tick.ts:43 and trace-store-reconcile.ts:202: the wrapped impulse form.
const dbAdminBody = (operation: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ impulse: { type: 'db_admin', pointer: { type: 'db_admin', operation, ...extra } } });
const content = (j: any) => { try { return typeof j.content === 'string' ? JSON.parse(j.content) : j.content; } catch { return j.content; } };

const CALLERS: Array<{ name: string; run: (as: Record<string, unknown>) => Promise<{ status: number; json: any }> }> = [
  { name: 'db-maintenance tick: diagnose', run: (as) => post('/v2/impulses/resolve', dbAdminBody('diagnose'), as) },
  { name: 'db-maintenance tick: create_index', run: (as) => post('/v2/impulses/resolve', dbAdminBody('create_index', { name: `idx_sc_${word()}`, table: 'impulse_relevance_metrics', fields: ['impulse_id'], concurrent: false }), as) },
  { name: 'development-vessel trace-store reconcile', run: (as) => post('/v2/impulses/resolve', dbAdminBody('reconcile_trace_store', { dry_run: false, lease_token: LEASE_TOKEN }), as) },
  // boredom-vessel src/index.ts:1373-1385
  { name: 'boredom-vessel auto-promote tick', run: (as) => post('/v2/activities/templates/auto-promote', JSON.stringify({ min_samples: 3, min_success_rate: 0.6, prune_failed_out: true, prune_min_samples: 6 }), as) },
  // development-vessel src/resolvers/reachable-unlearned-report.ts:97-101
  { name: 'development-vessel reachable-unlearned report', run: (as) => post('/v2/activities/templates/auto-promote?dry_run=true', JSON.stringify({ min_samples: 0, min_success_rate: 0, dry_run: true }), as) },
  // goal-host-vessel src/index.ts:19275-19284
  { name: 'goal-host auto-draft promote', run: (as) => post(`/v2/activities/templates/${encodeURIComponent(PROPOSED)}/promote`, '{}', as) },
];

beforeAll(async () => {
  try {
    leaseDir = mkdtempSync(join(tmpdir(), 'sc-lease-'));
    const leasePath = join(leaseDir, 'maintenance.json');
    writeFileSync(leasePath, JSON.stringify({ holder: 'trace-store-reconcile', token: LEASE_TOKEN, acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString() }), 'utf-8');
    process.env.MAINTENANCE_LEASE_PATH = leasePath;
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
    await db.sql(`${USE} CREATE type::thing('activity', '${PROPOSED}') CONTENT { name: '${PROPOSED}', input_shapes: [], output_shapes: ['y'], execution_type: 'template', scope: 'global', public: true, org_id: '${FLEET_ORG}', created_at: time::now(), updated_at: time::now(), proposed: true, retired: false, tasks: [] };`);
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  restoreModules();
  await db?.stop();
  if (savedLeasePath === undefined) delete process.env.MAINTENANCE_LEASE_PATH; else process.env.MAINTENANCE_LEASE_PATH = savedLeasePath;
  if (leaseDir) rmSync(leaseDir, { recursive: true, force: true });
});

describe('the five legit callers of the admin surfaces (real engine)', () => {
  it('instrument: surreal started', () => {
    expect(startError).toBe('');
  });

  it('[CONTROL] before the grant, the fleet key is refused 403 SCOPE_REQUIRED on every caller path', async () => {
    for (const c of CALLERS) {
      const r = await c.run(UNGRANTED);
      expect({ caller: c.name, status: r.status }).toEqual({ caller: c.name, status: 403 });
      expect(JSON.stringify(r.json)).toContain('SCOPE_REQUIRED');
    }
  }, 120_000);

  it('[CONTROL] 1. db-maintenance tick as the granted fleet key: diagnose and create_index succeed', async () => {
    const d = await CALLERS[0]!.run(GRANTED);
    expect(d.status).toBe(200);
    expect(d.json.success).toBe(true);
    expect(content(d.json)).toHaveProperty('db_metrics');
    const before = await db!.sql(`${USE} INFO FOR TABLE impulse_relevance_metrics;`);
    const n0 = Object.keys(before[before.length - 1].result.indexes ?? {}).length;
    const i = await CALLERS[1]!.run(GRANTED);
    expect(i.status).toBe(200);
    expect(i.json.success).toBe(true);
    const after = await db!.sql(`${USE} INFO FOR TABLE impulse_relevance_metrics;`);
    expect(Object.keys(after[after.length - 1].result.indexes ?? {}).length).toBe(n0 + 1);
  }, 120_000);

  it('[CONTROL] 2. development-vessel trace-store reconcile as the granted fleet key: the live swap runs', async () => {
    const r = await CALLERS[2]!.run(GRANTED);
    expect({ status: r.status, error: r.json.error }).toEqual({ status: 200, error: undefined });
    expect(r.json.success).toBe(true);
  }, 240_000);

  it('[CONTROL] 3. boredom-vessel auto-promote tick as the granted fleet key succeeds', async () => {
    const r = await CALLERS[3]!.run(GRANTED);
    expect(r.status).toBe(200);
    expect(r.json.error).toBeUndefined();
  }, 120_000);

  it('[CONTROL] 4. development-vessel dry-run auto-promote as the granted fleet key returns its candidate lists', async () => {
    const r = await CALLERS[4]!.run(GRANTED);
    expect(r.status).toBe(200);
    expect(r.json.error).toBeUndefined();
  }, 120_000);

  it('[CONTROL] 5. goal-host auto-draft promote as the granted fleet key promotes the template', async () => {
    // The cold-start evidence gate (no neighbours on a scratch engine) is not under test: switched off for this call,
    // the way its shadow-mode tuning does, so the promote itself is observed.
    process.env.PROMOTE_GATE_DISABLED = 'true';
    try {
      const r = await CALLERS[5]!.run(GRANTED);
      expect(r.status).toBe(200);
      expect(r.json.success).toBe(true);
    } finally {
      delete process.env.PROMOTE_GATE_DISABLED;
    }
    const row = await db!.sql(`${USE} SELECT proposed FROM type::thing('activity', '${PROPOSED}');`);
    expect(row[row.length - 1].result[0].proposed).toBe(false);
  }, 120_000);
});
