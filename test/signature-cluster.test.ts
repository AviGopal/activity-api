/**
 * D6.1 (ADAPTED) — unit tests for signature-cluster.ts.
 *
 * The implementation DEVIATES from the openspec D3.1 "implement HDBSCAN in
 * activity-api" line: clustering is DELEGATED to concept-db's `cluster` impulse
 * shape (see src/lib/signature-cluster.ts module header). So we do NOT test
 * HDBSCAN math. Instead we mock the concept-db HTTP call and assert the
 * delegation + stable-relabel contract:
 *   (a) existing embeddings pass through unchanged (no re-embedding);
 *   (b) concept-db's ephemeral cl-0/cl-1 are RE-LABELLED to stable content-derived
 *       `sigcl_<hex>` ids derived from the min-member signature;
 *   (c) the same membership yields the SAME stable id across two runs;
 *   (d) concept-db error / non-2xx / timeout never throws (returns [] / advisory).
 *
 * The only external dependency is `fetch` (the concept-db HTTP call); we replace
 * the global `fetch` per-test and restore it, the way an HTTP boundary is mocked
 * without a live substrate.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { createHash } from 'crypto';
import { clusterSignatures, type ClusterInputItem } from '../src/lib/signature-cluster';

// ---------------------------------------------------------------------------
// fetch mock harness — capture the outbound request, return a canned response.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  body: any;
}

/**
 * Install a fetch mock that records the request and returns the given JSON body
 * (status 200 by default). Returns the capture array.
 */
function mockConceptDb(
  responder: (req: CapturedRequest) => { status?: number; json?: any } | Promise<{ status?: number; json?: any }>,
): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const req: CapturedRequest = { url: String(url), body };
    captured.push(req);
    const r = await responder(req);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json ?? {},
    } as any;
  }) as any;
  return captured;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Expected stable id for a cluster, computed the SAME way the module does:
// sigcl_ + sha256(min member signature)[0:16].
function expectedStableId(members: string[]): string {
  const min = [...members].sort()[0];
  return 'sigcl_' + createHash('sha256').update(min).digest('hex').slice(0, 16);
}

const EMB = (n: number) => Array.from({ length: 8 }, (_, i) => Math.sin(n + i)); // dummy embedding

// ---------------------------------------------------------------------------
// (a) embeddings pass through unchanged (no re-embedding)
// ---------------------------------------------------------------------------

describe('clusterSignatures — (a) passes embeddings through without re-embedding', () => {
  test('the concept-db request carries the exact id+embedding pairs given', async () => {
    const items: ClusterInputItem[] = [
      { id: 'sig-alpha', embedding: EMB(1) },
      { id: 'sig-beta', embedding: EMB(2) },
    ];
    const captured = mockConceptDb(() => ({
      json: { content: [{ cluster_id: 'cl-0', members: ['sig-alpha', 'sig-beta'], size: 2 }] },
    }));

    await clusterSignatures(items);

    expect(captured).toHaveLength(1);
    const sent = captured[0].body.impulse.pointer.items;
    // Same number of items, same ids, byte-identical embeddings (no re-embed).
    expect(sent).toHaveLength(2);
    expect(sent[0].id).toBe('sig-alpha');
    expect(sent[0].embedding).toEqual(items[0].embedding);
    expect(sent[1].id).toBe('sig-beta');
    expect(sent[1].embedding).toEqual(items[1].embedding);
    // The impulse shape is the delegated `cluster` contract.
    expect(captured[0].body.impulse.type).toBe('cluster');
    expect(captured[0].body.impulse.pointer.type).toBe('cluster');
  });

  test('empty input short-circuits without any concept-db call', async () => {
    const captured = mockConceptDb(() => ({ json: { content: [] } }));
    const out = await clusterSignatures([]);
    expect(out).toEqual([]);
    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (b) re-label cl-N -> stable sigcl_ id from the min-member signature
// ---------------------------------------------------------------------------

describe('clusterSignatures — (b) re-labels ephemeral cl-N to stable content id', () => {
  test('each returned cluster_id is sigcl_<hex of min member>, not cl-N', async () => {
    mockConceptDb(() => ({
      json: {
        content: [
          { cluster_id: 'cl-0', members: ['m-charlie', 'm-alpha', 'm-bravo'], size: 3 },
          { cluster_id: 'cl-1', members: ['z-two', 'z-one'], size: 2 },
        ],
      },
    }));

    const out = await clusterSignatures([{ id: 'm-alpha', embedding: EMB(1) }]);

    expect(out).toHaveLength(2);
    // No ephemeral cl-N labels survive.
    expect(out.every((c) => !c.cluster_id.startsWith('cl-'))).toBe(true);
    expect(out.every((c) => c.cluster_id.startsWith('sigcl_'))).toBe(true);
    // Stable id derives from the LEXICOGRAPHICALLY SMALLEST member.
    expect(out[0].cluster_id).toBe(expectedStableId(['m-charlie', 'm-alpha', 'm-bravo'])); // min = m-alpha
    expect(out[1].cluster_id).toBe(expectedStableId(['z-two', 'z-one'])); // min = z-one
    // Members are preserved.
    expect(out[0].members).toEqual(['m-charlie', 'm-alpha', 'm-bravo']);
  });

  test('member-order does not change the stable id (min member is order-independent)', async () => {
    mockConceptDb(() => ({
      json: { content: [{ cluster_id: 'cl-0', members: ['b', 'a', 'c'], size: 3 }] },
    }));
    const out = await clusterSignatures([{ id: 'a', embedding: EMB(1) }]);
    expect(out[0].cluster_id).toBe(expectedStableId(['a', 'b', 'c']));
  });
});

// ---------------------------------------------------------------------------
// (c) same membership -> same stable id across two runs (even if cl-N differs)
// ---------------------------------------------------------------------------

describe('clusterSignatures — (c) stable id is identical across runs', () => {
  test('two runs with same membership but different cl-N labels yield same id', async () => {
    const members = ['sig-q', 'sig-a', 'sig-m'];

    // Run 1: concept-db labels it cl-0.
    mockConceptDb(() => ({ json: { content: [{ cluster_id: 'cl-0', members, size: 3 }] } }));
    const run1 = await clusterSignatures([{ id: 'sig-a', embedding: EMB(1) }]);

    // Run 2: concept-db labels the SAME group cl-1 (ephemeral order changed).
    mockConceptDb(() => ({ json: { content: [{ cluster_id: 'cl-1', members, size: 3 }] } }));
    const run2 = await clusterSignatures([{ id: 'sig-a', embedding: EMB(1) }]);

    expect(run1[0].cluster_id).toBe(run2[0].cluster_id);
    expect(run1[0].cluster_id).toBe(expectedStableId(members)); // min = sig-a
  });
});

// ---------------------------------------------------------------------------
// (d) never throws on concept-db error / timeout / shape mismatch
// ---------------------------------------------------------------------------

describe('clusterSignatures — (d) advisory: never throws, returns []', () => {
  test('non-2xx response -> []', async () => {
    mockConceptDb(() => ({ status: 503, json: { error: 'unavailable' } }));
    const out = await clusterSignatures([{ id: 'x', embedding: EMB(1) }]);
    expect(out).toEqual([]);
  });

  test('transport error (fetch rejects) -> []', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const out = await clusterSignatures([{ id: 'x', embedding: EMB(1) }]);
    expect(out).toEqual([]);
  });

  test('timeout (AbortError) -> []', async () => {
    globalThis.fetch = (async () => {
      const e = new Error('The operation timed out.');
      e.name = 'AbortError';
      throw e;
    }) as any;
    const out = await clusterSignatures([{ id: 'x', embedding: EMB(1) }]);
    expect(out).toEqual([]);
  });

  test('response shape mismatch (content not an array) -> []', async () => {
    mockConceptDb(() => ({ json: { content: 'not-an-array' } }));
    const out = await clusterSignatures([{ id: 'x', embedding: EMB(1) }]);
    expect(out).toEqual([]);
  });

  test('degenerate clusters with empty members are dropped, no throw', async () => {
    mockConceptDb(() => ({
      json: {
        content: [
          { cluster_id: 'cl-0', members: [], size: 0 },
          { cluster_id: 'cl-1', members: ['only'], size: 1 },
        ],
      },
    }));
    const out = await clusterSignatures([{ id: 'only', embedding: EMB(1) }]);
    expect(out).toHaveLength(1);
    expect(out[0].cluster_id).toBe(expectedStableId(['only']));
  });
});
