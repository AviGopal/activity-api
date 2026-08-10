/**
 * Regression pin for the `goalExecutionPath` resolve predicate.
 *
 * THE DEFECT. This handler filtered `AND org_id = $org` while every row in
 * `goal_execution_paths` is written WITHOUT tenancy — 200/200 rows sampled from
 * the live store had `org_id`, `account_id` and `project_id` ABSENT, not null.
 * A predicate demanding a field the writer never sets matches nothing, so the
 * shape resolved to `{paths: []}` for every caller and every target shape, while
 * the sibling `GET /v2/goal-paths` route (no org term) read the same rows fine.
 *
 * It was also the ONLY case block in impulses.ts hand-rolling strict scoping;
 * the other 24 scoped reads go through `accountIdScopedWhere()`, whose whole
 * purpose is tolerating legacy rows.
 *
 * WHAT THIS TEST CAN AND CANNOT SHOW. surrealDB is mocked, so this pins the
 * emitted SQL, not SurrealQL evaluation: it proves the strict predicate cannot
 * come back, and that tenanted rows are still constrained. Whether `IS NONE`
 * matches an absent column is a property of the engine, evidenced separately by
 * `accountIdScopedWhere()` relying on exactly that for `account_id`.
 *
 * Mirrors the mock pattern of impulses.account-id.test.ts.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

const surrealQueries: { sql: string; params: any }[] = [];
let queryReturnQueue: any[][] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      return queryReturnQueue.shift() ?? [];
    },
    getInstance: async () => ({}),
  },
  queryWithAuth: async (_token: string, sql: string, params: any) => {
    surrealQueries.push({ sql, params });
    return queryReturnQueue.shift() ?? [];
  },
  createAuthenticatedClient: async () => ({}),
}));

const fakeRedis = {
  del: async () => 0,
  get: async () => null,
  set: async () => 'OK',
  sadd: async () => 0,
  smembers: async () => [],
  srem: async () => 0,
  withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(),
  getClient: () => null,
};

mock.module('../db/redis', () => ({
  // The sibling test mocks only the class; this module also exports a `redis`
  // singleton, and this file's import graph reaches it. Omitting it fails at
  // import time with "Export named 'redis' not found", not at assertion time.
  redis: fakeRedis,
  RedisClient: {
    getInstance: () => ({
      del: async () => 0,
      get: async () => null,
      set: async () => 'OK',
      sadd: async () => 0,
      smembers: async () => [],
      srem: async () => 0,
      withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(),
      getClient: () => null,
    }),
  },
}));

mock.module('../websocket/broadcaster', () => ({ broadcaster: { emit: () => {} } }));

mock.module('../db/paradigm', () => ({
  insertActivity: async () => null,
  insertExecution: async () => null,
  getActivityScores: async () => ({ data: [], path: 'legacy' as const }),
  getShapeConditionedScores: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByShapes: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByFTS: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByDense: async () => ({ data: [], path: 'legacy' as const }),
  transformToLegacyTemplate: (t: any) => t,
  isDualWriteEnabled: () => false,
  getVariantFamily: async () => ({ data: [], path: 'legacy' as const }),
  getVariantScores: async () => ({ data: [], path: 'legacy' as const }),
  buildVariantTree: async () => null,
  normalizeActivityId: (id: string) =>
    id.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''),
  updateShapeActivityScores: async () => null,

  // Filled from the real module's export list, MATCHING each signature.
  // A mock missing any export fails at IMPORT time; and an `async` stub for a
  // SYNC predicate returns a truthy Promise, which flips branches invisibly.
  computeShapeSignature: (s: string[]) => s,
  getActivityShapePatterns: async () => ({ data: [], path: 'legacy' as const }),
  getParadigmReadPercentage: () => 0,
  isParadigmReadEnabled: () => false,
  logDualWriteConfig: () => undefined,
  queryActivitiesByEmbeddingDense: async () => ({ data: [], path: 'legacy' as const }),
  shouldSkipLegacyFallback: () => false,
  shouldUseParadigmRead: () => false,
  transformLegacyTemplate: (t: any) => t,
}));

mock.module('../services/variant-creator', () => ({
  autoCreateVariantIfNeeded: async () => null,
  checkAndRetireTemplate: async () => false,
}));

const impulsesRouter = (await import('./impulses')).default;

function appWithAuth(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (jwtAuth !== undefined) c.set('jwtAuth' as any, jwtAuth);
    await next();
  });
  app.route('/v2/impulses', impulsesRouter);
  return app;
}


const findGepQuery = () =>
  surrealQueries.find((q) => /FROM\s+goal_execution_paths/i.test(q.sql));

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

const auth = () => ({
  orgId: 'org-acme',
  accountId: 'acc-acme-001',
  jwtToken: '',
  authType: 'apikey' as const,
  keyId: 'k',
  scopes: ['read', 'write'],
});

const resolveGep = (pointer: Record<string, unknown>) =>
  appWithAuth(auth()).request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer: { type: 'goalExecutionPath', ...pointer } }),
  });

describe('goalExecutionPath resolve tolerates untenanted rows', () => {
  test('the strict `org_id = $org` predicate cannot come back', async () => {
    queryReturnQueue.push([]);
    await resolveGep({ shape_reference: 'shellResult' });
    const q = findGepQuery();
    expect(q).toBeDefined();
    // The exact regression: a bare equality with no IS NONE escape.
    expect(/org_id\s*=\s*\$org(?!\s*OR)/.test(q!.sql.replace(/\s+/g, ' '))).toBe(false);
    expect(q!.sql).toMatch(/org_id\s+IS\s+NONE/i);
  });

  test('rows that DO carry an org are still scoped to the caller', async () => {
    queryReturnQueue.push([]);
    await resolveGep({ shape_reference: 'shellResult' });
    const q = findGepQuery()!;
    // Isolation is preserved: the caller's org is still bound and compared.
    expect(q.sql).toMatch(/org_id\s*=\s*\$org/);
    expect(q.params.org).toBe('org-acme');
  });

  test('the target shape is still the other half of the filter', async () => {
    queryReturnQueue.push([]);
    await resolveGep({ shape_reference: 'fs_edit' });
    const q = findGepQuery()!;
    expect(q.sql).toMatch(/endpoint_output_shapes/);
    expect(q.params.shape).toBe('fs_edit');
  });

  test('an untenanted row is returned to the caller', async () => {
    // What the defect suppressed: a real row with no org_id must reach the body.
    queryReturnQueue.push([
      { goal_hash: 'g1', path_signature: 'p1', endpoint_output_shapes: ['shellResult'] },
    ]);
    const res = await resolveGep({ shape_reference: 'shellResult' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: { paths: unknown[] } };
    expect(json.body.paths).toHaveLength(1);
  });

  test('all three caller spellings of the target shape are accepted', async () => {
    for (const key of ['shape_reference', 'target_shape', 'endpoint_output_shape']) {
      surrealQueries.length = 0;
      queryReturnQueue = [[]];
      await resolveGep({ [key]: 'code_search' });
      expect(findGepQuery()!.params.shape).toBe('code_search');
    }
  });

  test('no target shape still refuses with 400 rather than querying', async () => {
    // Guards the negative control I used live: absence must be a refusal, not [].
    const res = await resolveGep({});
    expect(res.status).toBe(400);
    expect(findGepQuery()).toBeUndefined();
  });
});
