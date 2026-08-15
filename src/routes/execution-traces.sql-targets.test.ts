/**
 * SQL TARGET-TABLE PINS — the check that catches corruption inside string literals.
 *
 * WHY THIS EXISTS (2026-08-15). An autonomous compose (b4f9148) mis-localised an edit
 * by ~1600 lines and rewrote a working query's target table:
 *
 *     const variantMetricsInsert = `
 *   -     INSERT INTO variant_performance_metrics {
 *   +     INSERT INTO activity_composition_graph {
 *   +       execution_id = 'derive-from-parent',   <- SET syntax inside an INSERT object literal
 *
 * That change redirects the Thompson alpha/beta posterior write path to the wrong table
 * and is syntactically invalid SurrealDB. It nonetheless landed with
 * `verdict=FAVORABLE cited_checks=["typecheck","shape-dispatch","bun test"]`.
 *
 * It passed every gate because the damage is inside a TEMPLATE LITERAL: `tsc` does not
 * parse SQL in backticks, and no test exercised that query against a database. The verify
 * stack validates the TypeScript AROUND a query and never the query itself — so any edit
 * landing inside a string is unverified. That is a general hole (every SQL statement,
 * every shell command built as a string, every prompt template), and the compose pipeline
 * edits such strings constantly.
 *
 * These are cheap structural pins, not a SQL parser. Each asserts that a named query still
 * targets the table it is named for, and that INSERT bodies use object syntax (`field:`)
 * rather than SET syntax (`field =`). A mis-localised edit that rewrites a target table or
 * splices SET assignments into an INSERT now fails `bun test` instead of landing green.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dir, 'execution-traces.ts'), 'utf8');

/** Extract a `const <name> = ` template literal body by brace-free backtick scan. */
function templateLiteralFor(constName: string): string {
  const marker = `const ${constName} = \``;
  const start = SOURCE.indexOf(marker);
  if (start < 0) return '';
  const bodyStart = start + marker.length;
  const end = SOURCE.indexOf('`', bodyStart);
  return end < 0 ? '' : SOURCE.slice(bodyStart, end);
}

describe('execution-traces SQL target tables are pinned', () => {
  test('variantMetricsInsert still writes to variant_performance_metrics', () => {
    const sql = templateLiteralFor('variantMetricsInsert');
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).toContain('INSERT INTO variant_performance_metrics');
    // The posterior write path must not be redirected to any other table.
    expect(sql).not.toContain('INSERT INTO activity_composition_graph');
  });

  test('variantMetricsInsert uses INSERT object syntax, not SET assignments', () => {
    const sql = templateLiteralFor('variantMetricsInsert');
    expect(sql.length).toBeGreaterThan(0);
    // `field = value,` inside an INSERT { ... } body is invalid SurrealDB and is the
    // signature of a SET-syntax splice from a mis-localised edit.
    const setSpliceLines = sql
      .split('\n')
      .filter((l) => /^\s*[a-z_][a-z0-9_]*\s*=\s*[^=]/i.test(l));
    expect(setSpliceLines).toEqual([]);
  });

  test('the composition-edge upsert still targets activity_composition_graph', () => {
    // Guards the reverse direction: the edge writer must not be redirected either.
    expect(SOURCE).toContain('activity_composition_graph');
    const createIdx = SOURCE.indexOf('CREATE activity_composition_graph SET');
    expect(createIdx).toBeGreaterThan(-1);
  });
});
