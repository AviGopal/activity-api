/**
 * One-time seed of shape_score_counter by REPLAYING classifyReach over the executions the store still
 * retains (lib/shape-score-counter.ts). Not from v_shape_conditioned_score: that view counted exit
 * status, which is exactly what the counter exists to replace.
 *
 * It seeds ONLY the gradings variant_performance_metrics actually received (seedGradings): the
 * insert-occasion verdict, plus a late verdict only where the row carries reach_graded:true. A late
 * reach tag without that stamp (the window when POST /reach persisted verdicts but never graded them)
 * is NOT counted, so the counter equals VPM at birth.
 *
 * Bounded, resumable, idempotent:
 *   - pages `execution` oldest-first on idx_execution_executed_at (no ORDER BY: index range order),
 *     `pageSize` rows per page, at most `budgetMs` per tick;
 *   - progress (cursor, totals, done) lives in shape_score_counter_seed:v1, so a restart resumes;
 *   - every counted execution gets its shape_score_counted marker in the same transaction as the
 *     increment — the same key the live path uses — so the seed and live grading can overlap, and a
 *     re-run after a crash, without double-counting anything.
 * Executions already deleted by retention cannot be replayed; their evidence is lost (it was only
 * ever exit status in the view).
 *
 * DOES NOT COMPETE WITH THE RETENTION DRAIN (2026-10-01). On the hub each tick scanned 1,000 rows in
 * 37-87 s and counted ~2: ~68% of `execution` is the telemetry class, which the live counter never
 * counts (posterior-update skips accepted telemetry ids), while the retention drain needed the same
 * store to delete those very rows. So the seed
 *   - skips the accepted telemetry class (resolveTelemetryClass — the same vetted list the live
 *     counter and the drain read), so it neither replays nor counts what the live path never counts;
 *   - yields while trace retention is mid-sweep or the valve's last MEASURED surplus over the ceiling
 *     is > 0 (getDrainPressure: the valve's own count and ceiling), unless the valve reported that no
 *     drain can progress. Rows the drain deletes first were telemetry or past retention anyway.
 *   - never yields forever: a yield streak is stamped (yield_since, in the seed row, so it survives a
 *     restart) and once it is older than maxYieldMs (tuning param SHAPE_COUNTER_SEED_MAX_YIELD_MS,
 *     default 6 h) the tick runs anyway and the streak restarts. Under a drain that never finishes the
 *     seed still advances one tick per maxYieldMs instead of never.
 */
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { countShapeOutcomesBatch, type SeedRow } from '../lib/shape-score-counter';

const SEED_ID = 'shape_score_counter_seed:v1';
const EPOCH = '1970-01-01T00:00:00Z';

export interface SeedTickResult {
  done: boolean;
  /** True when the tick did no work because the retention drain has priority. */
  yielded?: boolean;
  scanned: number;
  counted: number;
  duplicate: number;
  cursor: string;
  durationMs: number;
}

export async function runShapeCounterSeedTick(opts: { pageSize?: number; budgetMs?: number; maxYieldMs?: number } = {}): Promise<SeedTickResult> {
  const pageSize = Math.max(50, Math.min(5000, opts.pageSize ?? 1000));
  const budgetMs = Math.max(1000, opts.budgetMs ?? 20_000);
  const started = Date.now();
  const state = (await surrealDB.query<{ done?: boolean; cursor?: string; scanned?: number; counted?: number; yield_since?: unknown }>(
    `SELECT done, cursor, scanned, counted, yield_since FROM ${SEED_ID}`,
  ))?.[0] ?? {};
  let cursor = state.cursor ?? EPOCH;
  let scanned = 0, counted = 0, duplicate = 0;
  if (state.done) return { done: true, scanned, counted, duplicate, cursor, durationMs: 0 };

  const { getDrainPressure } = await import('../services/trace-retention');
  const pressure = getDrainPressure();
  if (pressure.drainInFlight || (pressure.drainCanProgress && (pressure.surplus ?? 0) > 0)) {
    const maxYieldMs = await resolveMaxYieldMs(opts.maxYieldMs);
    const sinceMs = state.yield_since ? new Date(String(state.yield_since)).getTime() : NaN;
    if (Number.isNaN(sinceMs)) {
      await surrealDB.query(`UPSERT ${SEED_ID} SET yield_since = time::now(), updated_at = time::now()`);
    }
    const yieldingMs = Number.isNaN(sinceMs) ? 0 : started - sinceMs;
    if (yieldingMs < maxYieldMs) {
      logger.info('[shape-counter-seed] yielding to the trace-retention drain', {
        surplus: pressure.surplus, drainInFlight: pressure.drainInFlight, cursor, yieldingMs, maxYieldMs,
      });
      return { done: false, yielded: true, scanned, counted, duplicate, cursor, durationMs: Date.now() - started };
    }
    logger.warn('[shape-counter-seed] yield cap reached — running one tick despite drain pressure', {
      surplus: pressure.surplus, drainInFlight: pressure.drainInFlight, cursor, yieldingMs, maxYieldMs,
    });
  }
  const { resolveTelemetryClass } = await import('../lib/telemetry-class');
  const telemetry = (await resolveTelemetryClass()).accepted;

  let done = false;
  while (Date.now() - started < budgetMs) {
    // >= so rows sharing the boundary timestamp are not skipped; markers make the re-read harmless.
    // The telemetry filter rides the same idx_execution_executed_at range (plan verified on 2.3.3);
    // the cursor still advances by the last returned row's executed_at.
    const page = await surrealDB.query<SeedRow & { executed_at: unknown }>(
      `SELECT meta::id(id) AS eid, activity_id, org_id, success, tags, input_impulse_shapes, completion_shapes, executed_at
         FROM execution WHERE executed_at >= type::datetime($cursor)${telemetry.length > 0 ? ' AND activity_id NOT IN $telemetry' : ''} LIMIT $n`,
      { cursor, n: pageSize, ...(telemetry.length > 0 ? { telemetry } : {}) },
    );
    const rows = Array.isArray(page) ? page : [];
    scanned += rows.length;
    const r = await countShapeOutcomesBatch(surrealDB, rows);
    counted += r.counted;
    duplicate += r.duplicate;
    const last = rows.length > 0 ? new Date(String(rows[rows.length - 1]!.executed_at)).toISOString() : cursor;
    if (rows.length < pageSize) { done = true; cursor = last; break; }
    // A full page of one timestamp would never advance with >=; step past it (all its rows were seen).
    cursor = last === cursor ? new Date(new Date(last).getTime() + 1).toISOString() : last;
  }
  await surrealDB.query(
    `UPSERT ${SEED_ID} SET cursor = $cursor, done = $done, scanned = (scanned ?? 0) + $scanned,
       counted = (counted ?? 0) + $counted, yield_since = NONE, updated_at = time::now()`,
    { cursor, done, scanned, counted },
  );
  const durationMs = Date.now() - started;
  logger.info('[shape-counter-seed] tick', { done, scanned, counted, duplicate, cursor, durationMs });
  return { done, scanned, counted, duplicate, cursor, durationMs };
}

const DEFAULT_MAX_YIELD_MS = 6 * 3600_000;
/** The yield cap: explicit option, else the runtime tuning seam (law 1), clamped to [1 s, 7 d]. */
async function resolveMaxYieldMs(explicit?: number): Promise<number> {
  let v = explicit;
  if (v === undefined) {
    const { getTuningParam } = await import('../lib/tuning-params');
    v = await getTuningParam('SHAPE_COUNTER_SEED_MAX_YIELD_MS', undefined, DEFAULT_MAX_YIELD_MS);
  }
  return Math.min(7 * 86_400_000, Math.max(1000, Number.isFinite(v) ? Math.floor(v) : DEFAULT_MAX_YIELD_MS));
}

/** Run seed ticks until done, spaced so the live store is never saturated. Idempotent; a no-op once done. */
export function startShapeCounterSeed(delayMs = 60_000, restMs = 30_000): void {
  const tick = (): void => {
    void runShapeCounterSeedTick()
      .then((r) => { if (!r.done) setTimeout(tick, r.yielded ? restMs * 4 : restMs); })
      .catch((err) => {
        logger.warn('[shape-counter-seed] tick failed; retrying later', { error: err instanceof Error ? err.message : String(err) });
        setTimeout(tick, restMs * 10);
      });
  };
  setTimeout(tick, delayMs);
}
