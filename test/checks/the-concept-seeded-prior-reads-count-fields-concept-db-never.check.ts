import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';

// Mock logger to suppress output
mock.module('../../src/utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// Import the module under test
import * as priorSeed from '../../src/lib/prior-seed.js';

describe('seedPriorFromConcepts: concept-db weighting defect', () => {
  const originalFetch = global.fetch;

  // We need resolveConceptDbUrl() to return a URL for the code path to be tested.
  // We assume it's configurable via an environment variable, a common pattern in this repo.
  // If this assumption is wrong, tests will fail on `result.source` being 'fallback'.
  const originalConceptDbUrl = process.env.CONCEPT_DB_URL;
  beforeEach(() => {
    process.env.CONCEPT_DB_URL = 'http://concept-db.test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalConceptDbUrl === undefined) {
      delete process.env.CONCEPT_DB_URL;
    } else {
      process.env.CONCEPT_DB_URL = originalConceptDbUrl;
    }
    mock.restore();
  });

  test('MUST-FAIL: returns Beta(1,1) for concepts lacking load/success counts', async () => {
    // This test is expected to fail. The defect causes it to return ~Beta(5,5).
    // The correct behavior is an uninformative Beta(1,1) prior when no counts are available.

    // Arrange
    const conceptHits = [{ id: 'concept:123', relevance: 0.5 }]; // No loaded_count or succeeded_count
    global.fetch = mock(async (): Promise<Response> => {
      return new Response(JSON.stringify({ concepts: conceptHits }), { status: 200 });
    });

    // Act
    const result = await priorSeed.seedPriorFromConcepts(
      'some-template',
      'some-signature',
      'org-abc',
    );

    // Assert
    expect(result.source).toBe('concepts');
    // The assertion that fails due to the defect:
    expect(result.alpha0).toBeCloseTo(1);
    expect(result.beta0).toBeCloseTo(1);
  });

  test('CONTROL: returns count-weighted prior for concepts with load/success counts', async () => {
    // This test must pass now and after the fix, ensuring existing correct behavior is preserved.

    // Arrange
    const conceptHits = [
      { id: 'concept:456', relevance: 0.5, loaded_count: 10, succeeded_count: 7 },
    ];
    global.fetch = mock(async (): Promise<Response> => {
      return new Response(JSON.stringify({ concepts: conceptHits }), { status: 200 });
    });

    // Act
    const result = await priorSeed.seedPriorFromConcepts(
      'some-template',
      'some-signature',
      'org-abc',
    );

    // Assert
    // Calculation with kappa=10 (default):
    // a_i=7, b_i=3. w_a = 0.5*7=3.5, w_b=0.5*3=1.5. total_w=0.5
    // mean_a=7, mean_b=3. sum=10.
    // alpha0 = 10 * (7/10) = 7. beta0 = 10 * (3/10) = 3.
    expect(result.source).toBe('concepts');
    expect(result.alpha0).toBeCloseTo(7);
    expect(result.beta0).toBeCloseTo(3);
  });
});
