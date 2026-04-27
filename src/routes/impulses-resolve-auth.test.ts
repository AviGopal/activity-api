/**
 * /v2/impulses/resolve top-level auth gate (F-32, 2026-04-26)
 *
 * Locks in the F-32 fix: the top-level `requireAuthenticated` guard at the
 * head of the `/resolve` handler used to check `jwtAuth?.jwtToken`. On canary
 * with a misaligned `JWT_SECRET`, API-key auth produces a `JwtAuthContext`
 * with `authType: 'apikey'` but an *empty* `jwtToken` (because
 * `generateJwtToken` failed silently — see jwtAuth.ts:112-119). That left
 * read-only resolves like `executionTraceList` rejecting valid API-key
 * traffic with 401 "Authentication required for destructive operations" —
 * even though the same key worked fine on `/v2/activities/templates`.
 *
 * The fix: require *some* `JwtAuthContext` to be set, but do not require
 * `jwtToken` to be populated. Per-case destructive checks (already in place
 * for `_write`, `_deprecate`, `_update`, `_delete`, `templateAuditReport`)
 * still gate writes properly.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async () => [],
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

const impulsesRoutes = (await import('./impulses')).default;

function appWithAuth(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('jwtAuth', jwtAuth);
    await next();
  });
  app.route('/v2/impulses', impulsesRoutes);
  return app;
}

async function callResolve(app: Hono, pointer: Record<string, unknown>) {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /v2/impulses/resolve auth gate (F-32)', () => {
  test('rejects when jwtAuth is null (no auth context)', async () => {
    const app = appWithAuth(null);
    const { status, body } = await callResolve(app, { type: 'executionTraceList', limit: 3 });
    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Authentication required');
  });

  test('accepts API-key auth with empty jwtToken (canary JWT_SECRET fallback)', async () => {
    const app = appWithAuth({
      orgId: 'org-test',
      authType: 'apikey',
      jwtToken: '',
      keyId: 'test-key',
      scopes: ['read'],
    });
    const { status, body } = await callResolve(app, { type: 'executionTraceList', limit: 3 });
    expect(status).not.toBe(401);
    expect(body.error || '').not.toContain('Authentication required for destructive operations');
  });

  test('accepts API-key auth with populated jwtToken (healthy JWT_SECRET path)', async () => {
    const app = appWithAuth({
      orgId: 'org-test',
      authType: 'apikey',
      jwtToken: 'valid-jwt-token',
      keyId: 'test-key',
      scopes: ['read'],
    });
    const { status, body } = await callResolve(app, { type: 'executionTraceList', limit: 3 });
    expect(status).not.toBe(401);
    expect(body.error || '').not.toContain('Authentication required for destructive operations');
  });

  // -----------------------------------------------------------------------
  // L-3 (2026-04-27): regression coverage at the route level. The middleware
  // fix in jwtAuth.ts:103-130 propagates a JwtAuthContext with empty
  // `jwtToken` when generateJwtToken returns null. These tests verify that
  // the route handler honors that context for both read and write shapes.
  // -----------------------------------------------------------------------

  test('L-3: API-key with empty jwtToken accepted on read-side resolves (activityTemplate)', async () => {
    const app = appWithAuth({
      orgId: 'org-test',
      authType: 'apikey',
      jwtToken: '', // L-3: generateJwtToken returned null
      keyId: 'test-key',
      scopes: ['read'],
    });
    const { status, body } = await callResolve(app, {
      type: 'activityTemplate',
      templateId: 'hello-world-minimal',
    });
    // Whether the template exists in mocked DB or not, the auth gate must
    // not 401. (The mock returns [] so the resolver may return 404; that's
    // fine — we only care about NOT-401.)
    expect(status).not.toBe(401);
    expect(body.error || '').not.toContain('Authentication required');
  });

  test('L-3: API-key with empty jwtToken accepted on activityMetrics read', async () => {
    const app = appWithAuth({
      orgId: 'org-test',
      authType: 'apikey',
      jwtToken: '',
      keyId: 'test-key',
      scopes: ['read'],
    });
    const { status, body } = await callResolve(app, {
      type: 'activityMetrics',
      activityId: 'whatever',
    });
    expect(status).not.toBe(401);
    expect(body.error || '').not.toContain('Authentication required');
  });

  test('L-3: API-key with empty jwtToken passes route gate on destructive shape (then deeper checks gate writes)', async () => {
    // Destructive shapes (e.g. activityTemplate_deprecate) call the SAME
    // requireAuthenticated() gate at the head of their case. With L-3,
    // empty jwtToken is OK at this layer — the per-case admin/org checks
    // (downstream of requireAuthenticated) decide whether to permit the
    // write. We only assert that the gate itself doesn't reject.
    const app = appWithAuth({
      orgId: 'org-test',
      authType: 'apikey',
      jwtToken: '',
      keyId: 'test-key',
      scopes: ['write'],
    });
    const { status, body } = await callResolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'will-not-exist',
      reason: 'test',
    });
    // With mocked DB returning [] for the existence check, the handler
    // returns 404 ("Template not found") — NOT 401. That's the regression
    // we're locking in: empty jwtToken did NOT short-circuit at the gate.
    expect(status).not.toBe(401);
    expect(body.error || '').not.toContain('Authentication required for destructive operations');
  });

  test('L-3: bearer JWT auth still works on destructive shapes (audit-trail invariant)', async () => {
    const app = appWithAuth({
      orgId: 'org-test',
      authType: 'jwt',
      jwtToken: 'real-jwt',
      keyId: undefined,
      userId: 'user-test',
      scopes: ['write'],
      role: 'admin',
    });
    const { status, body } = await callResolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'will-not-exist',
      reason: 'test',
    });
    expect(status).not.toBe(401);
    expect(body.error || '').not.toContain('Authentication required for destructive operations');
  });

  test('L-3: null jwtAuth (no auth at all) still rejected at route gate', async () => {
    // Sanity: the L-3 fix only relaxes the EMPTY-jwtToken case; absent any
    // auth context whatsoever, we still reject. This covers the case where
    // identity-vessel rejects the API key (jwtAuth=null in middleware).
    const app = appWithAuth(null);
    const { status, body } = await callResolve(app, {
      type: 'activityTemplate_deprecate',
      templateId: 'whatever',
    });
    expect(status).toBe(401);
    expect(body.error || '').toContain('Authentication required');
  });
});
