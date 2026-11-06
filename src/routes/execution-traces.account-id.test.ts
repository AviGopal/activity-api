/**
 * Phase B2: account_id dual-write coverage for execution-traces.ts.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Locks in: writes set both account_id + org_id with account_id_version=1
 * (account_id left NONE when caller has no accountId); account-scoped reads
 * coalesce so legacy rows (account_id NONE) still match within the org.
 * Mirrors activities.account-id.test.ts mock pattern.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { Hono } from 'hono';

// mock.module is process-wide: capture the real modules and restore them in afterAll.
const prevSurreal = { ...(await import('../db/surreal')) };
const prevRedis = { ...(await import('../db/redis')) };
const prevBroadcaster = { ...(await import('../websocket/broadcaster')) };
const prevParadigm = { ...(await import('../db/paradigm')) };
const prevVariantCreator = { ...(await import('../services/variant-creator')) };
afterAll(() => {
  mock.module('../db/surreal', () => prevSurreal);
  mock.module('../db/redis', () => prevRedis);
  mock.module('../websocket/broadcaster', () => prevBroadcaster);
  mock.module('../db/paradigm', () => prevParadigm);
  mock.module('../services/variant-creator', () => prevVariantCreator);
});

// `execution` (insertExecution) is the authoritative trace write; AET is the DUAL_WRITE shadow.
const executionWrites: any[] = [];
let dualWrite = false;

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
  // `redis` must be exported too: mock.module replaces the module GLOBALLY and the
  // replacement outlives this file, so a factory that omits a real export breaks every
  // later test file importing it. Measured 2026-08-17: 53 files died at import with
  // "Export named 'redis' not found" and never ran their assertions.
  get redis() { return this.RedisClient.getInstance(); },
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
  insertExecution: async (e: any) => { executionWrites.push(e); return null; },
  getActivityScores: async () => ({ data: [], path: 'legacy' as const }),
  getShapeConditionedScores: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByShapes: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByFTS: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByDense: async () => ({ data: [], path: 'legacy' as const }),
  transformToLegacyTemplate: (t: any) => t,
  isDualWriteEnabled: () => dualWrite,
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
// The listing reads `execution` directly (the v_paradigm view froze).
const findListTraces = () =>
  surrealQueries.find((q) => /FROM\s+execution\b/i.test(q.sql) && /ORDER BY/.test(q.sql));
const findExecutionWrite = () => executionWrites[0];

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
  executionWrites.length = 0;
  dualWrite = false;
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
  test('JWT carries accountId → execution, AET shadow and metrics INSERT embed account_id + org_id', async () => {
    dualWrite = true;
    const res = await appWithAuth(authAcct('acc-acme-001')).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-acct-1')),
      },
    );
    expect(res.status).toBeLessThan(400);

    const exec = findExecutionWrite();
    expect(exec).toBeDefined();
    expect(exec.org_id).toBe('org-acme');
    expect(exec.account_id).toBe('acc-acme-001');
    expect(exec.account_id_version).toBe(1);

    const insert = findInsertTrace()!;
    expect(insert).toBeDefined();
    expect(insert.sql).toContain('account_id: $account_id');
    expect(insert.sql).toContain('account_id_version: $account_id_version');
    expect(insert.params.org_id).toBe('org-acme');
    expect(insert.params.account_id).toBe('acc-acme-001');
    expect(insert.params.account_id_version).toBe(1);

    const metrics = findVariantMetricsUpsert()!;
    expect(metrics).toBeDefined();
    expect(metrics.sql).toMatch(/account_id:\s*IF \$account_id IS NULL THEN NONE ELSE \$account_id END/);
    expect(metrics.params.account_id).toBe('acc-acme-001');
  });

  test('JWT has only orgId → account_id unset (NONE, never NULL) with version >= 1 on execution', async () => {
    dualWrite = true;
    const res = await appWithAuth(authAcct(undefined)).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-legacy-1')),
      },
    );
    expect(res.status).toBeLessThan(400);
    const exec = findExecutionWrite();
    expect(exec.org_id).toBe('org-legacy');
    expect(exec.account_id ?? null).toBeNull();
    // Even legacy callers tag rows with version=1 so backfill can identify them.
    expect(exec.account_id_version).toBeGreaterThanOrEqual(1);
    // AET shadow omits the field: option<string> rejects NULL, an unbound field is NONE.
    const insert = findInsertTrace()!;
    expect(insert.params.org_id).toBe('org-legacy');
    expect(insert.sql).not.toContain('account_id: $account_id');
  });

  test('body.account_id wins over JWT.accountId (mirrors body.org_id semantics)', async () => {
    const res = await appWithAuth(authAcct('acc-from-jwt')).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-body-acct', { account_id: 'acc-from-body' })),
      },
    );
    expect(res.status).toBeLessThan(400);
    // Body-provided account_id takes precedence (matches existing org_id-from-body behaviour).
    expect(findExecutionWrite().account_id).toBe('acc-from-body');
  });
});

// =============================================================================
// READ + CONTEXT-THOMPSON TESTS
// =============================================================================

describe('Phase B2: reads + context-bucket writes dual-scope', () => {
  test('GET / (session-fed, no account) scopes by org equality alone', async () => {
    const res = await appWithSession('org-acme').request('/v2/activities/execution-traces');
    expect(res.status).toBe(200);
    const list = findListTraces()!;
    expect(list).toBeDefined();
    expect(list.sql).toContain('org_id = $org_id');
    expect(list.sql).not.toContain('$account_id');
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

  test('legacy rows (account_id NONE) still match the account scope — semantic check', async () => {
    const res = await appWithSession('org-legacy-rows', 'acc-x').request('/v2/activities/execution-traces');
    expect(res.status).toBe(200);
    const list = findListTraces()!;
    // Coalesce, not an OR: a NONE account_id compares as the caller's own, within one org equality.
    expect(list.sql).toContain('(account_id ?? $account_id) = $account_id');
    expect(list.sql).toMatch(/org_id\s*=\s*\$org_id/);
    expect(list.sql).not.toMatch(/account_id IS NONE\s+OR|OR\s+org_id\s*=\s*NULL/);
  });

  test('8-hex context_bucket write is retired: no context_thompson_scores write keyed on it', async () => {
    const res = await appWithAuth(authAcct('acc-acme-001')).request(
      '/v2/activities/execution-traces',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseTrace('exec-ctx', { metadata: { context_bucket: 'a1b2c3d4' } })),
      },
    );
    expect(res.status).toBeLessThan(400);
    const ctx = surrealQueries.filter(
      (q) => /context_thompson_scores/i.test(q.sql) && JSON.stringify(q.params ?? {}).includes('a1b2c3d4'),
    );
    expect(ctx).toHaveLength(0);
  });
});
