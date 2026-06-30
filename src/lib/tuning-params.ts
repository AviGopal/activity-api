/**
 * tuning-params — runtime-consumable learning-policy hyperparameters (seam 3a).
 *
 * The Thompson learner historically froze its hyperparameters at process start,
 * reading them from `process.env` (or a hardcoded literal) exactly once. This
 * helper lets those constants be CONSUMED as data: each named parameter is read
 * from the `substrate_tuning_param` table (migration 152) through a short
 * in-memory TTL cache, so the substrate can author a tuning row and have the
 * learner pick it up within one TTL window — no restart, no env mutation.
 *
 * BEHAVIOR-PRESERVING CONTRACT (the prime directive of this seam):
 *   getTuningParam(name, envFallback, defaultValue) resolves in strict order:
 *     1. the table row for `name`, IFF it exists and carries a finite numeric value
 *     2. else Number(envFallback), IFF envFallback is a non-empty, finite number
 *     3. else defaultValue
 *   With an EMPTY / ABSENT table (the shipped state), step 1 never fires, so the
 *   result is identical to today: the env value if set, otherwise the in-code
 *   default. Any DB error is swallowed and falls through to the env/default path —
 *   a tuning lookup can never break trace ingestion.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

// Short TTL — tuning changes are rare and non-urgent; 30s keeps the hot trace-ingest
// path off the DB for the overwhelming majority of reads while still letting an
// authored tuning row take effect within one window.
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  /** The resolved table value, or null when the table had no usable row. */
  value: number | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function resolveFallback(envFallback: string | undefined, defaultValue: number): number {
  if (envFallback !== undefined && envFallback !== '') {
    const parsed = Number(envFallback);
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultValue;
}

/**
 * Resolve a tuning parameter, preferring an authored `substrate_tuning_param` row,
 * then the env fallback, then the in-code default. See the behavior-preserving
 * contract above. Never throws.
 */
export async function getTuningParam(
  name: string,
  envFallback: string | undefined,
  defaultValue: number,
): Promise<number> {
  const now = Date.now();
  const cached = cache.get(name);
  if (cached && cached.expiresAt > now) {
    return cached.value ?? resolveFallback(envFallback, defaultValue);
  }

  let tableValue: number | null = null;
  try {
    // NOTE: `value` is a reserved word in SurrealDB's SELECT grammar (it collides
    // with the VALUE projection clause), so it must be backtick-quoted and aliased
    // to a non-reserved name before it can be read as a plain column.
    const rows = await surrealDB.query<{ param_value: number | null }>(
      'SELECT `value` AS param_value FROM substrate_tuning_param WHERE name = $name LIMIT 1',
      { name },
    );
    if (rows && rows.length > 0 && typeof rows[0].param_value === 'number' && Number.isFinite(rows[0].param_value)) {
      tableValue = rows[0].param_value;
    }
  } catch (err) {
    // Table absent (pre-migration) or transient DB error: behave exactly as the
    // env-frozen code did. Debug-only — this is an expected steady state until a
    // tuning row is authored, and must never spam under load.
    logger.debug('tuning-param lookup fell back to env/default', {
      event: 'tuning_param_fallback',
      name,
      error: err instanceof Error ? err.message : String(err),
    });
    tableValue = null;
  }

  cache.set(name, { value: tableValue, expiresAt: now + CACHE_TTL_MS });
  return tableValue ?? resolveFallback(envFallback, defaultValue);
}

/** Test hook — drop the cache so a freshly-authored row is observed immediately. */
export function __clearTuningParamCache(): void {
  cache.clear();
}
