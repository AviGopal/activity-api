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
import { getTuningParam } from '../lib/tuning-params';

const CACHE_KEY_PREFIX = 'activity:template:';
const CACHE_LIST_KEY = 'activity:templates:list';

// ---------------------------------------------------------------------------
// IN-PROCESS TEMPLATE CATALOGUE (value-per-cost-selection 4b.2).
//
// GET /v2/activities/templates was measured at ~49 listings/min, every one a DB round trip:
// paginated requests skip the Redis list above, and each page ran an unindexed
// `ORDER BY created_at` plus two metrics enrichments (~1-2 s). This holds the FULL enriched,
// visibility-filtered catalogue per visibility key, so every limit/offset slice is served
// from memory and the DB is read at most once per key per TTL.
//
// KEY: every input that changes which rows the listing and its count return — orgId,
// projectId, accountId, scope filter, execution_type. Not for RBAC-JWT queries (their rows
// depend on $auth) nor for FTS searches. `category` is applied by the route after slicing,
// exactly as on its DB path, so it is not part of the key.
// TTL: the `template_catalogue_cache_ttl_ms` tuning param (substrate_tuning_param, read at use
// time through getTuningParam), default 60 s; a value <= 0 disables the cache.
// INVALIDATION: both helpers below clear every key, because one template mutation can change
// any visibility set. Writers that bypass the helpers are bounded by the TTL.
// ---------------------------------------------------------------------------

export interface TemplateCatalogue<T> {
  templates: T[];
  total: number;
}

interface CatalogueEntry {
  value: TemplateCatalogue<unknown>;
  expiresAt: number;
}

export const TEMPLATE_CATALOGUE_TTL_PARAM = 'template_catalogue_cache_ttl_ms';
const TEMPLATE_CATALOGUE_DEFAULT_TTL_MS = 60_000;
/** Row cap for one catalogue load; a load that reaches it may be truncated and is not served. */
export const TEMPLATE_CATALOGUE_MAX_ROWS = 20_000;

const catalogueCache = new Map<string, CatalogueEntry>();
const catalogueInflight = new Map<string, Promise<TemplateCatalogue<unknown>>>();
// A failed load is not retried for min(TTL, 10 s): a load that fails every time must not turn
// each listing into a full-catalogue attempt followed by the DB page.
const catalogueFailedUntil = new Map<string, number>();
let catalogueGeneration = 0;

export function templateCatalogueKey(parts: {
  orgId?: string | null;
  projectId?: string | null;
  accountId?: string | null;
  scope?: string | null;
  executionType?: string | null;
}): string {
  return JSON.stringify([
    parts.orgId ?? null,
    parts.projectId ?? null,
    parts.accountId ?? null,
    parts.scope ?? null,
    parts.executionType ?? null,
  ]);
}

/** Drop every cached catalogue. A load in flight when this runs is served but not stored. */
export function clearTemplateCatalogue(): void {
  catalogueGeneration++;
  catalogueCache.clear();
  catalogueInflight.clear();
  catalogueFailedUntil.clear();
}

/**
 * The cached catalogue for `key`, loaded with `load` on a miss; concurrent misses share one
 * load. Returns null when the cache is disabled or the load fails, so the caller takes its
 * own DB path. Never throws.
 */
export async function getTemplateCatalogue<T>(
  key: string,
  load: () => Promise<TemplateCatalogue<T>>,
): Promise<TemplateCatalogue<T> | null> {
  const ttlMs = await getTuningParam(TEMPLATE_CATALOGUE_TTL_PARAM, undefined, TEMPLATE_CATALOGUE_DEFAULT_TTL_MS);
  if (!(ttlMs > 0)) return null;
  const hit = catalogueCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as TemplateCatalogue<T>;
  const failedUntil = catalogueFailedUntil.get(key);
  if (failedUntil !== undefined && failedUntil > Date.now()) return null;
  let pending = catalogueInflight.get(key);
  if (!pending) {
    const generation = catalogueGeneration;
    const started: Promise<TemplateCatalogue<unknown>> = load().then((value) => {
      if (generation === catalogueGeneration) {
        catalogueCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    });
    catalogueInflight.set(key, started);
    started.then(
      () => { if (catalogueInflight.get(key) === started) catalogueInflight.delete(key); },
      () => { if (catalogueInflight.get(key) === started) catalogueInflight.delete(key); },
    );
    pending = started;
  }
  try {
    return (await pending) as TemplateCatalogue<T>;
  } catch (err) {
    catalogueFailedUntil.set(key, Date.now() + Math.min(ttlMs, 10_000));
    logger.warn('Template catalogue load failed; falling back to the DB path', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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
  clearTemplateCatalogue();
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
  clearTemplateCatalogue();
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
