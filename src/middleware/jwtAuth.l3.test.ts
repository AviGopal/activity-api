/**
 * L-3 (2026-04-27): API-key auth middleware fall-through on JWT generation
 * failure.
 *
 * The bug: `validateApiKey` (jwtAuth.ts) used to return null when
 * `generateJwtToken` returned null — even though identity-vessel had already
 * confirmed the API key was valid. That made the route handler see
 * `c.get('jwtAuth') === null`, so the F-32 `requireAuthenticated()` gate at
 * the top of `POST /v2/impulses/resolve` rejected every API-key request with
 * 401 "Authentication required for destructive operations" — including
 * read-only resolves like `executionTraceList` and `activityTemplate`.
 *
 * Root cause: `generateJwtToken` returns null when `jose.SignJWT` throws,
 * which most often happens when the runtime `JWT_SECRET` env var is misaligned
 * with the canary's k8s secret (see CLAUDE.md §"JWT Secret"). F-44 stopped the
 * 500 cascade for X-Internal-Api-Key auth; F-32 relaxed the per-route gate to
 * accept empty `jwtToken`. But the upstream null-return short-circuit in
 * `validateApiKey` meant F-32's gate never saw an apikey context — `jwtAuth`
 * was null, not `{authType: 'apikey', jwtToken: ''}`.
 *
 * The L-3 fix: when `generateJwtToken` returns null but the API key was
 * authenticated by identity-vessel, propagate the context with `jwtToken: ''`
 * instead of returning null. F-32's per-route gate then fires as designed,
 * and the read-side `executeAsAuth` fallback (root-creds with explicit
 * `org_id = $orgId`) handles the SurrealDB query. Per-case destructive checks
 * still gate writes properly via `requireAuthenticated()` and SurrealDB
 * PERMISSIONS / explicit org_id predicates.
 *
 * This test exercises the middleware in isolation against mocked auth
 * dependencies, covering:
 *   1. happy path — generateJwtToken succeeds, full context propagated
 *   2. L-3 path — generateJwtToken returns null, context propagated with empty
 *      jwtToken (this is the regression we're locking in)
 *   3. invalid key — identity-vessel rejects, jwtAuth=null
 *   4. missing keyId — even when identity-vessel returns authenticated=true
 *      without keyId, we still reject (audit trail requires keyId)
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

// Stable references so individual tests can set per-test behavior on the
// mocked module without re-importing.
const validateApiKeyWithFallbackImpl = mock(async (_apiKey: string) => ({
  authenticated: false,
  reason: 'unset by test',
} as any));
const generateJwtTokenImpl = mock(async (_ctx: unknown) => null as string | null);

mock.module('../services/auth', () => ({
  validateApiKeyWithFallback: validateApiKeyWithFallbackImpl,
  generateJwtToken: generateJwtTokenImpl,
}));

mock.module('../db/surreal', () => ({
  createAuthenticatedClient: async () => ({
    query: async () => [],
    close: async () => {},
  }),
}));

const { jwtAuthMiddleware } = await import('./jwtAuth');

function appWithMiddleware(): Hono {
  const app = new Hono();
  app.use('/v2/*', async (c, next) => jwtAuthMiddleware(c, next));
  app.post('/v2/probe', (c) => c.json({ ok: true, jwtAuth: c.get('jwtAuth' as never) ?? null }));
  return app;
}

describe('L-3: API-key auth fall-through when generateJwtToken returns null', () => {
  beforeEach(() => {
    validateApiKeyWithFallbackImpl.mockReset();
    generateJwtTokenImpl.mockReset();
  });

  test('happy path: identity-vessel valid + generateJwtToken returns token → full context', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: true,
      orgId: 'org-test',
      userId: 'user-test',
      keyId: 'key-test',
      scopes: ['read', 'write'],
      authMethod: 'identity-vessel',
    }));
    generateJwtTokenImpl.mockImplementation(async () => 'eyJ.real-jwt.signature');

    const app = appWithMiddleware();
    const res = await app.request('/v2/probe', {
      method: 'POST',
      headers: { Authorization: 'ApiKey valid-key' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.jwtAuth).not.toBeNull();
    expect(body.jwtAuth.orgId).toBe('org-test');
    expect(body.jwtAuth.authType).toBe('apikey');
    expect(body.jwtAuth.jwtToken).toBe('eyJ.real-jwt.signature');
  });

  test('L-3: identity-vessel valid + generateJwtToken returns null → context with empty jwtToken (NOT null)', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: true,
      orgId: 'org-test',
      userId: 'user-test',
      keyId: 'key-test',
      scopes: ['read', 'write'],
      authMethod: 'identity-vessel',
    }));
    generateJwtTokenImpl.mockImplementation(async () => null);

    const app = appWithMiddleware();
    const res = await app.request('/v2/probe', {
      method: 'POST',
      headers: { Authorization: 'ApiKey valid-key' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // L-3 regression: must NOT be null
    expect(body.jwtAuth).not.toBeNull();
    expect(body.jwtAuth.orgId).toBe('org-test');
    expect(body.jwtAuth.authType).toBe('apikey');
    // Empty jwtToken is the canonical signal that JWT generation failed but
    // the API key is still trusted. Downstream callers should detect this
    // (authType === 'apikey' && jwtToken === '') and route via root-creds
    // (executeAsAuth fallback) rather than queryWithAuth.
    expect(body.jwtAuth.jwtToken).toBe('');
    expect(body.jwtAuth.keyId).toBe('key-test');
  });

  test('invalid key: identity-vessel rejects → jwtAuth is null', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: false,
      reason: 'API key not found',
    }));

    const app = appWithMiddleware();
    const res = await app.request('/v2/probe', {
      method: 'POST',
      headers: { Authorization: 'ApiKey invalid-key' },
    });
    // No reject-by-default in middleware for ApiKey scheme — handler runs
    // with jwtAuth=null and is responsible for its own gate.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jwtAuth).toBeNull();
  });

  test('missing keyId: identity-vessel succeeds without keyId → jwtAuth is null (audit-trail invariant)', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: true,
      orgId: 'org-test',
      userId: 'user-test',
      // keyId omitted on purpose — audit trail breaks without it
      scopes: ['read'],
      authMethod: 'identity-vessel',
    }));

    const app = appWithMiddleware();
    const res = await app.request('/v2/probe', {
      method: 'POST',
      headers: { Authorization: 'ApiKey weird-key' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // No keyId means audit trail is broken — we keep the existing strict reject.
    // (Different from L-3: missing keyId is upstream identity-vessel breakage,
    // not a JWT_SECRET drift, so falling through would silently degrade audit.)
    expect(body.jwtAuth).toBeNull();
  });
});
