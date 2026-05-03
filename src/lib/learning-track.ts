/**
 * Learning-track classification helper.
 *
 * Resolves the learning_track for a given activity_id via a 60s in-process LRU
 * cache. Cache misses query the `activity` table (with legacy `activity_template`
 * fallback). Any error returns 'unclassified' so the call site falls through to
 * the default write path — no trace is ever lost due to a lookup failure.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

export type LearningTrack = 'unclassified' | 'learning' | 'system';

interface CacheEntry {
  value: LearningTrack;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 1_000;
// Rate-limit warn log: emit at most one per 60s per activity_id
const warnedAt = new Map<string, number>();

const cache = new Map<string, CacheEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
}

function pruneIfFull(): void {
  if (cache.size < CACHE_MAX_SIZE) return;
  // Evict oldest quarter by insertion order (Map preserves insertion order)
  const deleteCount = Math.ceil(CACHE_MAX_SIZE / 4);
  let i = 0;
  for (const k of cache.keys()) {
    cache.delete(k);
    if (++i >= deleteCount) break;
  }
}

export async function resolveLearningTrack(activity_id: string): Promise<LearningTrack> {
  const now = Date.now();
  const cached = cache.get(activity_id);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    // Try paradigm `activity` table first (canonical store for templates)
    const rows = await surrealDB.query<{ learning_track: string | null }>(
      `SELECT learning_track FROM activity WHERE id = $id LIMIT 1`,
      { id: activity_id }
    );

    let track: LearningTrack | null = null;
    if (rows && rows.length > 0 && rows[0].learning_track != null) {
      const raw = rows[0].learning_track;
      if (raw === 'learning' || raw === 'system' || raw === 'unclassified') {
        track = raw;
      }
    }

    if (track === null) {
      // Fallback: legacy activity_template view (alias over activity, but belt-and-suspenders)
      const legacyRows = await surrealDB.query<{ learning_track: string | null }>(
        `SELECT learning_track FROM activity_template WHERE id = $id LIMIT 1`,
        { id: activity_id }
      );
      if (legacyRows && legacyRows.length > 0 && legacyRows[0].learning_track != null) {
        const raw = legacyRows[0].learning_track;
        if (raw === 'learning' || raw === 'system' || raw === 'unclassified') {
          track = raw;
        }
      }
    }

    const resolved: LearningTrack = track ?? 'unclassified';

    // Prune before insert so the cache stays bounded
    evictExpired();
    pruneIfFull();
    cache.set(activity_id, { value: resolved, expiresAt: now + CACHE_TTL_MS });
    return resolved;
  } catch (err) {
    const lastWarn = warnedAt.get(activity_id) ?? 0;
    if (now - lastWarn > 60_000) {
      warnedAt.set(activity_id, now);
      logger.warn('learning-track lookup failed; falling through to default', { activity_id, err: err instanceof Error ? err.message : String(err) });
    }
    return 'unclassified';
  }
}

/**
 * Invalidate the cache for a specific activity_id (or flush all when called
 * with no argument). Called by the classifier after writing a transition.
 */
export function bustLearningTrackCache(activity_id?: string): void {
  if (activity_id === undefined) {
    cache.clear();
  } else {
    cache.delete(activity_id);
  }
}
