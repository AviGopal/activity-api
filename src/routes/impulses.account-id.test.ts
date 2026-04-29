/**
 * Phase B2: account_id dual-write coverage for impulses.ts.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Locks in: writes set both account_id + org_id with account_id_version=1
 * (or null + version=1 when caller has no accountId); reads dual-bind both
 * params so legacy rows (account_id IS NONE) still match via the org_id
 * branch. Mirrors activities.account-id.test.ts mock pattern.
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

mock.module('../db/redis', () => ({
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

const findInsertImpulse = () =>
  surrealQueries.find((q) => /INSERT\s+INTO\s+impulse\s*\{/i.test(q.sql));
const findListImpulses = () =>
  surrealQueries.find((q) => /SELECT\s+\*\s+FROM\s+impulse/i.test(q.sql) && /ORDER BY/.test(q.sql));
const findResolveActivity = () =>
  surrealQueries.find((q) => /SELECT\s+\*\s+FROM\s+activity\s+WHERE\s+record::id/i.test(q.sql));

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

const baseImpulse = (id: string) => ({
  impulse_id: id,
  impulse_data: {
    id,
    type: 'memo',
    pointer: { type: 'memo', content: 'x' },
    budget: 50,
  },
});

const authAcct = (accountId?: string) => ({
  orgId: accountId ? 'org-acme' : 'org-legacy',
  accountId,
  jwtToken: '',
  authType: 'apikey' as const,
  keyId: 'k',
  scopes: ['read', 'write'],
});

// =============================================================================
// WRITE TESTS — POST /v2/impulses
// =============================================================================

describe('Phase B2: POST /v2/impulses dual-writes account_id', () => {
  test('JWT carries accountId → INSERT embeds both account_id and org_id', async () => {
    queryReturnQueue.push([{ id: 'impulse:t1', shape: 'memo', created_at: '' }]);
    const res = await appWithAuth(authAcct('acc-acme-001')).request('/v2/impulses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseImpulse('t1')),
    });
    expect(res.status).toBeLessThan(400);
    const insert = findInsertImpulse()!;
    expect(insert).toBeDefined();
    // SurrealDB 3.x rejects JSON `null` against `TYPE none | string`, so the
    // INSERT wraps the bind in `IF $account_id IS NULL THEN NONE ELSE $account_id END`.
    // The literal substring `$account_id` still appears (in the THEN branch
    // and the ELSE branch); just match the wrapper instead of the bare bind.
    expect(insert.sql).toMatch(/account_id:\s+IF\s+\$account_id\s+IS\s+NULL/);
    expect(insert.sql).toContain('account_id_version: $account_id_version');
    expect(insert.params.org_id).toBe('org-acme');
    expect(insert.params.account_id).toBe('acc-acme-001');
    expect(insert.params.account_id_version).toBe(1);
  });

  test('JWT has only orgId → INSERT writes account_id = null with version = 1', async () => {
    queryReturnQueue.push([{ id: 'impulse:t2', shape: 'memo', created_at: '' }]);
    const res = await appWithAuth(authAcct(undefined)).request('/v2/impulses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseImpulse('t2')),
    });
    expect(res.status).toBeLessThan(400);
    const insert = findInsertImpulse()!;
    expect(insert.params.org_id).toBe('org-legacy');
    expect(insert.params.account_id).toBeNull();
    // account_id_version=1 even when no accountId — Phase F backfill needs
    // this to distinguish "written by Phase B" from "pre-Phase-A".
    expect(insert.params.account_id_version).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// READ TESTS — GET /v2/impulses (list + by-id) and resolve cases
// =============================================================================

describe('Phase B2: reads dual-scope impulse + activity-shape queries', () => {
  test('GET / list dual-binds account_id and org_id and includes the disjunction', async () => {
    const res = await appWithAuth(authAcct('acc-acme-001')).request('/v2/impulses');
    expect(res.status).toBe(200);
    const list = findListImpulses()!;
    expect(list).toBeDefined();
    expect(list.sql).toContain('account_id = $account_id');
    expect(list.sql).toContain('account_id IS NONE');
    expect(list.sql).toContain('org_id = $org_id');
    expect(list.params.account_id).toBe('acc-acme-001');
    expect(list.params.org_id).toBe('org-acme');
  });

  test('GET / list with no accountId still binds null + dual-scope SQL', async () => {
    const res = await appWithAuth(authAcct(undefined)).request('/v2/impulses');
    expect(res.status).toBe(200);
    const list = findListImpulses()!;
    expect(list.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(list.params.account_id).toBeNull();
    expect(list.params.org_id).toBe('org-legacy');
  });

  test('GET /:impulseId dual-binds via accountIdScopedWhere fragment', async () => {
    const res = await appWithAuth(authAcct('acc-acme-001')).request('/v2/impulses/some-id');
    expect([200, 404]).toContain(res.status);
    const get = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+impulse\s+WHERE\s+record::id/i.test(q.sql),
    )!;
    expect(get).toBeDefined();
    expect(get.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(get.params.account_id).toBe('acc-acme-001');
    expect(get.params.org_id).toBe('org-acme');
  });

  test('POST /resolve activityTemplate pointer dual-binds, preserves global+NONE visibility', async () => {
    const res = await appWithAuth(authAcct('acc-acme-001')).request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'activityTemplate', templateId: 'tmpl-1' } }),
    });
    expect([200, 404]).toContain(res.status);
    const q = findResolveActivity()!;
    expect(q).toBeDefined();
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(q.sql).toContain("scope = 'global'");
    expect(q.params.account_id).toBe('acc-acme-001');
  });

  test('POST /resolve activityExecutionTrace dual-binds on execution + legacy table', async () => {
    const res = await appWithAuth(authAcct('acc-acme-001')).request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'activityExecutionTrace', executionId: 'e1' } }),
    });
    expect([200, 404]).toContain(res.status);

    const newTbl = surrealQueries.find((q) => /SELECT\s+\*\s+FROM\s+execution\b/i.test(q.sql))!;
    expect(newTbl).toBeDefined();
    expect(newTbl.sql).toContain('account_id = $account_id');
    expect(newTbl.params.account_id).toBe('acc-acme-001');

    const legacy = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+activity_execution_traces/i.test(q.sql) &&
      /WHERE\s+execution_id/i.test(q.sql),
    )!;
    expect(legacy).toBeDefined();
    expect(legacy.sql).toContain('account_id IS NONE');
    expect(legacy.params.account_id).toBe('acc-acme-001');
  });

  test('legacy rows (account_id IS NONE) match via org_id branch — semantic check', async () => {
    // No live DB; verify SQL semantics. The disjunction guarantees a row
    // with account_id IS NONE matches when caller's $account_id is null.
    const res = await appWithAuth(authAcct(undefined)).request('/v2/impulses');
    expect(res.status).toBe(200);
    const list = findListImpulses()!;
    expect(list.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(list.params.account_id).toBeNull();
  });
});
