/**
 * shape_score_counter — the durable, REACH-graded, shape-conditioned outcome counter (migration 213).
 *
 * One record per (activity_id, org_id, shape_signature) — the grouping the old
 * v_shape_conditioned_score view used, over executions with non-empty input_impulse_shapes.
 * It counts the learner's grade, not exit status: the verdict comes from classifyReach
 * (lib/reach-classify.ts), the ONE honest-reach primitive — reached → `reached += 1`,
 * not-reached → `not_reached += 1`, ungraded → nothing. It is written where the main learner
 * applies its update (applyOutcomeToPosteriors), which runs both at trace insert and when a late
 * verdict arrives through POST /execution-traces/reach, because a goal-host walk's verdict is
 * usually NOT known at insert time.
 *
 * NEVER DECREMENTED by retention (the view lost whole groups whenever a delete zeroed one of its
 * count aggregates).
 *
 * MIRRORS THE VPM POSTERIOR'S GRADING EXACTLY. It is incremented at the one point where
 * applyOutcomeToPosteriors applies a variant_performance_metrics delta — same guard (not skipped
 * for an all-deterministic or idle-yield trace, non-zero delta), same verdict — so every grading
 * that moves VPM moves this counter and nothing else does. `reached` / `not_reached` count those
 * gradings; `alpha_sum` / `beta_sum` carry the same (graded-yield) deltas VPM received.
 * Regrades follow VPM's actual semantics, which are NEITHER reversal NOR first-verdict-wins: an
 * execution graded at insert (e.g. failed → not-reached, β) and graded again by a late
 * POST /execution-traces/reach (e.g. reached, α) keeps BOTH deltas in VPM, and so here; an
 * execution ungraded at insert and graded late is counted once, by the late verdict.
 *
 * IDEMPOTENT PER (execution, grading occasion). One marker per execution,
 * `shape_score_counted:<execution id>`, records the occasions already counted ('insert' | 'reach' |
 * 'seed') and their verdicts. The marker is read and written in the SAME transaction as the
 * increment; because every counting of an execution touches that one record, concurrent attempts
 * conflict and the retried one sees the occasion already present. So a replayed write or a retried
 * reach patch counts nothing twice, and the seed skips any execution the live path already counted.
 * Markers are deleted with their execution, inside the retention delete's transaction
 * (PRUNE_MARKERS_SQL), so the table is bounded by the execution table.
 *
 * Write shape: one atomic `UPSERT … SET x += …` on a deterministic record id; no read-modify-write
 * of the counter, no table-wide count. Same role as variant_performance_metrics (the durable
 * per-variant posterior written from posterior-update.ts), keyed by shape signature.
 */
import { classifyReach, type ReachVerdict } from './reach-classify';

export type GradingOccasion = 'insert' | 'reach' | 'seed';

interface QueryLike {
  query<T = any>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
}

/** Count ONE grading, reading activity/org/shapes from the stored execution in the same transaction. */
export const COUNT_ONE_SQL = `
BEGIN TRANSACTION;
LET $__row = (SELECT activity_id, org_id, input_impulse_shapes FROM ONLY type::thing('execution', $eid));
LET $__m = (SELECT occasions FROM ONLY type::thing('shape_score_counted', $eid));
LET $__go = $__row != NONE
  AND $__row.input_impulse_shapes != NONE AND array::len($__row.input_impulse_shapes) > 0
  AND ($__m = NONE OR $occasion NOTINSIDE ($__m.occasions ?? []));
IF $__go {
  UPSERT type::thing('shape_score_counted', $eid) SET
    eid = $eid, occasions += $occasion, verdicts += $verdict, counted_at = time::now();
  LET $__sig = array::sort(array::distinct($__row.input_impulse_shapes));
  UPSERT type::thing('shape_score_counter', [$__row.activity_id, $__row.org_id, $__sig]) SET
    activity_id = $__row.activity_id,
    org_id = $__row.org_id,
    shape_signature = $__sig,
    graded += 1,
    reached += IF $verdict = 'reached' { 1 } ELSE { 0 },
    not_reached += IF $verdict = 'not-reached' { 1 } ELSE { 0 },
    alpha_sum += $alpha_delta,
    beta_sum += $beta_delta,
    updated_at = time::now();
};
RETURN { counted: $__go, duplicate: $__m != NONE AND $occasion INSIDE ($__m.occasions ?? []) };
COMMIT TRANSACTION;`;

/**
 * SurrealQL fragment for a retention delete transaction: delete the counting markers of the
 * executions that same transaction deletes. `idsExpr` evaluates to a list of execution record ids.
 */
export const PRUNE_MARKERS_SQL = (idsExpr: string) =>
  `DELETE (${idsExpr}).map(|$__i| type::thing('shape_score_counted', meta::id($__i))) RETURN NONE;`;

export type CountResult = 'counted' | 'skipped' | 'duplicate';


/**
 * Count one grading into its shape group. Called by applyOutcomeToPosteriors exactly where it applies
 * a VPM delta, with the same verdict and deltas. A missing execution id or 'ungraded' is never
 * counted; a duplicate (same execution, same occasion) is a no-op, not an error.
 */
export async function countShapeOutcome(
  db: QueryLike & { queryAll?: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]> },
  executionId: string | undefined,
  verdict: ReachVerdict,
  occasion: GradingOccasion = 'insert',
  deltas: { alpha: number; beta: number } = { alpha: verdict === 'reached' ? 1 : 0, beta: verdict === 'not-reached' ? 1 : 0 },
): Promise<CountResult> {
  if (!executionId || verdict === 'ungraded') return 'skipped';
  const params = { eid: executionId, verdict, occasion, alpha_delta: deltas.alpha, beta_delta: deltas.beta };
  const out = typeof db.queryAll === 'function'
    ? await db.queryAll(COUNT_ONE_SQL, params)
    : await db.query(COUNT_ONE_SQL, params);
  const summary = (Array.isArray(out) ? out : []).filter((r): r is { counted: boolean; duplicate: boolean } =>
    !!r && typeof r === 'object' && 'counted' in (r as object)).pop();
  if (summary?.counted) return 'counted';
  return summary?.duplicate ? 'duplicate' : 'skipped';
}

/** A retained execution, as the seed job pages it. */
export interface SeedRow {
  eid: string;
  activity_id: string;
  org_id: string;
  success: boolean;
  tags?: string[];
  input_impulse_shapes?: string[];
  /** Written ONLY by POST /execution-traces/reach's verdict mirror; NONE on a never-patched row. */
  completion_shapes?: unknown;
}

const LATE_TAGS = new Set(['reached:true', 'reached:false', 'reach_graded:true']);

/**
 * The gradings VPM ACTUALLY RECEIVED for a retained execution — the seed counts these and nothing
 * else, so the counter equals VPM at birth (seed option (a)). Graded with classifyReach (no copy).
 *
 *   insert  — the verdict on the tags AS INSERTED. A row the /reach mirror patched (it alone writes
 *             completion_shapes) has the mirror's tags removed first: reached:true|false and
 *             reach_graded:true. (Assumes a walk that is later patched carried no reach tag at
 *             insert, which is how goal-host posts walks: tagged dispatcher_used:goal-host.)
 *   reach   — ONLY if the late verdict was really credited: the row carries reach_graded:true (the
 *             route's idempotence stamp, written immediately before it credits). A reach tag
 *             without that stamp was persisted but never graded (the 2026-09-11..d0 window), so
 *             VPM never received it and it is not seeded.
 */
export function seedGradings(r: SeedRow): Array<{ occasion: GradingOccasion; verdict: ReachVerdict }> {
  const tags = Array.isArray(r.tags) ? r.tags : [];
  const patched = r.completion_shapes !== undefined && r.completion_shapes !== null;
  const insertTags = patched ? tags.filter((t) => !LATE_TAGS.has(t)) : tags;
  const out: Array<{ occasion: GradingOccasion; verdict: ReachVerdict }> = [];
  const atInsert = classifyReach({ success: r.success === true, execution_id: r.eid, activity_id: r.activity_id, tags: insertTags });
  if (atInsert !== 'ungraded') out.push({ occasion: 'insert', verdict: atInsert });
  if (tags.includes('reach_graded:true') && (tags.includes('reached:true') || tags.includes('reached:false'))) {
    const late = classifyReach({ success: r.success === true, execution_id: r.eid, activity_id: r.activity_id, tags: [...insertTags, tags.includes('reached:true') ? 'reached:true' : 'reached:false'] });
    if (late !== 'ungraded') out.push({ occasion: 'reach', verdict: late });
  }
  return out;
}

const BATCH_SQL = `
BEGIN TRANSACTION;
LET $todo = (SELECT * FROM $items WHERE
  record::exists(type::thing('shape_score_counted', eid)) = false
  OR occasion NOTINSIDE (type::thing('shape_score_counted', eid).occasions ?? []));
FOR $m IN $todo {
  UPSERT type::thing('shape_score_counted', $m.eid) SET
    eid = $m.eid, occasions += $m.occasion, verdicts += $m.verdict, counted_at = time::now();
};
LET $groups = (SELECT activity_id, org_id, sig, count() AS graded,
    count(IF verdict = 'reached' THEN 1 ELSE NONE END) AS reached,
    count(IF verdict = 'not-reached' THEN 1 ELSE NONE END) AS not_reached
  FROM $todo GROUP BY activity_id, org_id, sig);
FOR $g IN $groups {
  UPSERT type::thing('shape_score_counter', [$g.activity_id, $g.org_id, $g.sig]) SET
    activity_id = $g.activity_id, org_id = $g.org_id, shape_signature = $g.sig,
    graded += $g.graded, reached += $g.reached, not_reached += $g.not_reached,
    alpha_sum += $g.reached, beta_sum += $g.not_reached,
    updated_at = time::now();
};
RETURN { counted: array::len($todo), duplicate: array::len($items) - array::len($todo) };
COMMIT TRANSACTION;`;

/**
 * Seed one page of retained executions in ONE transaction: the gradings VPM actually received
 * (seedGradings), minus any (execution, occasion) already counted (live path or an earlier run),
 * markers created, one UPSERT per group. alpha_sum/beta_sum are seeded at unit weight (the original
 * graded-yield deltas are not recoverable); the posterior reads the reached/not_reached COUNTS.
 */
export async function countShapeOutcomesBatch(
  db: QueryLike & { queryAll?: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]> },
  rows: SeedRow[],
): Promise<{ counted: number; duplicate: number }> {
  const items = rows
    .filter((r) => Array.isArray(r.input_impulse_shapes) && r.input_impulse_shapes.length > 0)
    .flatMap((r) => seedGradings(r).map((g) => ({
      eid: r.eid, activity_id: r.activity_id, org_id: r.org_id, occasion: g.occasion, verdict: g.verdict,
      sig: [...new Set(r.input_impulse_shapes!)].sort(),
    })));
  if (items.length === 0) return { counted: 0, duplicate: 0 };
  const out = typeof db.queryAll === 'function'
    ? await db.queryAll(BATCH_SQL, { items })
    : await db.query(BATCH_SQL, { items });
  const s = (Array.isArray(out) ? out : []).filter((r): r is { counted: number; duplicate: number } =>
    !!r && typeof r === 'object' && 'counted' in (r as object)).pop();
  return { counted: Number(s?.counted ?? 0), duplicate: Number(s?.duplicate ?? 0) };
}

/** A counter row presented in the selector's score shape: Beta(reached + 1, not_reached + 1). */
export interface ShapeScoreCounterRow {
  activity_id: string;
  org_id: string;
  shape_signature: string[];
  graded?: number;
  reached?: number;
  not_reached?: number;
}
export function counterRowToScore(r: ShapeScoreCounterRow) {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    activity_id: r.activity_id,
    org_id: r.org_id,
    shape_signature: r.shape_signature,
    total_executions: n(r.graded),
    successes: n(r.reached),
    failures: n(r.not_reached),
    alpha: n(r.reached) + 1,
    beta: n(r.not_reached) + 1,
    avg_duration_ms: 0,
    avg_cost_usd: 0,
    total_cost_usd: 0,
    total_tokens_in: 0,
    total_tokens_out: 0,
  };
}
