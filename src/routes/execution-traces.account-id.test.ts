/**
 * Phase B2: account_id dual-write coverage for execution-traces.ts.
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

const executionTracesRouter = (await import('./execution-traces')).default;

function appWithAuth(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (jwtAuth !== undefined) c.set('jwtAuth' as any, jwtAuth);
    await next();
  });
  app.route('/v2/activities/execution-traces', executionTracesRouter);
  return app;
}

function appWithSession(orgId: string, accountId?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // Explicitly clear jwtAuth so hasJwtAuth() returns false and the
    // !useJwtAuth branch (with the dual-tenant retrofit) fires.
    c.set('jwtAuth' as any, null);
    c.set('session' as any, {
      session_id: 's',
      org_id: orgId,
      account_id: accountId,
      project_id: null,
      api_key: null,
      latest_job_id: null,
    });
    await next();
  });
  app.route('/v2/activities/execution-traces', executionTracesRouter);
  return app;
}

const findInsertTrace = () =>
  surrealQueries.find((q) => /INSERT\s+INTO\s+activity_execution_traces\s*\{/i.test(q.sql));
const findVariantMetricsUpsert = () =>
  surrealQueries.find((q) => /INSERT\s+INTO\s+variant_performance_metrics\b/i.test(q.sql));
const findListTraces = () =>
  surrealQueries.find(
    (q) => /SELECT\s+\*\s+FROM\s+activity_execution_traces/i.test(q.sql) && /ORDER BY/.test(q.sql),
  );
const findCtxThompsonCreate = () =>
  surrealQueries.find((q) => /context_thompson_scores/i.test(q.sql) && /CREATE/i.test(q.sql));

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

const baseTrace = (executionId: string, extra: Record<string, unknown> = {}) => ({
  execution_id: executionId,
  template_id: 'template-test-1',
  activity_id: 'template-test-1',
  status: 'completed',
  duration_ms: 123,
  cost_usd: 0.001,
  tokens: { input: 100, output: 50, cache: 0 },
  ...extra,
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
// WRITE TESTS — POST /v2/activities/execution-traces
// =============================================================================

describe('Phase B2: POST /execution-traces dual-writes account_id', () => {
  test('JWT carries accountId → INSERT and metrics UPSERT embed account_id + org_id', async () => {
    queryReturnQueue.push([{ id: 'activity_execution_traces:1' }]);
    const res = await appWithAuth(authAcct('acc-acme-001')).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-acct-1')),
      },
    );
    expect(res.status).toBeLessThan(400);

    const insert = findInsertTrace()!;
    expect(insert).toBeDefined();
    expect(insert.sql).toContain('account_id: $account_id');
    expect(insert.sql).toContain('account_id_version: $account_id_version');
    expect(insert.params.org_id).toBe('org-acme');
    expect(insert.params.account_id).toBe('acc-acme-001');
    expect(insert.params.account_id_version).toBe(1);

    const metrics = findVariantMetricsUpsert()!;
    expect(metrics).toBeDefined();
    expect(metrics.sql).toContain('account_id: $account_id');
    expect(metrics.params.account_id).toBe('acc-acme-001');
  });

  test('JWT has only orgId → INSERT writes account_id = null with version >= 1', async () => {
    queryReturnQueue.push([{ id: 'activity_execution_traces:2' }]);
    const res = await appWithAuth(authAcct(undefined)).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-legacy-1')),
      },
    );
    expect(res.status).toBeLessThan(400);
    const insert = findInsertTrace()!;
    expect(insert.params.org_id).toBe('org-legacy');
    expect(insert.params.account_id).toBeNull();
    // Even legacy callers tag rows with version=1 so backfill can identify them.
    expect(insert.params.account_id_version).toBeGreaterThanOrEqual(1);
  });

  test('body.account_id wins over JWT.accountId (mirrors body.org_id semantics)', async () => {
    queryReturnQueue.push([{ id: 'activity_execution_traces:3' }]);
    const res = await appWithAuth(authAcct('acc-from-jwt')).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-body-acct', { account_id: 'acc-from-body' })),
      },
    );
    expect(res.status).toBeLessThan(400);
    const insert = findInsertTrace()!;
    // Body-provided account_id takes precedence (matches existing org_id-from-body behaviour).
    expect(insert.params.account_id).toBe('acc-from-body');
  });
});

// =============================================================================
// READ + CONTEXT-THOMPSON TESTS
// =============================================================================

describe('Phase B2: reads + context-bucket writes dual-scope', () => {
  test('GET / (session-fed) builds dual-tenant WHERE with account_id null fallback', async () => {
    const res = await appWithSession('org-acme').request('/v2/activities/execution-traces');
    expect(res.status).toBe(200);
    const list = findListTraces()!;
    expect(list).toBeDefined();
    expect(list.sql).toContain('account_id = $account_id');
    expect(list.sql).toContain('account_id IS NONE');
    expect(list.sql).toContain('org_id = $org_id');
    expect(list.params.account_id).toBeNull();
    expect(list.params.org_id).toBe('org-acme');
  });

  test('GET / (session w/ account_id) binds session.account_id preferentially', async () => {
    // Forward-compat: when a session ever carries account_id, the handler
    // honours it via `(session as any).account_id ?? null`.
    const res = await appWithSession('org-acme', 'acc-from-session').request(
      '/v2/activities/execution-traces',
    );
    expect(res.status).toBe(200);
    const list = findListTraces()!;
    expect(list.params.account_id).toBe('acc-from-session');
    expect(list.params.org_id).toBe('org-acme');
  });

  test('legacy rows (account_id IS NONE) match via org_id branch — semantic check', async () => {
    const res = await appWithSession('org-legacy-rows').request('/v2/activities/execution-traces');
    expect(res.status).toBe(200);
    const list = findListTraces()!;
    expect(list.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
  });

  test('context_thompson_scores CREATE branch dual-writes account_id + version', async () => {
    queryReturnQueue.push([{ id: 'activity_execution_traces:ctx' }]);
    const res = await appWithAuth(authAcct('acc-acme-001')).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-ctx', { metadata: { context_bucket: 'a1b2c3d4' } })),
      },
    );
    expect(res.status).toBeLessThan(400);
    const ctx = findCtxThompsonCreate()!;
    expect(ctx).toBeDefined();
    // Read clause uses dual-tenant WHERE.
    expect(ctx.sql).toContain('account_id = $account_id');
    expect(ctx.sql).toContain('account_id IS NONE');
    // CREATE branch writes account_id and account_id_version=1.
    expect(ctx.sql).toContain('account_id: $account_id');
    expect(ctx.sql).toContain('account_id_version: 1');
    expect(ctx.params.account_id).toBe('acc-acme-001');
    expect(ctx.params.org_id).toBe('org-acme');
  });
});
