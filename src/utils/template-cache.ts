/**
 * Template Redis cache invalidation helpers.
 *
 * Background: the activity-api Redis cache has two layers — a per-template
 * key (`activity:template:<id>`, holding the hydrated template body) and a
 * LIST set (`activity:templates:list`, holding all known template ids).
 *
 * Earlier mutation sites only invalidated one of the two, depending on
 * which symptom the author noticed first. Stale GETs persisted under
 * `activity:template:<id>` even when LIST was busted, and vice versa,
 * because writes/UPSERTs/promotes touch the row itself but the LIST key
 * happens to be the obvious one (it's what list-mode GETs hit).
 *
 * Rule (vessel_construction_pattern / cache_invalidation_per_key_completeness):
 * when a mutation affects N cache keys, invalidate all N — not just the
 * obvious one. For template mutations, that's *both* the per-template
 * key and the LIST set.
 *
 * Callers should use one of:
 *   - `invalidateTemplateCache(templateId)` — covers both LIST and per-template
 *   - `invalidateTemplateCacheForNew(templateId)` — only LIST + per-template
 *      drop (UPSERTs may overwrite an existing per-template value); kept as
 *      a named alias so call sites are self-documenting.
 *
 * The helpers are best-effort: Redis failures are logged but never thrown
 * to the caller, so cache hygiene never blocks a write that already
 * succeeded in SurrealDB.
 */

import { RedisClient } from '../db/redis';
import { logger } from './logger';

const CACHE_KEY_PREFIX = 'activity:template:';
const CACHE_LIST_KEY = 'activity:templates:list';

/**
 * Invalidate every Redis cache key affected by a template mutation.
 *
 * Drops both:
 *   - `activity:template:<templateId>`  (per-template hydrated body)
 *   - `activity:templates:list`         (LIST set of known template ids)
 *
 * Use after: POST /templates (UPSERT), POST /templates/:id/promote,
 * POST /templates/auto-promote, POST /:id/variants, POST /create-goal-seeking,
 * impulses.ts activityTemplate_update / _deprecate.
 */
export async function invalidateTemplateCache(templateId: string): Promise<void> {
  const redis = RedisClient.getInstance();
  try {
    await Promise.all([
      redis.del(CACHE_LIST_KEY),
      redis.del(`${CACHE_KEY_PREFIX}${templateId}`),
    ]);
    logger.debug('Template cache invalidated', { templateId });
  } catch (err) {
    logger.warn('Template cache invalidation failed (non-blocking)', {
      templateId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Invalidate cache for a set of template ids in one shot. Used by bulk
 * promoters that touch many rows.
 */
export async function invalidateTemplateCacheMany(templateIds: string[]): Promise<void> {
  if (templateIds.length === 0) return;
  const redis = RedisClient.getInstance();
  try {
    await redis.del(CACHE_LIST_KEY);
    await Promise.all(
      templateIds.map((id) => redis.del(`${CACHE_KEY_PREFIX}${id}`)),
    );
    logger.debug('Template cache invalidated (bulk)', { count: templateIds.length });
  } catch (err) {
    logger.warn('Bulk template cache invalidation failed (non-blocking)', {
      count: templateIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
