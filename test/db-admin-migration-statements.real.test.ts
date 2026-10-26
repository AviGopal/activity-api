// db_admin apply_migration ACCEPTS ONE TABLE-SCHEMA STATEMENT PER ENTRY, PARSED (real engine).
//
// apply_migration runs caller statements on the module client, which is DB ROOT. The old check was a prefix match:
// starts with DEFINE, carries IF NOT EXISTS / OVERWRITE, no DELETE/REMOVE/DROP. It admitted root users, access methods,
// and a harmless DEFINE chained with `;` to anything. db:admin is granted to the fleet key, so this check is what keeps
// the scope from being root. Every request below is sent as a db:admin key through POST /v2/impulses/resolve, and the
// engine's own catalogue (INFO FOR ROOT / DB / TABLE) on a scratch SurrealDB 2.3.10 is the ground truth.
//   [MUST-FAIL] DEFINE USER IF NOT EXISTS ... ON ROOT ... ROLES OWNER ⇒ refused, no root user.
//   [MUST-FAIL] DEFINE TABLE ...; DEFINE USER ... (chained) ⇒ refused, neither the table nor the user exists.
//   [MUST-FAIL] newline / odd-case DEFINE\n  user ... on root ⇒ refused, no root user.
//   [MUST-FAIL] a comment between two statements ⇒ refused, no root user.
//   [MUST-FAIL] DEFINE ACCESS IF NOT EXISTS ... ON DATABASE ⇒ refused, no access method.
//   [CONTROL]   DEFINE USER without IF NOT EXISTS, and a statement that opens with a comment, are refused (both were already).
//   [CONTROL]   DEFINE FIELD IF NOT EXISTS ... ON <table> (a migration's shape) applies; the field exists.
//   [CONTROL]   mode 'reconcile' with filenames is unchanged: the filename is recorded in init_migrations.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, useRealModules, type RealSurreal } from './support/real-surreal';

const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const DB_ADMIN = { jwtToken: '', orgId: 'organizations:substrate', authType: 'apikey', keyId: 'k-substrate-default', scopes: ['read', 'write', 'db:admin', 'templates:admin'] };

let db: RealSurreal | null = null;
let startError = '';
let restoreModules: () => void = () => {};
let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

async function migrate(statements: string[]): Promise<{ status: number; json: any }> {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ impulse: { type: 'db_admin', pointer: { type: 'db_admin', operation: 'apply_migration', mode: 'statements', statements } } }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function last(text: string): Promise<any> {
  const r = await db!.sql(text);
  return r[r.length - 1].result;
}
const rootUsers = async (): Promise<string[]> => Object.keys((await last('INFO FOR ROOT;')).users ?? {});
const dbAccesses = async (): Promise<string[]> => Object.keys((await last(`${USE} INFO FOR DB;`)).accesses ?? {});
const dbTables = async (): Promise<string[]> => Object.keys((await last(`${USE} INFO FOR DB;`)).tables ?? {});

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
    h.use('*', async (c, next) => { (c as any).set('jwtAuth', DB_ADMIN); await next(); });
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

describe('db_admin apply_migration statement parsing (real engine)', () => {
  it('instrument: surreal started and the catalogue reads', async () => {
    expect(startError).toBe('');
    expect(Array.isArray(await rootUsers())).toBe(true);
  }, 60_000);

  it('[MUST-FAIL] DEFINE USER IF NOT EXISTS ... ON ROOT ... ROLES OWNER is refused and no root user exists', async () => {
    const u = `mf_root_${word()}`;
    const r = await migrate([`DEFINE USER IF NOT EXISTS ${u} ON ROOT PASSWORD 'y' ROLES OWNER`]);
    expect(await rootUsers()).not.toContain(u);
    expect(r.status).not.toBe(200);
  }, 60_000);

  it('[MUST-FAIL] a table DEFINE chained with ; to DEFINE USER is refused and neither exists', async () => {
    const t = `mf_chain_${word()}`;
    const u = `mf_chain_${word()}`;
    const r = await migrate([`DEFINE TABLE IF NOT EXISTS ${t} SCHEMALESS; DEFINE USER IF NOT EXISTS ${u} ON ROOT PASSWORD 'y' ROLES OWNER`]);
    expect(await rootUsers()).not.toContain(u);
    expect(await dbTables()).not.toContain(t);
    expect(r.status).not.toBe(200);
  }, 60_000);

  it('[MUST-FAIL] a newline / odd-case DEFINE USER on root is refused and no root user exists', async () => {
    const u = `mf_case_${word()}`;
    const r = await migrate([`DEFINE\n  uSeR IF NOT EXISTS ${u}\n  on root PASSWORD 'y' roles owner`]);
    expect(await rootUsers()).not.toContain(u);
    expect(r.status).not.toBe(200);
  }, 60_000);

  it('[MUST-FAIL] a comment between two statements is refused and no root user exists', async () => {
    const u = `mf_cmt_${word()}`;
    const r = await migrate([`DEFINE TABLE IF NOT EXISTS mf_cmt_tbl SCHEMALESS /* */; DEFINE USER IF NOT EXISTS ${u} ON ROOT PASSWORD 'y' ROLES OWNER`]);
    expect(await rootUsers()).not.toContain(u);
    expect(r.status).not.toBe(200);
  }, 60_000);

  it('[MUST-FAIL] DEFINE ACCESS IF NOT EXISTS ... ON DATABASE is refused and no access method exists', async () => {
    const a = `mf_access_${word()}`;
    const r = await migrate([`DEFINE ACCESS IF NOT EXISTS ${a} ON DATABASE TYPE JWT ALGORITHM HS512 KEY 'k'`]);
    expect(await dbAccesses()).not.toContain(a);
    expect(r.status).not.toBe(200);
  }, 60_000);

  it('[CONTROL] DEFINE USER without IF NOT EXISTS, and a statement opening with a comment, are refused', async () => {
    const u1 = `ctl_plain_${word()}`;
    const u2 = `ctl_cmt_${word()}`;
    expect((await migrate([`DEFINE USER ${u1} ON ROOT PASSWORD 'y' ROLES OWNER`])).status).not.toBe(200);
    expect((await migrate([`/* */DEFINE USER IF NOT EXISTS ${u2} ON ROOT PASSWORD 'y' ROLES OWNER`])).status).not.toBe(200);
    const users = await rootUsers();
    expect(users).not.toContain(u1);
    expect(users).not.toContain(u2);
  }, 60_000);

  it('[CONTROL] DEFINE FIELD IF NOT EXISTS ... ON <table> applies and the field exists', async () => {
    const f = `ctl_note_${word()}`;
    const r = await migrate([`DEFINE FIELD IF NOT EXISTS ${f} ON activity_execution_traces TYPE option<string>;`]);
    expect({ status: r.status, error: r.json.error }).toEqual({ status: 200, error: undefined });
    const info = await last(`${USE} INFO FOR TABLE activity_execution_traces;`);
    expect(Object.keys(info.fields ?? {})).toContain(f);
  }, 60_000);

  it("[CONTROL] mode 'reconcile' records its filenames, unchanged", async () => {
    const file = `990-ctl-${word()}.surql`;
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impulse: { type: 'db_admin', pointer: { type: 'db_admin', operation: 'apply_migration', mode: 'reconcile', filenames: [file] } } }),
    });
    expect(res.status).toBe(200);
    const rows = await last(`${USE} SELECT * FROM init_migrations WHERE filename = '${file}' OR name = '${file}' OR id = type::thing('init_migrations', '${file}');`);
    expect(JSON.stringify(rows)).toContain(file);
  }, 60_000);
});
