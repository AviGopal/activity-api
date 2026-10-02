/**
 * getTuningParamList — after a failed read, back off instead of re-reading on every call.
 *
 * b0e70e19 made a failed read answer with the last known-good list and never cache [].
 * But it cached nothing on failure, so every caller re-read: on the hub (2026-10-02
 * 04:55-04:57Z) the failure warn fired 6 times in 2 minutes, each read holding a statement
 * for up to 5s on an already saturated store. A failure with a last-good list should serve
 * that list for the cache TTL without touching the DB; [] is still never cached.
 */
import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from 'bun:test';

let mode: 'ok' | 'fail' = 'ok';
let reads = 0;

mock.module('../db/surreal', () => ({
  surrealDB: {
    async query(_sql: string, _params: Record<string, unknown> = {}) {
      reads++;
      if (mode === 'fail') throw new Error('The query was not executed due to a failed transaction');
      return [{ param_value: 'auth_resolve_v1' }];
    },
  },
  // Stubs to satisfy mock-module-completeness.test.ts
  getDbStats: async () => ({}),
  createAuthenticatedClient: async () => ({ query: async () => [], close: () => {} }),
  queryWithAuth: async () => [],
  dbStats: async () => ({}),
}));

const { getTuningParamList, __clearTuningParamListCache, TRACE_TELEMETRY_ACTIVITIES_PARAM } = await import('./tuning-params');

describe('getTuningParamList: a failed read backs off on the last known-good list', () => {
  let now = 1_000_000;
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    mode = 'ok';
    reads = 0;
    now = 1_000_000;
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    __clearTuningParamListCache();
  });
  afterEach(() => clock.mockRestore());

  test('after a failed read with a last-good list, the next call within the TTL does not re-read', async () => {
    await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM); // good read
    now += 10 * 60_000; // past the TTL
    mode = 'fail';
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual(['auth_resolve_v1']);
    const after = reads;
    now += 1_000;
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual(['auth_resolve_v1']);
    expect(reads).toBe(after);
  });

  test('a failed read with NO last-good list is still not cached (control)', async () => {
    mode = 'fail';
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual([]);
    mode = 'ok';
    now += 1_000;
    expect(await getTuningParamList(TRACE_TELEMETRY_ACTIVITIES_PARAM)).toEqual(['auth_resolve_v1']);
  });
});
