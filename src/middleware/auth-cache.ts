/**
 * Process-local API-key validation cache + in-flight request deduplication.
 *
 * Background — auth rate-limit cascade (live-test audit 2026-05-16):
 *   - jwtAuth.ts fired a fresh identity-vessel `/v1/auth/resolve` call for
 *     every authenticated request (no cache, no dedup).
 *   - identity-vessel rate-limits at 20 req/min per IP (identity-vessel
 *     `index.ts:222`). Bursts from minibob (parallel impulse resolves) tripped
 *     the limit and identity-vessel returned 429.
 *   - activity-api's `validateApiKeyViaIdentityVessel` (services/auth.ts:278)
 *     treats any non-200 — including 429 — as `{authenticated: false,
 *     reason: "Identity vessel returned 429"}`, so the middleware set
 *     `jwtAuth = null` and every protected route returned 401.
 *   - Observed failure rate on /v2/impulses/resolve was ~80%.
 *
 * Two layered fixes implemented in this module:
 *
 *   Fix A — TTL cache keyed by raw apiKey. Both success and failure results
 *           are cached so a transient identity-vessel 429 doesn't ping-pong
 *           between authenticated/unauthenticated on every retry.
 *   Fix B — In-flight promise map. When N concurrent requests arrive on a
 *           cold cache for the same key, only one identity-vessel call fires;
 *           the rest await the shared promise.
 *
 * Fast path (cache hit) > slow path (in-flight dedupe, one call) > cold fetch.
 *
 * Cache key is the raw API key. It never leaves process memory — no logging,
 * no external propagation. Log lines that reference the key use a 12-char
 * fingerprint via `keyFingerprint()` to avoid leaking the secret to log
 * aggregators while still allowing operators to correlate per-key behavior.
 */
import { logger } from '../utils/logger';
import type { JwtAuthContext } from './jwtAuth';

const DEFAULT_TTL_MS = 30_000;
const MAX_ENTRIES_BEFORE_SWEEP = 1024;

interface CacheEntry {
  value: JwtAuthContext | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<JwtAuthContext | null>>();

function ttlMs(): number {
  const raw = process.env.AUTH_KEY_CACHE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Stable, log-safe fingerprint for an API key. Returns the first 8 characters
 * of a SHA-256 prefix. We use a simple, dependency-free djb2 hash here — it's
 * not cryptographically secure but the goal is correlation in logs, not
 * authentication, and avoiding a crypto import keeps this module hot-path
 * cheap.
 */
function keyFingerprint(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Drop expired entries. Called opportunistically on every lookup, plus a full
 * sweep when the Map exceeds MAX_ENTRIES_BEFORE_SWEEP.
 */
function sweepIfLarge(now: number): void {
  if (cache.size <= MAX_ENTRIES_BEFORE_SWEEP) return;
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}

/**
 * Wrap a fetcher with cache + in-flight dedupe.
 *
 * Order of operations matters:
 *   1. Cache hit → return immediately (no identity-vessel call).
 *   2. In-flight hit → await the existing promise (thundering-herd protection).
 *   3. Otherwise → register a new in-flight promise, call the fetcher, write
 *      the result to cache, and clear the in-flight slot.
 */
export async function getOrFetchValidatedApiKey(
  apiKey: string,
  fetcher: (apiKey: string) => Promise<JwtAuthContext | null>,
): Promise<JwtAuthContext | null> {
  const now = Date.now();
  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > now) {
    logger.info('[auth-cache] hit', {
      key_fp: keyFingerprint(apiKey),
      authenticated: cached.value !== null,
      ttl_remaining_ms: cached.expiresAt - now,
    });
    return cached.value;
  }
  if (cached) {
    // Expired — drop it now so the slot is reused below.
    cache.delete(apiKey);
  }

  const existing = inflight.get(apiKey);
  if (existing) {
    logger.info('[auth-cache] dedupe', { key_fp: keyFingerprint(apiKey) });
    return existing;
  }

  const promise = (async () => {
    try {
      const value = await fetcher(apiKey);
      const ttl = ttlMs();
      cache.set(apiKey, { value, expiresAt: Date.now() + ttl });
      sweepIfLarge(Date.now());
      return value;
    } finally {
      // Always clear the in-flight slot so the next miss can refetch.
      inflight.delete(apiKey);
    }
  })();
  inflight.set(apiKey, promise);
  return promise;
}

/**
 * Test-only: clear all cache and in-flight state. Exported so unit tests can
 * isolate scenarios; not part of the runtime API.
 */
export function _resetAuthKeyCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Test-only: inspect cache size.
 */
export function _authKeyCacheSize(): number {
  return cache.size;
}
