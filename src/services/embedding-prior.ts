/**
 * Embedding-conditioned Thompson prior (learning-rate mechanism M1).
 *
 * Replaces the independent Beta(α, β) per (signature, template) cell with
 * α₀ = relu(θ_α · [1, e]), β₀ = relu(θ_β · [1, e]) where e is the cell's
 * dense embedding (MiniLM-L6-v2, 384-dim). Brings sample complexity from
 * O(|C|/ε²) down to O(d/ε²) by sharing statistical strength across cells.
 *
 * Citations:
 *   concept_vugylIHzIMvk (embedding_conditioned_thompson_posterior)
 *   concept_TbN0eSf7U_hM (parent — Thompson learning-rate program)
 *   concept_7mzv7SQN_7JB (discipline gate)
 *
 * This MVP STARTER:
 *   - Schema migration 143 introduces `embedding_prior_weights`.
 *   - This module loads the latest row for org_id (Redis cached) and
 *     evaluates the dot products at inference time.
 *   - Integration hook in src/lib/prior-seed.ts is GATED on
 *     EMBEDDING_PRIOR_ENABLED (default false). When true, it short-circuits
 *     the concept-db neighbor query and uses θ-scored priors instead.
 *
 * Fallback discipline (must match prior-seed.ts): any error / missing row /
 * invalid embedding / disabled flag returns {α₀: 1, β₀: 1, source:
 * 'fallback_uniform'}. The substrate never blocks on prior seeding.
 *
 * Deferred to follow-up:
 *   - Training pipeline that fits θ from variant_performance_metrics + concept-db
 *     embeddings and writes rows into `embedding_prior_weights`.
 *   - Selector integration (recommend endpoint reads θ-scored priors for
 *     new cells).
 *   - Workbench UI for inspecting model_version, feature_dim, n_training_samples.
 */

import { surrealDB } from '../db/surreal';
import { redis } from '../db/redis';
import { logger } from '../utils/logger';

export interface EmbeddingConditionedPrior {
  α0: number;
  β0: number;
  source: 'embedding_model' | 'fallback_uniform';
  model_version?: string;
}

interface EmbeddingPriorWeightsRow {
  model_version: string;
  feature_dim: number;
  theta_alpha: number[];
  theta_beta: number[];
  trained_at?: string;
  n_training_samples?: number;
}

const FALLBACK: EmbeddingConditionedPrior = {
  α0: 1,
  β0: 1,
  source: 'fallback_uniform',
};

const ALPHA_BETA_MIN = 0.5;
const ALPHA_BETA_MAX = 100;
const CACHE_TTL_SECONDS = 5 * 60; // 5 min

function cacheKey(orgId: string): string {
  return `embedding_prior_weights:${orgId}`;
}

function isValidEmbedding(e: number[], expectedDim: number): boolean {
  if (!Array.isArray(e)) return false;
  if (e.length !== expectedDim) return false;
  for (let i = 0; i < e.length; i++) {
    const v = e[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

function dotPlusIntercept(theta: number[], embedding: number[]): number {
  // theta layout: [intercept, w_1, ..., w_d]
  let s = theta[0] ?? 0;
  for (let i = 0; i < embedding.length; i++) {
    s += (theta[i + 1] ?? 0) * embedding[i];
  }
  return s;
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function relu(x: number): number {
  return x > 0 ? x : 0;
}

/**
 * Load the latest model row for orgId from Redis (or fall through to SurrealDB
 * and re-cache). Returns null on any failure or when no row exists.
 */
async function loadLatestModel(orgId: string): Promise<EmbeddingPriorWeightsRow | null> {
  // Try cache first
  try {
    const cached = await redis.get(cacheKey(orgId));
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as EmbeddingPriorWeightsRow | { _empty: true };
        if ('_empty' in parsed) return null;
        return parsed;
      } catch {
        // Fall through to db query
      }
    }
  } catch (err) {
    logger.debug('embedding_prior_cache_get_failed', {
      org_id: orgId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Query latest by trained_at
  let row: EmbeddingPriorWeightsRow | null = null;
  try {
    const result = await surrealDB.query<EmbeddingPriorWeightsRow>(
      `SELECT model_version, feature_dim, theta_alpha, theta_beta, trained_at, n_training_samples
       FROM embedding_prior_weights
       WHERE org_id = $org_id
       ORDER BY trained_at DESC
       LIMIT 1`,
      { org_id: orgId },
    );
    const rows = Array.isArray(result) ? result : [];
    row = rows.length > 0 ? (rows[0] as EmbeddingPriorWeightsRow) : null;
  } catch (err) {
    logger.debug('embedding_prior_db_query_failed', {
      org_id: orgId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Cache (positive or negative) so we don't hammer the DB on misses
  try {
    const payload = row ? JSON.stringify(row) : JSON.stringify({ _empty: true });
    await redis.set(cacheKey(orgId), payload, CACHE_TTL_SECONDS);
  } catch (err) {
    logger.debug('embedding_prior_cache_set_failed', {
      org_id: orgId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return row;
}

/**
 * Compute an embedding-conditioned Beta(α₀, β₀) prior for a new (signature,
 * template) cell. Returns the uniform fallback Beta(1, 1) on any error path.
 *
 * @param embedding  dense feature vector (e.g. MiniLM-L6-v2, 384-dim)
 * @param orgId      tenant id; latest model_version for this org is loaded
 */
export async function computeEmbeddingConditionedPrior(
  embedding: number[],
  orgId: string,
): Promise<EmbeddingConditionedPrior> {
  if (!Array.isArray(embedding) || embedding.length === 0) return FALLBACK;

  const row = await loadLatestModel(orgId);
  if (!row) return FALLBACK;

  // Theta length must be feature_dim + 1 (intercept + per-dim weights)
  const expectedThetaLen = row.feature_dim + 1;
  if (
    !Array.isArray(row.theta_alpha) ||
    !Array.isArray(row.theta_beta) ||
    row.theta_alpha.length !== expectedThetaLen ||
    row.theta_beta.length !== expectedThetaLen
  ) {
    logger.debug('embedding_prior_theta_shape_mismatch', {
      org_id: orgId,
      model_version: row.model_version,
      feature_dim: row.feature_dim,
      theta_alpha_len: row.theta_alpha?.length,
      theta_beta_len: row.theta_beta?.length,
    });
    return FALLBACK;
  }

  if (!isValidEmbedding(embedding, row.feature_dim)) {
    logger.debug('embedding_prior_embedding_invalid', {
      org_id: orgId,
      model_version: row.model_version,
      expected_dim: row.feature_dim,
      got_dim: embedding.length,
    });
    return FALLBACK;
  }

  const rawAlpha = dotPlusIntercept(row.theta_alpha, embedding);
  const rawBeta = dotPlusIntercept(row.theta_beta, embedding);

  const α0 = clamp(relu(rawAlpha), ALPHA_BETA_MIN, ALPHA_BETA_MAX);
  const β0 = clamp(relu(rawBeta), ALPHA_BETA_MIN, ALPHA_BETA_MAX);

  if (!Number.isFinite(α0) || !Number.isFinite(β0)) return FALLBACK;

  const result: EmbeddingConditionedPrior = {
    α0,
    β0,
    source: 'embedding_model',
    model_version: row.model_version,
  };

  logger.debug('embedding_prior_applied', {
    event: 'embedding_prior_applied',
    org_id: orgId,
    model_version: row.model_version,
    feature_dim: row.feature_dim,
    α0,
    β0,
  });

  return result;
}

/**
 * Test-only: clear the Redis cache for a given org. Production code should
 * not call this; the TTL handles invalidation.
 */
export async function _clearEmbeddingPriorCache(orgId: string): Promise<void> {
  try {
    // ioredis exposes .del via getClient; use a minimal generic set-empty-with-1s-ttl
    // workaround if del is unavailable on the wrapper.
    const client = (redis as unknown as { getClient: () => { del: (k: string) => Promise<number> } }).getClient();
    await client.del(cacheKey(orgId));
  } catch {
    /* swallow */
  }
}
