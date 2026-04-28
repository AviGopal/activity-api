/**
 * Phase G2/G3 (2026-04-28): smoke test for migration 100.
 * OpenSpec: activity-api-account-id-migration-2026-04-28
 *
 * Pattern mirrors migrations.account-id*.test.ts (no DB connection).
 * Asserts:
 *   G2 — CC1 scope-narrowing as route-handler validator (NOT a DB ASSERT,
 *        because goal_execution_paths has no parent reference field).
 *   G3 — variant_performance_metrics: legacy single-column UNIQUE replaced
 *        with composite (variant_id, account_id) UNIQUE; idempotent
 *        (REMOVE IF EXISTS + DEFINE OVERWRITE).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const M100 = join(ROOT, 'sql', 'migrations', '100-cc1-scope-narrowing-assert.surql');
const GOAL_PATHS_ROUTE = join(ROOT, 'src', 'routes', 'goal-paths.ts');
const GOAL_PATHS_SCHEMA = join(ROOT, 'sql', '003-goal-execution-paths.surql');
const INIT_SCHEMA = join(ROOT, 'sql', '001-init-schema.surql');
const PRIOR_MIGRATIONS = [
  join(ROOT, 'sql', 'migrations', '095-account-id-additive.surql'),
  join(ROOT, 'sql', 'migrations', '099-account-id-permissions.surql'),
  INIT_SCHEMA,
];

describe('Phase G migration 100: structural well-formedness', () => {
  test('migration + referenced files all exist', () => {
    expect(existsSync(M100)).toBe(true);
    for (const f of PRIOR_MIGRATIONS) {
      expect(existsSync(f), `expected ${f}`).toBe(true);
    }
    expect(existsSync(GOAL_PATHS_ROUTE)).toBe(true);
    expect(existsSync(GOAL_PATHS_SCHEMA)).toBe(true);
  });

  test('header references Phase G OpenSpec change + date', () => {
    const sql = readFileSync(M100, 'utf-8');
    expect(sql.startsWith('--')).toBe(true);
    expect(sql).toMatch(/Migration 100/);
    expect(sql).toMatch(/2026-04-28/);
    expect(sql).toMatch(/account-id-migration-2026-04-28/);
    expect(sql).toMatch(/END MIGRATION 100/);
  });
});

describe('Phase G2: CC1 scope-narrowing — route-handler validator (not DB ASSERT)', () => {
  test('migration documents the route-handler choice', () => {
    const sql = readFileSync(M100, 'utf-8');
    expect(sql).toMatch(/§G2/);
    expect(sql).toMatch(/CC1/);
    expect(sql).toMatch(/route-handler validator/i);
    expect(sql).toMatch(/scope-narrow/i);
    expect(sql).toMatch(/parent.*reference/i);
    expect(sql).toMatch(/parent_path_signature/);
  });

  test('migration emits NO DEFINE FIELD ASSERT clause on goal_execution_paths', () => {
    // Defensive: comments are fine; an actual non-comment ASSERT line is a regression.
    const sql = readFileSync(M100, 'utf-8');
    const offending = sql.split('\n').filter((line) => {
      if (line.trim().startsWith('--')) return false;
      return /DEFINE FIELD .* ON goal_execution_paths .* ASSERT/.test(line);
    });
    expect(offending).toEqual([]);
  });

  test('GoalExecutionPath schema has no parent_id field (justifies decision)', () => {
    // If a future migration adds parent_path_signature, this test fails and
    // mig 100's "DEFERRED" note should be revisited.
    const schemaSql = readFileSync(GOAL_PATHS_SCHEMA, 'utf-8');
    expect(schemaSql).not.toMatch(/DEFINE FIELD parent_path_signature ON goal_execution_paths/);
    expect(schemaSql).not.toMatch(/DEFINE FIELD parent_goal_hash ON goal_execution_paths/);
  });

  test('route handler implements the validator (parent_path_signature branch)', () => {
    const route = readFileSync(GOAL_PATHS_ROUTE, 'utf-8');
    expect(route).toMatch(/parent_path_signature/);
    expect(route).toMatch(/CC1/);
    expect(route).toMatch(/scope-narrow/i);
    expect(route).toMatch(/400/); // subset violation
    expect(route).toMatch(/404/); // missing parent
  });
});

describe('Phase G3: variant_performance_metrics composite UNIQUE', () => {
  test('migration drops legacy index with IF EXISTS for idempotency', () => {
    const sql = readFileSync(M100, 'utf-8');
    expect(sql).toMatch(/REMOVE INDEX IF EXISTS idx_variant_performance_variant_id ON variant_performance_metrics/);
  });

  test('migration defines composite UNIQUE with OVERWRITE for idempotency', () => {
    const sql = readFileSync(M100, 'utf-8');
    expect(sql).toMatch(
      /DEFINE INDEX OVERWRITE idx_variant_performance_variant_id\s+ON variant_performance_metrics FIELDS variant_id, account_id UNIQUE/
    );
  });

  test('exactly one non-comment DEFINE INDEX for idx_variant_performance_variant_id', () => {
    const sql = readFileSync(M100, 'utf-8');
    const executable = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const matches = executable.match(/DEFINE INDEX (?:OVERWRITE )?idx_variant_performance_variant_id/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  test('no plain DEFINE INDEX (without OVERWRITE/IF NOT EXISTS) — re-run safe', () => {
    const sql = readFileSync(M100, 'utf-8');
    const plain = sql.match(/^DEFINE INDEX (?!OVERWRITE )(?!IF NOT EXISTS )idx_variant_performance_variant_id/gm);
    expect(plain).toBeNull();
  });

  test('migration references prerequisite migration 095 + Phase E rationale', () => {
    const sql = readFileSync(M100, 'utf-8');
    expect(sql).toMatch(/095/);
    expect(sql).toMatch(/Phase E/);
    expect(sql).toMatch(/account_id/);
  });

  test('legacy single-column UNIQUE in 001 (justifies replacement)', () => {
    const initSql = readFileSync(INIT_SCHEMA, 'utf-8');
    expect(initSql).toMatch(
      /DEFINE INDEX idx_variant_performance_variant_id\s+ON variant_performance_metrics FIELDS variant_id UNIQUE/
    );
    // Sanity: 001 must NOT already have the new composite — that's mig 100's job.
    expect(initSql).not.toMatch(
      /idx_variant_performance_variant_id\s+ON variant_performance_metrics FIELDS variant_id, account_id UNIQUE/
    );
  });
});
