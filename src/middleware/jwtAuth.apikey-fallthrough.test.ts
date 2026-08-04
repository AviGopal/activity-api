/**
 * API-key auth middleware fall-through on JWT generation failure.
 *
 * The bug: `validateApiKey` (jwtAuth.ts) used to return null when
 * `generateJwtToken` returned null — even though identity-vessel had already
 * confirmed the API key was valid. That made the route handler see
 * `c.get('jwtAuth') === null`, so the `requireAuthenticated()` gate at the top
 * of `POST /v2/impulses/resolve` rejected every API-key request with 401
 * "Authentication required for destructive operations" — including read-only
 * resolves like `executionTraceList` and `activityTemplate`.
 *
 * Root cause: `generateJwtToken` returns null when `jose.SignJWT` throws,
 * which most often happens when the runtime `JWT_SECRET` env var is misaligned
 * with the canary's k8s secret (see CLAUDE.md §"JWT Secret"). The
 * context-finalization fix stopped the 500 cascade for X-Internal-Api-Key
 * auth; the per-route gate was relaxed to accept empty `jwtToken`. But the
 * upstream null-return short-circuit in `validateApiKey` meant the gate never
 * saw an apikey context — `jwtAuth` was null, not
 * `{authType: 'apikey', jwtToken: ''}`.
 *
 * The fix: when `generateJwtToken` returns null but the API key was
 * authenticated by identity-vessel, propagate the context with `jwtToken: ''`
 * instead of returning null. The per-route gate then fires as designed, and
 * the read-side `executeAsAuth` fallback (root-creds with explicit
 * `org_id = $orgId`) handles the SurrealDB query. Per-case destructive checks
 * still gate writes properly via `requireAuthenticated()` and SurrealDB
 * PERMISSIONS / explicit org_id predicates.
 *
 * This test exercises the middleware in isolation against mocked auth
 * dependencies, covering:
 *   1. happy path — generateJwtToken succeeds, full context propagated
 *   2. fall-through path — generateJwtToken returns null, context propagated
 *      with empty jwtToken (this is the regression we're locking in)
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
const { _resetAuthKeyCache } = await import('./auth-cache');

function appWithMiddleware(): Hono {
  const app = new Hono();
  app.use('/v2/*', async (c, next) => jwtAuthMiddleware(c, next));
  app.post('/v2/probe', (c) => c.json({ ok: true, jwtAuth: c.get('jwtAuth' as never) ?? null }));
  return app;
}

describe('API-key auth fall-through when generateJwtToken returns null', () => {
  beforeEach(() => {
    validateApiKeyWithFallbackImpl.mockReset();
    generateJwtTokenImpl.mockReset();
    // The 30s-TTL apiKey result cache (auth-cache.ts) would otherwise
    // return the previous test's result for the same key.
    _resetAuthKeyCache();
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

  test('identity-vessel valid + generateJwtToken returns null → context with empty jwtToken (NOT null)', async () => {
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
    // Regression: must NOT be null
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
    // FAIL CLOSED. This previously asserted 200 — the middleware admitted a
    // rejected key and left the handler "responsible for its own gate", which
    // activities.ts never implemented (0 requireAuthenticated across 57 routes).
    // The assertion was locking in the vulnerability, so it is inverted here
    // deliberately rather than because the test became inconvenient.
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_API_KEY');
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
    // Missing keyId breaks the audit trail, so validateApiKey returns null and the
    // request is now rejected outright instead of proceeding un-auditable.
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_API_KEY');
  });
});

describe('fail-closed admission (regression guards for the auth fall-through)', () => {
  beforeEach(() => {
    _resetAuthKeyCache();
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: false,
      reason: 'should never be consulted for these cases',
    }));
  });

  function appWithPaths(): Hono {
    const app = new Hono();
    app.use('/v2/*', async (c, next) => jwtAuthMiddleware(c, next));
    const probe = (c: any) => c.json({ ok: true, jwtAuth: c.get('jwtAuth') ?? null });
    app.post('/v2/impulses', probe);
    app.post('/v2/events/publish', probe);
    app.post('/v2/activities/execution-traces', probe);
    app.get('/v2/activities/templates', probe);
    return app;
  }

  // The three paths the fleet genuinely calls with X-Internal-Api-Key. If any of
  // these starts 401ing, gap-write events (development-vessel substrate-gap.ts)
  // or auth traces (identity-vessel trace.ts) stop flowing fleet-wide.
  for (const path of ['/v2/impulses', '/v2/events/publish', '/v2/activities/execution-traces']) {
    test(`X-Internal-Api-Key is still admitted on ${path}`, async () => {
      const res = await appWithPaths().request(path, {
        method: 'POST',
        headers: { 'X-Internal-Api-Key': 'development-vessel' },
      });
      expect(res.status).toBe(200);
    });
  }

  // The actual hole: activities.ts has zero requireAuthenticated across 57 routes
  // and queries via the root client, where a null org context REMOVES the tenant
  // predicate rather than restricting it. Admission here is cross-tenant read.
  test('X-Internal-Api-Key does NOT admit an unguarded activities route', async () => {
    const res = await appWithPaths().request('/v2/activities/templates', {
      headers: { 'X-Internal-Api-Key': 'anything-at-all' },
    });
    expect(res.status).toBe(401);
  });

  test('a malformed Authorization header is rejected, not treated as anonymous', async () => {
    const res = await appWithPaths().request('/v2/activities/templates', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('MALFORMED_AUTH');
  });
});
