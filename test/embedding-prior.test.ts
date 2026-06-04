/**
 * Unit tests for computeEmbeddingConditionedPrior (learning-rate mechanism M1).
 *
 * Verifies:
 *   - Empty model row → fallback to (1, 1, 'fallback_uniform')
 *   - Seeded θ weights → expected α₀ / β₀ from the dot product
 *   - Invalid embedding (wrong dim, NaN, non-array) → fallback
 *   - model_version selection picks the latest by trained_at
 *
 * The DB layer is stubbed via module-mock on src/db/surreal and src/db/redis
 * so the test runs without infrastructure.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Mutable in-test state for the surreal/redis stubs.
let mockRows: Record<string, unknown>[] = [];
let mockQueryThrows = false;
const cache = new Map<string, string>();

mock.module('../src/db/surreal', () => ({
  surrealDB: {
    query: mock(async (_sql: string, _params?: Record<string, unknown>) => {
      if (mockQueryThrows) throw new Error('mock db error');
      return mockRows;
    }),
  },
}));

mock.module('../src/db/redis', () => ({
  redis: {
    get: mock(async (key: string) => cache.get(key) ?? null),
    set: mock(async (key: string, value: string, _ttl?: number) => {
      cache.set(key, value);
    }),
    getClient: () => ({
      del: mock(async (key: string) => {
        const had = cache.delete(key);
        return had ? 1 : 0;
      }),
    }),
  },
}));

// Import AFTER mocking
const { computeEmbeddingConditionedPrior, _clearEmbeddingPriorCache } = await import(
  '../src/services/embedding-prior'
);

function makeEmbedding(dim: number, fill = 0): number[] {
  return new Array(dim).fill(fill);
}

describe('computeEmbeddingConditionedPrior', () => {
  beforeEach(async () => {
    mockRows = [];
    mockQueryThrows = false;
    cache.clear();
  });

  it('falls back to (1,1) when no model row exists', async () => {
    mockRows = [];
    const e = makeEmbedding(384, 0.01);
    const r = await computeEmbeddingConditionedPrior(e, 'org-empty');
    expect(r.source).toBe('fallback_uniform');
    expect(r.α0).toBe(1);
    expect(r.β0).toBe(1);
    expect(r.model_version).toBeUndefined();
  });

  it('falls back when embedding is empty / non-array', async () => {
    mockRows = [
      {
        model_version: 'ridge-v1',
        feature_dim: 384,
        theta_alpha: new Array(385).fill(0.5),
        theta_beta: new Array(385).fill(0.5),
      },
    ];
    const r = await computeEmbeddingConditionedPrior([], 'org-x');
    expect(r.source).toBe('fallback_uniform');
  });

  it('falls back when embedding dim != feature_dim', async () => {
    mockRows = [
      {
        model_version: 'ridge-v1',
        feature_dim: 384,
        theta_alpha: new Array(385).fill(0.5),
        theta_beta: new Array(385).fill(0.5),
      },
    ];
    // wrong dim (10 instead of 384)
    await _clearEmbeddingPriorCache('org-wrongdim');
    const r = await computeEmbeddingConditionedPrior(makeEmbedding(10, 0.1), 'org-wrongdim');
    expect(r.source).toBe('fallback_uniform');
  });

  it('falls back when embedding contains NaN', async () => {
    mockRows = [
      {
        model_version: 'ridge-v1',
        feature_dim: 4,
        theta_alpha: [0, 1, 1, 1, 1],
        theta_beta: [0, 1, 1, 1, 1],
      },
    ];
    await _clearEmbeddingPriorCache('org-nan');
    const r = await computeEmbeddingConditionedPrior([0.1, Number.NaN, 0.2, 0.3], 'org-nan');
    expect(r.source).toBe('fallback_uniform');
  });

  it('falls back when theta length != feature_dim+1', async () => {
    mockRows = [
      {
        model_version: 'ridge-bad',
        feature_dim: 4,
        theta_alpha: [1, 2, 3], // too short
        theta_beta: [1, 2, 3, 4, 5],
      },
    ];
    await _clearEmbeddingPriorCache('org-bad-theta');
    const r = await computeEmbeddingConditionedPrior(makeEmbedding(4, 0.5), 'org-bad-theta');
    expect(r.source).toBe('fallback_uniform');
  });

  it('computes α₀/β₀ from θ · [1, e] with seeded weights', async () => {
    // feature_dim = 4
    // θ_α = [intercept=2, w=1,1,1,1]; e = [1,1,1,1] → α₀ = relu(2 + 4) = 6
    // θ_β = [intercept=1, w=0.5,0.5,0.5,0.5]; e = [1,1,1,1] → β₀ = relu(1 + 2) = 3
    mockRows = [
      {
        model_version: 'ridge-v1',
        feature_dim: 4,
        theta_alpha: [2, 1, 1, 1, 1],
        theta_beta: [1, 0.5, 0.5, 0.5, 0.5],
      },
    ];
    await _clearEmbeddingPriorCache('org-seeded');
    const r = await computeEmbeddingConditionedPrior([1, 1, 1, 1], 'org-seeded');
    expect(r.source).toBe('embedding_model');
    expect(r.model_version).toBe('ridge-v1');
    expect(r.α0).toBeCloseTo(6, 6);
    expect(r.β0).toBeCloseTo(3, 6);
  });

  it('clamps negative dot products to ALPHA_BETA_MIN (0.5)', async () => {
    // θ_α · [1, e] = -10 → relu = 0 → clamped to 0.5
    mockRows = [
      {
        model_version: 'ridge-v1',
        feature_dim: 4,
        theta_alpha: [-10, 0, 0, 0, 0],
        theta_beta: [-5, 0, 0, 0, 0],
      },
    ];
    await _clearEmbeddingPriorCache('org-neg');
    const r = await computeEmbeddingConditionedPrior([0, 0, 0, 0], 'org-neg');
    expect(r.source).toBe('embedding_model');
    expect(r.α0).toBe(0.5);
    expect(r.β0).toBe(0.5);
  });

  it('clamps huge dot products to ALPHA_BETA_MAX (100)', async () => {
    mockRows = [
      {
        model_version: 'ridge-v1',
        feature_dim: 4,
        theta_alpha: [500, 50, 50, 50, 50],
        theta_beta: [200, 0, 0, 0, 0],
      },
    ];
    await _clearEmbeddingPriorCache('org-big');
    const r = await computeEmbeddingConditionedPrior([1, 1, 1, 1], 'org-big');
    expect(r.source).toBe('embedding_model');
    expect(r.α0).toBe(100);
    expect(r.β0).toBe(100);
  });

  it('loads the latest model_version (DB query ORDER BY trained_at DESC)', async () => {
    // The service uses ORDER BY trained_at DESC LIMIT 1 in the DB query, so
    // the first element of mockRows simulates "the latest". We pin
    // model_version=ridge-v2 here and verify it surfaces.
    mockRows = [
      {
        model_version: 'ridge-v2',
        feature_dim: 4,
        theta_alpha: [0, 1, 0, 0, 0],
        theta_beta: [0, 0, 1, 0, 0],
        trained_at: '2026-06-04T00:00:00Z',
      },
    ];
    await _clearEmbeddingPriorCache('org-v2');
    const r = await computeEmbeddingConditionedPrior([2, 3, 0, 0], 'org-v2');
    expect(r.source).toBe('embedding_model');
    expect(r.model_version).toBe('ridge-v2');
    expect(r.α0).toBeCloseTo(2, 6); // 0 + 1*2 = 2
    expect(r.β0).toBeCloseTo(3, 6); // 0 + 1*3 = 3
  });

  it('falls back gracefully on DB error', async () => {
    mockQueryThrows = true;
    await _clearEmbeddingPriorCache('org-err');
    const r = await computeEmbeddingConditionedPrior(makeEmbedding(384, 0.01), 'org-err');
    expect(r.source).toBe('fallback_uniform');
  });
});
