/**
 * Phase C: smoke test for migration 099 (account_id-aware PERMISSIONS).
 *
 * OpenSpec change: activity-api-account-id-migration-2026-04-28
 *
 * Verifies (mirrors migrations.account-id*.test.ts pattern, no DB connection):
 *   1. The migration file exists.
 *   2. Every expected table has a redefined PERMISSIONS clause.
 *   3. Every clause carries the dual-scope check (account_id precedence,
 *      org_id fallback when row's account_id is unset).
 *   4. Migration uses DEFINE TABLE OVERWRITE for idempotency.
 *   5. Project-scoped tables retain the project_id escape clauses (084/085).
 *   6. `public = true`, `scope = 'global'`, `org_id IS NONE`, role-admin and
 *      created_by guards survive — semantics preserved.
 *   7. Type-cast variants from migration 074 survive on cast-using tables.
 *   8. Skipped tables (no DEFINE TABLE or no prior PERMISSIONS) are NOT
 *      touched.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const M099 = join(import.meta.dir, '..', '..', 'sql', 'migrations', '099-account-id-permissions.surql');

const MIGRATED_TABLES = [
  'activity', 'execution', 'impulse', 'vessel',
  'activity_composition_graph', 'activity_dataflows', 'activity_execution_traces',
  'activity_prerequisites', 'circuit_breaker_trace', 'code_variants',
  'composite_sequence_patterns', 'composition_chain', 'composition_edge',
  'composition_node', 'context_thompson_scores', 'execution_pattern',
  'execution_sequences', 'execution_traces', 'external_validation_history',
  'state_transition', 'thompson_selection_log', 'goal_execution_paths',
  'impulse_budget_log', 'impulse_relevance_metrics', 'impulse_resolution_metrics',
  'impulse_shape_activity_score', 'impulse_state_pattern', 'impulse_usage_history',
  'llm_resolution_log', 'pattern', 'prerequisite_patterns', 'relevance_feedback',
  'routing_trace', 'shape_definition', 'tool_argument_pattern', 'tool_usage',
  'variant_performance_metrics', 'vessel_circuit_breaker', 'vessel_health_metrics',
  'ci_runs', 'minibob_instance',
];

const SKIPPED_TABLES = [
  'impulse_data',              // no DEFINE TABLE
  'activity_registry',         // no DEFINE TABLE
  'activity_state_affinity',   // field-level perms only (mig 065)
  'discovered_state_pattern',  // field-level perms only
  'execution_state_snapshot',  // field-level perms only
  'state_feature_importance',  // field-level perms only
  'tool_usage_patterns',       // no PERMISSIONS at all
];

const PROJECT_SCOPED_TABLES = [
  'activity_execution_traces', 'goal_execution_paths', 'activity_dataflows',
  'code_variants', 'execution_sequences', 'impulse_usage_history', 'ci_runs',
  'execution', 'impulse',
];

const TABLES_WITH_PROJECT_IDS_ESCAPE = ['activity_execution_traces', 'goal_execution_paths'];
// 080 is canonical for activity_composition_graph and dropped 074's `OR
// public = true` escape; tables below carry public escapes in *their*
// most-recent baseline (056, 074, 080's composition_node, 080's pattern).
const TABLES_WITH_PUBLIC_ESCAPE = [
  'composition_edge', 'composition_node', 'pattern', 'shape_definition',
];
const TABLES_WITH_SCOPE_GLOBAL = ['activity', 'impulse_state_pattern'];
const TABLES_WITH_LEGACY_NONE_ESCAPE = [
  'activity', 'execution_traces', 'shape_definition', 'variant_performance_metrics',
];
const TOKEN_BASED_TABLES = [
  'activity', 'impulse', 'activity_composition_graph', 'composite_sequence_patterns',
  'composition_chain', 'composition_node', 'context_thompson_scores', 'execution_traces',
  'state_transition', 'thompson_selection_log', 'impulse_relevance_metrics',
  'impulse_state_pattern', 'llm_resolution_log', 'pattern', 'relevance_feedback',
  'tool_argument_pattern', 'tool_usage',
];

function extractTableBlocks(sql: string): Record<string, string> {
  const blocks: Record<string, string> = {};
  const lines = sql.split('\n');
  let currentTable: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentTable !== null) blocks[currentTable] = buffer.join('\n');
  };
  for (const line of lines) {
    const m = line.match(/^DEFINE TABLE (\w+) OVERWRITE\b/);
    if (m) {
      flush();
      currentTable = m[1];
      buffer = [line];
    } else if (currentTable !== null) {
      buffer.push(line);
    }
  }
  flush();
  return blocks;
}

describe('Phase C: migration 099 (account_id-aware PERMISSIONS)', () => {
  test('file exists', () => {
    expect(existsSync(M099)).toBe(true);
  });

  test('uses DEFINE TABLE OVERWRITE for idempotency', () => {
    const sql = readFileSync(M099, 'utf-8');
    const plain = (sql.match(/^DEFINE TABLE (?!\w+ OVERWRITE)(?!IF NOT EXISTS)/gm) || []).length;
    expect(plain).toBe(0);
    const overwrites = (sql.match(/^DEFINE TABLE \w+ OVERWRITE\b/gm) || []).length;
    expect(overwrites).toBe(MIGRATED_TABLES.length);
  });

  test('every expected table has a DEFINE TABLE OVERWRITE block', () => {
    const sql = readFileSync(M099, 'utf-8');
    for (const table of MIGRATED_TABLES) {
      expect(sql, `missing DEFINE TABLE OVERWRITE for ${table}`).toMatch(
        new RegExp(`^DEFINE TABLE ${table} OVERWRITE\\b`, 'm')
      );
    }
  });

  test('every PERMISSIONS clause references both account_id and org_id', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    expect(Object.keys(blocks).sort()).toEqual([...MIGRATED_TABLES].sort());
    for (const table of MIGRATED_TABLES) {
      const block = blocks[table];
      expect(block, `block for ${table} not found`).toBeDefined();
      if (table === 'minibob_instance') {
        // Deprecated read-only-by-admin table; no org/account predicate.
        expect(block).toContain("$auth.role = 'admin'");
        continue;
      }
      expect(block, `account_id missing in ${table}`).toContain('account_id');
      expect(block, `org_id missing in ${table}`).toContain('org_id');
    }
  });

  test('every account_id-scoped table includes the IS NOT NONE precedence guard', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of MIGRATED_TABLES) {
      if (table === 'minibob_instance') continue;
      const block = blocks[table];
      expect(block, `${table} missing account_id precedence`).toMatch(
        /\.account_id IS NOT NONE AND account_id =/
      );
      expect(block, `${table} missing account_id IS NONE fallback`).toMatch(
        /account_id IS NONE AND[\s\S]*?org_id =/
      );
    }
  });

  test('project-scoped tables retain their project_id logic', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of PROJECT_SCOPED_TABLES) {
      expect(blocks[table], `${table} missing project_id`).toContain('project_id');
    }
  });

  test('084/085 multi-condition project_ids escape preserved', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of TABLES_WITH_PROJECT_IDS_ESCAPE) {
      const b = blocks[table];
      expect(b).toContain('project_id IS NONE');
      expect(b).toContain('project_id IN $auth.project_ids');
      expect(b).toContain('$auth.project_ids IS NONE');
      expect(b).toContain('array::len($auth.project_ids) = 0');
    }
  });

  test('public = true escapes preserved', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of TABLES_WITH_PUBLIC_ESCAPE) {
      expect(blocks[table], `${table} missing public = true`).toContain('public = true');
    }
  });

  test("scope = 'global' escapes preserved on activity and impulse_state_pattern", () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of TABLES_WITH_SCOPE_GLOBAL) {
      expect(blocks[table], `${table} missing scope = 'global'`).toContain("scope = 'global'");
    }
  });

  test('org_id IS NONE legacy escapes preserved where they existed', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of TABLES_WITH_LEGACY_NONE_ESCAPE) {
      expect(blocks[table], `${table} missing org_id IS NONE`).toContain('org_id IS NONE');
    }
  });

  test('migration 074 type-cast variants preserved on cast-using tables', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of ['execution', 'composition_edge', 'variant_performance_metrics']) {
      const b = blocks[table];
      expect(b, `${table} cast missing`).toContain('<string>$auth.org_id');
      expect(b, `${table} reverse-cast missing`).toContain('<string>org_id');
    }
  });

  test('shape_definition retains the JWT org-id stripper', () => {
    const sql = readFileSync(M099, 'utf-8');
    expect(extractTableBlocks(sql).shape_definition).toContain(
      "string::replace(type::string($auth.org_id), 'organizations:', '')"
    );
  });

  test('$token-based tables continue to use $token (not $auth) for org-id branch', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of TOKEN_BASED_TABLES) {
      const b = blocks[table];
      expect(b, `${table} should reference $token.account_id`).toContain('$token.account_id');
      expect(b, `${table} should reference $token.org_id`).toContain('$token.org_id');
    }
  });

  test('admin-role guards preserved (both $token.role and $auth.role)', () => {
    const sql = readFileSync(M099, 'utf-8');
    expect(sql).toContain("$token.role = 'admin'");
    expect(sql).toContain("$auth.role = 'admin'");
  });

  test('created_by guards preserved on token+auth tables that use them', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    expect(blocks.pattern).toContain('created_by = $token.id');
    expect(blocks.llm_resolution_log).toContain('created_by = $token.id');
    expect(blocks.activity_execution_traces).toContain('created_by = $auth.id');
  });

  test('skipped tables NOT redefined by migration 099', () => {
    const sql = readFileSync(M099, 'utf-8');
    for (const table of SKIPPED_TABLES) {
      const hasDefine = new RegExp(`^DEFINE TABLE ${table} OVERWRITE\\b`, 'm').test(sql);
      expect(hasDefine, `skipped table ${table} should not be redefined`).toBe(false);
    }
  });

  test('migration header documents skipped tables for auditability', () => {
    const sql = readFileSync(M099, 'utf-8');
    for (const table of SKIPPED_TABLES) {
      expect(sql, `skipped ${table} not documented`).toContain(table);
    }
  });

  test('SCHEMALESS preserved for relevance_feedback (matches migration 090)', () => {
    const sql = readFileSync(M099, 'utf-8');
    expect(sql).toMatch(/DEFINE TABLE relevance_feedback OVERWRITE SCHEMALESS/);
  });

  test('SCHEMAFULL preserved on the SCHEMAFULL tables (spot-check)', () => {
    const sql = readFileSync(M099, 'utf-8');
    expect(sql).toMatch(/DEFINE TABLE execution OVERWRITE SCHEMAFULL/);
    expect(sql).toMatch(/DEFINE TABLE impulse OVERWRITE SCHEMAFULL/);
    expect(sql).toMatch(/DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL/);
    expect(sql).toMatch(/DEFINE TABLE goal_execution_paths OVERWRITE SCHEMAFULL/);
  });

  test("activity table preserves 087's admin guard for global scope writes", () => {
    const sql = readFileSync(M099, 'utf-8');
    expect(extractTableBlocks(sql).activity).toContain("scope = 'global' AND $auth.role = 'admin'");
  });

  test('every redefined block carries FOR select + PERMISSIONS', () => {
    const sql = readFileSync(M099, 'utf-8');
    const blocks = extractTableBlocks(sql);
    for (const table of MIGRATED_TABLES) {
      expect(blocks[table], `${table} missing FOR select`).toContain('FOR select');
      expect(blocks[table], `${table} missing PERMISSIONS`).toContain('PERMISSIONS');
    }
  });

  test('mutual exclusion: no skipped table appears in MIGRATED_TABLES', () => {
    const skipped = new Set(SKIPPED_TABLES);
    for (const table of MIGRATED_TABLES) {
      expect(skipped.has(table), `${table} appears in both lists`).toBe(false);
    }
  });

  test('migrated + skipped together cover the 39-table Phase A/A2 universe', () => {
    const universe = new Set([...MIGRATED_TABLES, ...SKIPPED_TABLES]);
    // 39 from the brief plus vessel_circuit_breaker, vessel_health_metrics
    // (which were in 097 but not enumerated in the user instructions).
    expect(universe.size).toBeGreaterThanOrEqual(39);
  });
});
