/**
 * Unit tests for seedPriorFromConcepts (learning-rate mechanism 2).
 *
 * Verifies the empirical-Bayes prior seeding logic and its fallback
 * discipline: any error / timeout / empty response / disabled flag MUST
 * return Beta(1, 1).
 */

import { describe, expect, it, beforeEach, afterEach, afterAll, mock, spyOn } from 'bun:test';
import { seedPriorFromConcepts } from '../src/lib/prior-seed';
import { discoveryClient } from '../src/services/discovery-client';

const originalFetch = globalThis.fetch;
// Env this file sets; restored in afterAll so later files in the process see the original.
const ENV_KEYS = ['CONCEPT_DB_URL', 'PRIOR_SEED_ENABLED', 'PRIOR_SEED_K', 'PRIOR_SEED_KAPPA', 'PRIOR_SEED_TIMEOUT_MS'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

describe('seedPriorFromConcepts', () => {
  beforeEach(() => {
    setEnv({
      CONCEPT_DB_URL: 'http://concept-db.test:8081',
      PRIOR_SEED_ENABLED: 'true',
      PRIOR_SEED_K: '5',
      PRIOR_SEED_KAPPA: '10',
      PRIOR_SEED_TIMEOUT_MS: '500',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterAll(() => setEnv(originalEnv));

  it('falls back when disabled', async () => {
    setEnv({ PRIOR_SEED_ENABLED: 'false' });
    const r = await seedPriorFromConcepts('tpl', 'sig', 'org-1');
    expect(r).toEqual({ alpha0: 1, beta0: 1, source: 'fallback' });
  });

  it('falls back when CONCEPT_DB_URL is unset and discovery serves no concept vessel', async () => {
    // With no override the endpoint resolves via discovery; stub it so no network is touched.
    setEnv({ CONCEPT_DB_URL: undefined });
    const spy = spyOn(discoveryClient, 'discoverVesselsForShape').mockImplementation(
      async () => ({ found: false, vessels: [] }) as never,
    );
    // The resolved endpoint is cached for 60 s per process; an earlier file may have
    // warmed it, so step past the TTL to make this call reach discovery.
    const realNow = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(realNow + 120_000);
    try {
      const r = await seedPriorFromConcepts('tpl', 'sig', 'org-1');
      expect(r.source).toBe('fallback');
      expect(spy).toHaveBeenCalledWith('concept');
    } finally {
      clock.mockRestore();
      spy.mockRestore();
    }
  });

  it('falls back on empty response', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ concepts: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await seedPriorFromConcepts('tpl', 'sig', 'org-1');
    expect(r.source).toBe('fallback');
  });

  it('falls back on non-2xx', async () => {
    globalThis.fetch = mock(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const r = await seedPriorFromConcepts('tpl', 'sig', 'org-1');
    expect(r.source).toBe('fallback');
  });

  it('falls back on thrown fetch (network error / timeout)', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await seedPriorFromConcepts('tpl', 'sig', 'org-1');
    expect(r.source).toBe('fallback');
  });

  it('computes κ-scaled prior from neighbor concepts', async () => {
    globalThis.fetch = mock(async () =>
      new Response(
        JSON.stringify({
          concepts: [
            // 80% success rate, weight 1.0
            { id: 'c1', relevance: 1.0, loaded_count: 10, succeeded_count: 8 },
            // 40% success rate, weight 0.5
            { id: 'c2', relevance: 0.5, loaded_count: 10, succeeded_count: 4 },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await seedPriorFromConcepts('tpl', 'sig', 'org-1');
    expect(r.source).toBe('concepts');
    expect(r.neighbor_count).toBe(2);
    // α₀ + β₀ ≈ κ = 10
    expect(r.alpha0 + r.beta0).toBeCloseTo(10, 4);
    // Weighted mean success: (1.0 * 8 + 0.5 * 4) / (1.0 * 10 + 0.5 * 10)
    //                     = (8 + 2) / 15 = 0.6667
    // → α₀ ≈ 10 * 0.6667 ≈ 6.667
    expect(r.alpha0).toBeGreaterThan(6.5);
    expect(r.alpha0).toBeLessThan(6.9);
  });
});
