/**
 * The retention sweep must not issue DELETEs while `REBUILD INDEX` holds the store.
 *
 * Measured on the live hub: the ceiling valve selected 25 ids, issued its DELETE and timed out at
 * 300s on EVERY cycle, deleting zero while the surplus grew 294,970 -> 295,625 -> 296,430 against
 * a 150,000 ceiling. Cause: this sweep and the FTS rebuild are both setInterval(30 min) armed at
 * the same boot, so they collide every period — two unrelated subsystems failing at the same
 * millisecond, 30 minutes apart.
 *
 * The property these tests pin is the pair, not either half: DEFER while rebuilding, and report a
 * reason the scheduler can retry on. A guard without the retry converts "DELETE times out" into
 * "sweep never runs", which is worse and would look like success in the logs.
 */

// config.ts evaluates `export const config = loadConfig()` at import time and THROWS without
// SURREALDB_NAMESPACE. Setting the env with ??= is NOT enough in a full-suite run: a sibling
// (config.account-id.test.ts) saves and RESTORES that variable to undefined, so whichever module
// triggers the first config load afterwards throws "between tests". That is precisely what the
// hub's convergence gate measures, and why this file passed in isolation while regressing the
// gate. Set it unconditionally, so no ordering between test files can reintroduce the throw.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, test, expect, mock, beforeEach } from 'bun:test';

let rebuilding = false;
const issuedSql: string[] = [];

mock.module('../jobs/fts-rebuild', () => ({
  isFtsRebuildInProgress: () => rebuilding,
  rebuildFtsIndexes: async () => {},
}));

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string) => {
      issuedSql.push(sql);
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

const { runTraceRetentionSweep, loadTraceRetentionConfig } = await import('./trace-retention');

const cfg = () => ({
  ...loadTraceRetentionConfig({
    TRACE_RETENTION_ENABLED: 'true',
    TRACE_RETENTION_DRY_RUN: 'false',
  } as NodeJS.ProcessEnv),
});

beforeEach(() => {
  rebuilding = false;
  issuedSql.length = 0;
});

describe('retention defers while an FTS rebuild holds the store', () => {
  test('skips with reason fts_rebuilding while a rebuild is in flight', async () => {
    rebuilding = true;
    const r = await runTraceRetentionSweep(cfg());
    expect(r.skipped).toBe(true);
    expect(r.skippedReason).toBe('fts_rebuilding');
  });

  test('issues NO statements at all while rebuilding — the whole point is not touching the store', async () => {
    rebuilding = true;
    await runTraceRetentionSweep(cfg());
    expect(issuedSql).toHaveLength(0);
  });

  test('the deferral is distinguishable from the in-flight skip, so the scheduler can retry only this one', async () => {
    rebuilding = true;
    const deferred = await runTraceRetentionSweep(cfg());
    expect(deferred.skippedReason).toBe('fts_rebuilding');
    expect(deferred.skippedReason).not.toBe('in_flight');
  });

  test('proceeds and touches the store once the rebuild has finished', async () => {
    rebuilding = false;
    const r = await runTraceRetentionSweep(cfg());
    expect(r.skippedReason).toBeUndefined();
    expect(issuedSql.length).toBeGreaterThan(0);
  });

  test('a rebuild that starts and finishes flips the decision both ways', async () => {
    rebuilding = true;
    expect((await runTraceRetentionSweep(cfg())).skipped).toBe(true);
    rebuilding = false;
    expect((await runTraceRetentionSweep(cfg())).skipped).toBeUndefined();
  });
});
