/**
 * corpus-summary must read a table that exists.
 *
 * THE REGRESSION THIS PINS. `GET /v2/activities/corpus-summary` selected
 * `FROM v_activity_score`. That view is absent from the database, and SurrealDB treats a
 * missing table as an empty one — `status: OK`, zero rows, no error. So the endpoint
 * returned a healthy 200 with every count at 0 and avg_belief at its 0.5 default, and had
 * been doing so silently since the view was dropped.
 *
 * Measured 2026-08-22 against the live database:
 *
 *   SELECT count() FROM v_activity_score                  -> 0        (missing table)
 *   the replacement query FROM variant_performance_metrics -> 3,275 activities,
 *                                                            1,560,649 executions,
 *                                                            637,961 successes,
 *                                                            avg_belief 0.435
 *
 * WHY NOT JUST RE-CREATE THE VIEW. It was a live aggregate `FROM execution` — the hot
 * trace table — and migration 165 removed its sibling `v_activity_score_enhanced` for
 * precisely that reason ("a dead write-amplifying aggregate over the hot execution
 * table"). Restoring it would reintroduce write amplification on the busiest table in the
 * system to serve one reporting endpoint. Its own header also declared it a replacement
 * for `variant_performance_metrics` — the table that actually won, and the one every
 * other reader already uses.
 *
 * It also could not have come back on its own: it is defined with IF NOT EXISTS in a
 * schema file that `init_migrations` records as applied, and `init-database.ts` skips any
 * recorded filename. Same stranded-view class migration 174 fixed for seven siblings.
 *
 * Asserted on source rather than by mocking. This repo's `mock.module` is global and
 * order-dependent — a sibling test in this codebase passed in isolation and failed in a
 * full-suite run for exactly that reason, and blocked convergence twice. The property
 * here is static (which table the query names), so a static check is the honest
 * instrument. Same pattern as execution-traces.sql-targets.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(import.meta.dir, 'activities.ts'), 'utf8');

/**
 * Source with `//` comment lines removed.
 *
 * NECESSARY, not tidiness: the fix's own explanatory comment quotes the defective
 * `FROM v_activity_score` to say why it was abandoned, so a naive match finds the
 * PROSE and reports the defect as live. That is the same "a comment describing a
 * defect was written by whoever fixed it" trap this codebase has hit before — here
 * self-inflicted, and caught by this test failing on correct code.
 */
const SOURCE = RAW.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The corpus-summary handler body, isolated from the rest of the (very large) file. */
function corpusSummaryBlock(): string {
  const start = SOURCE.indexOf("GET /v2/activities/corpus-summary");
  expect(start).toBeGreaterThan(-1);
  // The handler ends at the next route registration.
  const end = SOURCE.indexOf("app.get('/:id/variants'", start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('corpus-summary data source', () => {
  test('THE REGRESSION: it no longer aggregates from the missing v_activity_score view', () => {
    expect(corpusSummaryBlock()).not.toMatch(/FROM\s+v_activity_score\b/);
  });

  test('it reads the surviving producer instead', () => {
    expect(corpusSummaryBlock()).toMatch(/FROM\s+variant_performance_metrics\b/);
  });

  test('it binds BOTH org_id forms, like every other reader of that table', () => {
    // variant_performance_metrics stores org_id prefixed on 3,275 rows and plain on 19.
    // Binding one form is what made the posterior lookup match zero rows.
    const block = corpusSummaryBlock();
    const orgParams = new Set([...block.matchAll(/org_id\s*=\s*\$(\w+)/g)].map((m) => m[1]));
    expect(orgParams.size).toBeGreaterThanOrEqual(2);
  });

  test('NEGATIVE CONTROL: the pre-fix shape would fail these assertions', () => {
    // Proves the checks discriminate rather than passing on any query text.
    const preFix = 'FROM v_activity_score WHERE org_id = $org_id';
    expect(/FROM\s+v_activity_score\b/.test(preFix)).toBe(true);
    expect(/FROM\s+variant_performance_metrics\b/.test(preFix)).toBe(false);
    const orgParams = new Set([...preFix.matchAll(/org_id\s*=\s*\$(\w+)/g)].map((m) => m[1]));
    expect(orgParams.size).toBe(1);
  });

  test('NO reader anywhere still selects FROM v_activity_score', () => {
    // The whole point: a missing table is indistinguishable from an empty one, so any
    // remaining reader would report zeros forever without erroring.
    const readers = SOURCE.split('\n').filter((l) => /FROM\s+v_activity_score\b/.test(l));
    expect(readers).toEqual([]);
  });
});
