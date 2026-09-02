/**
 * groupedExecutionStats — per-activity execution HEALTH in one resolve.
 *
 * traceAggregateReport emits ONE metric per call as {key,value} rows, so it can
 * rank by count OR by success_count, but never express "activity X ran N,
 * succeeded S, rate S/N, failing mostly with mode M" in a single row. A family
 * re-picked at ~0 success (a LIVELOCK) is therefore invisible to the
 * self-direction loop (boredom / VoI / gap->goal can all CHOOSE work but none can
 * SEE that a family is doomed). This report joins per-activity count +
 * success_count + success_rate + dominant failure_mode over the same window and
 * tenant scoping, so a livelock (high count, near-zero success_rate) becomes a
 * named, detectable condition the escalation seam can fold into selection weights.
 *
 * Reorganize-before-create: same table (v_paradigm_execution_traces), same
 * index-aware window + org scoping, and the same "select the raw grouped field,
 * NEVER alias it (SurrealDB 2.3.3 aliased-group-collapse), sort/cap in JS"
 * convention as trace-aggregate-report.ts. Read-only, pure. Degrades to an
 * empty-but-valid result on query error (never a 500 / timeout).
 *
 * Pointer contract (all optional):
 *   {
 *     type: "groupedExecutionStats",
 *     window_hours?: number,   // default 24, clamped [1, 720]
 *     limit?: number,          // default 25, clamped [1, 200]
 *     min_count?: number,      // default 1 — drop tiny-sample activities
 *     activity_id?: string,    // restrict to one family (the per-activity filter
 *                              // traceAggregateReport lacks)
 *     order?: "desc" | "asc",  // by count, default desc (livelocks are high-count)
 *   }
 */

import type { Surreal } from 'surrealdb';
import { logger } from '../utils/logger';

export interface GroupedExecutionStatsInput {
  window_hours?: number;
  limit?: number;
  min_count?: number;
  activity_id?: string;
  order?: string;
}

export interface GroupedExecutionStatsAuthContext {
  orgId: string;
  accountId?: string | null;
  authType?: 'jwt' | 'apikey' | 'minibob_token';
}

export interface GroupedExecutionStatsRow {
  activity_id: string;
  count: number;
  success_count: number;
  success_rate: number;
  /** Rows with a goal verdict of REACHED (`reached = true`). Never derived from `success`. */
  reached_count: number;
  /** Rows carrying ANY reach verdict (`reached != NONE`) — the reach_rate denominator. */
  graded_count: number;
  /** count - graded_count. A high value means a low/absent reach_rate says nothing. */
  ungraded_count: number;
  /**
   * reached_count / graded_count, or NULL when nothing in the group was graded.
   * NULL, not 0: "no verdict" and "every verdict was not-reached" are different facts.
   */
  reach_rate: number | null;
  top_failure_mode: string | null;
}

export interface GroupedExecutionStats {
  shape: 'groupedExecutionStats';
  window_hours: number;
  generated_at: string;
  rows: GroupedExecutionStatsRow[];
  total_groups: number;
  empty: boolean;
  query_ms: number;
  /**
   * SINGLE-GROUP PROJECTION — top-level copies of the scoped group's reach numbers.
   *
   * These exist for one concrete consumer: the gap sweep's Class-2 falsifier
   * (`verifyGapConditionAsync` in development-vessel/src/resolvers/gap-to-feature.ts).
   * That verifier reads `evidence_resolve.nonzero_field` FLAT — `inner[nonzeroField]`,
   * with no dot/array traversal — so a predicate naming `reach_rate` would read
   * `undefined` off `rows[0].reach_rate`, score 'present', and the gap could never
   * close no matter how healthy the family became. A falsifier that can only ever
   * say "still broken" is the "looks measurable, is inert" defect, not a measurement.
   *
   * Populated ONLY when the caller scoped the query (`activity_id`) and exactly one
   * group came back; null otherwise, because a fleet-wide number is not a verdict
   * about any one family.
   */
  reach_rate: number | null;
  reached_count: number | null;
  graded_count: number | null;
  ungraded_count: number | null;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function runGroupedExecutionStats(
  db: Surreal,
  rawInput: unknown,
  auth: GroupedExecutionStatsAuthContext,
): Promise<GroupedExecutionStats> {
  const input = (rawInput ?? {}) as GroupedExecutionStatsInput;
  const windowHours = clampInt(input.window_hours, 24, 1, 720);
  const limit = clampInt(input.limit, 25, 1, 200);
  const minCount = clampInt(input.min_count, 1, 0, 1_000_000);
  const order = String(input.order) === 'asc' ? 'ASC' : 'DESC';
  const activityFilter =
    typeof input.activity_id === 'string' && input.activity_id.trim()
      ? input.activity_id.trim()
      : null;

  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

  // Index-aware window + tenant scoping (mirrors trace-aggregate-report.ts:
  // org-scoping keeps idx_aet_org_id_executed_at engaged; API-key callers can't
  // pass SurrealDB PERMISSIONS so the tenant filter is applied app-side).
  const baseWhere: string[] = ['executed_at >= type::datetime($since)'];
  const params: Record<string, unknown> = { since };
  if (auth.authType === 'apikey') {
    baseWhere.push('org_id = $orgId');
    params.orgId = auth.orgId;
    if (auth.accountId) {
      baseWhere.push('account_id = $account_id');
      params.account_id = auth.accountId;
    }
  }
  if (activityFilter) {
    baseWhere.push('activity_id = $activity_id');
    params.activity_id = activityFilter;
  }
  const whereSql = baseWhere.join(' AND ');

  // CRITICAL: do NOT alias the grouped column (SurrealDB 2.3.3 collapses
  // `SELECT x AS key ... GROUP BY x` into one degenerate bucket). Select the raw
  // grouped field; fold in JS. Two grouped counts over the same window (total,
  // then success=true) joined by activity_id — the proven trace-aggregate shape.
  const totalSql = `SELECT activity_id, count() AS value FROM v_paradigm_execution_traces WHERE ${whereSql} GROUP BY activity_id`;
  const succSql = `SELECT activity_id, count() AS value FROM v_paradigm_execution_traces WHERE ${whereSql} AND success = true GROUP BY activity_id`;

  // ── REACH (the goal verdict), NOT success (the exit status) ──────────────────
  //
  // WHY THIS EXISTS: `success_rate` above is exit cleanliness. The substrate's
  // execution contract is stated in terms of REACH, and nothing in the fleet
  // aggregates it — so a fleet running far below its own contract filed no gap,
  // because no reader existed. See src/lib/reach-classify.ts: "Exiting cleanly is
  // not evidence a goal was reached." reach_rate MUST NOT be success_count/count;
  // several composed activities computed exactly that and called it reach_rate.
  //
  // WHY A DIFFERENT TABLE: `reached` is a column on `execution` (migration 160) and
  // is NOT projected by the v_paradigm_execution_traces compat view (the live view
  // body is migration 167's, which has no `reached` line). The view is a plain
  // `SELECT … FROM execution` with no WHERE, so the two passes cover the identical
  // population row-for-row — the only difference is which columns are visible.
  // Adding `reached` to the view would need a REMOVE + DEFINE that re-materialises
  // the whole table; reading the base table costs nothing and is what
  // trace-retention.ts's reach rollup already does. Same window, same tenant
  // scoping, same never-alias-the-grouped-column rule.
  //
  // `reached != NONE` is the graded predicate, copied from
  // services/trace-retention.ts (rollupReachHistory) — the proven SurrealDB form
  // for "this option<bool> has a value".
  // EXCLUDE ROWS WHERE A GOAL VERDICT IS INAPPLICABLE (2026-09-02, review finding).
  //
  // lib/reach-classify.ts already defines this population and names the offender:
  // "`auth_resolve_v1` — the sole `telemetry:` emitter — ran hundreds of thousands of
  // times, every one success:true but stamped reached:false ... and every one was read
  // as a genuine not-reached failure." classifyReach routes those to 'ungraded'.
  //
  // But routes/execution-traces.ts:3046 writes the `reached` COLUMN straight from the
  // tag without consulting classifyReach, so the column disagrees with the classifier —
  // 314 telemetry rows/day sit in the store stamped reached:false. Measured on the live
  // corpus: auth_resolve_v1 alone is 255 of 393 graded rows in 24h, 0 reached. Aggregating
  // it drags the fleet figure from 8.9% to 2.8% and would file a gap accusing a family
  // that was never attempting a goal.
  //
  // Excluding here rather than fixing :3046 is deliberate: that is a WRITE-path semantics
  // change altering what verdict is stored and therefore Thompson credit, and it needs its
  // own before/after measurement. This read-side filter is reversible and blames nobody.
  // Mirrors isReachInapplicable/isHollowSatellite by tag prefix, the same authority
  // classifyReach uses.
  const inapplicableSql =
    `AND !array::any(tags ?? [], |$t| string::starts_with($t, "telemetry:") OR string::starts_with($t, "satisfier:"))`;
  const reachedSql = `SELECT activity_id, count() AS value FROM execution WHERE ${whereSql} AND reached = true ${inapplicableSql} GROUP BY activity_id`;
  const gradedSql = `SELECT activity_id, count() AS value FROM execution WHERE ${whereSql} AND reached != NONE ${inapplicableSql} GROUP BY activity_id`;

  const startedAt = Date.now();
  let queryOk = true;
  const totals = new Map<string, number>();
  const succs = new Map<string, number>();
  const reacheds = new Map<string, number>();
  const gradeds = new Map<string, number>();
  const topMode = new Map<string, string>();

  const readGroup = (result: unknown): Array<Record<string, unknown>> => {
    const set = Array.isArray(result) && result.length > 0 ? result[0] : [];
    return Array.isArray(set) ? (set as Array<Record<string, unknown>>) : [];
  };
  const asKey = (r: Record<string, unknown>): string => {
    const raw = r.activity_id ?? r.key;
    return raw == null ? '(none)' : typeof raw === 'string' ? raw : String(raw);
  };
  const asNum = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

  try {
    for (const r of readGroup(await db.query(totalSql, params))) totals.set(asKey(r), asNum(r.value));
    for (const r of readGroup(await db.query(succSql, params))) succs.set(asKey(r), asNum(r.value));

    // Guarded like the failure_mode histogram: if the reach passes degrade (an older
    // deployment without migration 160), the livelock signal must still survive. A
    // degraded reach pass yields graded_count 0 -> reach_rate null, which reads as
    // "no verdict", never as "reached nothing".
    try {
      for (const r of readGroup(await db.query(reachedSql, params))) reacheds.set(asKey(r), asNum(r.value));
      for (const r of readGroup(await db.query(gradedSql, params))) gradeds.set(asKey(r), asNum(r.value));
    } catch (rerr) {
      logger.warn('[grouped-execution-stats] reach aggregate degraded (null reach_rate)', {
        error: rerr instanceof Error ? rerr.message : String(rerr),
      });
      reacheds.clear();
      gradeds.clear();
    }

    // Best-effort dominant failure_mode per activity (failed rows only). The
    // nested-field double-group is fragile; guard it so the core stat (the
    // livelock signal: count / success_rate) survives even if this degrades to
    // null. Read the grouped nested field defensively (flattened OR nested form).
    try {
      const failSql = `SELECT activity_id, failure_mode.type, count() AS value FROM v_paradigm_execution_traces WHERE ${whereSql} AND success = false GROUP BY activity_id, failure_mode.type`;
      const best = new Map<string, { mode: string; n: number }>();
      for (const r of readGroup(await db.query(failSql, params))) {
        const k = asKey(r);
        const fm = (r as { failure_mode?: { type?: unknown } }).failure_mode;
        const rawMode = (r as Record<string, unknown>)['failure_mode.type'] ?? fm?.type;
        const mode = rawMode == null ? '' : String(rawMode);
        if (!mode) continue;
        const n = asNum(r.value);
        const cur = best.get(k);
        if (!cur || n > cur.n) best.set(k, { mode, n });
      }
      for (const [k, v] of best) topMode.set(k, v.mode);
    } catch (ferr) {
      logger.warn('[grouped-execution-stats] failure_mode histogram degraded (null top_failure_mode)', {
        error: ferr instanceof Error ? ferr.message : String(ferr),
      });
    }
  } catch (err) {
    queryOk = false;
    logger.error('[grouped-execution-stats] aggregate query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let rows: GroupedExecutionStatsRow[] = [];
  for (const [activity_id, count] of totals) {
    if (activity_id === '(none)' || count < minCount) continue;
    const success_count = succs.get(activity_id) ?? 0;
    const reached_count = reacheds.get(activity_id) ?? 0;
    const graded_count = gradeds.get(activity_id) ?? 0;
    rows.push({
      activity_id,
      count,
      success_count,
      success_rate: count > 0 ? success_count / count : 0,
      reached_count,
      graded_count,
      // DENOMINATOR = GRADED ONLY, and this is a load-bearing choice.
      //
      // `reached` is option<bool>: an ungraded run has NO verdict, and counting it
      // as a failure to reach would manufacture the very misleading aggregate this
      // change exists to prevent — a family whose runs are simply never graded
      // would read as a family that never reaches. Grading is also asynchronous
      // (POST /reach patches the row after insert), so an all-executions
      // denominator would additionally penalise recency.
      //
      // In-repo precedent: services/trace-retention.ts `rollupReachHistory` buckets
      // reached/total over `WHERE reached != NONE` — graded-only. Matching it means
      // the weekly history and this per-activity view are the same statistic.
      //
      // The cost of graded-only is that a small graded slice can look extreme, so
      // `ungraded_count` is exposed beside it: a reader (and the detector) can tell
      // a genuinely low reach rate from a mostly-ungraded population, and the
      // detector gates its volume threshold on graded_count rather than count.
      //
      // NOTE the interaction with reach-classify.ts: hollow satisfier satellites and
      // `telemetry:`-tagged infra probes are classified 'ungraded' and persisted with
      // `reached: null` (lib/posterior-update.ts), so graded-only already excludes
      // them. No activity_id name filter is needed or wanted here.
      ungraded_count: Math.max(0, count - graded_count),
      reach_rate: graded_count > 0 ? reached_count / graded_count : null,
      top_failure_mode: topMode.get(activity_id) ?? null,
    });
  }
  // Sort + cap in JS (ORDER BY over the aggregate triggers the degenerate plan).
  // Default desc by count — a livelock is a high-count / low-success-rate row.
  rows.sort((a, b) => (order === 'ASC' ? a.count - b.count : b.count - a.count));
  if (rows.length > limit) rows = rows.slice(0, limit);

  // Flat projection for the scoped single-group case (see the interface comment:
  // the gap sweep reads nonzero_field off the top level, not out of `rows`).
  const scoped = activityFilter !== null && rows.length === 1 ? rows[0]! : null;

  return {
    shape: 'groupedExecutionStats',
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
    rows,
    total_groups: rows.length,
    empty: rows.length === 0,
    query_ms: queryOk ? Date.now() - startedAt : -1,
    reach_rate: scoped ? scoped.reach_rate : null,
    reached_count: scoped ? scoped.reached_count : null,
    graded_count: scoped ? scoped.graded_count : null,
    ungraded_count: scoped ? scoped.ungraded_count : null,
  };
}
