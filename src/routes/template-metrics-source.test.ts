/**
 * The templates endpoint must deliver real posteriors — it scores the substrate's
 * dominant traffic.
 *
 * THE REGRESSION THIS PINS. The metrics read was
 * `SELECT * FROM v_activity_score`, with the variant_performance_metrics fallback
 * inside a `catch`. `v_activity_score` does not exist in this database, and SurrealDB
 * reports a missing table as an EMPTY one — status OK, zero rows, no exception. The catch
 * therefore never ran: measured 2026-08-22, the string "falling back to
 * variant_performance_metrics" appears ZERO times in activity-api's entire journal. The
 * fallback was correct and unreachable.
 *
 * WHY THIS IS THE WIDEST DEFECT IN THE AUDIT. This endpoint is what boredom-vessel scores
 * the pool with, and the pool is the substrate's dominant traffic. Measured over one
 * post-deploy window: 387 executions, of which ~95% were pool ticks
 * (gap-to-scenario-bridge 113, detectors 97, validator-dispatch 68, slot-binding 14)
 * against 18 auth checks. Every template arrived with NO metrics, so boredom's
 * `metrics?.thompson_alpha ?? 1` resolved to the uniform prior for all of them.
 *
 * In the exercise path (boredom-vessel index.ts:1048) that is worse than noise: with every
 * candidate at alpha=1, `curAlpha > bestAlpha` is never true, so "pick the template with
 * the HIGHEST alpha" silently degrades to "pick the first candidate".
 *
 * What the pool was denied, measured on the three arms it actually runs:
 *
 *   validator-dispatch              alpha=151,324  beta=585,780  n=788,023  mean 0.205
 *   slot-binding                    alpha=148,976  beta=230,564  n=221,924  mean 0.393
 *   gap-to-scenario-bridge-tick     alpha=  6,030  beta=  1,949  n= 12,310  mean 0.756
 *
 * A 3.7x spread in success rate across the arms it selects between, invisible to it.
 * 2,894 of 3,425 metric rows carry a real posterior this endpoint never delivered.
 *
 * Asserted on source: the property is static (which table the query names), and this
 * repo's mock.module is global and order-dependent — a sibling test passed in isolation,
 * failed in a full-suite run, and blocked convergence twice. Same pattern as
 * execution-traces.sql-targets.test.ts and corpus-summary-source.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(import.meta.dir, 'activities.templates-db.ts'), 'utf8');
// Comment lines are stripped before matching: this fix's own comment quotes the defective
// table name to explain why it was abandoned, and matching prose instead of code is a trap
// this codebase has hit — including once, self-inflicted, in corpus-summary-source.test.ts.
const SRC = RAW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('template metrics source', () => {
  test('THE REGRESSION: metrics no longer come from the missing v_activity_score view', () => {
    expect(SRC).not.toMatch(/FROM\s+v_activity_score\b/);
  });

  test('metrics come from the surviving producer', () => {
    expect(SRC).toMatch(/FROM\s+variant_performance_metrics\b/);
  });

  test('the read is not guarded ONLY by a catch that a missing table cannot trigger', () => {
    // The defect was structural: a missing table returns OK+empty, so try/catch is the
    // wrong instrument for detecting it. An empty result must be observable at the
    // consuming side instead.
    expect(SRC).toMatch(/template_metrics_fetched/);
    expect(SRC).toMatch(/matched:\s*metricsResult\.length/);
  });

  test('it matches BOTH id columns, since callers hold either form', () => {
    // variant_performance_metrics stores bare ids in variant_id and (sometimes)
    // activity_id; the endpoint passes normalized AND original forms.
    expect(SRC).toMatch(/activity_id IN \$activity_ids OR variant_id IN \$activity_ids/);
  });

  test('a genuine query failure is surfaced, not silently degraded', () => {
    // The whole lesson: silently scoring every template on the prior is exactly the
    // failure being fixed, so a real error must be loud.
    expect(SRC).toMatch(/template_metrics_read_failed/);
  });

  test('NEGATIVE CONTROL: the pre-fix shape would fail these assertions', () => {
    const preFix = 'SELECT * FROM v_activity_score WHERE activity_id IN $activity_ids';
    expect(/FROM\s+v_activity_score\b/.test(preFix)).toBe(true);
    expect(/FROM\s+variant_performance_metrics\b/.test(preFix)).toBe(false);
    expect(/template_metrics_fetched/.test(preFix)).toBe(false);
  });

  test('NO reader in this file still selects FROM v_activity_score', () => {
    const readers = SRC.split('\n').filter((l) => /FROM\s+v_activity_score\b/.test(l));
    expect(readers).toEqual([]);
  });
});
