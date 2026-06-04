/**
 * Tests for the M1 signature → embedding LRU cache.
 *
 * Verifies:
 *   - basic get/set semantics including negative caching
 *   - LRU eviction order (oldest unaccessed entry evicted first)
 *   - lookupEmbeddingForSignature short-circuits on cached negative entries
 *   - lookupEmbeddingForSignature caches both positive and negative fetch results
 *
 * Citations: concept_vfELeaE9GoiE (m1_training_pipeline_and_call_site_wiring)
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  EmbeddingLookupCache,
  lookupEmbeddingForSignature,
  embeddingLookupCache,
} from '../src/lib/embedding-lookup-cache';

const originalFetch = globalThis.fetch;

describe('EmbeddingLookupCache (LRU semantics)', () => {
  it('returns undefined on miss, value on hit', () => {
    const c = new EmbeddingLookupCache(4);
    expect(c.get('a')).toBeUndefined();
    c.set('a', [1, 2, 3]);
    expect(c.get('a')).toEqual([1, 2, 3]);
  });

  it('caches negative results as null (distinct from undefined miss)', () => {
    const c = new EmbeddingLookupCache(4);
    c.set('absent', null);
    expect(c.get('absent')).toBeNull();
    expect(c.has('absent')).toBe(true);
  });

  it('evicts least-recently-accessed entry when full', () => {
    const c = new EmbeddingLookupCache(3);
    c.set('a', [1]);
    c.set('b', [2]);
    c.set('c', [3]);
    // Access 'a' to make it MRU
    c.get('a');
    // Inserting 'd' should evict 'b' (oldest unaccessed)
    c.set('d', [4]);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
    expect(c.has('d')).toBe(true);
    expect(c.size()).toBe(3);
  });

  it('updates existing entries in place without growing', () => {
    const c = new EmbeddingLookupCache(2);
    c.set('a', [1]);
    c.set('a', [99]);
    expect(c.size()).toBe(1);
    expect(c.get('a')).toEqual([99]);
  });
});

describe('lookupEmbeddingForSignature', () => {
  beforeEach(() => {
    embeddingLookupCache.clear();
    process.env.CONCEPT_DB_URL = 'http://concept-db.test:8260';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null without fetching when CONCEPT_DB_URL is unset', async () => {
    delete process.env.CONCEPT_DB_URL;
    let fetched = 0;
    globalThis.fetch = mock(async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await lookupEmbeddingForSignature('sig-1', 'org-1');
    expect(r).toBeNull();
    expect(fetched).toBe(0);
  });

  it('caches positive results and short-circuits subsequent calls', async () => {
    let fetched = 0;
    globalThis.fetch = mock(async () => {
      fetched += 1;
      return new Response(
        JSON.stringify({ concepts: [{ content_embedding: [0.1, 0.2, 0.3] }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r1 = await lookupEmbeddingForSignature('sig-A', 'org-1');
    const r2 = await lookupEmbeddingForSignature('sig-A', 'org-1');
    const r3 = await lookupEmbeddingForSignature('sig-A', 'org-1');
    expect(r1).toEqual([0.1, 0.2, 0.3]);
    expect(r2).toEqual([0.1, 0.2, 0.3]);
    expect(r3).toEqual([0.1, 0.2, 0.3]);
    expect(fetched).toBe(1); // only the first call hits concept-db
  });

  it('caches negative results and does not retry', async () => {
    let fetched = 0;
    globalThis.fetch = mock(async () => {
      fetched += 1;
      return new Response(JSON.stringify({ concepts: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const r1 = await lookupEmbeddingForSignature('sig-empty', 'org-1');
    const r2 = await lookupEmbeddingForSignature('sig-empty', 'org-1');
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(fetched).toBe(1);
  });

  it('caches non-2xx as null', async () => {
    let fetched = 0;
    globalThis.fetch = mock(async () => {
      fetched += 1;
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;
    const r = await lookupEmbeddingForSignature('sig-X', 'org-1');
    expect(r).toBeNull();
    expect(fetched).toBe(1);
    const r2 = await lookupEmbeddingForSignature('sig-X', 'org-1');
    expect(r2).toBeNull();
    expect(fetched).toBe(1);
  });

  it('caches fetch errors as null', async () => {
    let fetched = 0;
    globalThis.fetch = mock(async () => {
      fetched += 1;
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await lookupEmbeddingForSignature('sig-err', 'org-1');
    expect(r).toBeNull();
    expect(fetched).toBe(1);
    await lookupEmbeddingForSignature('sig-err', 'org-1');
    expect(fetched).toBe(1);
  });

  it('treats malformed embeddings (NaN / non-array / empty) as null', async () => {
    const badBodies = [
      { concepts: [{ content_embedding: null }] },
      { concepts: [{ content_embedding: [] }] },
      { concepts: [{ content_embedding: [1, NaN, 3] }] },
      { concepts: [{ content_embedding: 'not-an-array' }] },
    ];
    for (let i = 0; i < badBodies.length; i++) {
      embeddingLookupCache.clear();
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(badBodies[i]), { status: 200 }),
      ) as unknown as typeof fetch;
      const r = await lookupEmbeddingForSignature(`sig-bad-${i}`, 'org-1');
      expect(r).toBeNull();
    }
  });
});
