/**
 * Check-first test for gap prior-seeding-full-text-searches-concept-text-with-machine-identifiers.
 *
 * seedPriorFromConcepts used to search concept TEXT (concept-db BM25) with
 * `${templateId} ${signature}`: an activity id plus a signature or signature-cluster
 * hash. Identifiers never occur in concept text, so every such search ran concept-db's
 * whole term-set ladder plus the dense leg, matched nothing, and the prior fell back
 * to Beta(1, 1) anyway. Measured on the syzygy hub (2026-10-02): concept-db BM25 was
 * the largest single statement (17.4% of database time); ladders that relaxed ended
 * on 'sigcl_<hex>' 211 times in 15 minutes.
 *
 * A query made only of identifiers must not reach /concepts/search at all.
 * The control keeps a query that carries words reaching concept-db as before.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { seedPriorFromConcepts } from '../src/lib/prior-seed';

const originalFetch = globalThis.fetch;

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
}

/** Installs a fetch mock that records every /concepts/search?query= request. */
function recordSearches(): string[] {
  const searched: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/concepts/search?query=')) searched.push(url);
    return new Response(JSON.stringify({ concepts: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return searched;
}

describe('prior seeding never full-text-searches machine identifiers', () => {
  beforeEach(() => {
    setEnv({
      CONCEPT_DB_URL: 'http://concept-db.test:8081',
      PRIOR_SEED_ENABLED: 'true',
      EMBEDDING_PRIOR_ENABLED: undefined,
      PRIOR_SEED_K: '5',
      PRIOR_SEED_KAPPA: '10',
      PRIOR_SEED_TIMEOUT_MS: '500',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('an activity id with a signature-cluster hash issues no concept text search', async () => {
    const searched = recordSearches();
    const r = await seedPriorFromConcepts('compose-x', 'sigcl_0123456789abcdef', 'org-1');
    expect(searched).toEqual([]);
    expect(r.source).toBe('fallback');
  });

  it('an activity id with a raw hex signature issues no concept text search', async () => {
    const searched = recordSearches();
    const r = await seedPriorFromConcepts('learned-composition-x', '0123456789abcdef0123', 'org-1');
    expect(searched).toEqual([]);
    expect(r.source).toBe('fallback');
  });

  it('control: a query that carries words still reaches concept-db', async () => {
    const searched = recordSearches();
    await seedPriorFromConcepts('summarize the meeting notes', null, 'org-1');
    expect(searched.length).toBe(1);
  });
});
