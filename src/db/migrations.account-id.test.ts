/**
 * Phase A: smoke test for migrations 095 + 096.
 *
 * OpenSpec change: activity-api-account-id-migration-2026-04-28
 *
 * Verifies:
 *   1. Both files exist on disk (matches the canonical migration directory).
 *   2. Migration 095 uses idempotent DEFINE FIELD OVERWRITE (matches 094 precedent).
 *   3. Migration 095 touches every table from the OpenSpec ~30-table list.
 *   4. Migration 096 (retired) REMOVEs the `v_<table>_by_account` view per table.
 *   5. Migration 096 never re-defines or writes to those views.
 *
 * This is a static-text test — no SurrealDB connection required. The harness
 * is intentionally minimal so it runs in `bun test` without any infra setup,
 * matching the existing schemas.test.ts and jwtAuth.*.test.ts patterns. A full
 * apply-against-real-DB test belongs in the integration suite (test/integration)
 * which is gated by SurrealDB availability.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'sql', 'migrations');
const M095 = join(MIGRATIONS_DIR, '095-account-id-additive.surql');
const M096 = join(MIGRATIONS_DIR, '096-back-compat-account-views.surql');

// Tables the OpenSpec change targets (Phase A.1 list).
// Kept in sync with migration 095 and the proposal/design docs.
const EXPECTED_TABLES = [
  'activity',
  'execution',
  'impulse',
  'vessel',
  'activity_composition_graph',
  'activity_dataflows',
  'activity_execution_traces',
  'activity_prerequisites',
  'activity_registry',
  'activity_state_affinity',
  'circuit_breaker_trace',
  'code_variants',
  'composite_sequence_patterns',
  'composition_edge',
  'context_thompson_scores',
  'discovered_state_pattern',
  'execution_pattern',
  'execution_sequences',
  'execution_state_snapshot',
  'execution_traces',
  'external_validation_history',
  'state_feature_importance',
  'state_transition',
  'thompson_selection_log',
  'goal_execution_paths',
  'impulse_budget_log',
  'impulse_data',
  'impulse_relevance_metrics',
  'impulse_resolution_metrics',
  'impulse_state_pattern',
  'impulse_usage_history',
  'llm_resolution_log',
  'pattern',
  'prerequisite_patterns',
  'relevance_feedback',
  'routing_trace',
  'shape_definition',
  'tool_usage',
  'variant_performance_metrics',
  'ci_runs',
  'minibob_instance',
];

describe('Phase A: migration 095 (additive account_id)', () => {
  test('file exists', () => {
    expect(existsSync(M095)).toBe(true);
  });

  test('uses DEFINE FIELD OVERWRITE for idempotency', () => {
    const sql = readFileSync(M095, 'utf-8');
    // The migration must NOT use plain DEFINE FIELD without OVERWRITE; that
    // would fail on re-run if the field is already defined.
    const plainDefineFieldCount = (sql.match(
      /^DEFINE FIELD (?!OVERWRITE)(?!IF NOT EXISTS)/gm
    ) || []).length;
    expect(plainDefineFieldCount).toBe(0);

    // OVERWRITE form must be present.
    expect(sql).toContain('DEFINE FIELD OVERWRITE account_id');
    expect(sql).toContain('DEFINE FIELD OVERWRITE account_id_version');
  });

  test('defines account_id and account_id_version on every targeted table', () => {
    const sql = readFileSync(M095, 'utf-8');
    for (const table of EXPECTED_TABLES) {
      expect(sql, `account_id missing on table ${table}`).toContain(
        `DEFINE FIELD OVERWRITE account_id ON TABLE ${table} `
      );
      expect(sql, `account_id_version missing on table ${table}`).toContain(
        `DEFINE FIELD OVERWRITE account_id_version ON TABLE ${table} TYPE int DEFAULT 0`
      );
    }
  });

  test('declares account_id as option<string> (not required)', () => {
    const sql = readFileSync(M095, 'utf-8');
    // Spot-check a representative table — the rest follow the same pattern.
    expect(sql).toContain(
      'DEFINE FIELD OVERWRITE account_id ON TABLE activity_execution_traces TYPE option<string>'
    );
    // Phase A invariant: account_id is option<>, NEVER required during the
    // rollout. Required form would break Phase B dual-write contracts.
    const requiredAccountIdMatch = sql.match(/account_id\s+ON\s+TABLE\s+\w+\s+TYPE\s+string\b/);
    expect(requiredAccountIdMatch).toBeNull();
  });

  test('creates an index on account_id for every targeted table', () => {
    const sql = readFileSync(M095, 'utf-8');
    for (const table of EXPECTED_TABLES) {
      // Some index definitions wrap across lines (`...account_id\n  ON
      // <table> FIELDS account_id`). Normalize whitespace in the haystack so
      // the regex doesn't have to special-case each linebreak.
      const normalized = sql.replace(/\s+/g, ' ');
      expect(normalized, `idx_<...>_account_id missing on ${table}`).toMatch(
        new RegExp(`DEFINE INDEX OVERWRITE \\w+ ON ${table} FIELDS account_id`)
      );
    }
  });
});

describe('Phase A: migration 096 (back-compat alias views)', () => {
  test('file exists', () => {
    expect(existsSync(M096)).toBe(true);
  });

  // 096 was retired (views had zero readers and churned on every write); it
  // now REMOVEs each view so the reconcile re-apply cannot resurrect them.
  test('removes the v_<table>_by_account view for every migrated table', () => {
    const sql = readFileSync(M096, 'utf-8');
    for (const table of EXPECTED_TABLES) {
      expect(sql, `view v_${table}_by_account not removed`).toContain(
        `REMOVE TABLE IF EXISTS v_${table}_by_account;`
      );
    }
  });

  test('never re-defines a by_account view (retirement stays durable)', () => {
    const sql = readFileSync(M096, 'utf-8');
    expect(sql).not.toMatch(/DEFINE TABLE[^;]*v_\w+_by_account/);
    expect(sql).not.toMatch(/AS effective_account_id/);
  });

  test('never writes to a by_account view', () => {
    const sql = readFileSync(M096, 'utf-8');
    expect(sql).not.toMatch(/UPDATE\s+v_\w+_by_account/);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+v_\w+_by_account/);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+v_\w+_by_account/);
  });

  test('uses DEFINE TABLE OVERWRITE for idempotency', () => {
    const sql = readFileSync(M096, 'utf-8');
    // No plain DEFINE TABLE without OVERWRITE/IF NOT EXISTS in this migration.
    const plainDefineTableCount = (sql.match(
      /^DEFINE TABLE (?!OVERWRITE)(?!IF NOT EXISTS)/gm
    ) || []).length;
    expect(plainDefineTableCount).toBe(0);
  });
});
