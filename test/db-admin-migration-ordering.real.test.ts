// db_admin apply_migration REFUSES BEFORE IT WRITES: the scope check and the allow-list both run before the ledger
// (real engine).
//
// apply_migration records into init_migrations, the ledger init-database.ts reads to skip a file on every unit start, so
// a row written by a refused request would mark a migration applied that never ran. Both refusals must therefore come
// before any write: the db:admin scope check (impulses.ts db_admin) before resolveDbAdmin runs at all, and the parsed
// allow-list (validateMigrationStatement) over EVERY statement before the first one runs or the filename is recorded.
// The ledger, the audit table and the catalogue of a scratch SurrealDB 2.3.10 are the ground truth.
//   [MUST-FAIL] a [read, write] key (no db:admin): statements + filename and reconcile + filenames ⇒ 403, init_migrations
//               unchanged, no db_admin_audit row for that key, the field not defined.
//   [MUST-FAIL] a db:admin key: a valid DEFINE FIELD followed by a statement the allow-list refuses, with a filename ⇒
//               refused, init_migrations unchanged, the valid field NOT applied, no root user.
//   [CONTROL]   a db:admin key: a valid DEFINE FIELD with a filename ⇒ 200, the field exists and the filename is in
//               init_migrations (the ledger check above reads a table that does get written).
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, useRealModules, type RealSurreal } from './support/real-surreal';

const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ORG = 'organizations:substrate';
const RW = { jwtToken: '', orgId: ORG, authType: 'apikey', keyId: `k-mo-rw-${word()}`, scopes: ['read', 'write'] };
const DB_ADMIN = { jwtToken: '', orgId: ORG, authType: 'apikey', keyId: `k-mo-dba-${word()}`, scopes: ['read', 'write', 'db:admin'] };

let db: RealSurreal | null = null;
let startError = '';
let restoreModules: () => void = () => {};
let caller: Record<string, unknown> = RW;
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

async function migrate(pointer: Record<string, unknown>, as: Record<string, unknown>): Promise<{ status: number; json: any }> {
  caller = as;
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ impulse: { type: 'db_admin', pointer: { type: 'db_admin', operation: 'apply_migration', ...pointer } } }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function last(text: string): Promise<any> {
  const r = await db!.sql(text);
  return r[r.length - 1].result;
}
const ledger = async (): Promise<string[]> => ((await last(`${USE} SELECT filename FROM init_migrations;`)) as any[]).map((r) => String(r.filename)).sort();
const auditRows = async (actor: string): Promise<number> => ((await last(`${USE} SELECT id FROM db_admin_audit WHERE actor = '${actor}';`)) as any[]).length;
const fields = async (): Promise<string[]> => Object.keys((await last(`${USE} INFO FOR TABLE activity_execution_traces;`)).fields ?? {});
const rootUsers = async (): Promise<string[]> => Object.keys((await last('INFO FOR ROOT;')).users ?? {});
const defineField = (f: string) => `DEFINE FIELD IF NOT EXISTS ${f} ON activity_execution_traces TYPE option<string>;`;

beforeAll(async () => {
  try {
    await import('../src/lib/posterior-update');
    restoreModules = await useRealModules(['src/lib/tuning-params', 'src/lib/prior-seed', 'src/lib/embedding-lookup-cache', 'src/lib/posterior-aggregator',
      'src/db/paradigm', 'src/websocket/broadcaster', 'src/services/variant-creator']);
    db = await startRealSurreal();
    await db.connectModuleClient();
    const impulses = (await import('../src/routes/impulses')).default;
    const { Hono } = await import('hono');
    const h = new Hono();
    h.use('*', async (c, next) => { (c as any).set('jwtAuth', caller); await next(); });
    h.route('/v2/impulses', impulses);
    app = h;
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  restoreModules();
  await db?.stop();
});

describe('db_admin apply_migration refuses before any ledger write (real engine)', () => {
  it('instrument: surreal started and the ledger reads', async () => {
    expect(startError).toBe('');
    expect(Array.isArray(await ledger())).toBe(true);
  }, 60_000);

  it('[MUST-FAIL] a caller without db:admin is refused before any ledger or audit write', async () => {
    const before = await ledger();
    const f = `mo_rw_${word()}`;
    const file1 = `991-mo-rw-${word()}.surql`;
    const file2 = `992-mo-rw-${word()}.surql`;
    const a = await migrate({ mode: 'statements', statements: [defineField(f)], filename: file1 }, RW);
    const b = await migrate({ mode: 'reconcile', filenames: [file2] }, RW);
    expect({ a: a.status, b: b.status }).toEqual({ a: 403, b: 403 });
    expect(await ledger()).toEqual(before);
    expect(await auditRows(RW.keyId)).toBe(0);
    expect(await fields()).not.toContain(f);
  }, 60_000);

  it('[MUST-FAIL] a statement the allow-list refuses leaves the ledger unchanged and runs nothing before it', async () => {
    const before = await ledger();
    const f = `mo_ok_${word()}`;
    const u = `mo_root_${word()}`;
    const file = `993-mo-refused-${word()}.surql`;
    const r = await migrate({ mode: 'statements', statements: [defineField(f), `DEFINE USER IF NOT EXISTS ${u} ON ROOT PASSWORD 'y' ROLES OWNER`], filename: file }, DB_ADMIN);
    expect(r.status).not.toBe(200);
    expect(await ledger()).toEqual(before);
    expect(await fields()).not.toContain(f);
    expect(await rootUsers()).not.toContain(u);
  }, 60_000);

  it('[CONTROL] a db:admin key applies a valid DEFINE FIELD and records its filename', async () => {
    const f = `mo_ctl_${word()}`;
    const file = `994-mo-ctl-${word()}.surql`;
    const r = await migrate({ mode: 'statements', statements: [defineField(f)], filename: file }, DB_ADMIN);
    expect({ status: r.status, error: r.json.error }).toEqual({ status: 200, error: undefined });
    expect(await fields()).toContain(f);
    expect(await ledger()).toContain(file);
  }, 60_000);
});
