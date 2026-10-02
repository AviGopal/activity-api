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
import { withDeadline } from './deadline';

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
    // ★ A TUNING LOOKUP NEEDS ITS OWN DEADLINE. `surrealDB.query` carries none, and against an
    //   unreachable or saturated store it does not fail fast — it hangs. Every caller here is
    //   asking for a POLICY VALUE with a documented fallback, so waiting is never the right
    //   behaviour: the fallback is a correct answer and the cache already tolerates staleness.
    //
    //   Measured 2026-08-18: a refresh of POSTERIOR_COALESCE issued from the flush timer hung
    //   on this query and stalled `applyOutcomeToPosteriors` past 5s — a policy read blocking
    //   a CREDIT WRITE. The same store saturation that already loses reach verdicts would then
    //   also stall the code path that records them.
    //
    //   1.5s is far above a healthy lookup (this table holds a handful of rows and answers in
    //   single-digit ms) and far below any caller's tolerance for delay.
    const rows = await Promise.race([
      surrealDB.query<{ param_value: number | null }>(
        'SELECT `value` AS param_value FROM substrate_tuning_param WHERE name = $name LIMIT 1',
        { name },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`tuning-param lookup exceeded deadline for '${name}'`)), 1_500),
      ),
    ]);
    const raw: unknown = rows && rows.length > 0 ? rows[0].param_value : null;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      tableValue = raw;
    } else if (raw !== null && raw !== undefined) {
      // `value` is `float | string` once string-valued params exist (migrations 203/215): a row a
      // numeric reader cannot use is REFUSED loudly, never coerced, and the env/default stands.
      logger.warn('tuning-param row is not a finite number; using env/default', {
        event: 'tuning_param_type_mismatch',
        name,
        found_type: typeof raw,
      });
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

/**
 * writeTuningParam — author a runtime-consumable tuning parameter (seam 2a write-back).
 *
 * UPSERTs a single `substrate_tuning_param` row keyed by `name` (the table has a
 * UNIQUE index on `name`, migration 152), sets its float `value`, stamps
 * `updated_at`, and records `updated_by` + `evidence` for audit. After the write
 * succeeds it drops this param's TTL cache entry so `getTuningParam(name, …)`
 * observes the new value on its very next call (no 30s wait, no restart).
 *
 * The `name` UNIQUE index makes a bare CREATE fail on the second write, so we
 * UPSERT by that natural key. Never throws to the caller of a write route beyond
 * a rejected promise; callers translate a rejection into a 500.
 */
export async function writeTuningParam(
  name: string,
  value: number,
  meta: { updated_by?: string; evidence?: string } = {},
): Promise<void> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('writeTuningParam: name must be a non-empty string');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('writeTuningParam: value must be a finite number');
  }
  // UPSERT by the UNIQUE `name` key. `value` is backtick-quoted because it is a
  // reserved word in SurrealDB's statement grammar.
  //
  // ★ NULL IS NOT NONE. `updated_by` and `evidence` are `option<string>`
  //   (migration 152). SurrealDB accepts NONE for those and REJECTS NULL — and
  //   the two UPSERT branches diverge catastrophically on that rejection: the
  //   UPDATE branch raises loudly, but the CREATE branch WRITES NOTHING AND
  //   RAISES NOTHING, returning an empty result set. The awaited promise
  //   resolves and the caller logs success over a row that does not exist.
  //
  //   Measured: accelerator-flag-tick calls this with no meta at all, so
  //   SF_BLEND took the silent create branch on every hourly tick — logging
  //   `flipped=true` forever while every reader resolved null -> default 0 and
  //   psi blending stayed off. Reproduced on two independent deployments.
  //
  //   Fix: omit the keys entirely when absent (an unbound param is NONE) rather
  //   than coalescing to null.
  const params: Record<string, unknown> = { name, value };
  const assignments = ['name = $name', '`value` = $value', 'updated_at = time::now()'];
  if (typeof meta.updated_by === 'string') {
    assignments.push('updated_by = $updated_by');
    params.updated_by = meta.updated_by;
  }
  if (typeof meta.evidence === 'string') {
    assignments.push('evidence = $evidence');
    params.evidence = meta.evidence;
  }
  await surrealDB.query(
    `UPSERT substrate_tuning_param SET ${assignments.join(', ')} WHERE name = $name`,
    params,
  );
  // Drop just this param's cache entry so the next getTuningParam observes it.
  cache.delete(name);

  // ★ READ BACK AND THROW ON MISMATCH. A write path that can silently no-op is
  //   exactly how this defect survived: the only honest way to report success
  //   is to observe the row. This is one extra indexed lookup on a table that
  //   holds a handful of rows, on a path that runs hourly at most.
  const check = await surrealDB.query<{ param_value: number | null }>(
    'SELECT `value` AS param_value FROM substrate_tuning_param WHERE name = $name LIMIT 1',
    { name },
  );
  const stored = check?.[0]?.param_value;
  if (typeof stored !== 'number' || stored !== value) {
    throw new Error(
      `writeTuningParam: '${name}' did not persist (wrote ${value}, read back ${JSON.stringify(stored)})`,
    );
  }
}

/** Test hook — drop the cache so a freshly-authored row is observed immediately. */
export function __clearTuningParamCache(): void {
  cache.clear();
}

// ─── list-valued tuning params ──────────────────────────────────────────────
//
// A tuning param whose value is a comma-separated list of ids (the idiom
// CREDIT_PROPAGATION_EXCLUDED_ANCESTORS established in lib/posterior-update.ts), read at use time
// through a short TTL cache with the same deadline and fail-open discipline as getTuningParam.
// Needs `substrate_tuning_param.value` to accept strings (migration 215 / the in-flight 203).
// An absent row or a non-string value is the EMPTY list. A failed or timed-out read is UNKNOWN,
// not empty: it is never cached, and it answers with the last list successfully read for that name
// (empty only if none ever was). On the hub a 1.5s read missed under load, [] was cached for the TTL,
// and the retention valve read it as "no telemetry declared" and silently skipped the telemetry drain.
const listCache = new Map<string, { value: string[]; expiresAt: number }>();
const listLastGood = new Map<string, string[]>();
const LIST_READ_TIMEOUT_S = 5;

/**
 * The telemetry trace class (migration 215): activity ids whose executions are telemetry, not
 * gradable executions. Read by trace retention (drained first) and the shape counter (never counted).
 */
export const TRACE_TELEMETRY_ACTIVITIES_PARAM = 'TRACE_RETENTION_TELEMETRY_ACTIVITIES';

export async function getTuningParamList(name: string): Promise<string[]> {
  const now = Date.now();
  const cached = listCache.get(name);
  if (cached && cached.expiresAt > now) return cached.value;
  let value: string[] = [];
  try {
    const rows = await withDeadline(
      surrealDB.query<{ param_value: unknown }>(
        `SELECT \`value\` AS param_value FROM substrate_tuning_param WHERE name = $name LIMIT 1 TIMEOUT ${LIST_READ_TIMEOUT_S}s`,
        { name },
      ),
      (LIST_READ_TIMEOUT_S + 1) * 1_000,
      `tuning-param list '${name}'`,
    );
    const raw = Array.isArray(rows) && rows.length > 0 ? rows[0]?.param_value : null;
    if (typeof raw === 'string') {
      value = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (raw !== null && raw !== undefined) {
      // A list reader refuses a non-string row loudly (a numeric value is not a list).
      logger.warn('tuning-param list row is not a string; using the empty list', {
        event: 'tuning_param_list_type_mismatch',
        name,
        found_type: typeof raw,
      });
    }
  } catch (err) {
    const lastGood = listLastGood.get(name);
    if (Array.isArray(lastGood) && lastGood.length > 0) {
      // Back off for one TTL using the last known-good list so callers do not hammer the DB while it is unhealthy.
      // Never cache [].
      listCache.set(name, { value: lastGood, expiresAt: now + CACHE_TTL_MS });
      logger.warn('tuning-param list lookup failed; answering with the last known-good list (cached for TTL)', {
        event: 'tuning_param_list_read_failed',
        name,
        last_good: lastGood,
        error: err instanceof Error ? err.message : String(err),
      });
      return lastGood;
    }
    logger.warn('tuning-param list lookup failed; answering with the last known-good list (not cached)', {
      event: 'tuning_param_list_read_failed',
      name,
      last_good: lastGood ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    return lastGood ?? [];
  }
  listLastGood.set(name, value);
  listCache.set(name, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/** Test hook — drop the list cache so a freshly-authored row is observed immediately. */
export function __clearTuningParamListCache(): void {
  listCache.clear();
  listLastGood.clear();
}
