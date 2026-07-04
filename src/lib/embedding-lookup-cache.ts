/**
 * In-memory LRU cache for signature → dense-embedding lookups.
 *
 * Used by the M1 hook in posterior-update.ts (concept_vugylIHzIMvk): credit
 * propagation walks each composition chain and re-resolves the same
 * (signature, template) cell many times in a short window. Without this
 * cache the concept-db lookup is on the hot path of every chain-credit
 * write.
 *
 * Discipline (concept_7mzv7SQN_7JB): purely additive — no new shape, no new
 * resolver tier. This is a private cache for an existing fetch.
 *
 * Citations:
 *   concept_vfELeaE9GoiE (m1_training_pipeline_and_call_site_wiring)
 *   concept_vugylIHzIMvk (M1 parent)
 */

const DEFAULT_MAX_SIZE = 1000;
const NEGATIVE_CACHE_VALUE: ReadonlyArray<number> = Object.freeze([]);

interface Entry {
  value: number[] | null;
  lastAccess: number;
}

export class EmbeddingLookupCache {
  private readonly maxSize: number;
  private readonly store = new Map<string, Entry>();
  private counter = 0;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * Get a cached embedding. Returns:
   *   - number[] when a positive entry is cached
   *   - null when a negative entry is cached (lookup previously returned nothing)
   *   - undefined when nothing is cached (caller must do the lookup)
   */
  get(key: string): number[] | null | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    entry.lastAccess = ++this.counter;
    return entry.value;
  }

  /**
   * Insert a value. Pass `null` to record a negative result (signature has no
   * embedding). The negative entry is still cached so repeated lookups don't
   * re-hit concept-db.
   */
  set(key: string, value: number[] | null): void {
    if (this.store.has(key)) {
      const existing = this.store.get(key)!;
      existing.value = value;
      existing.lastAccess = ++this.counter;
      return;
    }
    if (this.store.size >= this.maxSize) this.evictOldest();
    this.store.set(key, { value, lastAccess: ++this.counter });
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
    this.counter = 0;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAccess = Infinity;
    for (const [k, v] of this.store) {
      if (v.lastAccess < oldestAccess) {
        oldestAccess = v.lastAccess;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) this.store.delete(oldestKey);
  }
}

// Singleton — shared across both posterior-update.ts call sites.
export const embeddingLookupCache = new EmbeddingLookupCache(
  parseInt(process.env.EMBEDDING_LOOKUP_CACHE_SIZE ?? '1000', 10),
);

/**
 * Look up the dense embedding for a signature via concept-db.
 *
 * Returns null on any failure / timeout / missing concept / missing
 * embedding. Caches both positive and negative results to keep credit
 * propagation off the hot path.
 *
 * @param signature  impulse signature (signature_version-keyed string)
 * @param orgId      tenant id for the X-Org-Id header
 * @param timeoutMs  default 500ms (matches PRIOR_SEED_TIMEOUT_MS convention)
 */
export async function lookupEmbeddingForSignature(
  signature: string,
  orgId: string,
  timeoutMs = parseInt(process.env.EMBEDDING_LOOKUP_TIMEOUT_MS ?? '10000', 10),
): Promise<number[] | null> {
  const cached = embeddingLookupCache.get(signature);
  if (cached !== undefined) return cached;

  // Discovery-first concept-db endpoint (env override wins; warns when both
  // unavailable) — shared resolver lives in prior-seed.ts. Dynamic import
  // keeps this cache module dependency-light.
  const { resolveConceptDbUrl } = await import('./prior-seed');
  const url = await resolveConceptDbUrl();
  if (!url) {
    embeddingLookupCache.set(signature, null);
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const qs = new URLSearchParams({
      query: signature,
      source_type: 'impulse_signature',
      limit: '1',
    });
    const res = await fetch(`${url}/concepts/search?${qs.toString()}`, {
      signal: ctrl.signal,
      headers: {
        'X-Org-Id': orgId,
        ...(process.env.METABOB_API_KEY ? { Authorization: `ApiKey ${process.env.METABOB_API_KEY}` } : {}),
      },
    });
    if (!res.ok) {
      embeddingLookupCache.set(signature, null);
      return null;
    }
    const body = (await res.json()) as {
      concepts?: Array<{ content_embedding?: number[] | null }>;
    };
    const hit = Array.isArray(body?.concepts) ? body.concepts[0] : undefined;
    const emb = hit?.content_embedding;
    if (!Array.isArray(emb) || emb.length === 0) {
      embeddingLookupCache.set(signature, null);
      return null;
    }
    // sanity check: every entry must be a finite number
    for (let i = 0; i < emb.length; i++) {
      const v = emb[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        embeddingLookupCache.set(signature, null);
        return null;
      }
    }
    embeddingLookupCache.set(signature, emb);
    return emb;
  } catch {
    embeddingLookupCache.set(signature, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Re-export for tests that want a sentinel for "no embedding"
export const _NEGATIVE_CACHE_VALUE = NEGATIVE_CACHE_VALUE;
