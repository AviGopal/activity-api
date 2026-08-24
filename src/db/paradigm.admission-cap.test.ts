/**
 * Unit tests for computeAdmissionLimit (db/paradigm.ts).
 *
 * Regression guard for the recency-prefilter defect: queryActivitiesByShapes ran
 * `ORDER BY ev DESC, created_at DESC LIMIT $limit` before the Thompson draw.
 * Because `ev` is a dead constant (its VALUE clause reads activity.thompson_alpha
 * /beta, which no writer sets — posteriors live in variant_performance_metrics),
 * that ORDER BY collapses to recency and the tight LIMIT truncated earned,
 * non-recent arms out of the pool the draw could pick from. The fix widens
 * admission so the draw — the real selector — sees a bounded superset.
 *
 * The SQL-execution path is covered by the route tests; this pins the widening
 * arithmetic, which is the load-bearing behavior.
 */

import { describe, test, expect } from 'bun:test';

// paradigm.ts pulls in the DB config at import time, which throws without these.
// Set BEFORE the import so the module can load — no connection is made:
// computeAdmissionLimit is pure. Same pattern as execution-traces.reached-verdict.test.ts.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { computeAdmissionLimit } = await import('./paradigm');

describe('computeAdmissionLimit', () => {
  test('widens the default caller limit to the admission cap', () => {
    // The defect: 50 candidates admitted, ordered by recency, before the draw.
    expect(computeAdmissionLimit(50)).toBe(1000);
  });

  test('widens the tiered-fallback limit (limit * 3) to the cap', () => {
    // getActivitiesWithTieredFallback passes limit * 3; still below the cap.
    expect(computeAdmissionLimit(150)).toBe(1000);
  });

  test('never shrinks a caller that asks for more than the cap', () => {
    expect(computeAdmissionLimit(5000)).toBe(5000);
  });

  test('a caller at exactly the cap is unchanged', () => {
    expect(computeAdmissionLimit(1000)).toBe(1000);
  });

  test('cap is overridable for callers with a different pool size', () => {
    expect(computeAdmissionLimit(10, 200)).toBe(200);
    expect(computeAdmissionLimit(500, 200)).toBe(500);
  });

  test('the widened limit is always >= the caller limit (never starves)', () => {
    for (const n of [1, 10, 49, 50, 51, 999, 1000, 1001, 10000]) {
      expect(computeAdmissionLimit(n)).toBeGreaterThanOrEqual(n);
    }
  });
});
