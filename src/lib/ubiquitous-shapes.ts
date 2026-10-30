/**
 * Ubiquitous target shapes: shapes present in so many recent goals' target sets that an overlap on
 * them says nothing about whether two goals want the same thing.
 *
 * The goal-paths shape-signature arm scores a borrowed path by cover = |path ∩ target| / |target|.
 * Measured 2026-10-30: the walk's inferred targets carry llm_completion_dispatch on nearly every
 * goal, so a goal with targets [llm_completion_dispatch, human_surface:ui_view] reached cover 0.50
 * against a generic one-step llm pathway and borrowed it, and an unrelated cooking goal borrowed the
 * same donor minutes later. The overlap was real and carried no information.
 *
 * The share is MEASURED, not hand-listed: one read of the most recent goal_execution_paths rows'
 * recorded target sets (expected_output_shapes), the fraction of those rows naming each shape. A
 * shape at or over the threshold is ubiquitous and is left out of the cover NUMERATOR (the
 * denominator stays |target|, so a goal whose only overlap is ubiquitous no longer clears the bar).
 *
 * Shaped (law 1), read at use time through getTuningParam with these defaults:
 *   goal_paths_ubiquity_window_rows   2000    recent rows read
 *   goal_paths_ubiquity_share         0.5     share at or over which a shape is ubiquitous
 *   goal_paths_ubiquity_min_rows      100     fewer rows with a target set than this: no verdict
 *   goal_paths_ubiquity_cache_ttl_ms  300000  the measurement is reused for this long
 * A share >= 1 disables the exclusion. FAIL-OPEN: a failed or slow read, or too few rows, yields no
 * ubiquitous shape, so cover is computed exactly as before.
 */
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { getTuningParam } from './tuning-params';
import { newestFirstSql } from './newest-first-sql';
import { withDeadline } from './deadline';

export interface TargetShareMeasure {
  /** Rows read that carried a recorded target set. */
  rows: number;
  /** shape -> fraction of those rows whose target set names it. */
  share: Map<string, number>;
}

/** The fraction of rows whose target set names each shape. Rows without an array are not counted. */
export function measureTargetShare(rows: ReadonlyArray<{ expected_output_shapes?: unknown }>): TargetShareMeasure {
  const counts = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    const v = r?.expected_output_shapes;
    if (!Array.isArray(v)) continue;
    n++;
    for (const s of new Set(v.map(String))) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const share = new Map<string, number>();
  for (const [s, c] of counts) share.set(s, n > 0 ? c / n : 0);
  return { rows: n, share };
}

/** The target shapes the measure calls ubiquitous. Empty when the sample is too small or the threshold is >= 1. */
export function ubiquitousAmong(targets: readonly string[], m: TargetShareMeasure, threshold: number, minRows: number): Set<string> {
  const out = new Set<string>();
  if (!(threshold < 1) || m.rows < minRows) return out;
  for (const t of targets) if ((m.share.get(t) ?? 0) >= threshold) out.add(t);
  return out;
}

/** Cover of a path's endpoint shapes over the target set, a ubiquitous shape never counting toward it. */
export function shapeCover(have: readonly string[], targetSet: ReadonlySet<string>, ubiquitous: ReadonlySet<string>): number {
  if (targetSet.size === 0) return 0;
  const covered = have.filter((s) => targetSet.has(s) && !ubiquitous.has(s)).length;
  return covered / targetSet.size;
}

type RowQuery = (sql: string, params: Record<string, unknown>) => Promise<unknown>;
let cached: { at: number; ttl: number; measure: TargetShareMeasure } | null = null;

/** Test seam: drop the cached measurement. */
export function _resetUbiquityCache(): void { cached = null; }

const READ_TIMEOUT_S = 5;

/**
 * The ubiquitous shapes among `targets`, from a cached measurement of recent target sets.
 * Never throws: any failure is logged and answers an empty set (fail-open, cover as before).
 */
export async function ubiquitousTargetShapes(targets: readonly string[], query: RowQuery = (s, p) => surrealDB.query(s, p)): Promise<Set<string>> {
  if (targets.length === 0) return new Set();
  try {
    const [window, share, min, ttl] = await Promise.all([
      getTuningParam('goal_paths_ubiquity_window_rows', undefined, 2000),
      getTuningParam('goal_paths_ubiquity_share', undefined, 0.5),
      getTuningParam('goal_paths_ubiquity_min_rows', undefined, 100),
      getTuningParam('goal_paths_ubiquity_cache_ttl_ms', undefined, 300_000),
    ]);
    if (!(share < 1)) return new Set();
    const now = Date.now();
    if (!cached || now - cached.at >= cached.ttl) {
      const t0 = Date.now();
      const sql = `${newestFirstSql({
        fields: 'expected_output_shapes, updated_at',
        from: 'goal_execution_paths',
        where: [],
        orderBy: 'updated_at',
        limit: '$limit',
      })} TIMEOUT ${READ_TIMEOUT_S}s`;
      const rows = await withDeadline(query(sql, { limit: Math.max(1, Math.floor(window)) }), (READ_TIMEOUT_S + 1) * 1_000, 'goal-paths ubiquity read');
      const measure = measureTargetShare(Array.isArray(rows) ? (rows as Array<{ expected_output_shapes?: unknown }>) : []);
      cached = { at: now, ttl: Math.max(0, ttl), measure };
      logger.info('goal-paths ubiquity measured', { rows: measure.rows, window, latency_ms: Date.now() - t0 });
    }
    return ubiquitousAmong(targets, cached.measure, share, min);
  } catch (err) {
    // A failed read is remembered for a minute (an empty measure), so a slow store does not add its timeout to
    // every recommendation; the empty measure is the fail-open answer.
    cached = { at: Date.now(), ttl: 60_000, measure: { rows: 0, share: new Map() } };
    logger.warn('goal-paths ubiquity read failed; cover counts every shape (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}
