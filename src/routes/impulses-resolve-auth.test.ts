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
});
