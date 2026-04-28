/**
 * Phase A: JWT auth context carries optional `accountId` from identity-vessel.
 *
 * OpenSpec change: activity-api-account-id-migration-2026-04-28
 *
 * This test exercises the API-key path of `jwtAuthMiddleware` with mocked
 * identity-vessel responses, covering the three scenarios that matter for
 * Phase A:
 *
 *   1. identity-vessel emits `accountId` (post identity-vessel-account-id-upgrade)
 *      → JwtAuthContext.accountId is populated.
 *   2. identity-vessel does NOT emit `accountId` (older deploy)
 *      → JwtAuthContext.accountId is undefined; orgId is still populated and
 *        downstream code falls back to org_id paths (Phase B handlers' contract).
 *   3. The L-3 fall-through (generateJwtToken returns null) still propagates
 *      `accountId` so the apikey-with-empty-jwtToken context can still be
 *      account-scoped.
 *
 * The middleware itself does NOT enforce ACCOUNT_ID_REQUIRED — that gate
 * lands in Phase D when the flag flips. Phase A only ensures the field is
 * populated end-to-end so downstream Phase B handlers have it available.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

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

describe('Phase A: jwtAuthMiddleware passes accountId from identity-vessel', () => {
  beforeEach(() => {
    validateApiKeyWithFallbackImpl.mockReset();
    generateJwtTokenImpl.mockReset();
  });

  test('identity-vessel returns accountId → JwtAuthContext.accountId populated', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: true,
      orgId: 'org-test',
      accountId: 'acc-test-001',
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
    expect(body.jwtAuth).not.toBeNull();
    expect(body.jwtAuth.orgId).toBe('org-test');
    expect(body.jwtAuth.accountId).toBe('acc-test-001');
    expect(body.jwtAuth.authType).toBe('apikey');
  });

  test('identity-vessel omits accountId (older deploy) → JwtAuthContext.accountId undefined', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: true,
      orgId: 'org-test',
      // no accountId on response — pre identity-vessel-account-id-upgrade
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
    expect(body.jwtAuth).not.toBeNull();
    expect(body.jwtAuth.orgId).toBe('org-test');
    // Phase A invariant: accountId is undefined, NOT null, NOT empty string.
    // Phase B handlers detect `accountId === undefined` and fall back to orgId.
    expect(body.jwtAuth.accountId).toBeUndefined();
  });

  test('L-3 fall-through path still carries accountId when generateJwtToken returns null', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: true,
      orgId: 'org-test',
      accountId: 'acc-test-002',
      userId: 'user-test',
      keyId: 'key-test',
      scopes: ['read', 'write'],
      authMethod: 'identity-vessel',
    }));
    // L-3 simulation: JWT generation fails (e.g. JWT_SECRET drift) but the
    // API key was already validated by identity-vessel.
    generateJwtTokenImpl.mockImplementation(async () => null);

    const app = appWithMiddleware();
    const res = await app.request('/v2/probe', {
      method: 'POST',
      headers: { Authorization: 'ApiKey valid-key' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jwtAuth).not.toBeNull();
    expect(body.jwtAuth.orgId).toBe('org-test');
    expect(body.jwtAuth.accountId).toBe('acc-test-002');
    expect(body.jwtAuth.jwtToken).toBe(''); // L-3 marker: empty jwtToken
    expect(body.jwtAuth.authType).toBe('apikey');
  });
});
