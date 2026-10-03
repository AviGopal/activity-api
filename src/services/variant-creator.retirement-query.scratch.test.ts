/**
 * The template-retirement check's execution query against a REAL SurrealDB 2.3.x
 * (services/variant-creator.ts, checkAndRetireTemplate).
 *
 * The check reads `SELECT success FROM execution … ORDER BY created_at DESC LIMIT 20`. SurrealDB 2.3
 * refuses to order by a field the statement does not select ("Missing order idiom `created_at` in
 * statement selection"), so the query never parses, checkAndRetireTemplate's catch returns false,
 * and the retirement sweep can never see a template's history. shouldCreateVariant's
 * `SELECT success, error, created_at … ORDER BY created_at` is the control: same table, same
 * ordering, the ordered field selected.
 *
 * Calls the REAL functions with the real surrealDB client, recording what each query the module
 * issues resolved to (rows or the thrown error) — the functions themselves swallow errors.
 * Runs only with SCRATCH_SURREALDB_URL (loopback, never :8000/:18000) and its own database;
 * SKIPPED otherwise, and says so.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'variant_retirement_test';
if (SCRATCH) {
  const u = new URL(SCRATCH);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || ['8000', '18000'].includes(u.port)) {
    throw new Error(`refusing non-scratch SurrealDB: ${SCRATCH}`);
  }
  process.env.SURREALDB_URL = SCRATCH;
  process.env.SURREALDB_NAMESPACE = 'activity-system';
  process.env.SURREALDB_DATABASE = TEST_DB;
  process.env.SURREALDB_USERNAME = 'root';
  process.env.SURREALDB_PASSWORD = process.env.SCRATCH_SURREALDB_PASS ?? 'root';
} else {
  console.warn('[variant-creator.retirement-query.scratch] SKIPPED: set SCRATCH_SURREALDB_URL (+ SCRATCH_SURREALDB_PASS) to a throwaway SurrealDB 2.3 to run');
}
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

const run = SCRATCH ? describe : describe.skip;
const ORG = 'organizations:o';
const TPL = 'tpl_retire_probe';

type Rec = { sql: string; rows?: unknown[]; error?: string };

run('template retirement check query (scratch SurrealDB)', () => {
  let db: typeof import('../db/surreal')['surrealDB'];
  let VC: typeof import('./variant-creator');
  let original: typeof db.query;
  const calls: Rec[] = [];

  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) throw new Error('not the scratch DB — refusing');
    db = (await import('../db/surreal')).surrealDB;
    VC = await import('./variant-creator');
    if (typeof VC.checkAndRetireTemplate !== 'function') throw new Error('module mocked in this process — run this file on its own');
    // Pass-through recorder on the singleton the module imports: every query still runs for real.
    original = db.query.bind(db);
    (db as { query: typeof db.query }).query = (async (sql: string, params?: Record<string, unknown>) => {
      try {
        const rows = await original(sql, params);
        calls.push({ sql, rows });
        return rows;
      } catch (e) {
        calls.push({ sql, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    }) as typeof db.query;
  });

  afterAll(() => {
    if (original) (db as { query: typeof db.query }).query = original;
  });

  beforeEach(async () => {
    await original('REMOVE TABLE IF EXISTS execution; REMOVE TABLE IF EXISTS activity;');
    await original('DEFINE TABLE execution SCHEMALESS; DEFINE TABLE activity SCHEMALESS;');
    await original(`CREATE type::thing('activity', $id) CONTENT { name: 'probe', org_id: $org }`, { id: TPL, org: ORG });
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    for (let i = 0; i < 20; i++) {
      await original('CREATE execution CONTENT $r', { r: {
        activity_id: TPL, org_id: ORG, success: false, error: `boom ${i}`, created_at: new Date(t0 + i * 60_000),
      } });
    }
    calls.length = 0;
  });

  const executionQuery = (limit: number) =>
    calls.find((c) => /FROM\s+execution/.test(c.sql) && new RegExp(`LIMIT\\s+${limit}\\b`).test(c.sql));

  test('control: shouldCreateVariant\'s history query (created_at selected) parses and returns the executions', async () => {
    await VC.shouldCreateVariant(TPL, ORG, null);
    const q = executionQuery(10);
    expect(q).toBeDefined();
    expect(q?.error).toBeUndefined();
    expect(Array.isArray(q?.rows) ? q!.rows!.length : -1).toBe(10);
  });

  test('checkAndRetireTemplate\'s last-20 query parses and returns the template\'s executions', async () => {
    await VC.checkAndRetireTemplate(TPL, ORG, null);
    const q = executionQuery(20);
    expect(q).toBeDefined();
    expect(q?.error).toBeUndefined();
    expect(Array.isArray(q?.rows) ? q!.rows!.length : -1).toBe(20);
  });
});
