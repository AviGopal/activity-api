/**
 * Phase A2: smoke test for migrations 097 + 098.
 *
 * OpenSpec change: activity-api-account-id-migration-2026-04-28
 *
 * Verifies (mirrors migrations.account-id.test.ts for migrations 095 + 096):
 *   1. Both files exist on disk.
 *   2. Migration 097 uses idempotent DEFINE FIELD OVERWRITE.
 *   3. Migration 097 touches the 7 tier-2 tables (and only those).
 *   4. Migration 098 defines a `v_<table>_by_account` view per tier-2 table.
 *   5. Migration 098 views are read-only and use the same effective_account_id
 *      fallback contract as migration 096.
 *   6. The 4 phantom tables identified in the audit (activity_metrics,
 *      activity_templates, connection, org_members) are NOT referenced in
 *      either migration — guarding against accidentally adding fields to
 *      undefined tables.
 *
 * Static-text test — no SurrealDB connection required, matches the existing
 * migrations.account-id.test.ts pattern.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'sql', 'migrations');
const M097 = join(MIGRATIONS_DIR, '097-account-id-additive-tier2.surql');
const M098 = join(MIGRATIONS_DIR, '098-back-compat-account-views-tier2.surql');

// Tier-2 tables — referenced by code but missed by migration 095.
// Confirmed in the audit (see migration 097 header) to have a DEFINE TABLE
// statement somewhere in sql/*.surql. Kept in sync with migration 097.
const TIER2_TABLES = [
  'composition_chain',
  'composition_node',
  'impulse_shape_activity_score',
  'tool_argument_pattern',
  'tool_usage_patterns',
  'vessel_circuit_breaker',
  'vessel_health_metrics',
];

// Phantoms — names that appeared in code but have NO DEFINE TABLE statement
// anywhere in sql/. Either dead paths or typos. See migration 097 header for
// the per-table explanation.
const PHANTOM_TABLES = [
  'activity_metrics',
  'activity_templates', // typo for `activity` paradigm table; covered by 095
  'connection', // never declared; only Redis/SurrealDB connection objects share the name
  'org_members', // identity-vessel scope, not activity-api
];

describe('Phase A2: migration 097 (additive account_id, tier 2)', () => {
  test('file exists', () => {
    expect(existsSync(M097)).toBe(true);
  });

  test('uses DEFINE FIELD OVERWRITE for idempotency', () => {
    const sql = readFileSync(M097, 'utf-8');
    // Plain DEFINE FIELD without OVERWRITE/IF NOT EXISTS would fail on re-run.
    const plainDefineFieldCount = (sql.match(
      /^DEFINE FIELD (?!OVERWRITE)(?!IF NOT EXISTS)/gm
    ) || []).length;
    expect(plainDefineFieldCount).toBe(0);

    expect(sql).toContain('DEFINE FIELD OVERWRITE account_id');
    expect(sql).toContain('DEFINE FIELD OVERWRITE account_id_version');
  });

  test('defines account_id and account_id_version on every tier-2 table', () => {
    const sql = readFileSync(M097, 'utf-8');
    for (const table of TIER2_TABLES) {
      expect(sql, `account_id missing on table ${table}`).toContain(
        `DEFINE FIELD OVERWRITE account_id ON TABLE ${table} `
      );
      expect(sql, `account_id_version missing on table ${table}`).toContain(
        `DEFINE FIELD OVERWRITE account_id_version ON TABLE ${table} TYPE int DEFAULT 0`
      );
    }
  });

  test('declares account_id as option<string> (never required)', () => {
    const sql = readFileSync(M097, 'utf-8');
    // Spot-check a representative tier-2 table.
    expect(sql).toContain(
      'DEFINE FIELD OVERWRITE account_id ON TABLE composition_chain TYPE option<string>'
    );
    // Phase A invariant: no required-string account_id anywhere.
    const requiredAccountIdMatch = sql.match(/account_id\s+ON\s+TABLE\s+\w+\s+TYPE\s+string\b/);
    expect(requiredAccountIdMatch).toBeNull();
  });

  test('creates an index on account_id for every tier-2 table', () => {
    const sql = readFileSync(M097, 'utf-8');
    const normalized = sql.replace(/\s+/g, ' ');
    for (const table of TIER2_TABLES) {
      expect(normalized, `idx_<...>_account_id missing on ${table}`).toMatch(
        new RegExp(`DEFINE INDEX OVERWRITE \\w+ ON ${table} FIELDS account_id`)
      );
    }
  });

  test('does NOT touch any phantom table (audit no-go list)', () => {
    const sql = readFileSync(M097, 'utf-8');
    for (const phantom of PHANTOM_TABLES) {
      // The phantom names may appear in comments (the audit notes them
      // explicitly) but must never appear in a DEFINE FIELD or DEFINE INDEX
      // statement, which would create dangling fields on undefined tables.
      const hasDefineField = new RegExp(
        `^DEFINE FIELD\\s+(OVERWRITE\\s+)?\\w+\\s+ON\\s+(TABLE\\s+)?${phantom}\\b`,
        'm'
      ).test(sql);
      const hasDefineIndex = new RegExp(
        `^DEFINE INDEX\\s+(OVERWRITE\\s+)?\\w+\\s+ON\\s+${phantom}\\b`,
        'm'
      ).test(sql);
      expect(hasDefineField, `phantom ${phantom} has DEFINE FIELD`).toBe(false);
      expect(hasDefineIndex, `phantom ${phantom} has DEFINE INDEX`).toBe(false);
    }
  });

  test('tool_usage_patterns gains both org_id and account_id (only place 097 backfills org_id)', () => {
    // tool_usage_patterns predates multi-tenant conversion and lacks org_id;
    // 097 must add org_id as option<string> so the back-compat view in 098
    // can compute (account_id ?? org_id) without referencing an undefined
    // field. This invariant is documented inline in 097.
    const sql = readFileSync(M097, 'utf-8');
    expect(sql).toContain(
      'DEFINE FIELD OVERWRITE org_id ON TABLE tool_usage_patterns TYPE option<string>'
    );
    // No other table in 097 should be having org_id added (everywhere else
    // org_id already exists). One match total.
    const orgIdAdds = (sql.match(/DEFINE FIELD OVERWRITE org_id ON TABLE \w+/g) || []).length;
    expect(orgIdAdds).toBe(1);
  });
});

describe('Phase A2: migration 098 (back-compat alias views, tier 2)', () => {
  test('file exists', () => {
    expect(existsSync(M098)).toBe(true);
  });

  test('defines a v_<table>_by_account view per tier-2 table', () => {
    const sql = readFileSync(M098, 'utf-8');
    for (const table of TIER2_TABLES) {
      expect(sql, `view v_${table}_by_account missing`).toContain(
        `DEFINE TABLE OVERWRITE v_${table}_by_account AS`
      );
    }
  });

  test('every view derives effective_account_id = account_id ?? org_id', () => {
    const sql = readFileSync(M098, 'utf-8');
    const occurrences = (sql.match(
      /\(account_id \?\? org_id\) AS effective_account_id/g
    ) || []).length;
    expect(occurrences).toBe(TIER2_TABLES.length);
  });

  test('views are read-only (SELECT-derived; no UPDATE/INSERT/DELETE)', () => {
    const sql = readFileSync(M098, 'utf-8');
    const selectViewCount = (sql.match(/AS\s*\n\s*SELECT \*, \(account_id \?\? org_id\)/g) || [])
      .length;
    expect(selectViewCount).toBe(TIER2_TABLES.length);

    expect(sql).not.toMatch(/UPDATE\s+v_\w+_by_account/);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+v_\w+_by_account/);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+v_\w+_by_account/);
  });

  test('uses DEFINE TABLE OVERWRITE for idempotency', () => {
    const sql = readFileSync(M098, 'utf-8');
    const plainDefineTableCount = (sql.match(
      /^DEFINE TABLE (?!OVERWRITE)(?!IF NOT EXISTS)/gm
    ) || []).length;
    expect(plainDefineTableCount).toBe(0);
  });

  test('does NOT define a view for any phantom table', () => {
    const sql = readFileSync(M098, 'utf-8');
    for (const phantom of PHANTOM_TABLES) {
      expect(
        sql,
        `phantom ${phantom} has a view defined in 098`
      ).not.toContain(`v_${phantom}_by_account`);
    }
  });

  test('does NOT redefine views already present in migration 096', () => {
    // 096 already covers impulse_relevance_metrics; ensure 098 does not
    // duplicate it (impulse_relevance_metrics was named in the Phase B audit
    // but is in the 095 list, see 097 header note).
    const sql = readFileSync(M098, 'utf-8');
    expect(sql).not.toContain('v_impulse_relevance_metrics_by_account');
  });
});

describe('Phase A2: cross-migration invariants', () => {
  test('migration 097 header documents the 4 phantoms', () => {
    const sql = readFileSync(M097, 'utf-8');
    // The audit decision must be auditable from the migration header alone.
    for (const phantom of PHANTOM_TABLES) {
      expect(sql, `phantom ${phantom} not documented in 097 header`).toContain(phantom);
    }
  });

  test('migration 097 + 098 together touch the same 7 tables', () => {
    const sql097 = readFileSync(M097, 'utf-8');
    const sql098 = readFileSync(M098, 'utf-8');
    for (const table of TIER2_TABLES) {
      expect(sql097, `097 missing field for ${table}`).toContain(
        `DEFINE FIELD OVERWRITE account_id ON TABLE ${table} `
      );
      expect(sql098, `098 missing view for ${table}`).toContain(
        `DEFINE TABLE OVERWRITE v_${table}_by_account AS`
      );
    }
  });

  test('migration 097 does NOT overlap with the migration 095 table list', () => {
    // Defense against re-touching tables already covered by 095. We don't
    // import the 095 list here (to avoid coupling); instead we spot-check that
    // a representative 095 table (activity_execution_traces) is NOT in 097.
    const sql097 = readFileSync(M097, 'utf-8');
    expect(sql097).not.toContain(
      'DEFINE FIELD OVERWRITE account_id ON TABLE activity_execution_traces '
    );
    expect(sql097).not.toContain(
      'DEFINE FIELD OVERWRITE account_id ON TABLE impulse_relevance_metrics '
    );
    expect(sql097).not.toContain(
      'DEFINE FIELD OVERWRITE account_id ON TABLE goal_execution_paths '
    );
  });
});
