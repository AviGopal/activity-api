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
 */
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { countShapeOutcomesBatch, type SeedRow } from '../lib/shape-score-counter';

const SEED_ID = 'shape_score_counter_seed:v1';
const EPOCH = '1970-01-01T00:00:00Z';

export interface SeedTickResult {
  done: boolean;
  scanned: number;
  counted: number;
  duplicate: number;
  cursor: string;
  durationMs: number;
}

export async function runShapeCounterSeedTick(opts: { pageSize?: number; budgetMs?: number } = {}): Promise<SeedTickResult> {
  const pageSize = Math.max(50, Math.min(5000, opts.pageSize ?? 1000));
  const budgetMs = Math.max(1000, opts.budgetMs ?? 20_000);
  const started = Date.now();
  const state = (await surrealDB.query<{ done?: boolean; cursor?: string; scanned?: number; counted?: number }>(
    `SELECT done, cursor, scanned, counted FROM ${SEED_ID}`,
  ))?.[0] ?? {};
  let cursor = state.cursor ?? EPOCH;
  let scanned = 0, counted = 0, duplicate = 0;
  if (state.done) return { done: true, scanned, counted, duplicate, cursor, durationMs: 0 };

  let done = false;
  while (Date.now() - started < budgetMs) {
    // >= so rows sharing the boundary timestamp are not skipped; markers make the re-read harmless.
    const page = await surrealDB.query<SeedRow & { executed_at: unknown }>(
      `SELECT meta::id(id) AS eid, activity_id, org_id, success, tags, input_impulse_shapes, completion_shapes, executed_at
         FROM execution WHERE executed_at >= type::datetime($cursor) LIMIT $n`,
      { cursor, n: pageSize },
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
       counted = (counted ?? 0) + $counted, updated_at = time::now()`,
    { cursor, done, scanned, counted },
  );
  const durationMs = Date.now() - started;
  logger.info('[shape-counter-seed] tick', { done, scanned, counted, duplicate, cursor, durationMs });
  return { done, scanned, counted, duplicate, cursor, durationMs };
}

/** Run seed ticks until done, spaced so the live store is never saturated. Idempotent; a no-op once done. */
export function startShapeCounterSeed(delayMs = 60_000, restMs = 30_000): void {
  const tick = (): void => {
    void runShapeCounterSeedTick()
      .then((r) => { if (!r.done) setTimeout(tick, restMs); })
      .catch((err) => {
        logger.warn('[shape-counter-seed] tick failed; retrying later', { error: err instanceof Error ? err.message : String(err) });
        setTimeout(tick, restMs * 10);
      });
  };
  setTimeout(tick, delayMs);
}
