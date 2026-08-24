/**
 * Unit tests for deriveCorrelationIdFromTags (routes/execution-traces.ts).
 *
 * Regression guard for the selection→outcome join defect (law 12). The walk
 * carries the Thompson selection's correlation id only as a `correlation:<id>`
 * tag; the trace store keyed the selection-outcome join on a top-level
 * correlation_id that was never populated, so 29,452 selections were structurally
 * unjoinable to any outcome — credit reached arms, never decisions. The ingest
 * handler now lifts the tag into body.correlation_id via this helper.
 *
 * A prior compose attempt refused a draft that referenced `correlationTag.slice`
 * on an absent binding; these tests pin the real, present-symbol implementation.
 */

import { describe, test, expect } from 'bun:test';

// execution-traces.ts pulls in the DB config at import time, which throws without
// these. Set BEFORE the import so the module can load — no connection is made:
// deriveCorrelationIdFromTags is pure. Same pattern as the reached-verdict test.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { deriveCorrelationIdFromTags } = await import('./execution-traces');

describe('deriveCorrelationIdFromTags', () => {
  test('strips the correlation: prefix from the matching tag', () => {
    expect(
      deriveCorrelationIdFromTags(['reached:true', 'correlation:sel_123_abc_4', 'operator:x']),
    ).toBe('sel_123_abc_4');
  });

  test('returns null when no correlation tag is present', () => {
    expect(deriveCorrelationIdFromTags(['reached:true', 'operator:x'])).toBeNull();
  });

  test('returns null for a non-array (missing tags)', () => {
    expect(deriveCorrelationIdFromTags(undefined)).toBeNull();
    expect(deriveCorrelationIdFromTags(null)).toBeNull();
    expect(deriveCorrelationIdFromTags('correlation:x')).toBeNull();
  });

  test('ignores non-string tag entries', () => {
    expect(
      deriveCorrelationIdFromTags([42, { correlation: 'x' }, 'correlation:sel_ok']),
    ).toBe('sel_ok');
  });

  test('takes the first correlation tag when several are present', () => {
    expect(
      deriveCorrelationIdFromTags(['correlation:first', 'correlation:second']),
    ).toBe('first');
  });

  test('an id that itself contains a colon survives (only the prefix is stripped)', () => {
    expect(deriveCorrelationIdFromTags(['correlation:sel_1787:idx_3'])).toBe('sel_1787:idx_3');
  });

  test('an empty correlation tag yields the empty string, not null', () => {
    // Distinguishes "tag present but empty" from "no tag" — the caller only
    // assigns when the result is truthy, so an empty id will not overwrite.
    expect(deriveCorrelationIdFromTags(['correlation:'])).toBe('');
  });
});
