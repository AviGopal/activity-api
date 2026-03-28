/**
 * Pattern Store
 *
 * Manages storage and retrieval of deterministic patterns.
 * Patterns are extracted from successful LLM resolutions
 * and used for Tier 1 (exact match) and Tier 2 (interpolation) resolution.
 *
 * Uses Redis caching for hot patterns to minimize database queries.
 */

import { surrealDB, queryWithAuth } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface Pattern {
  id: string;
  pattern_id: string;
  org_id: string;
  impulse_hash: string;
  impulse_shape?: Record<string, any>;
  template: Record<string, any>;
  template_type: 'exact' | 'interpolate' | 'parametric';
  template_variables?: Array<{ name: string; type: string; required?: boolean }>;
  executions: number;
  successes: number;
  failures: number;
  success_rate: number;
  result_consistency: number;
  status: 'active' | 'deprecated' | 'testing';
  public: boolean;
  similarity?: number; // Populated for similar matches
  last_used_at?: string;
  created_at: string;
  updated_at: string;
}

export interface PatternMatch extends Pattern {
  similarity: number;
}

// ============================================================================
// Redis Cache Configuration
// ============================================================================

const CACHE_TTL_SECONDS = 3600; // 1 hour cache TTL
const CACHE_PREFIX = 'pattern:';

/**
 * Get cache key for a pattern by impulse hash
 */
function getCacheKey(impulseHash: string): string {
  return `${CACHE_PREFIX}${impulseHash}`;
}

// ============================================================================
// Cache Operations
// ============================================================================

/**
 * Get pattern from Redis cache
 */
async function getCachedPattern(impulseHash: string): Promise<Pattern | null> {
  const redis = RedisClient.getInstance();
  const key = getCacheKey(impulseHash);

  try {
    const cached = await redis.get(key);
    if (cached) {
      logger.debug('[PatternStore] Cache hit', { impulseHash: impulseHash.substring(0, 16) });
      return JSON.parse(cached);
    }
  } catch (error) {
    logger.warn('[PatternStore] Cache read error', { error });
  }

  return null;
}

/**
 * Store pattern in Redis cache
 */
async function cachePattern(impulseHash: string, pattern: Pattern): Promise<void> {
  const redis = RedisClient.getInstance();
  const key = getCacheKey(impulseHash);

  try {
    await redis.set(key, JSON.stringify(pattern), CACHE_TTL_SECONDS);
    logger.debug('[PatternStore] Pattern cached', { impulseHash: impulseHash.substring(0, 16) });
  } catch (error) {
    logger.warn('[PatternStore] Cache write error', { error });
  }
}

/**
 * Invalidate pattern cache
 */
export async function invalidatePatternCache(impulseHash: string): Promise<void> {
  const redis = RedisClient.getInstance();
  const key = getCacheKey(impulseHash);

  try {
    await redis.del(key);
    logger.debug('[PatternStore] Cache invalidated', { impulseHash: impulseHash.substring(0, 16) });
  } catch (error) {
    logger.warn('[PatternStore] Cache invalidation error', { error });
  }
}

/**
 * Invalidate all pattern caches (for bulk updates)
 */
export async function invalidateAllPatternCaches(): Promise<void> {
  const redis = RedisClient.getInstance();
  const client = redis.getClient();

  try {
    const keys = await client.keys(`${CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await client.del(...keys);
      logger.info('[PatternStore] All pattern caches invalidated', { count: keys.length });
    }
  } catch (error) {
    logger.warn('[PatternStore] Bulk cache invalidation error', { error });
  }
}

// ============================================================================
// Find Exact Match
// ============================================================================

/**
 * Find a pattern that exactly matches the given impulse hash.
 *
 * @param impulseHash - SHA-256 hash of the impulse shape
 * @param jwtToken - Optional JWT for org-scoped queries
 * @returns The matching pattern or null
 */
export async function findExact(
  impulseHash: string,
  jwtToken?: string
): Promise<Pattern | null> {
  // Check cache first
  const cached = await getCachedPattern(impulseHash);
  if (cached) {
    // Verify pattern is still active and meets thresholds
    if (cached.status === 'active' && cached.success_rate > 0.85 && cached.executions >= 5) {
      // Update last_used_at asynchronously
      updateLastUsed(cached.id).catch(() => {});
      return cached;
    }
  }

  // Query database
  try {
    const query = `
      SELECT * FROM pattern
      WHERE impulse_hash = $impulseHash
        AND status = 'active'
      ORDER BY success_rate DESC, executions DESC
      LIMIT 1
    `;

    let patterns: Pattern[];
    if (jwtToken) {
      // User-scoped query (includes public patterns via PERMISSIONS)
      patterns = await queryWithAuth<Pattern>(jwtToken, query, { impulseHash });
    } else {
      // System query (all patterns)
      patterns = await surrealDB.query<Pattern>(query, { impulseHash });
    }

    if (patterns.length > 0) {
      const pattern = patterns[0];

      // Cache the result
      await cachePattern(impulseHash, pattern);

      // Update last_used_at asynchronously
      updateLastUsed(pattern.id).catch(() => {});

      logger.info('[PatternStore] Exact match found', {
        patternId: pattern.pattern_id,
        successRate: pattern.success_rate,
        executions: pattern.executions
      });

      return pattern;
    }
  } catch (error) {
    logger.error('[PatternStore] Error finding exact pattern', { error });
  }

  return null;
}

// ============================================================================
// Find Similar Patterns
// ============================================================================

/**
 * Find patterns similar to the given impulse hash.
 * Uses a similarity threshold to filter results.
 *
 * Note: This is a simplified implementation. A production system would use
 * vector similarity search (e.g., with pgvector or a dedicated vector DB).
 *
 * Current approach: Find patterns with similar prefix (first N characters of hash)
 * and compare full impulse shapes for structural similarity.
 *
 * @param impulseHash - SHA-256 hash of the impulse shape
 * @param threshold - Minimum similarity score (0-1)
 * @param jwtToken - Optional JWT for org-scoped queries
 * @returns The most similar pattern above threshold, or null
 */
export async function findSimilar(
  impulseHash: string,
  threshold: number = 0.85,
  jwtToken?: string
): Promise<PatternMatch | null> {
  // For now, we use prefix matching as a simple similarity heuristic
  // A real implementation would use vector embeddings

  // Try progressively shorter prefixes
  const prefixLengths = [16, 12, 8];

  for (const prefixLen of prefixLengths) {
    const prefix = impulseHash.substring(0, prefixLen);

    try {
      const query = `
        SELECT * FROM pattern
        WHERE impulse_hash CONTAINS $prefix
          AND status = 'active'
          AND success_rate >= $minSuccessRate
          AND executions >= 5
        ORDER BY success_rate DESC, executions DESC
        LIMIT 10
      `;

      let patterns: Pattern[];
      if (jwtToken) {
        patterns = await queryWithAuth<Pattern>(jwtToken, query, {
          prefix,
          minSuccessRate: threshold
        });
      } else {
        patterns = await surrealDB.query<Pattern>(query, {
          prefix,
          minSuccessRate: threshold
        });
      }

      // Calculate similarity scores
      const matches: PatternMatch[] = patterns.map(pattern => ({
        ...pattern,
        similarity: calculateSimilarity(impulseHash, pattern.impulse_hash)
      }));

      // Filter by threshold and sort by similarity
      const filtered = matches
        .filter(m => m.similarity >= threshold)
        .sort((a, b) => b.similarity - a.similarity);

      if (filtered.length > 0) {
        const best = filtered[0];

        logger.info('[PatternStore] Similar match found', {
          patternId: best.pattern_id,
          similarity: best.similarity,
          successRate: best.success_rate
        });

        // Update last_used_at asynchronously
        updateLastUsed(best.id).catch(() => {});

        return best;
      }
    } catch (error) {
      logger.warn('[PatternStore] Error finding similar patterns', { error, prefixLen });
    }
  }

  return null;
}

/**
 * Calculate similarity between two impulse hashes.
 * Simple implementation based on common prefix length.
 *
 * @param hash1 - First hash
 * @param hash2 - Second hash
 * @returns Similarity score (0-1)
 */
function calculateSimilarity(hash1: string, hash2: string): number {
  if (hash1 === hash2) return 1.0;

  // Count matching characters from the start
  let commonPrefix = 0;
  const minLen = Math.min(hash1.length, hash2.length);

  for (let i = 0; i < minLen; i++) {
    if (hash1[i] === hash2[i]) {
      commonPrefix++;
    } else {
      break;
    }
  }

  // Similarity based on common prefix length
  // SHA-256 is 64 hex characters
  return commonPrefix / 64;
}

// ============================================================================
// Pattern Lifecycle
// ============================================================================

/**
 * Update the last_used_at timestamp for a pattern
 */
async function updateLastUsed(patternId: string): Promise<void> {
  try {
    await surrealDB.query(
      `UPDATE $patternId SET last_used_at = time::now(), updated_at = time::now()`,
      { patternId }
    );
  } catch (error) {
    logger.warn('[PatternStore] Failed to update last_used_at', { patternId, error });
  }
}

/**
 * Record a pattern execution result (success or failure)
 */
export async function recordPatternExecution(
  patternId: string,
  success: boolean
): Promise<void> {
  try {
    if (success) {
      await surrealDB.query(
        `UPDATE $patternId SET
          executions = executions + 1,
          successes = successes + 1,
          success_rate = (successes + 1) / (executions + 1),
          last_used_at = time::now(),
          updated_at = time::now()`,
        { patternId }
      );
    } else {
      await surrealDB.query(
        `UPDATE $patternId SET
          executions = executions + 1,
          failures = failures + 1,
          success_rate = successes / (executions + 1),
          last_used_at = time::now(),
          updated_at = time::now()`,
        { patternId }
      );
    }

    // Invalidate cache since stats changed
    // We'd need to look up the impulse_hash first, so just log for now
    logger.debug('[PatternStore] Pattern execution recorded', { patternId, success });
  } catch (error) {
    logger.error('[PatternStore] Failed to record pattern execution', { patternId, error });
  }
}

/**
 * Create a new pattern
 */
export async function createPattern(
  pattern: Omit<Pattern, 'id' | 'created_at' | 'updated_at'>
): Promise<Pattern | null> {
  try {
    const now = new Date().toISOString();

    const result = await surrealDB.query<Pattern>(
      `CREATE pattern CONTENT {
        pattern_id: $patternId,
        org_id: $orgId,
        impulse_hash: $impulseHash,
        impulse_shape: $impulseShape,
        template: $template,
        template_type: $templateType,
        template_variables: $templateVariables,
        executions: $executions,
        successes: $successes,
        failures: $failures,
        success_rate: $successRate,
        result_consistency: $resultConsistency,
        status: $status,
        public: $public,
        created_at: $now,
        updated_at: $now
      }`,
      {
        patternId: pattern.pattern_id,
        orgId: pattern.org_id,
        impulseHash: pattern.impulse_hash,
        impulseShape: pattern.impulse_shape || null,
        template: pattern.template,
        templateType: pattern.template_type,
        templateVariables: pattern.template_variables || null,
        executions: pattern.executions,
        successes: pattern.successes,
        failures: pattern.failures,
        successRate: pattern.success_rate,
        resultConsistency: pattern.result_consistency,
        status: pattern.status,
        public: pattern.public,
        now
      }
    );

    if (result.length > 0) {
      logger.info('[PatternStore] Pattern created', { patternId: pattern.pattern_id });
      return result[0];
    }
  } catch (error) {
    logger.error('[PatternStore] Failed to create pattern', { error });
  }

  return null;
}

/**
 * Deprecate a pattern (soft delete)
 */
export async function deprecatePattern(patternId: string): Promise<boolean> {
  try {
    await surrealDB.query(
      `UPDATE $patternId SET status = 'deprecated', updated_at = time::now()`,
      { patternId }
    );

    // Invalidate cache - we'd need the impulse_hash
    // For now, just log
    logger.info('[PatternStore] Pattern deprecated', { patternId });
    return true;
  } catch (error) {
    logger.error('[PatternStore] Failed to deprecate pattern', { patternId, error });
    return false;
  }
}
