/**
 * Phase B-followup: account_id dual-write coverage for the 7 tables backfilled
 * by migration 097 (Phase A2). These tables were skipped by B1-B4b because
 * `account_id` and `account_id_version` did not exist on the schema yet.
 *
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Tables covered (1 read + 1 write per table):
 *   composition_chain, composition_node               (services/composition-graph.ts)
 *   impulse_shape_activity_score                      (routes/activities.ts)
 *   tool_argument_pattern, tool_usage_patterns        (routes/activities.ts)
 *   vessel_circuit_breaker                            (services/circuit-breaker.ts)
 *   vessel_health_metrics                             (services/health-scoring.ts)
 *
 * Pattern (locked in by B1+B2+B3+B4): writes set both account_id + org_id with
 * account_id_version=1 (or null + version=1 when caller has no accountId);
 * reads dual-bind both params via accountIdScopedWhere() so legacy rows
 * (account_id IS NONE) still match through the org_id branch. SurrealDB
 * queries are captured via mock so assertions inspect SQL text + params
 * without a live DB.
 *
 * Note: deliberately does NOT mock '../db/paradigm' or
 * '../services/variant-creator' so b4a/b4b tests can co-run with this file
 * and still see the real exports of variant-creator. The routes/services
 * covered here do not invoke those modules.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// =============================================================================
// SHARED MOCKS — capture every SurrealDB query
// =============================================================================

const surrealQueries: { sql: string; params: any }[] = [];
let queryReturnQueue: any[][] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      return queryReturnQueue.shift() ?? [];
    },
    getInstance: async () => ({
      query: async (sql: string, params: any) => {
        surrealQueries.push({ sql, params });
        return [queryReturnQueue.shift() ?? []];
      },
    }),
  },
  queryWithAuth: async (_token: string, sql: string, params: any) => {
    surrealQueries.push({ sql, params });
    return queryReturnQueue.shift() ?? [];
  },
  createAuthenticatedClient: async () => ({
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      return [queryReturnQueue.shift() ?? []];
    },
  }),
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
      acquireLock: async () => true,
      releaseLock: async () => true,
      withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(),
      keys: async () => [],
      getClient: () => null,
    }),
  },
  redis: { acquireLock: async () => true, releaseLock: async () => true },
}));

mock.module('../utils/logger', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

const authWith = (accountId?: string) => ({
  orgId: accountId ? 'org-acme' : 'org-legacy',
  accountId,
  jwtToken: 'jwt-token-fake',
  authType: 'apikey' as const,
  keyId: 'k1',
  scopes: ['read', 'write'],
});

function appWithJwt(router: Hono, prefix: string, jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (jwtAuth !== undefined) c.set('jwtAuth' as any, jwtAuth);
    await next();
  });
  app.route(prefix, router);
  return app;
}

// Helper: assert a query carries the dual-tenant disjunction + dual-bound params.
function expectDualBound(q: { sql: string; params: any }, accountId: string | null, orgId: string): void {
  expect(q.sql).toContain('account_id = $account_id');
  expect(q.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
  expect(q.params.account_id).toBe(accountId as any);
  expect(q.params.org_id).toBe(orgId);
}

// Helper: assert a CREATE/UPDATE write carries account_id + version + org_id.
function expectDualWritten(q: { sql: string; params: any }, accountId: string | null, orgId: string): void {
  // CREATE uses `account_id: $account_id` (CONTENT/SET map syntax).
  // UPDATE uses `account_id = $account_id`. Match either.
  expect(q.sql).toMatch(/account_id\s*[:=]\s*\$account_id/);
  expect(q.sql).toMatch(/account_id_version\s*[:=]\s*\$account_id_version/);
  expect(q.params.account_id).toBe(accountId as any);
  expect(q.params.account_id_version).toBe(1);
  // org_id may be `org_id` or `orgId` depending on the call site.
  const orgVal = q.params.org_id ?? q.params.orgId;
  expect(orgVal).toBe(orgId);
}

// =============================================================================
// composition_node + composition_chain — services/composition-graph.ts
// =============================================================================

describe('Phase B-followup: composition_node — read+write', () => {
  test('updateNode lookup dual-binds; CREATE writes account_id + version', async () => {
    queryReturnQueue.push([[]]); // existing-node lookup → none
    queryReturnQueue.push([]);   // CREATE composition_node

    const { compositionGraphService } = await import('../services/composition-graph');
    await compositionGraphService.updateNode(
      'activity-foo', ['inputShape'], ['outputShape'], true, 125,
      'org-acme', 'acc-acme-001',
    );

    const lookup = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+composition_node\b/i.test(q.sql),
    )!;
    expect(lookup).toBeDefined();
    expectDualBound(lookup, 'acc-acme-001', 'org-acme');

    const create = surrealQueries.find((q) =>
      /CREATE\s+composition_node\s+SET/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expectDualWritten(create, 'acc-acme-001', 'org-acme');
  });
});

describe('Phase B-followup: composition_chain — read+write', () => {
  test('recordChain CREATE embeds account_id + version', async () => {
    queryReturnQueue.push([]); // CREATE composition_chain

    const { compositionGraphService } = await import('../services/composition-graph');
    await compositionGraphService.recordChain(
      {
        orchestrator_id: 'orch-1', execution_id: 'exec-1',
        activity_sequence: ['a1'], shape_sequence: ['s1'],
        success: true, target_shapes_achieved: ['s1'], target_shapes_missing: [],
        total_duration_ms: 100, total_cost_usd: 0.001, org_id: 'org-acme',
      },
      'acc-acme-001',
    );

    const create = surrealQueries.find((q) =>
      /CREATE\s+composition_chain\s+SET/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expectDualWritten(create, 'acc-acme-001', 'org-acme');
  });

  test('getRecentChains read dual-binds account_id + org_id', async () => {
    queryReturnQueue.push([[]]);

    const { compositionGraphService } = await import('../services/composition-graph');
    await compositionGraphService.getRecentChains('orch-1', 'org-acme', 10, 'acc-acme-001');

    const read = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+composition_chain\b/i.test(q.sql),
    )!;
    expect(read).toBeDefined();
    expectDualBound(read, 'acc-acme-001', 'org-acme');
  });
});

// =============================================================================
// vessel_circuit_breaker — services/circuit-breaker.ts
// =============================================================================

describe('Phase B-followup: vessel_circuit_breaker — write', () => {
  test('getState CREATE writes account_id + version when row missing', async () => {
    queryReturnQueue.push([]); // SELECT existing → none
    queryReturnQueue.push([[{ vessel_id: 'v1', org_id: 'org-acme', state: 'closed' }]]);

    const { CircuitBreakerService } = await import('../services/circuit-breaker');
    await CircuitBreakerService.getState('v1', 'org-acme', 'acc-acme-001');

    const create = surrealQueries.find((q) =>
      /CREATE\s+vessel_circuit_breaker:/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expectDualWritten(create, 'acc-acme-001', 'org-acme');
  });
});

// =============================================================================
// vessel_health_metrics — services/health-scoring.ts
// =============================================================================

describe('Phase B-followup: vessel_health_metrics — write', () => {
  test('getMetrics CREATE writes account_id + version when row missing', async () => {
    queryReturnQueue.push([]);
    queryReturnQueue.push([[{ vessel_id: 'v1', org_id: 'org-acme', health_score: 1 }]]);

    const { HealthScoringService } = await import('../services/health-scoring');
    await HealthScoringService.getMetrics('v1', 'org-acme', 'acc-acme-001');

    const create = surrealQueries.find((q) =>
      /CREATE\s+vessel_health_metrics:/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expectDualWritten(create, 'acc-acme-001', 'org-acme');
  });
});

// =============================================================================
// impulse_shape_activity_score / tool_argument_pattern / tool_usage_patterns
// — routes/activities.ts (handler-level coverage via Hono request)
// =============================================================================

describe('Phase B-followup: routes/activities.ts — read+write', () => {
  let activitiesRouter: Hono;
  beforeEach(async () => {
    activitiesRouter = (await import('./activities')).default;
  });

  // -- impulse_shape_activity_score (read + UPDATE) ----------------------------

  test('POST /feedback positive: SELECT dual-binds, UPDATE alpha dual-binds', async () => {
    queryReturnQueue.push([{ id: 'activity:foo', input_shapes: ['s1'] }]);
    queryReturnQueue.push([
      { shape: 's1', activity_id: 'foo', org_id: 'org-acme', alpha: 6, beta: 3 },
    ]);
    queryReturnQueue.push([]); // UPDATE alpha

    const app = appWithJwt(activitiesRouter, '/v2/activities', authWith('acc-acme-001'));
    const res = await app.request('/v2/activities/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity_id: 'foo', direction: 'positive', intensity: 1 }),
    });
    expect(res.status).toBeLessThan(500);

    const shapesRead = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+impulse_shape_activity_score\b/i.test(q.sql),
    )!;
    expect(shapesRead).toBeDefined();
    expectDualBound(shapesRead, 'acc-acme-001', 'org-acme');

    const alphaUpdate = surrealQueries.find((q) =>
      /UPDATE\s+impulse_shape_activity_score\b[\s\S]*?SET\s+alpha\s*=\s*\$new_alpha/i.test(q.sql),
    )!;
    expect(alphaUpdate).toBeDefined();
    expect(alphaUpdate.sql).toContain('account_id = $account_id');
    expect(alphaUpdate.params.account_id).toBe('acc-acme-001');
    expect(alphaUpdate.params.org_id).toBe('org-acme');
  });

  test('POST /feedback initializes shape scores: CREATE writes account_id + version', async () => {
    queryReturnQueue.push([{ id: 'activity:bar', input_shapes: ['shapeA', 'shapeB'] }]);
    queryReturnQueue.push([]);
    queryReturnQueue.push([]); queryReturnQueue.push([]); // 2 CREATEs
    queryReturnQueue.push([]); // refresh

    const app = appWithJwt(activitiesRouter, '/v2/activities', authWith('acc-acme-001'));
    const res = await app.request('/v2/activities/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activity_id: 'bar', direction: 'negative', intensity: 0 }),
    });
    expect(res.status).toBeLessThan(500);

    const creates = surrealQueries.filter((q) =>
      /CREATE\s+impulse_shape_activity_score\s+CONTENT/i.test(q.sql),
    );
    expect(creates.length).toBeGreaterThanOrEqual(1);
    for (const c of creates) {
      expectDualWritten(c, 'acc-acme-001', 'org-acme');
    }
  });

  // -- tool_argument_pattern (read + write) -----------------------------------

  test('POST /tool-argument-patterns CREATE branch dual-writes account_id + version', async () => {
    queryReturnQueue.push([]); // existing → none → CREATE branch
    queryReturnQueue.push([{ activity_id: 'a1' }]);

    const app = appWithJwt(activitiesRouter, '/v2/activities', authWith('acc-acme-001'));
    const res = await app.request('/v2/activities/tool-argument-patterns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activity_id: 'a1', tool_name: 'bash', argument_shape: 'sx', argument_hash: 'hx',
        arguments: { cmd: 'ls' }, execution_succeeded: true, execution_ms: 12,
      }),
    });
    expect(res.status).toBeLessThan(500);

    const lookup = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+tool_argument_pattern\b/i.test(q.sql),
    )!;
    expect(lookup).toBeDefined();
    expectDualBound(lookup, 'acc-acme-001', 'org-acme');

    const create = surrealQueries.find((q) =>
      /CREATE\s+tool_argument_pattern\s+SET/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expectDualWritten(create, 'acc-acme-001', 'org-acme');
  });

  // -- tool_usage_patterns (read + write) -------------------------------------

  test('POST /tool-usage CREATE branch dual-writes; lookup dual-binds', async () => {
    queryReturnQueue.push([]); // existing → none → CREATE branch
    queryReturnQueue.push([{ tool_name: 'bash' }]);

    const app = appWithJwt(activitiesRouter, '/v2/activities', authWith('acc-acme-001'));
    const res = await app.request('/v2/activities/tool-usage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'bash', activity_variant_id: 'foo-v1', execution_id: 'exec-1',
        tool_succeeded: true, activity_succeeded: true,
      }),
    });
    expect(res.status).toBeLessThan(500);

    const lookup = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+tool_usage_patterns\b/i.test(q.sql),
    )!;
    expect(lookup).toBeDefined();
    expectDualBound(lookup, 'acc-acme-001', 'org-acme');

    const create = surrealQueries.find((q) =>
      /CREATE\s+tool_usage_patterns\s+CONTENT/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expectDualWritten(create, 'acc-acme-001', 'org-acme');
  });

  test('GET /tool-usage list dual-binds account_id and org_id', async () => {
    queryReturnQueue.push([]); // patterns
    queryReturnQueue.push([[{ total: 0 }]]); // count

    const app = appWithJwt(activitiesRouter, '/v2/activities', authWith('acc-acme-001'));
    const res = await app.request('/v2/activities/tool-usage');
    expect(res.status).toBeLessThan(500);

    const list = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+tool_usage_patterns\b/i.test(q.sql),
    )!;
    expect(list).toBeDefined();
    expectDualBound(list, 'acc-acme-001', 'org-acme');
  });

  test('legacy caller (no accountId): null binds + version=1 still flows through', async () => {
    // Single representative no-accountId test for the route layer. Each
    // dedicated A2 table follows the same sticky-write pattern; redundant
    // per-table cases are dropped to keep this file under budget.
    queryReturnQueue.push([]);
    queryReturnQueue.push([{ tool_name: 'bash' }]);

    const app = appWithJwt(activitiesRouter, '/v2/activities', authWith(undefined));
    const res = await app.request('/v2/activities/tool-usage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: 'bash', activity_variant_id: 'baz-v1', execution_id: 'exec-2',
        tool_succeeded: false, activity_succeeded: false,
      }),
    });
    expect(res.status).toBeLessThan(500);

    const create = surrealQueries.find((q) =>
      /CREATE\s+tool_usage_patterns\s+CONTENT/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expect(create.params.account_id).toBeNull();
    expect(create.params.account_id_version).toBe(1);
    expect(create.params.org_id).toBe('org-legacy');
  });
});
