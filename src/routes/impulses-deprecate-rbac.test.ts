/**
 * /v2/impulses/resolve → activityTemplate_deprecate (and _update)
 *
 * The deprecate / update handlers used to combine the existence check and
 * the RBAC admin/org gate into a single SurrealQL WHERE clause. When the
 * caller lacked permission for an existing row, the query returned 0 rows and
 * the handler emitted `404 Template not found` — indistinguishable from "row
 * doesn't exist". This information leak caused callers to chase phantom
 * id-format issues.
 *
 * The fix splits the check: a permissionless existence query first, then an
 * application-level admin/org check. Tests below verify:
 *
 *   - Genuinely missing id → 404 "Template not found"
 *   - Existing global-scope row, non-admin caller → 403 "admin scope required"
 *   - Existing other-org row, non-admin caller → 403 "different org"
 *   - Existing same-org row → 200 success (UPDATE applied)
 *   - Existing global-scope row, admin caller → 200 success
 *
 * The SurrealDB module is replaced with a stub that intercepts queries and
 * returns canned rows. No live DB needed.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Stubbed SurrealDB module — must be registered before importing the route.
// ---------------------------------------------------------------------------

type StubHandler = (sql: string, params?: Record<string, any>) => unknown;

interface QueryRecord {
  sql: string;
  params?: Record<string, any>;
}

const queryLog: QueryRecord[] = [];
let queryHandler: StubHandler = () => [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params?: Record<string, any>) => {
      queryLog.push({ sql, params });
      return queryHandler(sql, params);
    },
  },
  queryWithAuth: async (
    _token: string,
    sql: string,
    params?: Record<string, any>,
  ) => {
    queryLog.push({ sql, params });
    return queryHandler(sql, params);
  },
  createAuthenticatedClient: async () => ({}),
}));

// Import AFTER the module mock is registered.
const impulsesRoutes = (await import('./impulses')).default;

// ---------------------------------------------------------------------------
// Test app helpers
// ---------------------------------------------------------------------------

interface StubAuthOptions {
  orgId?: string;
  isAdmin?: boolean;
}

function buildAppWithStubAuth(opts: StubAuthOptions = {}): Hono {
  const app = new Hono();
  const orgId = opts.orgId ?? 'org-test';
  const role = opts.isAdmin ? 'admin' : 'user';
  app.use('*', async (c, next) => {
    c.set('jwtAuth', {
      orgId,
      projectId: undefined,
      projectIds: undefined,
      instanceId: undefined,
      authType: 'apikey',
      jwtToken: 'stub-jwt-for-tests',
      keyId: 'test-key',
      userId: 'test-user',
      role,
      scopes: opts.isAdmin ? ['admin'] : ['read', 'write'],
    });
    await next();
  });
  app.route('/v2/impulses', impulsesRoutes);
  return app;
}

async function resolve(
  app: Hono,
  pointer: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

function resetQueryLog() {
  queryLog.length = 0;
  queryHandler = () => [];
}

/**
 * Configure the stub so the first query (the SELECT existence probe) returns
 * the given row (or null) and any subsequent queries (UPDATE, INSERT audit)
 * return an empty/echo result. This mirrors the call ordering in the handler:
 * SELECT existence → UPDATE → INSERT impulse audit.
 */
function withExistenceRow(row: Record<string, any> | null) {
  let calls = 0;
  queryHandler = (sql: string) => {
    calls += 1;
    if (calls === 1) {
      // First call: existence SELECT. Return canned row.
      return row ? [row] : [];
    }
    // Subsequent calls: UPDATE / INSERT audit. Echo back something benign.
    if (sql.includes('UPDATE')) {
      // RETURN AFTER expects a row; echo the existence row with deprecation set.
      return [{ ...(row ?? {}), deprecated: true }];
    }
    return [];
  };
}

// ---------------------------------------------------------------------------
// activityTemplate_deprecate
// ---------------------------------------------------------------------------

describe('POST /v2/impulses/resolve → activityTemplate_deprecate (404 vs 403)', () => {
  beforeEach(resetQueryLog);

  test('genuinely missing id returns 404 Template not found', async () => {
    withExistenceRow(null);
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'no-such-template',
    });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not found');
  });

  test('existing global-scope row + non-admin caller returns 403 admin-required', async () => {
    withExistenceRow({
      id: 'activity:foo',
      scope: 'global',
      org_id: 'org-other',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'foo',
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toContain('admin scope required');
    // No UPDATE should have been issued.
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('existing other-org row + non-admin caller returns 403 different-org', async () => {
    withExistenceRow({
      id: 'activity:bar',
      scope: 'org',
      org_id: 'org-other',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'bar',
    });
    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toContain('different org');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('existing same-org row returns 200 with UPDATE issued', async () => {
    withExistenceRow({
      id: 'activity:baz',
      scope: 'org',
      org_id: 'org-test',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'baz',
      reason: 'superseded',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.metadata.shape).toBe('activityTemplate_deprecate_result');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });

  test('existing global-scope row + admin caller returns 200', async () => {
    withExistenceRow({
      id: 'activity:global-foo',
      scope: 'global',
      org_id: 'org-platform',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: true });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'global-foo',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// activityTemplate_update — same anti-pattern, fixed in lockstep.
// ---------------------------------------------------------------------------

describe('POST /v2/impulses/resolve → activityTemplate_update (404 vs 403)', () => {
  beforeEach(resetQueryLog);

  test('genuinely missing id returns 404', async () => {
    withExistenceRow(null);
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'no-such',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  test('existing global-scope row + non-admin returns 403 admin-required', async () => {
    withExistenceRow({
      id: 'activity:foo',
      scope: 'global',
      org_id: 'org-other',
      name: 'orig',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'foo',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(403);
    expect(body.error).toContain('admin scope required');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(false);
  });

  test('existing other-org row + non-admin returns 403 different-org', async () => {
    withExistenceRow({
      id: 'activity:bar',
      scope: 'org',
      org_id: 'org-other',
      name: 'orig',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'bar',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(403);
    expect(body.error).toContain('different org');
  });

  test('existing same-org row returns 200', async () => {
    withExistenceRow({
      id: 'activity:baz',
      scope: 'org',
      org_id: 'org-test',
      name: 'orig',
    });
    const app = buildAppWithStubAuth({ orgId: 'org-test', isAdmin: false });
    const { status, body } = await resolve(app, {
      type: 'activityTemplate_update',
      templateId: 'baz',
      updates: { name: 'renamed' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.metadata.shape).toBe('activityTemplate_update_result');
    expect(queryLog.some((q) => q.sql.includes('UPDATE activity'))).toBe(true);
  });
});
