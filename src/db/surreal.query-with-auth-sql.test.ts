/**
 * queryWithAuth MUST RUN THE CALLER'S SQL ON BOTH PATHS.
 *
 * The auth-session-pool branch of queryWithAuth (taken when DB_POOL_ENABLED=true) passed a
 * hard-coded `SELECT id, name, description, content, created_at, updated_at FROM template`
 * to the pooled session's db.query instead of the `sql` argument it was given. With the pool
 * on, every user-scoped query — whatever table, whatever predicate — silently returns rows
 * of `template`. The legacy (pool-off) path is the control: it forwards sql and params as
 * given, so the two paths must agree.
 *
 * No mock.module here on purpose: the pool singleton and the Surreal client prototype are
 * spied on and restored, so this file cannot amputate another file's imports (see
 * src/mock-module-completeness.test.ts) and needs no SurrealDB instance.
 *
 * WHY THE QUERY-SUFFIXED IMPORT: other test files replace '../db/surreal' via mock.module with a
 * stub queryWithAuth, and Bun's mock.module is process-wide — in the full suite a plain
 * `import { queryWithAuth } from './surreal'` binds to whichever stub registered last, so
 * both tests here failed (the control too) while the file passed alone. `./surreal.ts?real`
 * is a distinct module-registry key that no mock.module targets, so it always evaluates the
 * real source. Its own dependencies still resolve through the shared registry, which is why
 * the test reaches authSessionPool the same way queryWithAuth does (a dynamic import of
 * './auth-session-pool') and steers the branch by spying enabled() rather than trusting env.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Surreal } from 'surrealdb';

const realSurreal = (await import('./surreal.ts?real')) as typeof import('./surreal');
const { queryWithAuth } = realSurreal;
const { authSessionPool } = await import('./auth-session-pool');

// Fail loudly, and distinctly, if the real module could not be loaded — a stub here would
// make both the defect test and its control report on a function that is not under test.
function assertRealQueryWithAuth(): void {
  const src = String(queryWithAuth);
  if (!src.includes('authSessionPool') || !src.includes('createAuthenticatedClient')) {
    throw new Error(
      'CONTAMINATED: queryWithAuth under test is not the real src/db/surreal.ts implementation ' +
        '(a process-wide mock.module replaced it); this result says nothing about the pooled path',
    );
  }
}

const CALLER_SQL = 'SELECT id, status FROM execution WHERE org_id = $org AND status = $status';
const CALLER_PARAMS = { org: 'org:check-first', status: 'completed' };

type Restorable = { mockRestore: () => void };
let spies: Restorable[] = [];
let savedPoolEnv: string | undefined;

beforeEach(() => {
  savedPoolEnv = process.env.DB_POOL_ENABLED;
  spies = [];
});

afterEach(() => {
  for (const s of spies.reverse()) s.mockRestore();
  if (savedPoolEnv === undefined) delete process.env.DB_POOL_ENABLED;
  else process.env.DB_POOL_ENABLED = savedPoolEnv;
});

describe('queryWithAuth forwards the caller sql and params', () => {
  test('pool enabled: the pooled session db.query receives exactly the caller sql and params', async () => {
    assertRealQueryWithAuth();
    process.env.DB_POOL_ENABLED = 'true';
    spies.push(spyOn(authSessionPool, 'enabled').mockImplementation(() => true) as unknown as Restorable);

    const calls: Array<{ sql: unknown; params: unknown }> = [];
    const fakeDb = {
      query: async (sql: unknown, params: unknown) => {
        calls.push({ sql, params });
        return [[{ id: 'execution:1', status: 'completed' }]];
      },
    };
    let released = 0;
    spies.push(
      spyOn(authSessionPool, 'acquire').mockImplementation(async () => ({
        db: fakeDb as unknown as Surreal,
        key: 'k',
        jwtExp: Date.now() + 900_000,
      })) as unknown as Restorable,
      spyOn(authSessionPool, 'release').mockImplementation(() => {
        released++;
      }) as unknown as Restorable,
    );

    const rows = await queryWithAuth('jwt-token', CALLER_SQL, CALLER_PARAMS);

    // Positive control on the address: the pooled branch really was the one taken.
    expect(authSessionPool.acquire).toHaveBeenCalledTimes(1);
    expect(released).toBe(1);
    expect(calls.length).toBe(1);
    // THE DEFECT: the session must run the caller's query, not a fixed `FROM template` select.
    expect(calls[0]!.sql).toBe(CALLER_SQL);
    expect(calls[0]!.params).toEqual(CALLER_PARAMS);
    expect(rows).toEqual([{ id: 'execution:1', status: 'completed' }]);
  });

  test('pool disabled (control): the per-call client db.query receives exactly the caller sql and params', async () => {
    assertRealQueryWithAuth();
    process.env.DB_POOL_ENABLED = 'false';
    spies.push(spyOn(authSessionPool, 'enabled').mockImplementation(() => false) as unknown as Restorable);

    const acquireSpy = spyOn(authSessionPool, 'acquire');
    const calls: Array<{ sql: unknown; params: unknown }> = [];
    let closed = 0;
    const proto = Surreal.prototype as any;
    spies.push(
      acquireSpy as unknown as Restorable,
      spyOn(proto, 'connect').mockImplementation(async () => true) as unknown as Restorable,
      spyOn(proto, 'use').mockImplementation(async () => ({})) as unknown as Restorable,
      spyOn(proto, 'authenticate').mockImplementation(async () => ({})) as unknown as Restorable,
      spyOn(proto, 'query').mockImplementation(async (sql: unknown, params: unknown) => {
        calls.push({ sql, params });
        return [[{ id: 'execution:1', status: 'completed' }]];
      }) as unknown as Restorable,
      spyOn(proto, 'close').mockImplementation(async () => {
        closed++;
        return true;
      }) as unknown as Restorable,
    );

    const rows = await queryWithAuth('jwt-token', CALLER_SQL, CALLER_PARAMS);

    expect(acquireSpy).toHaveBeenCalledTimes(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.sql).toBe(CALLER_SQL);
    expect(calls[0]!.params).toEqual(CALLER_PARAMS);
    expect(closed).toBe(1);
    expect(rows).toEqual([{ id: 'execution:1', status: 'completed' }]);
  });
});
