/**
 * Federation on-behalf-of (OBO) Bearer tokens are validated by IDENTITY, and the
 * request then runs on an org-scoped database session, never on root credentials.
 *
 * The federation transport forwards a remote caller to this vessel with a short-lived
 * OBO token minted by identity (`POST /v1/auth/on-behalf-of`): it names the caller,
 * this node and one shape, and carries no SurrealDB access claims. The Bearer branch
 * used to validate every JWT by signing in to SurrealDB with it, so an OBO token was
 * always refused ("JWT authentication failed") and federated callers could not reach
 * activity-api at all.
 *
 * What these tests hold:
 *   - an OBO for THIS node and the requested shape is accepted, and the DB session is
 *     opened with the database token identity returned for it (org-scoped through
 *     PERMISSIONS on $token.org_id), never with a locally minted general session and
 *     never with root;
 *   - an OBO minted for another node or shape is refused, including when identity
 *     answers without checking the audience;
 *   - expired and garbage Bearers are refused;
 *   - the ApiKey and ordinary JWT paths are unchanged and never consult the new path.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

const NODE = 'obo-node-a';
process.env.FED_SUBSTRATE_ID = NODE;

const validateApiKeyWithFallbackImpl = mock(async (_apiKey: string) => ({ authenticated: false, reason: 'unset' } as any));
const generateJwtTokenImpl = mock(async (_ctx: unknown) => 'locally-minted-general-session' as string | null);
const validateBearerViaIdentityImpl = mock(async (_token: string, _aud: { node: string; shape: string }) => ({ authenticated: false, reason: 'unset' } as any));

// mock.module replaces the module for every LATER test file too, so the exports this
// file does not exercise are the real ones, not stand-ins another file would then test.
const realAuth = await import('../services/auth');
mock.module('../services/auth', () => ({
  isTransientIdentityFailure: realAuth.isTransientIdentityFailure,
  validateJwtToken: realAuth.validateJwtToken,
  generateJwtToken: generateJwtTokenImpl,
  validateApiKeyViaIdentityVessel: realAuth.validateApiKeyViaIdentityVessel,
  validateApiKeyWithFallback: validateApiKeyWithFallbackImpl,
  validateBearerViaIdentity: validateBearerViaIdentityImpl,
}));

// The DB session the middleware opens. Records which token it was opened with and
// answers the $token claims query with what that token would carry.
const sessionTokens: string[] = [];
let tokenClaims: Record<string, unknown> = {};
let sessionAuthenticateFails = false;
const rootQueries: string[] = [];

mock.module('../db/surreal', () => ({
  dbStats: { snapshot: () => ({}) },
  getDbStats: () => ({}),
  surrealDB: {
    query: async (sql: string) => {
      rootQueries.push(sql);
      throw new Error('root credentials must never be used for a Bearer');
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async (jwt: string) => {
    sessionTokens.push(jwt);
    if (sessionAuthenticateFails) throw new Error('There was a problem with authentication');
    return {
      query: async () => [tokenClaims],
      close: async () => {},
    };
  },
}));

const { jwtAuthMiddleware, _resetOboCacheForTest } = await import('./jwtAuth');
const { _resetAuthKeyCache } = await import('./auth-cache');

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
/** A JWT-shaped string. The middleware only DECODES it to pick a validator; identity verifies. */
function jwtLike(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS512', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJl`;
}
const now = () => Math.floor(Date.now() / 1000);
function obo(shape: string, node = NODE, extra: Record<string, unknown> = {}): string {
  return jwtLike({ typ: 'obo', aud: `substrate:${node}`, obo_shape: shape, org_id: 'org-A', user_id: 'u-1', iat: now(), exp: now() + 60, ...extra });
}

function app(): Hono {
  const a = new Hono();
  a.use('/v2/*', async (c, next) => jwtAuthMiddleware(c, next));
  const echo = async (c: any) => {
    // The handler still reads the body after the middleware looked at it.
    let body: unknown = null;
    if (c.req.method === 'POST') body = await c.req.json().catch(() => 'UNREADABLE');
    return c.json({ ok: true, jwtAuth: c.get('jwtAuth') ?? null, body });
  };
  a.post('/v2/impulses/resolve', echo);
  a.get('/v2/activities', echo);
  return a;
}

/** The envelope the federation transport sends (proxyToVessel). */
function transportBody(shape: string): string {
  const fwd = { type: shape, id: 'x' };
  return JSON.stringify({ ...fwd, impulse: { ...fwd, pointer: fwd } });
}

function identityAccepts(shape: string, over: Record<string, unknown> = {}) {
  validateBearerViaIdentityImpl.mockImplementation(async () => ({
    authenticated: true,
    orgId: 'org-A',
    userId: 'u-1',
    keyId: 'caller-key-1',
    scopes: ['read', 'write'],
    obo: { node: NODE, shape, actor_key_id: 'transport-key', expires_at: new Date(Date.now() + 60_000).toISOString() },
    jwt: 'identity-minted-obo-db-token',
    ...over,
  }));
}

beforeEach(() => {
  validateApiKeyWithFallbackImpl.mockReset();
  generateJwtTokenImpl.mockReset();
  generateJwtTokenImpl.mockImplementation(async () => 'locally-minted-general-session');
  validateBearerViaIdentityImpl.mockReset();
  validateBearerViaIdentityImpl.mockImplementation(async () => ({ authenticated: false, reason: 'unset' }));
  sessionTokens.length = 0;
  rootQueries.length = 0;
  sessionAuthenticateFails = false;
  tokenClaims = { org_id: 'org-A', user_id: 'u-1', role: 'member', scopes: ['read', 'write'] };
  _resetAuthKeyCache();
  (_resetOboCacheForTest ?? (() => {}))();
});

describe('OBO Bearer: accepted for this node and shape, on an org-scoped session', () => {
  test('identity validates with audience = this node + the requested shape; DB session uses identity\'s token', async () => {
    identityAccepts('concept');
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Identity was asked, with the audience this vessel serves for this request.
    expect(validateBearerViaIdentityImpl).toHaveBeenCalledTimes(1);
    expect(validateBearerViaIdentityImpl.mock.calls[0]![1]).toEqual({ node: NODE, shape: 'concept' });

    // The session was opened with the token identity returned for this OBO — not the
    // OBO itself (it carries no DB access claims), not a locally minted 15-minute
    // general session (that would launder a node- and shape-bound grant), not root.
    expect(sessionTokens).toEqual(['identity-minted-obo-db-token']);
    expect(generateJwtTokenImpl).not.toHaveBeenCalled();
    expect(rootQueries).toEqual([]);

    // The org used is the one the DB session's $token carries, and it is the caller's.
    expect(body.jwtAuth.orgId).toBe('org-A');
    expect(body.jwtAuth.jwtToken).toBe('identity-minted-obo-db-token');
    // 'jwt' routes every executeAsAuth / queryWithAuth through PERMISSIONS; 'apikey'
    // would route to root credentials with a hand-written org predicate.
    expect(body.jwtAuth.authType).toBe('jwt');
    expect(body.jwtAuth.obo).toEqual({ node: NODE, shape: 'concept', actorKeyId: 'transport-key' });
    // The handler can still read the body.
    expect((body.body as any).impulse.pointer.type).toBe('concept');
  });

  test('flat { pointer: { type } } body form is read for the shape too', async () => {
    identityAccepts('executionReplicationPull');
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('executionReplicationPull')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'executionReplicationPull' } }),
    });
    expect(res.status).toBe(200);
    expect(validateBearerViaIdentityImpl.mock.calls[0]![1]).toEqual({ node: NODE, shape: 'executionReplicationPull' });
  });

  test('a burst with the same OBO costs one identity round trip', async () => {
    identityAccepts('concept');
    const a = app();
    for (let i = 0; i < 3; i++) {
      const res = await a.request('/v2/impulses/resolve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${obo('concept', NODE, { iat: 1 })}`, 'Content-Type': 'application/json' },
        body: transportBody('concept'),
      });
      expect(res.status).toBe(200);
    }
    expect(validateBearerViaIdentityImpl).toHaveBeenCalledTimes(1);
  });
});

describe('OBO Bearer: refused when it is not for this node and shape', () => {
  test('identity refuses an OBO minted for another node → 401, no DB session', async () => {
    validateBearerViaIdentityImpl.mockImplementation(async () => ({
      authenticated: false,
      reason: 'on-behalf-of token was minted for a different node or shape',
    }));
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept', 'obo-node-b')}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(401);
    expect(sessionTokens).toEqual([]);
    expect(rootQueries).toEqual([]);
  });

  test('OBO for shape A used on a request for shape B → identity is asked about B and refuses', async () => {
    validateBearerViaIdentityImpl.mockImplementation(async (_t, aud) =>
      aud.shape === 'concept'
        ? { authenticated: true, orgId: 'org-A', userId: 'u-1', obo: { node: NODE, shape: 'concept' }, jwt: 'tok' }
        : { authenticated: false, reason: 'on-behalf-of token was minted for a different node or shape' });
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('poolImpulse_write'),
    });
    expect(res.status).toBe(401);
    expect(validateBearerViaIdentityImpl.mock.calls[0]![1]).toEqual({ node: NODE, shape: 'poolImpulse_write' });
    expect(sessionTokens).toEqual([]);
  });

  test('identity that answers without checking the audience (stated obo names another shape) → 401', async () => {
    identityAccepts('concept');
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('memoryNote_write'),
    });
    expect(res.status).toBe(401);
    expect(sessionTokens).toEqual([]);
  });

  test('identity that does not report the token as on-behalf-of (no obo field) → 401', async () => {
    identityAccepts('concept', { obo: undefined });
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(401);
    expect(sessionTokens).toEqual([]);
  });

  test('no shape determinable (GET) → 401 without asking identity: an OBO grants one shape', async () => {
    identityAccepts('concept');
    const res = await app().request('/v2/activities', {
      method: 'GET',
      headers: { Authorization: `Bearer ${obo('concept')}` },
    });
    expect(res.status).toBe(401);
    expect(validateBearerViaIdentityImpl).not.toHaveBeenCalled();
    expect(sessionTokens).toEqual([]);
  });
});

describe('OBO Bearer: never falls back to a wider session', () => {
  test('identity validated but returned no DB token → 401, not root, not a local mint', async () => {
    identityAccepts('concept', { jwt: undefined });
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(401);
    expect(generateJwtTokenImpl).not.toHaveBeenCalled();
    expect(sessionTokens).toEqual([]);
    expect(rootQueries).toEqual([]);
  });

  test('DB session refuses identity\'s token → 401', async () => {
    identityAccepts('concept');
    sessionAuthenticateFails = true;
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(401);
    expect(rootQueries).toEqual([]);
  });

  test('DB session $token names a different org than identity → 401', async () => {
    identityAccepts('concept');
    tokenClaims = { org_id: 'org-B', user_id: 'u-1' };
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(401);
  });

  test('identity unreachable → 503 IDENTITY_UNAVAILABLE, not a revocation', async () => {
    validateBearerViaIdentityImpl.mockImplementation(async () => ({ authenticated: false, reason: 'Identity vessel returned 503', transient: true }));
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept')}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('IDENTITY_UNAVAILABLE');
  });
});

describe('expired and garbage Bearers are refused', () => {
  test('expired OBO → identity refuses → 401', async () => {
    validateBearerViaIdentityImpl.mockImplementation(async () => ({ authenticated: false, reason: 'Invalid or expired JWT token' }));
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${obo('concept', NODE, { iat: now() - 300, exp: now() - 180 })}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(401);
    expect(sessionTokens).toEqual([]);
  });

  test('garbage three-part Bearer → 401', async () => {
    sessionAuthenticateFails = true;
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: 'Bearer not.a.jwt', 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(401);
    expect(rootQueries).toEqual([]);
  });
});

describe('controls: ApiKey and ordinary JWT paths are unchanged', () => {
  test('ApiKey → identity API-key validation, the OBO path is not consulted', async () => {
    validateApiKeyWithFallbackImpl.mockImplementation(async () => ({
      authenticated: true, orgId: 'org-K', userId: 'u-k', keyId: 'k-1', scopes: ['read'], authMethod: 'identity-vessel',
    }));
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: 'ApiKey some-key', 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jwtAuth.authType).toBe('apikey');
    expect(body.jwtAuth.orgId).toBe('org-K');
    expect(validateBearerViaIdentityImpl).not.toHaveBeenCalled();
  });

  test('ordinary (non-OBO) JWT → validated by a DB session opened with that same token', async () => {
    const plain = jwtLike({ NS: 'activity-system', DB: 'learning_loop', AC: 'apikey_token', org_id: 'org-J', user_id: 'u-j', exp: now() + 600 });
    tokenClaims = { org_id: 'org-J', user_id: 'u-j' };
    const res = await app().request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${plain}`, 'Content-Type': 'application/json' },
      body: transportBody('concept'),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(sessionTokens).toEqual([plain]);
    expect(body.jwtAuth.orgId).toBe('org-J');
    expect(body.jwtAuth.authType).toBe('jwt');
    expect(body.jwtAuth.obo).toBeUndefined();
    expect(validateBearerViaIdentityImpl).not.toHaveBeenCalled();
  });
});
