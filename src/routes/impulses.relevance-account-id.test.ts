/**
 * Phase E: account_id-aware impulse relevance.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28 (phase E).
 *
 * Locks in:
 *   - POST /v2/activities/impulse-relevance: existence-check, UPDATE, and
 *     CREATE branches all bind both $org_id and $account_id; updates only
 *     touch the row matching the caller's tenant; new rows carry both
 *     tenant fields and account_id_version=1.
 *   - GET /v2/activities/impulse-relevance: query is scoped via
 *     accountIdScopedWhere() so two callers in the same org but different
 *     accounts see distinct relevance metrics; legacy rows
 *     (account_id IS NONE) still match a same-org caller via the org_id
 *     branch.
 *   - POST /v2/impulses/resolve impulseRelevance shape: dual-tenant scope
 *     applied to the read query.
 *
 * Captures issued SurrealDB queries instead of round-tripping a live DB —
 * mirrors the activities.account-id and b3-account-id mock patterns.
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

mock.module('../websocket/broadcaster', () => ({
  broadcaster: { emit: () => {} },
}));

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

const activitiesRouter = (await import('./activities')).default;
const impulsesRouter = (await import('./impulses')).default;

function appWithAuth(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (jwtAuth !== undefined) c.set('jwtAuth' as any, jwtAuth);
    await next();
  });
  app.route('/v2/activities', activitiesRouter);
  return app;
}

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

function findCheckQuery(): { sql: string; params: any } | null {
  for (const call of surrealQueries) {
    if (
      /SELECT\s+\*\s+FROM\s+impulse_relevance_metrics\s+WHERE/.test(call.sql) &&
      /LIMIT\s+1/.test(call.sql)
    ) {
      return call;
    }
  }
  return null;
}

function findCreateQuery(): { sql: string; params: any } | null {
  for (const call of surrealQueries) {
    if (/CREATE\s+impulse_relevance_metrics\s+CONTENT/.test(call.sql)) {
      return call;
    }
  }
  return null;
}

function findUpdateQuery(): { sql: string; params: any } | null {
  for (const call of surrealQueries) {
    if (/UPDATE\s+impulse_relevance_metrics\s+SET/.test(call.sql)) {
      return call;
    }
  }
  return null;
}

function findGetQuery(): { sql: string; params: any } | null {
  for (const call of surrealQueries) {
    if (
      /SELECT\s+\*\s+FROM\s+impulse_relevance_metrics/.test(call.sql) &&
      !/LIMIT\s+1/.test(call.sql)
    ) {
      return call;
    }
  }
  return null;
}

// ============================================================================
// POST /impulse-relevance — CREATE branch (no existing row)
// ============================================================================

describe('Phase E: POST /v2/activities/impulse-relevance CREATE branch dual-writes tenant', () => {
  test('caller with accountId → CREATE embeds both account_id and org_id with version=1', async () => {
    queryReturnQueue.push([]); // existing-row check returns empty
    queryReturnQueue.push([{ id: 'impulse_relevance_metrics:new1' }]); // CREATE result

    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'k1',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse_id: 'impulse_test_1',
        activity_variant_id: 'variant_test_1',
        was_loaded: true,
        execution_succeeded: true,
        content_size_tokens: 100,
      }),
    });
    expect(res.status).toBeLessThan(400);

    const checkQuery = findCheckQuery();
    expect(checkQuery).not.toBeNull();
    // Check query carries the dual-tenant WHERE.
    expect(checkQuery!.sql).toContain('account_id = $account_id');
    expect(checkQuery!.sql).toContain('account_id IS NONE');
    expect(checkQuery!.sql).toContain('org_id = $org_id');
    expect(checkQuery!.params.account_id).toBe('acc-acme-001');
    expect(checkQuery!.params.org_id).toBe('org-acme');

    // CREATE carries account_id, org_id, account_id_version=1.
    const createQuery = findCreateQuery();
    expect(createQuery).not.toBeNull();
    expect(createQuery!.sql).toContain('org_id: $org_id');
    expect(createQuery!.sql).toContain('account_id: $account_id');
    expect(createQuery!.sql).toContain('account_id_version: 1');
    expect(createQuery!.params.account_id).toBe('acc-acme-001');
    expect(createQuery!.params.org_id).toBe('org-acme');
  });

  test('caller without accountId → CREATE embeds account_id=null and version=1', async () => {
    queryReturnQueue.push([]);
    queryReturnQueue.push([{ id: 'impulse_relevance_metrics:new2' }]);

    const app = appWithAuth({
      orgId: 'org-legacy',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'k2',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse_id: 'impulse_test_2',
        activity_variant_id: 'variant_test_2',
        was_loaded: true,
        execution_succeeded: false,
      }),
    });
    expect(res.status).toBeLessThan(400);

    const createQuery = findCreateQuery();
    expect(createQuery).not.toBeNull();
    expect(createQuery!.params.account_id).toBeNull();
    expect(createQuery!.params.org_id).toBe('org-legacy');
  });

  test('two callers in same org, different accounts → both CREATE distinct rows', async () => {
    // First caller: account A → existence check empty, CREATE.
    queryReturnQueue.push([]);
    queryReturnQueue.push([{ id: 'impulse_relevance_metrics:row_A' }]);

    const appA = appWithAuth({
      orgId: 'org-shared',
      accountId: 'acc-A',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'kA',
      scopes: ['read', 'write'],
    });
    await appA.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse_id: 'impulse_shared',
        activity_variant_id: 'variant_shared',
        was_loaded: true,
        execution_succeeded: true,
      }),
    });
    const createA = findCreateQuery();
    expect(createA!.params.account_id).toBe('acc-A');

    // Reset and run second caller: account B, same impulse + variant.
    surrealQueries.length = 0;
    queryReturnQueue.push([]);
    queryReturnQueue.push([{ id: 'impulse_relevance_metrics:row_B' }]);

    const appB = appWithAuth({
      orgId: 'org-shared',
      accountId: 'acc-B',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'kB',
      scopes: ['read', 'write'],
    });
    await appB.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse_id: 'impulse_shared',
        activity_variant_id: 'variant_shared',
        was_loaded: true,
        execution_succeeded: false,
      }),
    });
    const createB = findCreateQuery();
    expect(createB).not.toBeNull();
    expect(createB!.params.account_id).toBe('acc-B');

    // Distinct accounts mean the existence check found no row for B (because
    // the account_id branch did not match A's row), so CREATE was issued.
    // Confirm both calls had a fresh existence check followed by CREATE.
    const checkB = findCheckQuery();
    expect(checkB).not.toBeNull();
    expect(checkB!.params.account_id).toBe('acc-B');
    // Crucially, the check WHERE filters by account_id — so row_A is invisible.
    expect(checkB!.sql).toContain('account_id = $account_id');
  });
});

// ============================================================================
// POST /impulse-relevance — UPDATE branch (existing row found)
// ============================================================================

describe('Phase E: POST /v2/activities/impulse-relevance UPDATE branch is account-scoped', () => {
  test('UPDATE carries the dual-tenant WHERE so cross-account writes are isolated', async () => {
    // Existence check returns a row → handler dispatches UPDATE branch.
    queryReturnQueue.push([
      {
        impulse_id: 'impulse_test_update',
        activity_variant_id: 'variant_test_update',
        times_loaded: 1,
        times_execution_succeeded: 1,
        times_execution_failed: 0,
        times_not_loaded_succeeded: 0,
        times_not_loaded_failed: 0,
        relevance_score: 1.0,
        irrelevance_score: 0.0,
        avg_content_size_tokens: 50,
      },
    ]);
    queryReturnQueue.push([{ updated: true }]);

    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'k1',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse_id: 'impulse_test_update',
        activity_variant_id: 'variant_test_update',
        was_loaded: true,
        execution_succeeded: true,
      }),
    });
    expect(res.status).toBeLessThan(400);

    const updateQuery = findUpdateQuery();
    expect(updateQuery).not.toBeNull();
    expect(updateQuery!.sql).toContain('account_id = $account_id');
    expect(updateQuery!.sql).toContain('account_id IS NONE');
    expect(updateQuery!.sql).toContain('org_id = $org_id');
    expect(updateQuery!.params.account_id).toBe('acc-acme-001');
    expect(updateQuery!.params.org_id).toBe('org-acme');
  });
});

// ============================================================================
// GET /impulse-relevance — read scoping
// ============================================================================

describe('Phase E: GET /v2/activities/impulse-relevance dual-scopes the WHERE', () => {
  test('caller with accountId → GET WHERE includes account_id branch + org_id fallback', async () => {
    queryReturnQueue.push([]); // metrics result
    queryReturnQueue.push([{ total: 0 }]); // count result

    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'k1',
      scopes: ['read'],
    });

    const res = await app.request('/v2/activities/impulse-relevance');
    expect(res.status).toBe(200);

    const getQuery = findGetQuery();
    expect(getQuery).not.toBeNull();
    expect(getQuery!.sql).toContain('account_id = $account_id');
    expect(getQuery!.sql).toContain('account_id IS NONE');
    expect(getQuery!.sql).toContain('org_id = $org_id');
    expect(getQuery!.params.account_id).toBe('acc-acme-001');
    expect(getQuery!.params.org_id).toBe('org-acme');
  });

  test('caller with only orgId → GET still binds dual-tenant scope (account_id null)', async () => {
    queryReturnQueue.push([]);
    queryReturnQueue.push([{ total: 0 }]);

    const app = appWithAuth({
      orgId: 'org-legacy',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'k2',
      scopes: ['read'],
    });

    const res = await app.request('/v2/activities/impulse-relevance');
    expect(res.status).toBe(200);

    const getQuery = findGetQuery();
    expect(getQuery).not.toBeNull();
    // Even without accountId, the dual-tenant WHERE is present so legacy rows
    // (account_id IS NONE AND org_id = $org_id) match.
    expect(getQuery!.sql).toContain('account_id IS NONE');
    expect(getQuery!.sql).toContain('org_id = $org_id');
    expect(getQuery!.params.account_id).toBeNull();
    expect(getQuery!.params.org_id).toBe('org-legacy');
  });

  test('legacy rows (account_id IS NONE) match same-org caller via org_id branch', async () => {
    // Pre-Phase-E rows have account_id NONE; the GET WHERE disjunction
    // (account_id = $account_id) OR (account_id IS NONE AND org_id = $org_id)
    // means a caller with both accountId and orgId still sees the legacy rows
    // because the second branch matches (account_id IS NONE AND org matches).
    queryReturnQueue.push([]);
    queryReturnQueue.push([{ total: 0 }]);

    const app = appWithAuth({
      orgId: 'org-legacy-rows',
      accountId: 'acc-new-tag',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'k3',
      scopes: ['read'],
    });

    const res = await app.request('/v2/activities/impulse-relevance');
    expect(res.status).toBe(200);

    const getQuery = findGetQuery();
    expect(getQuery).not.toBeNull();
    // The disjunction is what makes legacy rows visible:
    //   (account_id = $account_id) OR (account_id IS NONE AND org_id = $org_id)
    expect(getQuery!.sql).toMatch(/account_id\s*=\s*\$account_id/);
    expect(getQuery!.sql).toMatch(/account_id\s+IS\s+NONE\s+AND\s+org_id\s*=\s*\$org_id/);
  });
});

// ============================================================================
// POST /v2/impulses/resolve impulseRelevance shape
// ============================================================================

describe('Phase E: POST /v2/impulses/resolve impulseRelevance shape is account-scoped', () => {
  test('caller with accountId binds both $org_id and $account_id on the read', async () => {
    queryReturnQueue.push([]); // relevance-data SELECT
    queryReturnQueue.push([]); // shape enrichment SELECT

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('jwtAuth' as any, {
        orgId: 'org-acme',
        accountId: 'acc-acme-001',
        jwtToken: '',
        authType: 'apikey',
        keyId: 'k1',
        scopes: ['read'],
      });
      await next();
    });
    app.route('/v2/impulses', impulsesRouter);

    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'impulseRelevance',
          activityId: 'variant_x',
          impulseShape: 'shape_y',
          limit: 10,
        },
      }),
    });
    expect(res.status).toBeLessThan(500);

    const relevanceRead = surrealQueries.find((q) =>
      /FROM\s+impulse_relevance_metrics/.test(q.sql) &&
      /relevance_score/.test(q.sql)
    );
    expect(relevanceRead).toBeDefined();
    expect(relevanceRead!.sql).toContain('account_id = $account_id');
    expect(relevanceRead!.sql).toContain('org_id = $org_id');
    expect(relevanceRead!.params.account_id).toBe('acc-acme-001');
    expect(relevanceRead!.params.org_id).toBe('org-acme');
  });
});
