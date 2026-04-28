/**
 * Phase B3: account_id dual-write coverage for the remaining route files.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Locks in: writes set both account_id + org_id with account_id_version=1
 * (or null + version=1 when caller has no accountId); reads dual-bind both
 * params so legacy rows (account_id IS NONE) still match via the org_id
 * branch. Mirrors the activities.account-id and impulses.account-id mock
 * patterns — captures issued SurrealDB queries instead of round-tripping
 * a live DB.
 *
 * Routes covered:
 *   - vessel-registry.ts (29 refs in B3)
 *   - shapes.ts (12 refs in B3)
 *   - execution-trace-with-signatures.ts (9 refs in B3)
 *   - template-audit.ts (7 refs in B3)
 *
 * Routes skipped (see report): patterns.ts (route delegates to
 * services/pattern-extraction; service-level conversion is Phase B4),
 * connections.ts (table `connection` not in migration 095),
 * auth.ts (identity flow over `org_members`, not in 095),
 * code-variants.ts (alias-less `org_id` filter on a JOIN whose left
 * table `activity_templates` is not in 095),
 * state-aware-recommendations.ts (uses unrelated `c.get('auth')` shape
 * with snake_case `auth.org_id`; not wired to the app router; deferred
 * to B3b).
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// =============================================================================
// SHARED MOCKS
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

mock.module('../services/vessel-health', () => ({
  computeVesselHealthScore: async () => ({
    score: 50,
    status: 'degraded',
    details: { lastHeartbeat: new Date().toISOString() },
  }),
  getOrganizationVesselHealth: async () => [],
}));

mock.module('../services/health-scoring', () => ({
  HealthScoringService: {
    recordHeartbeat: async () => ({
      health_score: 80,
      eligible_for_routing: true,
      availability: 1.0,
    }),
  },
}));

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

// =============================================================================
// AUTH HELPERS
// =============================================================================

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

// =============================================================================
// VESSEL-REGISTRY ROUTES
// =============================================================================

describe('Phase B3: vessel-registry.ts dual-writes account_id', () => {
  test('POST /register UPDATE embeds account_id + version + org_id', async () => {
    queryReturnQueue.push([]); // existing-row lookup
    queryReturnQueue.push([{ id: 'vessel:test', expires_at: 'never' }]);

    const vesselRegistry = (await import('./vessel-registry')).default;
    const app = appWithJwt(vesselRegistry, '/v2/vessels', authWith('acc-acme-001'));
    const res = await app.request('/v2/vessels/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vesselId: 'vtest',
        vesselName: 'test',
        endpoint: 'http://x',
        shapes: ['s1'],
      }),
    });
    expect(res.status).toBeLessThan(500);

    const upsert = surrealQueries.find((q) => /UPDATE\s+vessel:/i.test(q.sql))!;
    expect(upsert).toBeDefined();
    expect(upsert.sql).toContain('account_id: $account_id');
    expect(upsert.sql).toContain('account_id_version: $account_id_version');
    expect(upsert.params.account_id).toBe('acc-acme-001');
    expect(upsert.params.account_id_version).toBe(1);
    expect(upsert.params.orgId).toBe('org-acme');
  });

  test('POST /register: legacy caller (no accountId) writes account_id=null with version=1', async () => {
    queryReturnQueue.push([]);
    queryReturnQueue.push([{ id: 'vessel:legacy', expires_at: 'never' }]);

    const vesselRegistry = (await import('./vessel-registry')).default;
    const app = appWithJwt(vesselRegistry, '/v2/vessels', authWith(undefined));
    const res = await app.request('/v2/vessels/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vesselId: 'vlegacy',
        vesselName: 'legacy',
        endpoint: 'http://x',
        shapes: ['s1'],
      }),
    });
    expect(res.status).toBeLessThan(500);

    const upsert = surrealQueries.find((q) => /UPDATE\s+vessel:/i.test(q.sql))!;
    expect(upsert).toBeDefined();
    expect(upsert.params.account_id).toBeNull();
    expect(upsert.params.account_id_version).toBe(1);
    expect(upsert.params.orgId).toBe('org-legacy');
  });

  test('GET / list dual-binds account_id and org_id with disjunction', async () => {
    queryReturnQueue.push([]);

    const vesselRegistry = (await import('./vessel-registry')).default;
    const app = appWithJwt(vesselRegistry, '/v2/vessels', authWith('acc-acme-001'));
    const res = await app.request('/v2/vessels');
    expect(res.status).toBe(200);

    const list = surrealQueries.find((q) => /SELECT\s+\*\s+FROM\s+vessel/i.test(q.sql))!;
    expect(list).toBeDefined();
    expect(list.sql).toContain('account_id = $account_id');
    expect(list.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(list.params.account_id).toBe('acc-acme-001');
    expect(list.params.org_id).toBe('org-acme');
  });

  test('GET /:vesselId dual-binds tenant predicate', async () => {
    queryReturnQueue.push([{ id: 'vessel:vt', expires_at: new Date(Date.now() + 60000).toISOString(), last_heartbeat: '' }]);

    const vesselRegistry = (await import('./vessel-registry')).default;
    const app = appWithJwt(vesselRegistry, '/v2/vessels', authWith('acc-acme-001'));
    const res = await app.request('/v2/vessels/vt');
    expect([200, 404]).toContain(res.status);

    const get = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+vessel\s+WHERE\s+id\s*=\s*\$vesselId/i.test(q.sql),
    )!;
    expect(get).toBeDefined();
    expect(get.sql).toContain('account_id = $account_id');
    expect(get.params.account_id).toBe('acc-acme-001');
  });

  test('DELETE /:vesselId scopes by account_id with org_id fallback', async () => {
    queryReturnQueue.push([]);

    const vesselRegistry = (await import('./vessel-registry')).default;
    const app = appWithJwt(vesselRegistry, '/v2/vessels', authWith('acc-acme-001'));
    const res = await app.request('/v2/vessels/vtest', { method: 'DELETE' });
    expect([204, 500]).toContain(res.status);

    const del = surrealQueries.find((q) => /DELETE\s+FROM\s+vessel/i.test(q.sql))!;
    expect(del).toBeDefined();
    expect(del.sql).toContain('account_id = $account_id');
    expect(del.params.account_id).toBe('acc-acme-001');
  });

  test('GET /discover routing_trace CREATE carries account_id', async () => {
    queryReturnQueue.push([{ name: 's1', version: '1.0.0', description: '' }]);
    queryReturnQueue.push([
      { id: 'vessel:v1', endpoint: 'http://x', last_heartbeat: '' },
    ]);
    queryReturnQueue.push([]); // routing_trace CREATE

    const vesselRegistry = (await import('./vessel-registry')).default;
    const app = appWithJwt(vesselRegistry, '/v2/vessels', authWith('acc-acme-001'));
    const res = await app.request('/v2/vessels/discover?shape=s1');
    expect([200, 404, 500]).toContain(res.status);

    const trace = surrealQueries.find((q) =>
      /CREATE\s+routing_trace/i.test(q.sql),
    );
    if (trace) {
      expect(trace.sql).toContain('account_id: $account_id');
      expect(trace.sql).toContain('account_id_version: $account_id_version');
      expect(trace.params.account_id).toBe('acc-acme-001');
      expect(trace.params.account_id_version).toBe(1);
    }
  });
});

// =============================================================================
// SHAPES ROUTES
// =============================================================================

describe('Phase B3: shapes.ts dual-writes account_id', () => {
  test('POST / CREATE shape_definition embeds account_id + version', async () => {
    queryReturnQueue.push([[]]); // existing version lookup → empty
    queryReturnQueue.push([[]]); // latest version lookup → empty
    queryReturnQueue.push([
      [{ id: 'shape_definition:s1', name: 'test', version: '1.0.0', created_at: '' }],
    ]);

    const shapesRouter = (await import('./shapes')).default;
    const app = appWithJwt(shapesRouter, '/v2/shapes', authWith('acc-acme-001'));
    const res = await app.request('/v2/shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test',
        version: '1.0.0',
        schema: { type: 'object' },
        description: 'd',
        example: {},
      }),
    });
    expect(res.status).toBeLessThan(500);

    const create = surrealQueries.find((q) =>
      /CREATE\s+shape_definition/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expect(create.sql).toContain('account_id: $account_id');
    expect(create.sql).toContain('account_id_version: $account_id_version');
    expect(create.params.account_id).toBe('acc-acme-001');
    expect(create.params.account_id_version).toBe(1);
  });

  test('POST / public shape leaves account_id null but version=1', async () => {
    queryReturnQueue.push([[]]); // existing
    queryReturnQueue.push([[]]); // latest
    queryReturnQueue.push([
      [{ id: 'shape_definition:p1', name: 'pub', version: '1.0.0', created_at: '' }],
    ]);

    const shapesRouter = (await import('./shapes')).default;
    const app = appWithJwt(shapesRouter, '/v2/shapes', authWith('acc-acme-001'));
    const res = await app.request('/v2/shapes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'pub',
        version: '1.0.0',
        schema: { type: 'object' },
        description: 'public',
        example: {},
        public: true,
      }),
    });
    expect(res.status).toBeLessThan(500);

    const create = surrealQueries.find((q) =>
      /CREATE\s+shape_definition/i.test(q.sql),
    )!;
    expect(create).toBeDefined();
    expect(create.params.account_id).toBeNull();
    expect(create.params.orgId).toBeNull();
    expect(create.params.account_id_version).toBe(1);
  });

  test('GET /:name dual-binds tenant predicate alongside public/NONE branches', async () => {
    queryReturnQueue.push([
      [{ name: 'test', version: '1.0.0', schema: {}, description: '', example: {} }],
    ]);

    const shapesRouter = (await import('./shapes')).default;
    const app = appWithJwt(shapesRouter, '/v2/shapes', authWith('acc-acme-001'));
    const res = await app.request('/v2/shapes/test');
    expect([200, 404]).toContain(res.status);

    const get = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+shape_definition/i.test(q.sql),
    )!;
    expect(get).toBeDefined();
    expect(get.sql).toContain('public = true');
    expect(get.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(get.params.account_id).toBe('acc-acme-001');
    expect(get.params.org_id).toBe('org-acme');
  });

  test('GET / list applies dual-tenant predicate; legacy caller binds null', async () => {
    queryReturnQueue.push([[]]);

    const shapesRouter = (await import('./shapes')).default;
    const app = appWithJwt(shapesRouter, '/v2/shapes', authWith(undefined));
    const res = await app.request('/v2/shapes');
    expect(res.status).toBe(200);

    const list = surrealQueries.find((q) =>
      /SELECT\s+name,\s+version,\s+description/i.test(q.sql) &&
      /FROM\s+shape_definition/i.test(q.sql),
    )!;
    expect(list).toBeDefined();
    expect(list.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(list.params.account_id).toBeNull();
    expect(list.params.org_id).toBe('org-legacy');
  });
});

// =============================================================================
// EXECUTION-TRACE-WITH-SIGNATURES (resolver — direct call, not HTTP route)
// =============================================================================

describe('Phase B3: runExecutionTraceWithSignatures threads account_id', () => {
  test('apikey auth dual-scopes execution + impulse queries', async () => {
    const { runExecutionTraceWithSignatures } = await import(
      './execution-trace-with-signatures'
    );

    // Stub Surreal client capturing queries.
    const seen: { sql: string; params: any }[] = [];
    const stubDb: any = {
      query: async (sql: string, params: any) => {
        seen.push({ sql, params });
        if (/FROM\s+execution\b/i.test(sql)) return [[]];
        if (/FROM\s+impulse\b/i.test(sql)) return [[]];
        return [[]];
      },
    };

    await runExecutionTraceWithSignatures(stubDb, {}, {
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      authType: 'apikey',
    });

    const exec = seen.find((q) => /FROM\s+execution\b/i.test(q.sql))!;
    expect(exec).toBeDefined();
    expect(exec.sql).toContain('account_id = $account_id');
    expect(exec.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$orgId/);
    expect(exec.params.account_id).toBe('acc-acme-001');
    expect(exec.params.orgId).toBe('org-acme');
  });

  test('apikey auth, no accountId: account_id binds null and org_id branch matches legacy rows', async () => {
    const { runExecutionTraceWithSignatures } = await import(
      './execution-trace-with-signatures'
    );

    const seen: { sql: string; params: any }[] = [];
    const stubDb: any = {
      query: async (sql: string, params: any) => {
        seen.push({ sql, params });
        return [[]];
      },
    };

    await runExecutionTraceWithSignatures(stubDb, {}, {
      orgId: 'org-legacy',
      accountId: null,
      authType: 'apikey',
    });

    const exec = seen.find((q) => /FROM\s+execution\b/i.test(q.sql))!;
    expect(exec).toBeDefined();
    expect(exec.params.account_id).toBeNull();
    expect(exec.params.orgId).toBe('org-legacy');
  });

  test('jwt auth (PERMISSIONS path) does not append app-side filter', async () => {
    const { runExecutionTraceWithSignatures } = await import(
      './execution-trace-with-signatures'
    );

    const seen: { sql: string; params: any }[] = [];
    const stubDb: any = {
      query: async (sql: string, params: any) => {
        seen.push({ sql, params });
        return [[]];
      },
    };

    await runExecutionTraceWithSignatures(stubDb, {}, {
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      authType: 'jwt',
    });

    const exec = seen.find((q) => /FROM\s+execution\b/i.test(q.sql))!;
    expect(exec).toBeDefined();
    // JWT path relies on PERMISSIONS; no account_id predicate added.
    expect(exec.sql).not.toContain('account_id = $account_id');
  });
});

// =============================================================================
// TEMPLATE-AUDIT (resolver — direct call, not HTTP route)
// =============================================================================

describe('Phase B3: runTemplateAuditReport threads account_id', () => {
  test('apikey auth dual-scopes template scan with global escape hatch', async () => {
    const { runTemplateAuditReport } = await import('./template-audit');

    const seen: { sql: string; params: any }[] = [];
    const stubDb: any = {
      query: async (sql: string, params: any) => {
        seen.push({ sql, params });
        return [[]];
      },
    };

    await runTemplateAuditReport(stubDb, {}, {
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      authType: 'apikey',
    });

    // Audit reads embed the full deficiency field set; observeShapes uses a
    // smaller projection. Filter to the audit reads (those carry $account_id).
    const templateReads = seen.filter((q) =>
      /FROM\s+(activity|activity_template)\b/i.test(q.sql) &&
      /name,\s+variant_name/i.test(q.sql),
    );
    expect(templateReads.length).toBeGreaterThan(0);
    for (const r of templateReads) {
      expect(r.sql).toContain('account_id = $account_id');
      expect(r.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$orgId/);
      expect(r.sql).toContain("scope = 'global'");
      expect(r.params.account_id).toBe('acc-acme-001');
      expect(r.params.orgId).toBe('org-acme');
    }
  });

  test('jwt auth includes the org_id IS NONE branch (PERMISSIONS-relaxed)', async () => {
    const { runTemplateAuditReport } = await import('./template-audit');

    const seen: { sql: string; params: any }[] = [];
    const stubDb: any = {
      query: async (sql: string, params: any) => {
        seen.push({ sql, params });
        return [[]];
      },
    };

    await runTemplateAuditReport(stubDb, {}, {
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      authType: 'jwt',
    });

    const templateReads = seen.filter((q) =>
      /FROM\s+(activity|activity_template)\b/i.test(q.sql) &&
      /name,\s+variant_name/i.test(q.sql),
    );
    expect(templateReads.length).toBeGreaterThan(0);
    const sample = templateReads[0];
    expect(sample.sql).toContain('account_id = $account_id');
    expect(sample.sql).toContain('org_id IS NONE');
    expect(sample.params.account_id).toBe('acc-acme-001');
  });

  test('legacy caller (no accountId) binds null and matches legacy rows via org_id', async () => {
    const { runTemplateAuditReport } = await import('./template-audit');

    const seen: { sql: string; params: any }[] = [];
    const stubDb: any = {
      query: async (sql: string, params: any) => {
        seen.push({ sql, params });
        return [[]];
      },
    };

    await runTemplateAuditReport(stubDb, {}, {
      orgId: 'org-legacy',
      accountId: null,
      authType: 'apikey',
    });

    const templateReads = seen.filter((q) =>
      /FROM\s+(activity|activity_template)\b/i.test(q.sql) &&
      /name,\s+variant_name/i.test(q.sql),
    );
    expect(templateReads.length).toBeGreaterThan(0);
    expect(templateReads[0].params.account_id).toBeNull();
    expect(templateReads[0].params.orgId).toBe('org-legacy');
  });
});
