/**
 * Tests for Phase F account_id backfill CLI.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Coverage: parseArgs; AccountMappingCache (cache, 404, 501, network error,
 * malformed body, fallback); RateLimiter (token bucket + sleep); checkpoint
 * I/O; migrateTable (dry-run, forward write w/ version=2, skip null org_id,
 * skip 404-mapping, pagination, checkpoint cadence); rollbackTable (clears
 * version=2 only — preserves Phase B's =1); runMigration (--table filter,
 * unknown-table reject, rollback over all tables). DB stubbed via
 * mock.module (b4a pattern); no live round-trips.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const surrealResultQueue: any[][] = [];
mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async () => surrealResultQueue.shift() ?? [],
    getInstance: async () => ({}),
  },
  queryWithAuth: async () => surrealResultQueue.shift() ?? [],
  createAuthenticatedClient: async () => ({}),
}));
mock.module('../utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import {
  parseArgs, AccountMappingCache, RateLimiter,
  loadCheckpoint, writeCheckpoint, migrateTable, rollbackTable, runMigration,
  ALL_TABLES, PHASE_A_TABLES, PHASE_A2_TABLES,
  CHECKPOINT_PATH, PAGE_SIZE, RATE_LIMIT_PER_SEC,
  type CliOptions, type Checkpoint, type FetchLike, type DbLike, type TableProgress,
} from './migrate-org-to-account';

beforeEach(() => { surrealResultQueue.length = 0; });

function defaultOpts(over: Partial<CliOptions> = {}): CliOptions {
  return {
    dryRun: false, rollback: false, resume: false, table: null,
    userVesselEndpoint: 'http://uv', ...over,
  };
}
function fastLimiter(): RateLimiter {
  let now = 0;
  return new RateLimiter(1_000_000, () => now, async () => {});
}
function makeCacheReturning(map: Record<string, string | null>): AccountMappingCache {
  const fn: FetchLike = async (url: string) => {
    const orgId = decodeURIComponent(url.split('/').pop() || '');
    const v = map[orgId];
    if (v === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ account_id: v }) };
  };
  return new AccountMappingCache('http://uv', fn);
}
function makeRecordingDb(): DbLike & { calls: { sql: string; params?: any }[] } {
  const calls: { sql: string; params?: any }[] = [];
  return {
    calls,
    query: async (sql: string, params?: any) => {
      calls.push({ sql, params });
      return surrealResultQueue.shift() ?? [];
    },
  };
}
function fetchOk(body: any): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => body });
}
function fetchStatus(status: number): FetchLike {
  return async () => ({ ok: false, status, json: async () => ({}) });
}
function counter(impl: FetchLike): FetchLike & { calls: () => number } {
  let n = 0;
  const f: any = async (u: string) => { n++; return impl(u); };
  f.calls = () => n;
  return f;
}
const baseProgress: TableProgress = { processed: 0, skipped: 0, offset: 0, done: false };

describe('table constants', () => {
  // 095 file actually has 41 DEFINE FIELDs (header comment is stale at "32").
  test('counts: A=41, A2=7, ALL=48 unique', () => {
    expect(PHASE_A_TABLES.length).toBe(41);
    expect(PHASE_A2_TABLES.length).toBe(7);
    expect(ALL_TABLES.length).toBe(48);
    expect(new Set(ALL_TABLES).size).toBe(48);
  });
});

describe('parseArgs', () => {
  test('defaults conservative', () => {
    const o = parseArgs([]);
    expect(o.dryRun).toBe(false);
    expect(o.rollback).toBe(false);
    expect(o.resume).toBe(false);
    expect(o.table).toBeNull();
    expect(o.userVesselEndpoint.length).toBeGreaterThan(0);
  });
  test('flags set', () => {
    const o = parseArgs(['--dry-run', '--resume', '--rollback']);
    expect(o.dryRun).toBe(true);
    expect(o.resume).toBe(true);
    expect(o.rollback).toBe(true);
  });
  test('--table requires value', () => {
    expect(parseArgs(['--table', 'activity']).table).toBe('activity');
    expect(() => parseArgs(['--table'])).toThrow();
    expect(() => parseArgs(['--table', '--dry-run'])).toThrow();
  });
  test('--user-vessel sets endpoint', () => {
    expect(parseArgs(['--user-vessel', 'http://x:1']).userVesselEndpoint).toBe('http://x:1');
    expect(() => parseArgs(['--user-vessel'])).toThrow();
  });
  test('unknown flags ignored', () => {
    expect(parseArgs(['--unknown', '--dry-run']).dryRun).toBe(true);
  });
});

describe('AccountMappingCache', () => {
  test('cache hit avoids second HTTP call', async () => {
    const fn = counter(fetchOk({ account_id: 'accounts:abc' }));
    const cache = new AccountMappingCache('http://uv', fn);
    expect(await cache.lookup('organizations:abc')).toBe('accounts:abc');
    expect(await cache.lookup('organizations:abc')).toBe('accounts:abc');
    expect(await cache.lookup('organizations:abc')).toBe('accounts:abc');
    expect(fn.calls()).toBe(1);
    expect(cache.size()).toBe(1);
  });
  test('per-org 404 → null, cached', async () => {
    const fn = counter(fetchStatus(404));
    const cache = new AccountMappingCache('http://uv', fn);
    expect(await cache.lookup('organizations:m')).toBeNull();
    expect(await cache.lookup('organizations:m')).toBeNull();
    expect(fn.calls()).toBe(1);
    expect(cache.isDegraded()).toBe(false);
  });
  test('501 → degrade + fallback (one HTTP call total)', async () => {
    const fn = counter(fetchStatus(501));
    const cache = new AccountMappingCache('http://uv', fn);
    expect(await cache.lookup('organizations:foo')).toBe('accounts:foo');
    expect(await cache.lookup('organizations:bar')).toBe('accounts:bar');
    expect(fn.calls()).toBe(1);
    expect(cache.isDegraded()).toBe(true);
  });
  test('network error → degrade + fallback', async () => {
    const fn: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
    const cache = new AccountMappingCache('http://uv', fn);
    expect(await cache.lookup('organizations:net')).toBe('accounts:net');
    expect(cache.isDegraded()).toBe(true);
    expect(await cache.lookup('organizations:net2')).toBe('accounts:net2');
  });
  test('malformed body → null', async () => {
    expect(await new AccountMappingCache('http://uv', fetchOk({ wrong: 'oops' })).lookup('organizations:b')).toBeNull();
  });
  test('reads body.id when account_id absent', async () => {
    expect(await new AccountMappingCache('http://uv', fetchOk({ id: 'accounts:from-id' })).lookup('organizations:x')).toBe('accounts:from-id');
  });
  test('normalizes bare id by prefixing', async () => {
    expect(await new AccountMappingCache('http://uv', fetchOk({ account_id: 'bare-id' })).lookup('organizations:y')).toBe('accounts:bare-id');
  });
  test('500 throws', async () => {
    await expect(new AccountMappingCache('http://uv', fetchStatus(500)).lookup('organizations:e')).rejects.toThrow(/HTTP 500/);
  });
  test('fallback handles bare org id', async () => {
    const cache = new AccountMappingCache('http://uv', async () => { throw new Error('down'); });
    await cache.lookup('organizations:once');
    expect(await cache.lookup('plain-id')).toBe('accounts:plain-id');
  });
});

describe('RateLimiter', () => {
  test('default rate is 100/sec', () => { expect(RATE_LIMIT_PER_SEC).toBe(100); });
  test('grants up to opsPerSec without sleeping', async () => {
    let now = 0, slept = 0;
    const rl = new RateLimiter(10, () => now, async (ms) => { slept += ms; });
    for (let i = 0; i < 10; i++) await rl.acquire();
    expect(slept).toBe(0);
  });
  test('sleeps when bucket empty', async () => {
    let now = 0, sleptCalls = 0;
    const rl = new RateLimiter(10, () => now, async (ms) => { sleptCalls++; now += ms; });
    for (let i = 0; i < 10; i++) await rl.acquire();
    await rl.acquire();
    expect(sleptCalls).toBeGreaterThan(0);
  });
  test('refills proportionally over time', async () => {
    let now = 0, slept = 0;
    const rl = new RateLimiter(100, () => now, async (ms) => { slept += ms; now += ms; });
    for (let i = 0; i < 100; i++) await rl.acquire();
    now += 500;
    const before = slept;
    for (let i = 0; i < 50; i++) await rl.acquire();
    expect(slept).toBe(before);
  });
});

describe('checkpoint I/O', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mig-acct-')); });
  test('default path', () => {
    expect(CHECKPOINT_PATH).toBe('/tmp/migrate-account-id.checkpoint.json');
  });
  test('round-trips', () => {
    const file = join(dir, 'cp.json');
    const cp: Checkpoint = {
      activity: { processed: 50, skipped: 2, offset: 0, done: false },
      execution: { processed: 100, skipped: 0, offset: 0, done: true },
    };
    writeCheckpoint(cp, file);
    expect(loadCheckpoint(file)).toEqual(cp);
    rmSync(dir, { recursive: true, force: true });
  });
  test('missing file → empty', () => {
    expect(loadCheckpoint(join(dir, 'no.json'))).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
  test('garbage file → empty (non-fatal)', () => {
    const file = join(dir, 'g.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(loadCheckpoint(file)).toEqual({});
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('migrateTable', () => {
  test('dry-run counts but does not write', async () => {
    const db = makeRecordingDb();
    surrealResultQueue.push([
      { id: 'activity:r1', org_id: 'organizations:o1' },
      { id: 'activity:r2', org_id: 'organizations:o1' },
    ]);
    const result = await migrateTable(
      'activity', makeCacheReturning({ 'organizations:o1': 'accounts:o1' }),
      fastLimiter(), db, defaultOpts({ dryRun: true }), baseProgress, () => {});
    expect(result.processed).toBe(2);
    expect(result.done).toBe(true);
    expect(db.calls.filter((c) => c.sql.startsWith('UPDATE')).length).toBe(0);
  });

  test('forward write sets account_id_version=2', async () => {
    const db = makeRecordingDb();
    surrealResultQueue.push([{ id: 'execution:e1', org_id: 'organizations:tA' }]);
    const result = await migrateTable(
      'execution', makeCacheReturning({ 'organizations:tA': 'accounts:tA' }),
      fastLimiter(), db, defaultOpts(), baseProgress, () => {});
    expect(result.processed).toBe(1);
    const updates = db.calls.filter((c) => c.sql.startsWith('UPDATE'));
    expect(updates.length).toBe(1);
    expect(updates[0]?.sql).toContain('account_id = $aid');
    expect(updates[0]?.sql).toContain('account_id_version = 2');
    expect(updates[0]?.params).toEqual({ id: 'execution:e1', aid: 'accounts:tA' });
  });

  test('null/empty org_id rows skipped', async () => {
    const db = makeRecordingDb();
    surrealResultQueue.push([
      { id: 'activity:r1', org_id: null },
      { id: 'activity:r2', org_id: '' },
      { id: 'activity:r3', org_id: 'organizations:ok' },
    ]);
    const result = await migrateTable('activity',
      makeCacheReturning({ 'organizations:ok': 'accounts:ok' }),
      fastLimiter(), db, defaultOpts(), baseProgress, () => {});
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(2);
  });

  test('rows with no mapping skipped (per-org 404)', async () => {
    const db = makeRecordingDb();
    surrealResultQueue.push([{ id: 'activity:r1', org_id: 'organizations:unknown' }]);
    const result = await migrateTable(
      'activity', new AccountMappingCache('http://uv', fetchStatus(404)),
      fastLimiter(), db, defaultOpts(), baseProgress, () => {});
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(db.calls.filter((c) => c.sql.startsWith('UPDATE')).length).toBe(0);
  });

  test('SELECT uses LIMIT 500 with offset=skipped', async () => {
    const db = makeRecordingDb();
    surrealResultQueue.push([]);
    await migrateTable('pattern', makeCacheReturning({}), fastLimiter(), db,
      defaultOpts(), { processed: 0, skipped: 5, offset: 5, done: false }, () => {});
    expect(db.calls[0]?.sql).toContain(`LIMIT ${PAGE_SIZE}`);
    expect(db.calls[0]?.sql).toContain('START $offset');
    expect(db.calls[0]?.params).toEqual({ offset: 5 });
  });

  test('checkpoint callback fires every 100 rows', async () => {
    const db = makeRecordingDb();
    const rows = Array.from({ length: 250 }, (_, i) => ({
      id: `activity:r${i}`, org_id: 'organizations:o',
    }));
    surrealResultQueue.push(rows);
    const ckpts: TableProgress[] = [];
    await migrateTable('activity',
      makeCacheReturning({ 'organizations:o': 'accounts:o' }),
      fastLimiter(), db, defaultOpts(), baseProgress,
      (p) => { ckpts.push({ ...p }); });
    const counts = ckpts.map((c) => c.processed);
    expect(counts).toContain(100);
    expect(counts).toContain(200);
  });
});

describe('rollbackTable', () => {
  test('dry-run runs SELECT count() only', async () => {
    surrealResultQueue.push([{ count: 42 }]);
    const db = makeRecordingDb();
    const result = await rollbackTable('activity', fastLimiter(), db,
      defaultOpts({ dryRun: true, rollback: true }));
    expect(result.cleared).toBe(42);
    expect(db.calls[0]?.sql).toContain('SELECT count()');
    expect(db.calls.find((c) => c.sql.startsWith('UPDATE'))).toBeUndefined();
  });
  test('UPDATE clears version=2 only — preserves Phase B (=1) writes', async () => {
    surrealResultQueue.push([{ id: 'activity:r1' }, { id: 'activity:r2' }]);
    const db = makeRecordingDb();
    const result = await rollbackTable('activity', fastLimiter(), db,
      defaultOpts({ rollback: true }));
    expect(result.cleared).toBe(2);
    expect(db.calls[0]?.sql).toContain('UPDATE activity SET account_id = NONE');
    expect(db.calls[0]?.sql).toContain('account_id_version = 0');
    expect(db.calls[0]?.sql).toContain('WHERE account_id_version = 2');
    expect(db.calls[0]?.sql).not.toContain('account_id_version = 1');
  });
});

describe('runMigration', () => {
  function tableSpyDb(seen: string[]): DbLike {
    return {
      query: async (sql: string) => {
        const m = sql.match(/FROM (\w+)/);
        if (m && m[1]) seen.push(m[1]);
        return surrealResultQueue.shift() ?? [];
      },
    };
  }
  const okFetch: FetchLike = fetchOk({});

  test('--table filter scopes the run', async () => {
    surrealResultQueue.push([]);
    const seen: string[] = [];
    await runMigration(defaultOpts({ dryRun: true, table: 'activity' }), tableSpyDb(seen), okFetch);
    expect(seen).toEqual(['activity']);
  });
  test('rejects unknown table', async () => {
    await expect(
      runMigration(defaultOpts({ dryRun: true, table: 'nope' }),
        { query: async () => [] }, okFetch),
    ).rejects.toThrow(/Unknown table/);
  });
  test('rollback iterates all 48 tables when no filter', async () => {
    for (let i = 0; i < ALL_TABLES.length; i++) surrealResultQueue.push([{ count: 0 }]);
    const seen: string[] = [];
    await runMigration(defaultOpts({ dryRun: true, rollback: true }), tableSpyDb(seen), okFetch);
    expect(seen.length).toBe(48);
    expect(new Set(seen).size).toBe(48);
  });
});
