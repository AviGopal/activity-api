/**
 * Pins the transient-vs-definitive classification of identity-vessel failures.
 *
 * THE DEFECT: `AbortSignal.timeout()` rejects with "The operation timed out.", which
 * does NOT contain the substring "timeout". Both copies of the predicate in auth.ts
 * matched only "timeout", so every aborted identity request fell through to the
 * revoked-key branch and was negatively cached for its full TTL rather than ~2s.
 * Measured 2026-08-11: 13 timeout events, 13/13 logged transient:false, 0/13 took a
 * fallback branch — cascading into discovery deregistration and a 15.3-minute window
 * in which the local registry drained from 14/386 shapes to 0/0 with no restart.
 *
 * The identical "timed out" vs "timeout" class was already fixed once in
 * llm-resolver-vessel/src/provider-errors.ts; auth.ts carried TWO copies of the
 * predicate and neither received the lesson. Hence one shared definition.
 *
 * `auth.ts` pulls in config at import time, which throws without SURREALDB_*, so the
 * import is deferred into beforeAll behind the env the module requires.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

let isTransientIdentityFailure: (reason: string | undefined) => boolean;
let validateApiKeyWithFallback: (apiKey: string) => Promise<{ authenticated: boolean; transient?: boolean; reason?: string }>;

beforeAll(async () => {
  process.env.SURREALDB_URL ||= 'ws://localhost:8000';
  process.env.SURREALDB_NAMESPACE ||= 'test';
  process.env.SURREALDB_DATABASE ||= 'test';
  process.env.SURREALDB_USERNAME ||= 'test';
  process.env.SURREALDB_PASSWORD ||= 'test';
  process.env.JWT_SECRET ||= 'dev-only-jwt-secret-do-not-use-in-prod';
  ({ isTransientIdentityFailure, validateApiKeyWithFallback } = await import('./auth'));
});

describe('isTransientIdentityFailure', () => {
  test('THE REGRESSION: the literal AbortSignal.timeout message is transient', () => {
    // This exact string is what AbortSignal.timeout() rejects with. Before the fix it
    // returned false, and a slow identity vessel read as a revoked credential.
    expect(isTransientIdentityFailure('The operation timed out.')).toBe(true);
  });

  test('still recognises the spellings it always did', () => {
    for (const reason of [
      'Network error',
      'fetch failed',
      'request timeout after 5000ms',
      'connect ECONNREFUSED 127.0.0.1:8100',
      'identity-vessel returned 503',
      'getaddrinfo ENOTFOUND identity-vessel',
    ]) {
      expect(isTransientIdentityFailure(reason)).toBe(true);
    }
  });

  test('a DEFINITIVE rejection stays definitive — the property that must not regress', () => {
    // If these ever read as transient, a genuinely revoked key would be retried and
    // cached as valid. Widening the predicate must never reach these.
    for (const reason of [
      'Invalid API key',
      'API key revoked',
      'identity-vessel returned 401',
      'identity-vessel returned 403',
      'Unauthorized',
    ]) {
      expect(isTransientIdentityFailure(reason)).toBe(false);
    }
  });

  test('a missing reason is not transient — absence of evidence is not a network error', () => {
    expect(isTransientIdentityFailure(undefined)).toBe(false);
    expect(isTransientIdentityFailure('')).toBe(false);
  });

  test('4xx other than a 5xx server error is not transient (guards the "returned 5" prefix)', () => {
    expect(isTransientIdentityFailure('identity-vessel returned 400')).toBe(false);
    expect(isTransientIdentityFailure('identity-vessel returned 500')).toBe(true);
  });
});

// An identity RATE LIMIT is not a revoked key. tryIdentityVesselValidation marks a 429 transient, but
// validateApiKeyWithFallback re-derived transience from the reason text ("returned 5" matches 5xx only) and
// its returns dropped `transient`, so jwtAuth cached the 429 as a revoked key for the full negative TTL: every
// key got 401 and the retries kept identity saturated (measured on a fresh hub, 2026-09-30: 776 identity
// rate-limit events in 2 min, all trace-store calls 401). Only the ORIGINAL 429 may decide; a definitive
// 401 must stay definitive.
describe('validateApiKeyWithFallback keeps an identity rate limit transient', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const answer = (status: number) => { globalThis.fetch = (async () => new Response('{}', { status })) as typeof fetch; };

  test('THE REGRESSION: an identity 429 is returned as transient, not as a revoked key', async () => {
    answer(429);
    const r = await validateApiKeyWithFallback('k-rate-limited');
    expect(r.authenticated).toBe(false);
    expect(r.transient).toBe(true);
  });

  test('a definitive 401 stays definitive: the fix must not make revoked keys transient', async () => {
    answer(401);
    const r = await validateApiKeyWithFallback('k-revoked');
    expect(r.authenticated).toBe(false);
    expect(r.transient === true).toBe(false);
  });
});
