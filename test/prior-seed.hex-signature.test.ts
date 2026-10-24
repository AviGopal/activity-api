/**
 * A machine-shaped signature must not suppress the templateId concept search.
 *
 * seedPriorFromConcepts searches concept-db with `${templateId} ${signature}`.
 * An early return that skipped the search whenever the signature was a long hex
 * string dropped the templateId half of the query too. Every observed trace
 * signature is 16-hex, so concept prior seeding fell back to Beta(1, 1) for every
 * cell. The search must still run, and its query must still carry the templateId.
 * The control keeps a human-readable signature on the combined query.
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

/** Installs a fetch mock that records the decoded query of every /concepts/search request. */
function recordQueries(): string[] {
  const queries: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/concepts/search')) queries.push(url.searchParams.get('query') ?? '');
    return new Response(JSON.stringify({ concepts: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return queries;
}

const hex16 = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

describe('prior seeding keeps the templateId search for machine-shaped signatures', () => {
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

  it('a 16-hex signature still runs the concept search with a query carrying the templateId', async () => {
    const queries = recordQueries();
    const templateId = 'summarize the meeting notes';
    const signature = hex16();
    await seedPriorFromConcepts(templateId, signature, 'org-1');
    expect(queries.length).toBe(1);
    expect(queries[0]).toContain(templateId);
  });

  it('control: a human-readable signature searches the combined templateId and signature query', async () => {
    const queries = recordQueries();
    await seedPriorFromConcepts('summarize the meeting notes', 'weekly sync', 'org-1');
    expect(queries).toEqual(['summarize the meeting notes weekly sync']);
  });
});
