/**
 * Trace retention sweep — stratified, bounded reservoir over the authoritative `execution` table.
 *
 * Why: activity_execution_traces re-bloats past ~100K rows (lifecycle activities such
 * as validator-dispatch / slot-binding POST a trace per fire), and the
 * GET /v2/activities/execution-traces hot path is O(rows) under Bun event-loop
 * contention. Trace-read latency gates the learning loop (the loop reads recent
 * posteriors on every dispatch), so bounding the store speeds both execution and
 * learning. See docs/architecture/SUBSTRATE_AS_SOFTWARE.md §2 (the Recorded group).
 *
 * What it does NOT do: it never blanket-deletes a lifecycle activity. For each
 * stratum it keeps ALL recent traces (hot window) plus a uniform-random bounded
 * sample of the cold tail, separately for success and failure, so we retain enough
 * signal to learn *when* to run lifecycle activities and *what* to register.
 *
 * Design notes / SurrealDB constraints (hard-won — see operator memory):
 *  - GROUP BY <field> and math::* are unreliable on this table; we therefore sweep
 *    an explicit configured list of activity_ids and use direct
 *    `WHERE ... GROUP ALL count()` per stratum (reliable).
 *  - executed_at is a SurrealDB `datetime` (verified via type::is::datetime), NOT a
 *    string — comparing it against a string literal silently matches nothing. Convert
 *    the ISO cutoff with the `type::datetime($cut)` FUNCTION, NOT the `<datetime>$cut`
 *    CAST: the cast is an "Unsupported value" to the query planner and forces a full
 *    table scan (Iterate Table, ~610ms on 72k rows), whereas type::datetime() keeps the
 *    (activity_id, success, executed_at) index live (Iterate Index, ~120ms). Verified via EXPLAIN.
 *  - Deletes go through the ROOT path (surrealDB.query), never queryWithAuth — the
 *    table's PERMISSIONS would otherwise drop the delete silently.
 *  - rand::float() is evaluated per-record in a WHERE clause → uniform reservoir.
 *
 * Default-disabled (TRACE_RETENTION_ENABLED) and dry-run-able
 * (TRACE_RETENTION_DRY_RUN) so it is reviewable before any deletion runs.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { decrementTraceStoreCounter } from '../lib/trace-store-counters';

// WRITE-FLIP/decommission: retention now bounds the canonical `execution`
// table (root path). AET is the DUAL_WRITE shadow; when DUAL_WRITE is off it
// stops growing and ages out on its own.
const TABLE = 'execution';

// Resumable cursor for the orphaned-content reap (execution_trace_content).
// execution_id-ordered; persists across sweeps within a process so each cycle
// advances past already-scanned rows instead of re-paying the head prefix.
// Resets to '' on process restart (re-scans from head — self-healing) and on
// reaching the table tail (wrap). In-memory by design: no schema/migration.
let orphanReapCursor = '';

export interface StratumPolicy {
  /** Max cold-tail (older than hot window) traces to keep for status=success. */
  successCap: number;
  /** Max cold-tail traces to keep for status=failure. */
  failureCap: number;
}

export interface TraceRetentionConfig {
  enabled: boolean;
  dryRun: boolean;
  intervalMs: number;
  /** Keep ALL traces newer than this regardless of stratum/cap. */
  hotWindowMs: number;
  /** Default cold-tail caps applied to any swept activity without an override. */
  defaultSuccessCap: number;
  defaultFailureCap: number;
  /** Max rows deleted per DELETE statement (bounds per-statement DB blocking). */
  deleteBatchSize: number;
  /** Activity ids to sweep. Defaults to the known lifecycle flooders. */
  activities: string[];
  /** Per-activity overrides, keyed by activity_id. */
  overrides: Record<string, Partial<StratumPolicy>>;
  /**
   * Auto-discover over-cap strata each cycle (GROUP BY activity_id, largest
   * strata exceeding the default caps). A static env list cannot keep up with
   * the fleet: on 2026-07-02 the store had re-bloated to 423k rows across
   * 1,787 strata (130 observer-tick strata alone held 138k) while the
   * configured list covered two activities.
   */
  autoDiscover: boolean;
  /** Bound on auto-discovered strata swept per cycle (keeps cycles bounded). */
  autoDiscoverMax: number;
  /**
   * Global row-count ceiling across ALL strata — the safety valve that bounds the
   * store's TOTAL size, i.e. the invariant the health observer actually measures
   * (trace_store_counters.row_count > cap). The stratified caps above bound each
   * (activity_id,status) stratum, but the live fleet spreads across ~1000+ distinct
   * activity_ids, so the sum can sit far over the global cap while every stratum is
   * individually under its per-stratum cap. Defaults to TRACE_STORE_CAP so ENFORCE
   * == SENSE by construction; set TRACE_RETENTION_GLOBAL_CEILING to decouple. 0 = off.
   */
  globalCeiling: number;
  /** Toggle just the global-ceiling valve (still overall-gated by enabled + dryRun). */
  globalCeilingEnabled: boolean;
  /**
   * Bound on rows the ceiling valve deletes in ONE sweep, and a wall-clock budget for
   * the attempt. Without these the valve drains the entire surplus in a single cycle:
   * at 156k surplus and a 25-row batch that is ~6,250 SELECT+DELETE round trips
   * against a 30-minute interval, on a memory-pressured box, with a real chance of
   * overrunning the interval and overlapping the next sweep. The orphan reap below
   * already solved this and its comment records why; the valve gets the same shape
   * rather than a second answer to the same question. Surplus that survives a cycle
   * is picked up by the next one — the valve is a steady drain, not a one-shot.
   */
  ceilingPerSweepCap: number;
  ceilingBudgetMs: number;
  /**
   * Reap ORPHANED execution_trace_content rows — content whose parent `execution`
   * was already pruned by the sweeps above. Bounded per sweep + time-budgeted +
   * age-windowed. On by default once the sweep is enabled and not dry-run.
   */
  orphanReapEnabled: boolean;
  /** Max orphan content rows reaped per sweep (spreads the backlog over cycles). */
  orphanReapPerSweepCap: number;
  /** Hard wall-clock budget for the orphan reap step (yields under memory pressure). */
  orphanReapBudgetMs: number;
  /** Never reap content younger than this (guards a row whose parent execution is still mid dual-write). */
  orphanReapMinAgeMs: number;
}

export function loadTraceRetentionConfig(env = process.env): TraceRetentionConfig {
  const overrides: Record<string, Partial<StratumPolicy>> = (() => {
    const raw = env.TRACE_RETENTION_OVERRIDES;
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      logger.warn('[trace-retention] TRACE_RETENTION_OVERRIDES is not valid JSON; ignoring', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  })();

  // Default swept activities: the lifecycle flooders, plus any explicitly named in
  // the overrides map. Balanced default caps (success == failure) — bias is opt-in
  // per-activity via overrides.
  const fromEnv = (env.TRACE_RETENTION_ACTIVITIES ?? 'validator-dispatch,slot-binding')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const activities = Array.from(new Set([...fromEnv, ...Object.keys(overrides)]));

  return {
    enabled: env.TRACE_RETENTION_ENABLED === 'true',
    dryRun: env.TRACE_RETENTION_DRY_RUN !== 'false', // dry-run unless explicitly disabled
    intervalMs: parseInt(env.TRACE_RETENTION_INTERVAL_MS ?? String(30 * 60 * 1000), 10),
    hotWindowMs: parseInt(env.TRACE_RETENTION_HOT_WINDOW_MS ?? String(2 * 60 * 60 * 1000), 10),
    defaultSuccessCap: parseInt(env.TRACE_RETENTION_DEFAULT_SUCCESS_CAP ?? '2000', 10),
    defaultFailureCap: parseInt(env.TRACE_RETENTION_DEFAULT_FAILURE_CAP ?? '2000', 10),
    // DELETE COST ON `execution` SCALES WITH STATEMENT WIDTH, NOT ROW COUNT (2026-08-09).
    //
    // Measured against the live 300k-row store:
    //   DELETE <1 id>    0.0s  (row verified gone)
    //   DELETE <2 ids>   10.7s
    //   DELETE <50 ids>  TIMEOUT at 60s
    //   SELECT 1000 ids   0.1s  (reads are fine; only mutation is pathological)
    // Cause: `execution` carries 16 indexes, several low-cardinality (success, tier,
    // org), so a delete rewrites all sixteen B-trees per row and the cost compounds
    // across a wide id list. The aux tables reap happily at the same batch size —
    // trace_digest and concept_usage log removed:29/76/16 in the same sweeps that
    // fail on `execution` — which is what makes this table-specific rather than a
    // general DB problem.
    //
    // At 1000 the valve's `DELETE $ids RETURN NONE` times out every cycle, so the
    // loop dies at iteration 1 and commits NOTHING. Lowering it trades throughput for
    // completion: many small statements that finish beat one wide statement that
    // never does. 25 is deliberately well under the measured 50-id failure point,
    // since the timeout is load-dependent and the margin matters more than the count.
    //
    // Kept as an env override so a deployment on a healthier table (fewer indexes, or
    // post-partition) can raise it without a code change.
    // 25 -> 1, BECAUSE THE COST IS PER-STATEMENT, NOT PER-ROW (2026-08-09).
    //
    // The measurements above say 1000 was fatal and 25 survives. They do not say 25 is
    // good, and the valve's own instrumentation now shows it is not:
    //
    //   batch 25, 16 indexes      100 rows / 352s   ->  ~88s PER DELETE STATEMENT
    //   batch 25, index dropped    50 rows / 860s   -> ~430s per statement
    //   batch 25, index dropped    50 rows / 570s   -> ~285s per statement
    //
    // Against the earlier direct probe of the same table:
    //
    //   DELETE <1 id>    0.0s      DELETE <2 ids>   10.7s      DELETE <50 ids>  timeout
    //
    // One id is effectively free and two cost eleven seconds. That is not a per-row cost
    // curve — it is a threshold: the moment a DELETE carries more than one id, something
    // (16 index B-trees, several low-cardinality) turns pathological, and the penalty then
    // scales with statement width. 25 ids inherits the whole penalty and amortises nothing.
    //
    // So the batch size was tuned against the wrong model. At ~0.2s per single delete the
    // valve sheds ~5 rows/sec against a measured intake of ~325 rows/HOUR — the first
    // configuration in this file that can actually outpace arrivals. Many cheap statements
    // beat one expensive statement, and the extra round trips are irrelevant next to a
    // 285s stall.
    //
    // MEASURED AND REVERTED TO 25. Singles were not faster:
    //
    //   batch 25, 16 indexes, quiet      100 rows / 352s  ->  3.52 s/row   <- best observed
    //   batch  1, index rebuilding        33 rows / 303s  ->  9.19 s/row
    //
    // So the statement-width theory is not supported either. A single-id DELETE still
    // costs seconds, nothing like the 0.0s the earlier direct probe recorded — which now
    // looks like it was taken against a much quieter table rather than being a property of
    // single deletes.
    //
    // THE BATCH=1 SAMPLE IS CONTAMINATED AND I CAUSED IT: the unique index restored by
    // migration 194 was rebuilding CONCURRENTLY in the background during that sweep —
    // sustained write load on this exact table. It is not comparable to the 3.52 baseline,
    // so it neither confirms nor refutes cleanly; it only fails to show the large win the
    // change was made to capture. Reverting to the best MEASURED value rather than keeping
    // an unvalidated one is the conservative call, and 25 also carries the documented
    // margin below the 50-id failure point.
    //
    // WHAT THIS LEAVES: two hypotheses tested and neither supported — index count (drop
    // measured WORSE, reverted in 0da9c16) and statement width (this). The remaining
    // explanation is that the per-delete cost is in the storage engine's delete path for
    // this table, which is a design question (partitioning, a different retention
    // substrate, or not storing this volume at all) rather than anything tunable here.
    // Re-test batch=1 on a QUIET table before drawing a conclusion from that sample.
    deleteBatchSize: parseInt(env.TRACE_RETENTION_DELETE_BATCH ?? '25', 10),
    activities,
    overrides,
    autoDiscover: env.TRACE_RETENTION_AUTO !== 'false', // on by default; ENABLED already gates the job
    autoDiscoverMax: parseInt(env.TRACE_RETENTION_AUTO_MAX ?? '60', 10),
    // Global ceiling defaults to the sensor's own cap (TRACE_STORE_CAP; config.ts
    // default 50_000) so the enforced global bound is EXACTLY the number the health
    // observer alarms on — SENSE and ENFORCE become one number, and a sweep clears
    // the over-cap signal instead of re-emitting a gap that can never close.
    // TRACE_RETENTION_GLOBAL_CEILING overrides for headroom (keeps the stratified
    // policy primary); 0 disables. Still overall-gated by enabled + dryRun.
    globalCeiling: parseInt(env.TRACE_RETENTION_GLOBAL_CEILING ?? env.TRACE_STORE_CAP ?? '50000', 10),
    globalCeilingEnabled: env.TRACE_RETENTION_GLOBAL_CEILING_ENABLED !== 'false', // on by default
    // 20000/sweep at a 30-min interval is ~40k/hr of drain capacity against a measured
    // intake of ~275 rows/hr, so a 156k surplus clears in ~8 sweeps while leaving the
    // valve able to absorb a large burst. The time budget is the real guard: it caps
    // the attempt regardless of how slow individual deletes turn out to be under load.
    ceilingPerSweepCap: parseInt(env.TRACE_RETENTION_CEILING_PER_SWEEP_CAP ?? '20000', 10),
    ceilingBudgetMs: parseInt(env.TRACE_RETENTION_CEILING_BUDGET_MS ?? String(5 * 60 * 1000), 10),
    orphanReapEnabled: env.TRACE_RETENTION_ORPHAN_REAP_ENABLED !== 'false', // on by default
    orphanReapPerSweepCap: parseInt(env.TRACE_RETENTION_ORPHAN_MAX ?? '20000', 10),
    orphanReapBudgetMs: parseInt(env.TRACE_RETENTION_ORPHAN_BUDGET_MS ?? '120000', 10),
    orphanReapMinAgeMs: parseInt(env.TRACE_RETENTION_ORPHAN_MIN_AGE_MS ?? String(60 * 60 * 1000), 10),
  };
}

function policyFor(cfg: TraceRetentionConfig, activityId: string): StratumPolicy {
  const o = cfg.overrides[activityId] ?? {};
  return {
    successCap: o.successCap ?? cfg.defaultSuccessCap,
    failureCap: o.failureCap ?? cfg.defaultFailureCap,
  };
}

/** Reliable per-stratum count: GROUP ALL aggregate (not GROUP BY <field>). */
async function countCold(activityId: string, succeeded: boolean, coldCutoffIso: string): Promise<number> {
  try {
    const rows = await surrealDB.query<{ count: number }>(
      `SELECT count() FROM ${TABLE}
         WHERE activity_id = $aid AND success = $ok AND executed_at < type::datetime($cut)
         GROUP ALL`,
      { aid: activityId, ok: succeeded, cut: coldCutoffIso },
    );
    return Array.isArray(rows) && rows.length > 0 ? Number(rows[0]?.count ?? 0) : 0;
  } catch (err) {
    logger.warn('[trace-retention] countCold failed; treating stratum as empty this cycle', {
      activityId, succeeded, error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

export interface StratumResult {
  activityId: string;
  status: string;
  coldCount: number;
  cap: number;
  keepProb: number;
  deletedEstimate: number;
  deletedActual: number | null; // null in dry-run
}

/**
 * REACH HISTORY ROLLUP — so the substrate can observe its own trajectory.
 *
 * The system records reach twice and NEITHER supports a time-series:
 *   - execution.reached  — per execution, timestamped, but the store is pruned to
 *                          TRACE_STORE_CAP oldest-first. Measured on the hub: the whole
 *                          table spans 2026-07-24..2026-08-08 (~15 days) and every one of
 *                          the 5,341 reach-graded rows fell inside a SINGLE week.
 *   - goal_execution_paths — full history, but only cumulative counters plus a
 *                          `last_executed_at`, so a row that accrued 50 attempts over three
 *                          weeks buckets entirely into its final week.
 *
 * So "are we reaching more over time?" — the question the whole learning loop exists to
 * answer — cannot be asked. The raw evidence is deleted faster than the signal accumulates,
 * and the surviving summary has no time resolution. Note the trap: the retention sweep this
 * file implements is what deletes it, so making retention work (which it now does) actively
 * destroys the trajectory unless something captures it first.
 *
 * This is that capture. Before any deletion, fold newly-graded executions into a tiny
 * per-ISO-week counter table that retention never touches.
 *
 * INCREMENTAL, NOT RECOMPUTED. Counts advance from a stored watermark and only ever add
 * rows newer than it. Recomputing a week from surviving rows would make its totals SHRINK as
 * pruning caught up — a monotonically-decreasing history, which is worse than none because it
 * looks plausible. The watermark is why this survives its own garbage collector.
 */
const REACH_HISTORY_WATERMARK = 'reach_history:__watermark__';

export async function rollupReachHistory(): Promise<{ scanned: number; weeks: number } | null> {
  try {
    const wmRows = await surrealDB.query<{ last_executed_at?: string }>(
      `SELECT last_executed_at FROM ${REACH_HISTORY_WATERMARK}`,
    );
    // First run has no watermark: start from the oldest row the store still holds rather
    // than from epoch, so the first bucket is honest about what it could actually see.
    const since = (Array.isArray(wmRows) && wmRows[0]?.last_executed_at)
      ? String(wmRows[0].last_executed_at)
      : new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    const rows = await surrealDB.query<{ executed_at?: string; reached?: boolean }>(
      `SELECT executed_at, reached FROM ${TABLE}
         WHERE reached != NONE AND executed_at > type::datetime($since)
         ORDER BY executed_at ASC LIMIT 20000`,
      { since },
    );
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) return { scanned: 0, weeks: 0 };

    const buckets = new Map<string, { reached: number; total: number }>();
    let maxTs = since;
    for (const r of list) {
      const ts = r?.executed_at;
      if (!ts) continue;
      const d = new Date(String(ts));
      if (Number.isNaN(d.getTime())) continue;
      // ISO week start (Monday), UTC.
      const day = (d.getUTCDay() + 6) % 7;
      const wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day))
        .toISOString().slice(0, 10);
      const b = buckets.get(wk) ?? { reached: 0, total: 0 };
      b.total += 1;
      if (r.reached === true) b.reached += 1;
      buckets.set(wk, b);
      if (String(ts) > maxTs) maxTs = String(ts);
    }

    for (const [wk, b] of buckets) {
      await surrealDB.query(
        `UPSERT reach_history:['${wk}'] SET
           week = $wk,
           reached = (reached ?? 0) + $reached,
           total = (total ?? 0) + $total,
           updated_at = time::now()`,
        { wk, reached: b.reached, total: b.total },
      );
    }
    await surrealDB.query(
      `UPSERT ${REACH_HISTORY_WATERMARK} SET last_executed_at = $ts, updated_at = time::now()`,
      { ts: maxTs },
    );
    logger.info('[trace-retention] reach-history rollup', {
      scanned: list.length, weeks: buckets.size, watermark: maxTs,
    });
    return { scanned: list.length, weeks: buckets.size };
  } catch (err) {
    // Never block the sweep on the observability write.
    logger.warn('[trace-retention] reach-history rollup failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Re-entrancy guard. The sweep has TWO independent callers — the interval timer in
 * startTraceRetentionSweep, and the db-admin reconcile route, which the substrate's
 * `trace-store-reconcile` activity drives on a ~5-minute lease. Neither knew about the
 * other, so they interleaved freely: observed 2026-08-09 in one process, sweeps at
 * 18:01:53 and 18:05:26 with a 30-minute configured interval.
 *
 * Concurrent sweeps are not merely redundant here, they are actively harmful. The
 * ceiling valve pages cold rows with a cutoff-bounded WHERE and no cursor, so two
 * sweeps select THE SAME rows and both issue DELETEs for them — duplicated work and
 * write contention on the one table where deletes already cost seconds per row
 * (16 indexes rewritten per delete). The overlap makes the exact bottleneck worse.
 *
 * A module-level boolean is the right scope: both callers live in this process, and a
 * cross-process lease already exists for the reconcile path. Second caller returns the
 * skip marker rather than throwing — a skipped sweep is normal, not an error, and the
 * next tick picks the work up.
 */
let sweepInFlight = false;

export async function runTraceRetentionSweep(
  cfg: TraceRetentionConfig = loadTraceRetentionConfig(),
): Promise<{ results: StratumResult[]; durationMs: number; orphanReaped: number; skipped?: true }> {
  if (sweepInFlight) {
    logger.info('[trace-retention] sweep already in flight — skipping this invocation', {
      note: 'timer tick and reconcile route both drive this sweep; overlapping runs would delete the same rows twice',
    });
    return { results: [], durationMs: 0, orphanReaped: 0, skipped: true };
  }
  sweepInFlight = true;
  try {
    return await runTraceRetentionSweepInner(cfg);
  } finally {
    // finally, not a trailing assignment: an exception anywhere in the sweep must not
    // leave the guard stuck true and disable retention for the life of the process.
    sweepInFlight = false;
  }
}

async function runTraceRetentionSweepInner(
  cfg: TraceRetentionConfig,
): Promise<{ results: StratumResult[]; durationMs: number; orphanReaped: number }> {
  const startedAt = Date.now();
  // CAPTURE BEFORE DELETE. The rollup must precede every prune below, or the sweep
  // destroys the only timestamped record of whether reach is improving.
  await rollupReachHistory();
  const coldCutoffIso = new Date(startedAt - cfg.hotWindowMs).toISOString();
  const statuses = ['success', 'failure'] as const;
  const results: StratumResult[] = [];

  // Auto-discover the strata actually worth sweeping this cycle: one GROUP BY,
  // keep the largest strata whose total exceeds the combined default caps,
  // bounded by autoDiscoverMax so a cycle's work stays bounded. Per-stratum
  // caps below still come from policyFor (overrides respected). Best-effort:
  // on failure we fall back to the configured list alone.
  // ── PRESSURE CHECK: when the store is over the global ceiling, the cheap valve
  // runs FIRST and discovery is skipped for this cycle. ────────────────────────
  //
  // Measured on the hub at 267,731 rows against a 150,000 ceiling: every sweep
  // cycle for hours ended in "sweep cycle failed: The operation timed out", so
  // `execution` was never pruned to cap and kept growing. The cycle spends its
  // budget before it reaches the valve:
  //
  //   SELECT activity_id, count() AS n FROM execution GROUP BY activity_id
  //     -> Iterate Table (FULL SCAN), 15,160ms measured
  //
  // and then sweeps up to autoDiscoverMax (60) discovered strata with several
  // queries each — all before the global-ceiling valve, which is the ONLY step
  // that bounds total size. The valve itself is cheap and index-backed:
  //
  //   SELECT id, executed_at FROM execution ORDER BY executed_at ASC LIMIT 1000
  //     -> Iterate Index (idx_execution_executed_at), 237ms measured
  //
  // Note this is NOT an unindexed-field problem: idx_execution_activity ON
  // execution FIELDS activity_id already exists and the GROUP BY full-scans
  // anyway, so it cannot be indexed away — the only fix is to not pay for it
  // while the store is over its hard bound.
  //
  // Ordering is the whole change. Stratified balance is the better policy and
  // keeps running normally; it is simply not the policy to spend a timing-out
  // budget on while the store is 1.8x over the bound it is supposed to enforce.
  // Once the valve brings the store back under the ceiling, the next cycle
  // discovers and sweeps strata as before — over a smaller table, so the scan
  // is cheaper too.
  let overCeiling = false;
  if (cfg.globalCeilingEnabled && cfg.globalCeiling > 0) {
    try {
      const rows = await surrealDB.query<{ count: number }>(`SELECT count() FROM ${TABLE} GROUP ALL`);
      const total = Array.isArray(rows) && rows.length > 0 ? Number(rows[0]?.count ?? 0) : 0;
      overCeiling = total > cfg.globalCeiling;
      if (overCeiling) {
        logger.warn('[trace-retention] over global ceiling — skipping stratum auto-discovery this cycle so the indexed valve is reached', {
          total, ceiling: cfg.globalCeiling, surplus: total - cfg.globalCeiling,
        });
      }
    } catch (err) {
      // Cannot tell: behave exactly as before rather than skipping work on a guess.
      logger.warn('[trace-retention] pressure check failed; proceeding with the normal cycle order', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let sweepActivities = cfg.activities;
  if (cfg.autoDiscover && !overCeiling) {
    try {
      const groups = await surrealDB.query<{ activity_id: unknown; n: unknown }>(
        `SELECT activity_id, count() AS n FROM ${TABLE} GROUP BY activity_id`,
      );
      const overCap = (Array.isArray(groups) ? groups : [])
        .filter((g) => typeof g?.activity_id === 'string' && Number(g?.n ?? 0) > cfg.defaultSuccessCap + cfg.defaultFailureCap)
        .sort((a, b) => Number(b.n) - Number(a.n))
        .slice(0, cfg.autoDiscoverMax)
        .map((g) => g.activity_id as string);
      sweepActivities = Array.from(new Set([...cfg.activities, ...overCap]));
      if (overCap.length > 0) {
        logger.info('[trace-retention] auto-discovered over-cap strata', {
          discovered: overCap.length, sweeping: sweepActivities.length,
        });
      }
    } catch (err) {
      logger.warn('[trace-retention] stratum auto-discovery failed; sweeping configured list only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const activityId of sweepActivities) {
    const policy = policyFor(cfg, activityId);
    for (const status of statuses) {
      const succeeded = status === 'success';
      const cap = status === 'success' ? policy.successCap : policy.failureCap;
      const coldCount = await countCold(activityId, succeeded, coldCutoffIso);

      if (coldCount <= cap) {
        results.push({
          activityId, status, coldCount, cap,
          keepProb: 1, deletedEstimate: 0, deletedActual: cfg.dryRun ? null : 0,
        });
        continue;
      }

      const keepProb = cap / coldCount;
      const deletedEstimate = Math.round(coldCount * (1 - keepProb));

      let deletedActual: number | null = null;
      if (!cfg.dryRun) {
        // Uniform reservoir, deleted in BOUNDED BATCHES. A single DELETE of ~20K
        // rows blocks the single-threaded SurrealDB for minutes (the exact
        // contention we are fixing), so we delete at most `batchSize` rows per
        // statement: select a bounded set of ids on the "delete" side of the
        // reservoir (rand::float() >= keepProb, evaluated per-record → uniform),
        // then DELETE that id list. RETURN NONE so no row bodies are hauled back.
        // Stop once we have removed the up-front surplus (coldCount - cap); no
        // expensive per-iteration full recount.
        const target = coldCount - cap;
        const batchSize = cfg.deleteBatchSize;
        const maxIters = Math.ceil(coldCount / batchSize) + 10; // generous guard
        let removed = 0;
        for (let iter = 0; iter < maxIters && removed < target; iter++) {
          // Clamp the final batch so we stop exactly at `target` (= coldCount - cap)
          // and never over-delete into the sample we mean to keep.
          const thisBatch = Math.min(batchSize, target - removed);
          const ids = await surrealDB.query<unknown>(
            `SELECT VALUE id FROM ${TABLE}
               WHERE activity_id = $aid AND success = $ok
                 AND executed_at < type::datetime($cut) AND rand::float() >= $keepProb
               LIMIT $batch`,
            { aid: activityId, ok: succeeded, cut: coldCutoffIso, keepProb, batch: thisBatch },
          );
          if (!Array.isArray(ids) || ids.length === 0) break; // tail exhausted
          await surrealDB.query('DELETE $ids RETURN NONE', { ids });
          removed += ids.length;
        }
        deletedActual = removed;
      }

      results.push({ activityId, status, coldCount, cap, keepProb, deletedEstimate, deletedActual });
    }
  }

  // ── Global ceiling safety valve ────────────────────────────────────────────
  // trace_digest / concept_usage have no per-stratum sweep and grow unbounded
  // (the re-thrash root at 1.57M / 614k rows). Reap cold rows older than the hot
  // window in BOUNDED batches (select-ids then DELETE $ids, same pattern as the
  // stratified sweep) so no giant transaction spikes RSS; capped per sweep so the
  // backlog drains over cycles rather than in one memory-ballooning DELETE.
  if (!cfg.dryRun) {
    const auxTables: Array<{ table: string; timeField: string }> = [
      { table: "trace_digest", timeField: "executed_at" },
      { table: "concept_usage", timeField: "recorded_at" },
    ];
    const auxCutoffIso = new Date(Date.now() - cfg.hotWindowMs).toISOString();
    const auxMaxPerSweep = 50000;
    const auxBatch = cfg.deleteBatchSize;
    for (const { table, timeField } of auxTables) {
      let removed = 0;
      try {
        for (let iter = 0; iter < Math.ceil(auxMaxPerSweep / auxBatch) && removed < auxMaxPerSweep; iter++) {
          const ids = await surrealDB.query<unknown>(
            `SELECT VALUE id FROM ${table} WHERE ${timeField} < type::datetime($cut) LIMIT $batch`,
            { cut: auxCutoffIso, batch: Math.min(auxBatch, auxMaxPerSweep - removed) },
          );
          if (!Array.isArray(ids) || ids.length === 0) break;
          await surrealDB.query("DELETE $ids RETURN NONE", { ids });
          removed += ids.length;
        }
        if (removed > 0) logger.info("[trace-retention] aux-table reap", { table, removed });
      } catch (err) {
        logger.warn("[trace-retention] aux-table reap failed", { table, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  // The stratified sweep above bounds each (activity_id,status) stratum, but the
  // store's global row_count is the SUM over ALL strata. The live fleet spreads
  // across 1000+ distinct activity_ids (every composed-cap-*, learned-*,
  // auto-bridge-*, and probe mint is its own stratum), so the total can sit far
  // above the global cap while EVERY individual stratum is under its per-stratum
  // cap — the exact condition trace_store_health_observer alarms on
  // (trace_store_counters.row_count > cap). A purely stratified enforcer can
  // therefore NEVER clear a global-cap alarm, and the unbounded growth axis is the
  // strata COUNT, not any one stratum's depth (the OOM re-pressure risk).
  //
  // This valve keeps the newest `globalCeiling` rows globally by executed_at and
  // drops the oldest surplus, so SENSE (the sensor's global cap) and ENFORCE (this
  // prune) measure the SAME invariant and the loop is honest. It runs AFTER the
  // stratified sweep (which does the per-stratum-balanced work first), reuses the
  // same enabled/dryRun gating and the same bounded-batch delete, and pushes a
  // synthetic StratumResult so the shared counter-decrement below AND the reconcile
  // route's `deleted` tally both account for it (no separate decrement — that would
  // double-count). Default ceiling == TRACE_STORE_CAP so the enforced number is the
  // sensed number; TRACE_RETENTION_GLOBAL_CEILING decouples, and
  // TRACE_RETENTION_GLOBAL_CEILING_ENABLED=false disables just this valve.
  // ENTRY LOGGING, BECAUSE THIS BRANCH IS SILENTLY SKIPPED (2026-08-09).
  //
  // Measured on the live hub: the store sits at 2x its cap, the sensor alarms, the
  // sweep completes without error, and the full sweep log is exactly three lines —
  // reach-history rollup, the "over global ceiling ... so the indexed valve is
  // reached" warning, and the aux-table reap. This valve's delete never runs and
  // logs nothing. Net rate measured +436 rows/hr across 22 samples / 27 min with
  // ZERO negative deltas, which is consistent with nothing deleting from `execution`
  // at all.
  //
  // Its three gates all pass when checked by hand (globalCeilingEnabled default true,
  // globalCeiling 150000, dryRun false), and the count query returns correctly —
  // `SELECT count() FROM execution GROUP ALL` yields {"count":306191}, exactly the
  // shape the code reads. So the skip is not the gate and not the count, and there is
  // no return/throw between the aux reap and here.
  //
  // Log the entry rather than infer it from surrounding lines. Every diagnosis today
  // that reasoned from adjacent evidence instead of instrumenting the branch itself
  // was wrong; this makes the next cycle answer the question directly.
  logger.info('[trace-retention] global-ceiling valve: entering', {
    enabled: cfg.globalCeilingEnabled,
    ceiling: cfg.globalCeiling,
    dryRun: cfg.dryRun,
    deleteBatchSize: cfg.deleteBatchSize,
  });
  if (cfg.globalCeilingEnabled && cfg.globalCeiling > 0) {
    let total = 0;
    try {
      const rows = await surrealDB.query<{ count: number }>(`SELECT count() FROM ${TABLE} GROUP ALL`);
      total = Array.isArray(rows) && rows.length > 0 ? Number(rows[0]?.count ?? 0) : 0;
      logger.info('[trace-retention] global-ceiling valve: counted', { total, ceiling: cfg.globalCeiling, willPrune: total > cfg.globalCeiling });
    } catch (err) {
      logger.warn('[trace-retention] global-ceiling count failed; skipping valve this cycle', {
        error: err instanceof Error ? err.message : String(err),
      });
      total = 0;
    }

    if (total > cfg.globalCeiling) {
      const surplus = total - cfg.globalCeiling;
      const keepProb = cfg.globalCeiling / total;
      let removed: number | null = null;
      if (!cfg.dryRun) {
        const batchSize = cfg.deleteBatchSize;
        // Target this sweep's work, not the whole surplus (see ceilingPerSweepCap).
        const target = Math.min(surplus, cfg.ceilingPerSweepCap);
        const budgetUntil = Date.now() + cfg.ceilingBudgetMs;
        const maxIters = Math.ceil(target / batchSize) + 10; // generous guard
        let done = 0;
        let stoppedBy: 'target' | 'budget' | 'empty' | 'iters' = 'iters';
        for (let iter = 0; iter < maxIters && done < target; iter++) {
          if (Date.now() >= budgetUntil) { stoppedBy = 'budget'; break; }
          const thisBatch = Math.min(batchSize, target - done);
          // NO `ORDER BY` — that is the whole fix, and this file already proved it.
          //
          // The previous comment here claimed executed_at ORDER BY was index-backed and
          // bounded. It is not: the orphan-reap block below records the measured truth
          // for the same table — ORDER BY triggers SurrealDB 2.3.3 MemoryOrderedLimit, a
          // full-table materialize+sort, and "with ORDER BY even LIMIT 1 times out >30s;
          // without it, LIMIT 1000 returns in ~1s". That fix was found once, for the
          // orphan reap, and never applied here.
          //
          // Measured 2026-08-09: every sweep died on this statement —
          //   [trace-retention] over global ceiling {"total":302376,"surplus":152376}
          //   [trace-retention] sweep cycle failed {"error":"...The operation timed out."}
          // and because the loop re-queries from the head each iteration, a timeout on
          // iteration 1 means ZERO rows deleted, forever. The valve that exists to shrink
          // the table could not run at the table size that made it necessary — the store
          // grew ~1000 rows/hr against a cap it was already 2x over.
          //
          // A cutoff bound gives us oldest-first without a sort: executed_at is
          // index-backed, so `WHERE executed_at < $cut` is a bounded range scan. The
          // cutoff is the hot-window edge, which is exactly the retention contract
          // (keep everything newer than the hot window) — so this deletes only what the
          // policy already designates as cold, and never touches recent traces.
          const rows = await surrealDB.query<{ id: unknown }>(
            `SELECT id FROM ${TABLE} WHERE executed_at < type::datetime($cut) LIMIT $batch`,
            // Reuse the sweep's own cold cutoff (line ~295) rather than recomputing it,
            // so the valve and the per-activity strata can never disagree about what
            // "cold" means.
            { batch: thisBatch, cut: coldCutoffIso },
          );
          const ids = (Array.isArray(rows) ? rows : [])
            .map((r) => (r as { id?: unknown })?.id)
            .filter((id) => id != null);
          if (iter === 0) {
            // WHY THE FIRST ITERATION IS LOGGED (2026-08-09).
            //
            // The valve enters, counts 306326 against a 150000 ceiling, sets
            // willPrune:true — and then emits nothing at all. The only silent exit in
            // this loop is the `break` below, so a valve that "does not run" and a
            // valve that runs and finds zero cold rows are indistinguishable from the
            // outside. They have opposite fixes: the first is a control-flow bug, the
            // second means the ceiling and the cold cutoff disagree about what should
            // be deleted, and the valve is correctly declining to touch hot traces.
            //
            // Log what the first SELECT actually returned so the next cycle says which
            // one it is instead of leaving it to be inferred.
            logger.info('[trace-retention] global-ceiling valve: first batch', {
              cut: coldCutoffIso,
              requested: thisBatch,
              returned: ids.length,
              surplus,
              target,
            });
          }
          if (ids.length === 0) {
            // Not necessarily "table drained" — the original comment assumed the only
            // reason for an empty page is exhaustion. With a cutoff-bounded WHERE it
            // also means nothing is older than the hot window, which is a policy
            // disagreement rather than success. Say which, and say it at warn level
            // when the table is over its ceiling and still cannot shed anything.
            logger.warn('[trace-retention] global-ceiling valve: nothing cold to delete', {
              cut: coldCutoffIso,
              iter,
              deletedSoFar: done,
              surplus,
              note: 'over ceiling but no rows older than the hot window — ceiling and cold cutoff disagree',
            });
            stoppedBy = 'empty';
            break;
          }
          await surrealDB.query('DELETE $ids RETURN NONE', { ids });
          done += ids.length;
          if (done >= target) stoppedBy = 'target';
        }
        removed = done;
        // `remaining` is what this sweep deliberately left for the next one. It is the
        // number to watch: a healthy valve shows it falling sweep over sweep. If it
        // holds steady while removed>0, intake matches drain and the cap needs raising.
        logger.info('[trace-retention] global-ceiling valve: done', {
          removed,
          target,
          surplus,
          remaining: Math.max(0, surplus - done),
          stoppedBy,
          batchSize,
          elapsedMs: Date.now() - (budgetUntil - cfg.ceilingBudgetMs),
        });
      }
      // Synthetic stratum so the counter-decrement below and the reconcile route's
      // `deleted` reduce both include the valve's deletions.
      results.push({
        activityId: '__global_ceiling__',
        status: 'all',
        coldCount: total,
        cap: cfg.globalCeiling,
        keepProb,
        deletedEstimate: surplus,
        deletedActual: removed,
      });
    }
  }

  // ── Orphaned content reap ──────────────────────────────────────────────────
  // execution_trace_content holds the split-out heavy FLEXIBLE payload (tasks,
  // state_snapshot, impulse_resolutions, output_impulses) co-written per trace,
  // keyed by execution_id = meta::id(execution.id). The stratified sweep and the
  // global-ceiling valve above reap `execution` rows but NEVER the content table,
  // so every reaped execution leaves its content row behind as an ORPHAN. Live,
  // this backlog reached ~1.08M rows (1.2M content backing ~111k executions) — the
  // single largest table, growing unbounded and re-inflating anon RSS (a storage/
  // OOM-headroom leak, not latency: reads are execution_id-indexed). This step
  // deletes content whose parent execution is PROVABLY absent, in bounded batches,
  // capped per sweep and time-budgeted so one cycle can never attempt the whole
  // backlog in a tight loop (which would spike RSS on this memory-pressured box).
  // SurrealDB 2.3.x has no covering-index projection, so paging materializes row
  // bodies (tens of ms/row under pressure) — hence the hard time budget and the
  // resumable module-level cursor. A created_at safety window (orphanReapMinAgeMs)
  // skips rows young enough to be mid dual-write, so a trace whose execution row
  // has not yet committed is never false-reaped. No trace_store_counters decrement:
  // that counter tracks `execution`, not this table. Same enabled/dryRun gating;
  // dry-run scans + counts but deletes nothing.
  let orphanReaped = 0;
  if (cfg.orphanReapEnabled && cfg.orphanReapPerSweepCap > 0) {
    const budgetUntil = Date.now() + cfg.orphanReapBudgetMs;
    const safeCutIso = new Date(startedAt - cfg.orphanReapMinAgeMs).toISOString();
    const batch = cfg.deleteBatchSize;
    let scanned = 0;
    try {
      while (orphanReaped < cfg.orphanReapPerSweepCap && Date.now() < budgetUntil) {
        // NB: intentionally NO 'ORDER BY execution_id'. The unique idx_etc_execution_id
        // range scan already yields rows in ascending execution_id order (verified
        // live), so the `execution_id > $cursor` cursor paging still advances
        // monotonically. An explicit ORDER BY here triggers SurrealDB 2.3.3
        // MemoryOrderedLimit — a full-table materialize+sort of ALL ~1.2M big-blob
        // rows — which timed out on EVERY sweep (reaped 0 for weeks; orphans stuck
        // at ~1.08M) and spiked RSS. Measured: with ORDER BY even LIMIT 1 times out
        // >30s; without it, LIMIT 1000 returns in ~1s.
        const page = await surrealDB.query<string>(
          `SELECT VALUE execution_id FROM execution_trace_content
             WHERE execution_id > $cursor AND created_at < type::datetime($safeCut)
             LIMIT $batch`,
          { cursor: orphanReapCursor, safeCut: safeCutIso, batch },
        );
        if (!Array.isArray(page) || page.length === 0) {
          orphanReapCursor = ''; // index range exhausted — wrap for next sweep
          break;
        }
        scanned += page.length;
        orphanReapCursor = page[page.length - 1]; // advance + persist across sweeps

        const existing = await surrealDB.query<string>(
          `SELECT VALUE meta::id(id) FROM execution
             WHERE id IN $eids.map(|$e| type::thing('execution', $e))`,
          { eids: page },
        );
        const existingSet = new Set(Array.isArray(existing) ? existing : []);
        const orphans = page.filter((eid) => !existingSet.has(eid));

        if (orphans.length > 0 && !cfg.dryRun) {
          await surrealDB.query(
            'DELETE execution_trace_content WHERE execution_id IN $orphans RETURN NONE',
            { orphans },
          );
        }
        orphanReaped += orphans.length;

        if (page.length < batch) {
          orphanReapCursor = ''; // reached the tail — wrap for next sweep
          break;
        }
      }
    } catch (err) {
      logger.warn('[trace-retention] orphan content reap failed; cursor retained for next sweep', {
        error: err instanceof Error ? err.message : String(err),
        scanned, orphanReaped, cursor: orphanReapCursor,
      });
    }
    logger.info('[trace-retention] orphan content reap', {
      dryRun: cfg.dryRun,
      scanned,
      [cfg.dryRun ? 'wouldReap' : 'reaped']: orphanReaped,
      perSweepCap: cfg.orphanReapPerSweepCap,
      budgetMs: cfg.orphanReapBudgetMs,
      minAgeMs: cfg.orphanReapMinAgeMs,
      resumeCursor: orphanReapCursor,
    });
  }

  // Reconcile the O(1) trace_store_counters row (migration 156) against the
  // rows actually removed from `execution` this cycle. The counter is
  // incremented once per insert (execution-traces.ts / activities.ts) and read
  // by /metrics/db + the reconciliation observer, so a live prune MUST decrement
  // it or the over-cap signal never clears. Dry-run touches nothing.
  if (!cfg.dryRun) {
    const totalDeleted = results.reduce((n, r) => n + (r.deletedActual ?? 0), 0);
    if (totalDeleted > 0) await decrementTraceStoreCounter(totalDeleted);
  }

  const durationMs = Date.now() - startedAt;
  logger.info('[trace-retention] sweep complete', {
    dryRun: cfg.dryRun,
    hotWindowMs: cfg.hotWindowMs,
    coldCutoff: coldCutoffIso,
    durationMs,
    orphanReaped,
    strata: results.map((r) => ({
      stratum: `${r.activityId}/${r.status}`,
      coldCount: r.coldCount,
      cap: r.cap,
      [cfg.dryRun ? 'wouldDelete' : 'deleted']: cfg.dryRun ? r.deletedEstimate : r.deletedActual,
    })),
  });

  return { results, durationMs, orphanReaped };
}

/**
 * Wire the periodic sweep. Mirrors exemplar-selector / learning-track-classifier:
 * delayed first run (DB warmup), then on a fixed interval. No-op if disabled.
 */
export function startTraceRetentionSweep(cfg: TraceRetentionConfig = loadTraceRetentionConfig()): void {
  if (!cfg.enabled) {
    logger.info('[trace-retention] disabled (set TRACE_RETENTION_ENABLED=true to enable)');
    return;
  }
  logger.info('[trace-retention] job started', {
    dryRun: cfg.dryRun,
    intervalMs: cfg.intervalMs,
    activities: cfg.activities,
    defaultSuccessCap: cfg.defaultSuccessCap,
    defaultFailureCap: cfg.defaultFailureCap,
    overrides: cfg.overrides,
  });

  const tick = () =>
    void runTraceRetentionSweep(cfg).catch((err) =>
      logger.warn('[trace-retention] sweep cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );

  setTimeout(tick, 30_000); // 30s warmup, matches sibling jobs
  setInterval(tick, cfg.intervalMs);
}
