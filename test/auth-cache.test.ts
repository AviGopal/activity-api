/**
 * Tests for auth-cache.ts — TTL cache + in-flight dedupe.
 *
 * Covers the audit-driven fixes (live-test 2026-05-16, identity-vessel 429
 * cascade): cache hit fast path, expiry boundary, and thundering-herd
 * deduplication of concurrent cold-cache calls.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  getOrFetchValidatedApiKey,
  _resetAuthKeyCache,
  _authKeyCacheSize,
} from './auth-cache';
import type { JwtAuthContext } from './jwtAuth';

const authedCtx: JwtAuthContext = {
  jwtToken: 'tok',
  orgId: 'org-1',
  keyId: 'k1',
  userId: 'u1',
  authType: 'apikey',
  scopes: ['read', 'write'],
};

describe('auth-cache', () => {
  beforeEach(() => {
    _resetAuthKeyCache();
    delete process.env.AUTH_KEY_CACHE_TTL_MS;
  });

  test('cache hit: second call within TTL reuses the first result and does not refire the fetcher', async () => {
    const fetcher = mock(async (_k: string) => authedCtx);
    const a = await getOrFetchValidatedApiKey('key-1', fetcher);
    const b = await getOrFetchValidatedApiKey('key-1', fetcher);
    expect(a).toEqual(authedCtx);
    expect(b).toEqual(authedCtx);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('cache expiry: after TTL, the fetcher fires again', async () => {
    process.env.AUTH_KEY_CACHE_TTL_MS = '1';
    const fetcher = mock(async (_k: string) => authedCtx);
    await getOrFetchValidatedApiKey('key-expiring', fetcher);
    // Wait past the 1ms TTL.
    await new Promise((r) => setTimeout(r, 10));
    await getOrFetchValidatedApiKey('key-expiring', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('failure results are cached (transient 429 from identity-vessel should not ping-pong)', async () => {
    const fetcher = mock(async (_k: string) => null);
    const a = await getOrFetchValidatedApiKey('key-bad', fetcher);
    const b = await getOrFetchValidatedApiKey('key-bad', fetcher);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('in-flight dedupe: 10 concurrent calls on a cold cache fire the fetcher exactly once', async () => {
    let resolve!: (v: JwtAuthContext) => void;
    const gate = new Promise<JwtAuthContext>((r) => {
      resolve = r;
    });
    const fetcher = mock(async (_k: string) => gate);

    const tasks = Array.from({ length: 10 }, () =>
      getOrFetchValidatedApiKey('herd-key', fetcher),
    );
    // All 10 are now awaiting the same in-flight promise.
    resolve(authedCtx);
    const results = await Promise.all(tasks);

    expect(results.every((r) => r === authedCtx)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('different keys do not collide', async () => {
    const ctxA = { ...authedCtx, orgId: 'org-A' };
    const ctxB = { ...authedCtx, orgId: 'org-B' };
    const fetcher = mock(async (k: string) => (k === 'a' ? ctxA : ctxB));
    const [a, b] = await Promise.all([
      getOrFetchValidatedApiKey('a', fetcher),
      getOrFetchValidatedApiKey('b', fetcher),
    ]);
    expect(a?.orgId).toBe('org-A');
    expect(b?.orgId).toBe('org-B');
    expect(_authKeyCacheSize()).toBe(2);
  });

  test('in-flight slot clears after settlement so refetch works post-expiry', async () => {
    process.env.AUTH_KEY_CACHE_TTL_MS = '1';
    const fetcher = mock(async (_k: string) => authedCtx);
    await getOrFetchValidatedApiKey('flush-key', fetcher);
    await new Promise((r) => setTimeout(r, 10));
    await getOrFetchValidatedApiKey('flush-key', fetcher);
    // If the in-flight slot hadn't cleared, the second call would have
    // returned the first promise instead of refetching.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
