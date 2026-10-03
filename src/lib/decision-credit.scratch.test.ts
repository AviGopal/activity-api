/**
 * decision_outcome writers against a REAL SurrealDB 2.3.x (lib/decision-credit.ts, migrations 201 + 202).
 *
 * decision_outcome is SCHEMAFULL with `created_at TYPE datetime DEFAULT time::now()`. SurrealDB 2.3
 * applies a DEFAULT only when a record is CREATED; `UPSERT … CONTENT $content` REPLACES the whole
 * record, so on the second write for the same id `created_at` is NONE and the schema rejects it
 * ("Found NONE for field `created_at`"). Both writers swallow the error (best-effort), so the second
 * write for an execution / correlation is silently lost: the stored outcome stays the first one.
 *
 * Drives the shipped recordExecutionDecisionOutcome and recordDecisionOutcome with the real
 * surrealDB client (what posterior-update.ts passes). Runs only with SCRATCH_SURREALDB_URL (loopback,
 * never :8000/:18000) and its own database; SKIPPED otherwise, and says so.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'decision_outcome_test';
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
  console.warn('[decision-credit.scratch] SKIPPED: set SCRATCH_SURREALDB_URL (+ SCRATCH_SURREALDB_PASS) to a throwaway SurrealDB 2.3 to run');
}
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';

const run = SCRATCH ? describe : describe.skip;
const MIGRATIONS = ['201-decision-outcome-capture.surql', '202-decision-outcome-execution-source.surql']
  .map((f) => readFileSync(new URL(`../../sql/migrations/${f}`, import.meta.url), 'utf8'));
const ORG = 'organizations:o';

run('decision_outcome second write for the same id (scratch SurrealDB)', () => {
  let db: typeof import('../db/surreal')['surrealDB'];
  let DC: typeof import('./decision-credit');

  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) throw new Error('not the scratch DB — refusing');
    db = (await import('../db/surreal')).surrealDB;
    DC = await import('./decision-credit');
    if (typeof DC.recordExecutionDecisionOutcome !== 'function') throw new Error('module mocked in this process — run this file on its own');
  });

  beforeEach(async () => {
    await db.query(['decision_outcome', 'variant_performance_metrics', 'thompson_selection_log']
      .map((t) => `REMOVE TABLE IF EXISTS ${t};`).join(' '));
    for (const m of MIGRATIONS) await db.query(m);
    await db.query('DEFINE TABLE variant_performance_metrics SCHEMALESS; DEFINE TABLE thompson_selection_log SCHEMALESS;');
  });

  async function row(id: string) {
    const rows = await db.query<{ outcome_success: boolean; reached?: boolean; created_at: unknown; executed_at?: string }>(
      `SELECT outcome_success, reached, created_at, executed_at FROM type::thing('decision_outcome', $id)`, { id },
    );
    return rows[0];
  }

  test('control: the first execution-sourced write lands with created_at set', async () => {
    const r = await DC.recordExecutionDecisionOutcome(db, {
      executionId: 'exec_first', activityId: 'A', orgId: ORG, success: false, reached: false, executedAt: '2026-10-01T00:00:00Z',
    });
    expect(r).not.toBeNull();
    const got = await row('exec_first');
    expect(got?.outcome_success).toBe(false);
    expect(got?.reached).toBe(false);
    expect(got?.created_at).toBeDefined();
  });

  test('a second recordExecutionDecisionOutcome for the same execution updates the outcome and keeps created_at', async () => {
    const first = await DC.recordExecutionDecisionOutcome(db, {
      executionId: 'exec_twice', activityId: 'A', orgId: ORG, success: false, reached: false, executedAt: '2026-10-01T00:00:00Z',
    });
    expect(first).not.toBeNull();
    const before = await row('exec_twice');
    const second = await DC.recordExecutionDecisionOutcome(db, {
      executionId: 'exec_twice', activityId: 'A', orgId: ORG, success: true, reached: true, executedAt: '2026-10-01T00:05:00Z',
    });
    expect(second).not.toBeNull();
    const after = await row('exec_twice');
    expect(after?.outcome_success).toBe(true);
    expect(after?.reached).toBe(true);
    expect(after?.executed_at).toBe('2026-10-01T00:05:00Z');
    expect(String(after?.created_at)).toBe(String(before?.created_at));
    const n = await db.query<{ n: number }>(`SELECT count() AS n FROM decision_outcome GROUP ALL`);
    expect(n[0]?.n).toBe(1);
  });

  test('a second recordDecisionOutcome for the same correlation updates the outcome and keeps created_at', async () => {
    await db.query(`CREATE thompson_selection_log CONTENT $r`, { r: {
      correlation_id: 'sel_twice', activity_id: 'A', alpha: 3, beta: 1, thompson_sample: 0.7, selected_at: '2026-10-01T00:00:00Z',
    } });
    const first = await DC.recordDecisionOutcome(db, { correlationId: 'sel_twice', success: false, reached: false });
    expect(first).not.toBeNull();
    const before = await row('sel_twice');
    const second = await DC.recordDecisionOutcome(db, { correlationId: 'sel_twice', success: true, reached: true });
    expect(second).not.toBeNull();
    const after = await row('sel_twice');
    expect(after?.outcome_success).toBe(true);
    expect(after?.reached).toBe(true);
    expect(String(after?.created_at)).toBe(String(before?.created_at));
  });
});
