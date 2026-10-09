/**
 * API-key validation asks only in-fleet identity: the configured identity-vessel,
 * then the identity that discovery locates. When neither can answer, the key is
 * refused (transient, so the HTTP layer answers 503) — no other host is asked and
 * nothing outside the fleet decides the verdict.
 *
 * Every request goes through a fetch recorder; no request leaves the process. Any
 * host other than the in-fleet ones answers "authenticated", so a call that
 * reaches one shows up both as a recorded host and as an accepted key.
 *
 * `auth.ts` pulls in config at import time, which throws without SURREALDB_*, so the
 * import is deferred into beforeAll behind the env the module requires.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

type Auth = typeof import('./auth');
let auth: Auth;

const PRIMARY = 'http://identity-primary.fleet.test:8080';
const DISCOVERY = 'http://discovery.fleet.test:8100';
const DISCOVERED = 'http://identity-discovered.fleet.test:8080';
const IN_FLEET_HOSTS = new Set([PRIMARY, DISCOVERY, DISCOVERED].map((u) => new URL(u).host));

const VALID = {
  authenticated: true,
  orgId: 'org-a',
  accountId: 'acct-a',
  userId: 'user-a',
  keyId: 'key-a',
  scopes: ['read', 'write'],
};

type Handler = () => Promise<Response>;
const ok = (body: unknown): Handler => async () => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number): Handler => async () => new Response('{}', { status: code });
const throws = (err: Error): Handler => async () => { throw err; };
const timeoutError = () => new DOMException('The operation timed out.', 'TimeoutError') as unknown as Error;

let seen: string[] = [];
let primary: Handler;
let discovery: Handler;
let discovered: Handler;
let outside: Handler;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.SURREALDB_URL ||= 'ws://localhost:8000';
  process.env.SURREALDB_NAMESPACE ||= 'test';
  process.env.SURREALDB_DATABASE ||= 'test';
  process.env.SURREALDB_USERNAME ||= 'test';
  process.env.SURREALDB_PASSWORD ||= 'test';
  process.env.JWT_SECRET ||= 'dev-only-jwt-secret-do-not-use-in-prod';
  process.env.IDENTITY_VESSEL_URL = PRIMARY;
  process.env.DISCOVERY_VESSEL_ENDPOINT = DISCOVERY;
  delete process.env.IDENTITY_VESSEL_EXTERNAL_URL;
  auth = await import('./auth');
});

beforeEach(() => {
  seen = [];
  primary = status(503);
  discovery = status(503);
  discovered = status(503);
  outside = ok({ success: true, data: VALID });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    const host = new URL(url).host;
    if (host === new URL(PRIMARY).host) return primary();
    if (host === new URL(DISCOVERY).host) return discovery();
    if (host === new URL(DISCOVERED).host) return discovered();
    // Any other host answers as if it accepted the key, unless a test says otherwise.
    return outside();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const outsideFleet = () => seen.filter((u) => !IN_FLEET_HOSTS.has(new URL(u).host));

const primaryFailures: Array<[string, () => Handler]> = [
  ['transient: timeout', () => throws(timeoutError())],
  ['transient: 503', () => status(503)],
  ['transient: connection refused', () => throws(new TypeError('connect ECONNREFUSED 10.0.0.1:8080'))],
  ['hard: 500', () => status(500)],
  ['hard: host not found', () => throws(new TypeError('getaddrinfo ENOTFOUND identity-primary.fleet.test'))],
];

describe('validateApiKeyWithFallback (HTTP path) refuses when in-fleet identity cannot answer', () => {
  for (const [label, make] of primaryFailures) {
    test(`primary ${label}, discovery down: refused as unavailable, no request outside the fleet`, async () => {
      primary = make();
      const r = await auth.validateApiKeyWithFallback('k-any');
      expect(outsideFleet()).toEqual([]);
      expect(r.authenticated).toBe(false);
      expect(r.transient).toBe(true);
      expect(seen.some((u) => u.startsWith(PRIMARY))).toBe(true);
    });
  }
});

describe('validateApiKeyViaIdentityVessel (WebSocket path) refuses when the primary cannot answer', () => {
  for (const [label, make] of primaryFailures) {
    test(`primary ${label}: refused, no request outside the fleet`, async () => {
      primary = make();
      const r = await auth.validateApiKeyViaIdentityVessel('k-any');
      expect(outsideFleet()).toEqual([]);
      expect(r.authenticated).toBe(false);
      expect(r.orgId).toBeUndefined();
    });
  }
});

describe('controls: in-fleet identity behaves as before', () => {
  test('a healthy primary accepts a valid key with the same identity fields', async () => {
    primary = ok({ success: true, data: VALID });
    const r = await auth.validateApiKeyWithFallback('k-valid');
    expect(r.authenticated).toBe(true);
    expect(r.orgId).toBe('org-a');
    expect(r.accountId).toBe('acct-a');
    expect(r.userId).toBe('user-a');
    expect(r.keyId).toBe('key-a');
    expect(r.scopes).toEqual(['read', 'write']);
    expect(r.authMethod).toBe('identity-vessel');
    expect(seen).toEqual([`${PRIMARY}/v1/auth/resolve`]);

    const ws = await auth.validateApiKeyViaIdentityVessel('k-valid');
    expect(ws.authenticated).toBe(true);
    expect(ws.orgId).toBe('org-a');
  });

  test('a healthy primary refuses an invalid key, definitively', async () => {
    primary = ok({ success: false, data: { authenticated: false, reason: 'Invalid API key' } });
    const r = await auth.validateApiKeyWithFallback('k-invalid');
    expect(r.authenticated).toBe(false);
    expect(r.transient === true).toBe(false);
    expect(r.reason).toBe('Invalid API key');
    expect(outsideFleet()).toEqual([]);
  });

  test('a definitive 401 from the primary is refused without asking anyone else', async () => {
    primary = status(401);
    const r = await auth.validateApiKeyWithFallback('k-revoked');
    expect(r.authenticated).toBe(false);
    expect(r.transient === true).toBe(false);
    expect(seen).toEqual([`${PRIMARY}/v1/auth/resolve`]);
  });

  test('primary down: the identity discovery locates in the fleet still validates', async () => {
    primary = status(503);
    discovery = ok({ vessels: [{ endpoint: DISCOVERED, vesselId: 'identity-vessel' }] });
    discovered = ok({ success: true, data: VALID });
    outside = status(503); // isolate the discovery path; the must-fails cover outside requests
    const r = await auth.validateApiKeyWithFallback('k-valid');
    expect(r.authenticated).toBe(true);
    expect(r.authMethod).toBe('discovery');
    expect(r.orgId).toBe('org-a');
    expect(r.keyId).toBe('key-a');
    expect(seen).toContain(`${DISCOVERED}/v1/auth/resolve`);
  });

  test('a valid JWT still validates, with no request made', async () => {
    const token = await auth.generateJwtToken({ orgId: 'org-a', userId: 'user-a', keyId: 'key-a', scopes: ['read'] });
    expect(token).toBeTruthy();
    const v = await auth.validateJwtToken(token!);
    expect(v.valid).toBe(true);
    expect(v.payload?.org_id).toBe('organizations:org-a');
    expect(seen).toEqual([]);
  });
});
