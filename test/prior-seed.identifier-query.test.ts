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

  // A generated identifier set (the class, not two examples): every shape a templateId or signature
  // takes in the fleet, alone or combined. None of these carries a natural-language word, so none
  // may reach concept text search. Generated per run so no literal can be special-cased.
  const hex = (n: number, upper = false) => {
    const s = Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(n / 2))), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
    return upper ? s.replace(/[a-f]/g, (c, i: number) => (i % 2 ? c.toUpperCase() : c)) : s;
  };
  const w = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(97 + (b % 26))).join('');
  const identifierTemplateIds = () => [
    `${w()}-${w()}`, // kebab template id
    `learned-composition-${hex(8)}`, // minted composition id
    `${w()}_${w()}_${w()}`, // snake id
    `activity:${w()}-${w()}`, // record id
    `activity:⟨${crypto.randomUUID()}⟩`, // bracketed record id
    crypto.randomUUID(), // uuid
    hex(64), // sha256
    hex(24, true), // mixed-case hex
    `${w()}:${w()}:${hex(6)}`, // colon-namespaced id
    `compose-${w()}-v${1 + (hex(2).charCodeAt(0) % 9)}`, // versioned id with a digit
  ];
  const identifierSignatures = () => [`sigcl_${hex(16)}`, hex(20), hex(64), `sigcl_${hex(32)}`, hex(16, true)];

  it('an identifier-only templateId with no signature issues no concept text search (generated id shapes)', async () => {
    const searched = recordSearches();
    for (const id of identifierTemplateIds()) {
      const r = await seedPriorFromConcepts(id, null, 'org-1');
      expect({ id, source: r.source }).toEqual({ id, source: 'fallback' });
    }
    expect(searched).toEqual([]);
  });

  it('an identifier-only templateId with any identifier signature issues no concept text search (generated pairs)', async () => {
    const searched = recordSearches();
    const ids = identifierTemplateIds();
    const sigs = identifierSignatures();
    for (let i = 0; i < ids.length; i++) {
      const r = await seedPriorFromConcepts(ids[i]!, sigs[i % sigs.length]!, 'org-1');
      expect({ id: ids[i], source: r.source }).toEqual({ id: ids[i], source: 'fallback' });
    }
    expect(searched).toEqual([]);
  });

  it('control: word queries that carry digits, hyphens and punctuation each reach concept-db exactly once', async () => {
    const searched = recordSearches();
    const wordy = [
      'fix the 404 in the step-2 handler',
      'compare Q3-2026 revenue to Q2',
      'summarize gap-drain backoff for org 7',
      `list the ${hex(4)} failures since 10:30`,
      're-run the e2e suite on dev',
    ];
    for (const q of wordy) await seedPriorFromConcepts(q, null, 'org-1');
    expect(searched.length).toBe(wordy.length);
  });

  it('control: a word query with an identifier signature still reaches concept-db', async () => {
    const searched = recordSearches();
    await seedPriorFromConcepts('summarize the meeting notes', `sigcl_${hex(16)}`, 'org-1');
    await seedPriorFromConcepts('draft a release note for vessel 3', hex(20), 'org-1');
    expect(searched.length).toBe(2);
  });

  it('control: a query that carries words still reaches concept-db', async () => {
    const searched = recordSearches();
    await seedPriorFromConcepts('summarize the meeting notes', null, 'org-1');
    expect(searched.length).toBe(1);
  });
});
