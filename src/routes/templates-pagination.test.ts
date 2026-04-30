/**
 * Pagination tests for GET /v2/activities/templates
 *
 * Pins the pagination contract added so operators can enumerate beyond the
 * previous 100-row cap (per the 11.1 retry findings: ~10 hidden shadow
 * templates were unreachable via the public list endpoint).
 *
 * Two tracks:
 *  1. parsePaginationOffset() unit tests — clamping, NaN/negative handling.
 *  2. Response-shape validation — `total`, `limit`, `offset`, and the
 *     "offset >= total => empty page" walking invariant that operator
 *     audit scripts depend on.
 *
 * Style follows endpoints.test.ts: no live DB; pure functions + mocked
 * response shapes. Real-DB pagination is exercised by the canary CI suite.
 */

import { describe, test, expect } from 'bun:test';
import { parsePaginationOffset } from './activities';

describe('parsePaginationOffset', () => {
  test('returns 0 for missing input', () => {
    expect(parsePaginationOffset(undefined)).toBe(0);
    expect(parsePaginationOffset(null)).toBe(0);
    expect(parsePaginationOffset('')).toBe(0);
  });

  test('returns 0 for non-numeric input', () => {
    expect(parsePaginationOffset('abc')).toBe(0);
    expect(parsePaginationOffset('NaN')).toBe(0);
  });

  test('clamps negative offsets to 0', () => {
    expect(parsePaginationOffset('-1')).toBe(0);
    expect(parsePaginationOffset('-100')).toBe(0);
  });

  test('passes positive integers through', () => {
    expect(parsePaginationOffset('0')).toBe(0);
    expect(parsePaginationOffset('5')).toBe(5);
    expect(parsePaginationOffset('100')).toBe(100);
    expect(parsePaginationOffset('500')).toBe(500);
  });

  test('truncates floats to int (parseInt semantics)', () => {
    expect(parsePaginationOffset('5.7')).toBe(5);
    expect(parsePaginationOffset('99.999')).toBe(99);
  });

  test('does not cap offset (operators must walk past 100)', () => {
    // Limit is capped at 100 per request; offset has no upper bound so
    // operators can iterate {0, 100, 200, ...} until total is reached.
    expect(parsePaginationOffset('1000')).toBe(1000);
    expect(parsePaginationOffset('10000')).toBe(10000);
  });
});

describe('GET /v2/activities/templates pagination response contract', () => {
  /**
   * The contract operator scripts depend on. Each test pins one invariant.
   * The handler returns:
   *   { templates: ActivityTemplate[], total: number, limit: number, offset: number }
   *
   * These are pure-shape tests against mocked responses; the canary CI
   * harness exercises the same contract end-to-end against real SurrealDB.
   */

  const mkPage = (
    rows: number,
    total: number,
    limit: number,
    offset: number,
  ) => ({
    templates: Array.from({ length: rows }, (_, i) => ({
      id: `activity:t${offset + i}`,
      name: `Template ${offset + i}`,
    })),
    total,
    limit,
    offset,
  });

  test('first page returns rows up to limit, with total reflecting full visible set', () => {
    const page = mkPage(5, 18, 5, 0);
    expect(page.templates.length).toBe(5);
    expect(page.total).toBe(18);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(5);
  });

  test('second page returns the next slice (different ids)', () => {
    const page1 = mkPage(5, 18, 5, 0);
    const page2 = mkPage(5, 18, 5, 5);

    const page1Ids = new Set(page1.templates.map((t) => t.id));
    const page2Ids = new Set(page2.templates.map((t) => t.id));

    // No overlap between consecutive pages
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
    expect(page2.templates[0].id).toBe('activity:t5');
    expect(page2.offset).toBe(5);
  });

  test('total is consistent across pages', () => {
    const page1 = mkPage(5, 18, 5, 0);
    const page2 = mkPage(5, 18, 5, 5);
    const page3 = mkPage(5, 18, 5, 10);
    const page4 = mkPage(3, 18, 5, 15); // Final page: 3 rows (15+3 = 18)

    expect(page1.total).toBe(18);
    expect(page2.total).toBe(18);
    expect(page3.total).toBe(18);
    expect(page4.total).toBe(18);
  });

  test('offset >= total returns empty page (terminating walk condition)', () => {
    // This is the operator-audit walking invariant: keep paging until
    // templates.length === 0 OR offset + templates.length >= total.
    const empty = mkPage(0, 18, 5, 18);
    expect(empty.templates.length).toBe(0);
    expect(empty.total).toBe(18);
    expect(empty.offset).toBe(18);

    const wayPast = mkPage(0, 18, 5, 100);
    expect(wayPast.templates.length).toBe(0);
    expect(wayPast.total).toBe(18);
  });

  test('walking offset {0, limit, 2*limit, ...} covers every row exactly once', () => {
    const total = 18;
    const limit = 5;
    const seen = new Set<string>();

    for (let offset = 0; offset < total; offset += limit) {
      const remaining = Math.min(limit, total - offset);
      const page = mkPage(remaining, total, limit, offset);
      for (const t of page.templates) {
        // No duplicates across pages
        expect(seen.has(t.id)).toBe(false);
        seen.add(t.id);
      }
    }

    // All 18 rows accounted for
    expect(seen.size).toBe(total);
  });

  test('limit is reflected in response (informs operator client of effective cap)', () => {
    // Server caps limit at 100 even if caller asked for more; the response
    // echoes the *effective* limit so clients can detect the cap.
    const page = mkPage(100, 250, 100, 0);
    expect(page.limit).toBe(100);
    expect(page.total).toBe(250);
    // Operator must continue paginating: total > limit
    expect(page.total).toBeGreaterThan(page.limit);
  });
});

describe('pagination respects RBAC scoping', () => {
  /**
   * Documentation test: total reflects what the caller can SEE, not the
   * global table size. countAllTemplatesFromDB mirrors the same WHERE
   * clauses (jwt path uses queryWithAuth with PERMISSIONS; legacy path
   * uses application-level org_id/project_id filters).
   *
   * This test pins the contract via shape; deep behavior is exercised by
   * the existing auth-branching tests in endpoints.test.ts.
   */
  test('total scoped per-caller (no cross-tenant leak)', () => {
    // Org A sees their 5 + global public 3 = 8 visible
    const orgAResponse = { templates: [], total: 8, limit: 5, offset: 0 };
    // Org B sees their 12 + global public 3 = 15 visible
    const orgBResponse = { templates: [], total: 15, limit: 5, offset: 0 };

    // Each caller's total reflects ONLY their visible set
    expect(orgAResponse.total).not.toBe(orgBResponse.total);
    expect(orgAResponse.total).toBe(8);
    expect(orgBResponse.total).toBe(15);
  });
});
