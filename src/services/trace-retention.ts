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
    deleteBatchSize: parseInt(env.TRACE_RETENTION_DELETE_BATCH ?? '1000', 10),
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

export async function runTraceRetentionSweep(
  cfg: TraceRetentionConfig = loadTraceRetentionConfig(),
): Promise<{ results: StratumResult[]; durationMs: number; orphanReaped: number }> {
  const startedAt = Date.now();
  const coldCutoffIso = new Date(startedAt - cfg.hotWindowMs).toISOString();
  const statuses = ['success', 'failure'] as const;
  const results: StratumResult[] = [];

  // Auto-discover the strata actually worth sweeping this cycle: one GROUP BY,
  // keep the largest strata whose total exceeds the combined default caps,
  // bounded by autoDiscoverMax so a cycle's work stays bounded. Per-stratum
  // caps below still come from policyFor (overrides respected). Best-effort:
  // on failure we fall back to the configured list alone.
  let sweepActivities = cfg.activities;
  if (cfg.autoDiscover) {
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
  if (cfg.globalCeilingEnabled && cfg.globalCeiling > 0) {
    let total = 0;
    try {
      const rows = await surrealDB.query<{ count: number }>(`SELECT count() FROM ${TABLE} GROUP ALL`);
      total = Array.isArray(rows) && rows.length > 0 ? Number(rows[0]?.count ?? 0) : 0;
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
        const maxIters = Math.ceil(surplus / batchSize) + 10; // generous guard
        let done = 0;
        for (let iter = 0; iter < maxIters && done < surplus; iter++) {
          const thisBatch = Math.min(batchSize, surplus - done);
          // Oldest-first paging: executed_at is index-backed (idx_execution_executed_at
          // → Iterate Index, bounded range scan) and MUST appear in the projection —
          // SurrealDB 2.3.x requires any ORDER BY field to be selected. Delete that id
          // list with RETURN NONE so no row bodies are hauled back. Re-querying from the
          // head each iteration converges because the prior batch is already deleted.
          const rows = await surrealDB.query<{ id: unknown }>(
            `SELECT id, executed_at FROM ${TABLE} ORDER BY executed_at ASC LIMIT $batch`,
            { batch: thisBatch },
          );
          const ids = (Array.isArray(rows) ? rows : [])
            .map((r) => (r as { id?: unknown })?.id)
            .filter((id) => id != null);
          if (ids.length === 0) break; // table drained
          await surrealDB.query('DELETE $ids RETURN NONE', { ids });
          done += ids.length;
        }
        removed = done;
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
