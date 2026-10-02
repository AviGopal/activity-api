/**
 * getTuningParamList — a failed read must never become a cached EMPTY list.
 *
 * On the hub (2026-10-02, activity-api 15c637e) the 1.5s list read of
 * TRACE_RETENTION_TELEMETRY_ACTIVITIES missed under load; the catch kept
 * `value = []`, logged at debug, and cached [] for the TTL. The retention valve
 * read that as "no telemetry declared" and silently skipped the telemetry drain,
 * falling through to an age drain over graded executions instead.
 *
 * "Unknown" is not "empty": a failed read must not be cached, and must answer
 * with the last known-good list when there is one.
 */
import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from 'bun:test';

let mode: 'ok' | 'fail' = 'ok';
let stored = 'auth_resolve_v1';

mock.module('../db/surreal', () => ({
  surrealDB: {
    async query(_sql: string, _params: Record<string, unknown> = {}) {
      if (mode === 'fail') throw new Error('The query was not executed due to a failed transaction');
      return [{ param_value: stored }];
    },
  },
  // Stubs to satisfy mock-module-completeness.test.ts
  getDbStats: async () => ({}),
  createAuthenticatedClient: async () => ({ query: async () => [], close: () => {} }),
  queryWithAuth: async () => [],
  dbStats: async () => ({}),
}));

const { getTuningParamList, __clearTuningParamListCache, TRACE_TELEMETRY_ACTIVITIES_PARAM } = await import('./tuning-params');

describe('getTuningParamList: a failed read is unknown, not empty', () => {
  let now = 1_000_000;
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    mode = 'ok';
    stored = 'auth_resolve_v1';
    now = 1_000_000;
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    __clearTuningParamListCache();
  });
  afterEach(() => clock.mockRestore());

  test('a failed read is not cached: the next successful read is observed immediately', async () => {
    mode = 'fail';
    await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM);
    mode = 'ok';
    now += 1_000; // well inside the cache TTL
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual(['auth_resolve_v1']);
  });

  test('a failed read after a known-good read answers with the last known-good list', async () => {
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual(['auth_resolve_v1']);
    now += 10 * 60_000; // past any cache TTL
    mode = 'fail';
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual(['auth_resolve_v1']);
  });

  test('a genuinely absent or empty row is still the empty list (control)', async () => {
    stored = '';
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual([]);
  });
});
