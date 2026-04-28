/**
 * Phase B1: account_id dual-write coverage for activities.ts.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Locks in: writes set both account_id + org_id with account_id_version=1
 * (or null + version=1 when caller has no accountId); reads dual-bind both
 * params so legacy rows (account_id IS NONE) still match via the org_id
 * branch. Mirrors activities-template-id-normalize.test.ts mock pattern —
 * captures issued SurrealDB queries instead of round-tripping a live DB.
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';

// Capture every SurrealDB query the handler issues so the assertions can
// inspect both the SQL text and the parameter binds.
const surrealQueries: { sql: string; params: any }[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      // Return [] for SELECT-style queries (existing rows lookup) and the
      // execution-record activity lookup. Specific tests that need a "row
      // exists" outcome push pre-canned responses through resetCaptures.
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

// Stub Redis so cache invalidation in POST /templates does not block on a
// missing local Redis.
mock.module('../db/redis', () => ({
  RedisClient: {
    getInstance: () => ({
      del: async () => 0,
      get: async () => null,
      set: async () => 'OK',
      sadd: async () => 0,
      smembers: async () => [],
      srem: async () => 0,
      withLock: async (_lockKey: unknown, _cacheKey: unknown, fn: () => Promise<unknown>) => fn(),
      getClient: () => null,
    }),
  },
}));

// Stub the broadcaster (POST /executions emits a WebSocket event).
mock.module('../websocket/broadcaster', () => ({
  broadcaster: { emit: () => {} },
}));

// Stub paradigm dual-write so it doesn't touch SurrealDB indirectly.
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
}));

// Stub variant-creator (auto-variant detection on failures).
mock.module('../services/variant-creator', () => ({
  autoCreateVariantIfNeeded: async () => null,
  checkAndRetireTemplate: async () => false,
}));

const activitiesRouter = (await import('./activities')).default;

function appWithAuth(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (jwtAuth !== undefined) c.set('jwtAuth' as any, jwtAuth);
    await next();
  });
  app.route('/v2/activities', activitiesRouter);
  return app;
}

const baseTemplate = {
  name: 'Test Template',
  description: 'Phase B1 fixture',
  category: 'tool',
  tasks: [{ id: 't1', description: 'one', prompt: { template: 'do thing' } }],
  scope: 'global' as const,
  public: false,
  output_shapes: ['tool_output'],
};

function findActivityUpsert(): { sql: string; params: any } | null {
  for (const call of surrealQueries) {
    if (/UPSERT\s+activity:`[^`]+`\s+CONTENT/.test(call.sql)) return call;
  }
  return null;
}

function findVariantMetricsUpsert(): { sql: string; params: any } | null {
  for (const call of surrealQueries) {
    if (
      /UPSERT\s+variant_performance_metrics:`[^`]+`\s+CONTENT/.test(call.sql) ||
      /INSERT\s+INTO\s+variant_performance_metrics/.test(call.sql)
    ) {
      return call;
    }
  }
  return null;
}

function reset(): void {
  surrealQueries.length = 0;
}

// ============================================================================
// WRITE TESTS
// ============================================================================

describe('Phase B1: POST /v2/activities/templates writes account_id', () => {
  test('JWT carries accountId → write embeds both account_id and org_id', async () => {
    reset();
    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-1',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: 'phase-b1-account-write' }),
    });
    expect(res.status).toBeLessThan(400);

    const upsert = findActivityUpsert();
    expect(upsert).not.toBeNull();
    expect(upsert!.params.org_id).toBe('org-acme');
    expect(upsert!.params.account_id).toBe('acc-acme-001');
    expect(upsert!.params.account_id_version).toBe(1);
    // SQL must contain account_id binding (built via dynamic field list).
    expect(upsert!.sql).toContain('account_id');
    expect(upsert!.sql).toContain('account_id_version');

    // Sibling metrics row: account_id is also propagated (record-ref form).
    const metrics = findVariantMetricsUpsert();
    expect(metrics).not.toBeNull();
    expect(metrics!.params.account_id).toBe('accounts:acc-acme-001');
  });

  test('JWT has only orgId (no accountId) → write succeeds with account_id = null', async () => {
    reset();
    const app = appWithAuth({
      orgId: 'org-legacy',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-2',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: 'phase-b1-legacy-write' }),
    });
    expect(res.status).toBeLessThan(400);

    const upsert = findActivityUpsert();
    expect(upsert).not.toBeNull();
    // org_id still flows from auth; account_id is null (option<string> accepts null).
    expect(upsert!.params.org_id).toBe('org-legacy');
    expect(upsert!.params.account_id).toBeNull();
    // account_id_version still flips to 1 — we tagged this row even without an
    // accountId, so Phase F backfill can distinguish it.
    expect(upsert!.params.account_id_version).toBe(1);
  });

  test('account_id_version >= 1 marker on dual-written rows', async () => {
    reset();
    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-002',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-3',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: 'phase-b1-version-marker' }),
    });
    expect(res.status).toBeLessThan(400);

    const upsert = findActivityUpsert();
    expect(upsert).not.toBeNull();
    expect(upsert!.params.account_id_version).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// READ TESTS
// ============================================================================

describe('Phase B1: GET /v2/activities/executions reads dual-scope', () => {
  test('caller with accountId binds both $account_id and $org_id, falls back to org_id branch', async () => {
    reset();
    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-1',
      scopes: ['read'],
    });

    const res = await app.request('/v2/activities/executions');
    expect(res.status).toBe(200);

    // The list query must include the dual-scope WHERE fragment so a legacy
    // row (account_id IS NONE) still matches via org_id.
    const listQuery = surrealQueries.find((q) => /FROM execution\b/.test(q.sql));
    expect(listQuery).toBeDefined();
    expect(listQuery!.sql).toContain('account_id = $account_id');
    expect(listQuery!.sql).toContain('account_id IS NONE');
    expect(listQuery!.sql).toContain('org_id = $org_id');
    // Both bind params present.
    expect(listQuery!.params.account_id).toBe('acc-acme-001');
    expect(listQuery!.params.org_id).toBe('org-acme');
  });

  test('caller with only orgId still issues dual-scope query, account_id bound as null', async () => {
    reset();
    const app = appWithAuth({
      orgId: 'org-legacy',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-2',
      scopes: ['read'],
    });

    const res = await app.request('/v2/activities/executions');
    expect(res.status).toBe(200);

    const listQuery = surrealQueries.find((q) => /FROM execution\b/.test(q.sql));
    expect(listQuery).toBeDefined();
    // Same SQL fragment regardless of account_id presence.
    expect(listQuery!.sql).toContain('account_id IS NONE');
    expect(listQuery!.sql).toContain('org_id = $org_id');
    // account_id bound as null — query gracefully matches only the org_id branch.
    expect(listQuery!.params.account_id).toBeNull();
    expect(listQuery!.params.org_id).toBe('org-legacy');
  });

  test('legacy rows (account_id IS NONE in DB) match via org_id branch', async () => {
    // No live DB; verify the SQL semantics: WHERE clause disjoins on
    // `account_id IS NONE AND org_id = $org_id`, and the caller binds
    // $account_id = null. Together these guarantee a legacy row matches.
    reset();
    const app = appWithAuth({
      orgId: 'org-legacy-rows',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-legacy',
      scopes: ['read'],
    });

    const res = await app.request('/v2/activities/executions');
    expect(res.status).toBe(200);

    const listQuery = surrealQueries.find((q) => /FROM execution\b/.test(q.sql));
    expect(listQuery).toBeDefined();
    // The disjunction must include the account_id IS NONE arm with org_id match.
    expect(listQuery!.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
  });
});
