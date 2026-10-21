import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as embeddingLookupCacheModule from '../../src/lib/embedding-lookup-cache';

// Mock the dependency that resolves the concept-db URL.
// This needs to be at the top level for `bun:test`'s mock hoisting.
mock.module('../../src/lib/prior-seed', () => ({
  resolveConceptDbUrl: async () => 'http://mock-concept-db',
}));

describe('embedding-lookup-cache defective search path', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset cache before each test to ensure isolation
    embeddingLookupCacheModule.embeddingLookupCache.clear();
  });

  afterEach(() => {
    // Restore original fetch after each test
    global.fetch = originalFetch;
  });

  test('lookupEmbeddingForSignature fails to read embedding because search path omits it', async () => {
    const signature = 'test-signature-v1';
    const orgId = 'test-org-123';
    // This is the embedding we *should* get, but won't due to the bug.
    const expectedEmbedding = [0.1, 0.2, 0.3, 0.4];

    // Mock fetch to simulate concept-db's search response.
    // The key is that this response, while successful, lacks `content_embedding`.
    const mockFetch = mock(async (url: string | URL, options?: RequestInit) => {
      const urlString = url.toString();
      if (urlString.startsWith('http://mock-concept-db/concepts/search')) {
        const queryParams = new URL(urlString).searchParams;
        expect(queryParams.get('query')).toBe(signature);
        expect(queryParams.get('source_type')).toBe('impulse_signature');
        expect(queryParams.get('limit')).toBe('1');

        return new Response(JSON.stringify({
          concepts: [
            {
              // A realistic payload for a search hit that correctly matches the signature,
              // but is from a path that omits the dense embedding vector.
              id: 'impulse_signature:some_id',
              source_type: 'impulse_signature',
              source_key: signature,
              content: 'some content',
              // `content_embedding` is critically missing, which causes the bug.
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Unexpected fetch call in test.', { status: 500 });
    });

    global.fetch = mockFetch as any;

    const result = await embeddingLookupCacheModule.lookupEmbeddingForSignature(signature, orgId);

    // This assertion will fail. The function returns `null` because `content_embedding`
    // is undefined in the mocked response. The test expects the actual embedding array,
    // thereby demonstrating the bug and satisfying the goal of writing a failing test.
    expect(result).toEqual(expectedEmbedding);
  });
});
