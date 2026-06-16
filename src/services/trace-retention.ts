/**
 * Trace retention sweep — stratified, bounded reservoir over activity_execution_traces.
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
 *  - created_at is a SurrealDB `datetime` (verified via type::is::datetime), NOT a
 *    string — comparing it against a string literal silently matches nothing, so the
 *    ISO cutoff must be cast with `<datetime>$cut`.
 *  - Deletes go through the ROOT path (surrealDB.query), never queryWithAuth — the
 *    table's PERMISSIONS would otherwise drop the delete silently.
 *  - rand::float() is evaluated per-record in a WHERE clause → uniform reservoir.
 *
 * Default-disabled (TRACE_RETENTION_ENABLED) and dry-run-able
 * (TRACE_RETENTION_DRY_RUN) so it is reviewable before any deletion runs.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

const TABLE = 'activity_execution_traces';

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
async function countCold(activityId: string, status: string, coldCutoffIso: string): Promise<number> {
  const rows = await surrealDB.query<{ count: number }>(
    `SELECT count() FROM ${TABLE}
       WHERE activity_id = $aid AND status = $st AND created_at < <datetime>$cut
       GROUP ALL`,
    { aid: activityId, st: status, cut: coldCutoffIso },
  );
  return Array.isArray(rows) && rows.length > 0 ? Number(rows[0]?.count ?? 0) : 0;
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
): Promise<{ results: StratumResult[]; durationMs: number }> {
  const startedAt = Date.now();
  const coldCutoffIso = new Date(startedAt - cfg.hotWindowMs).toISOString();
  const statuses = ['success', 'failure'] as const;
  const results: StratumResult[] = [];

  for (const activityId of cfg.activities) {
    const policy = policyFor(cfg, activityId);
    for (const status of statuses) {
      const cap = status === 'success' ? policy.successCap : policy.failureCap;
      const coldCount = await countCold(activityId, status, coldCutoffIso);

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
               WHERE activity_id = $aid AND status = $st
                 AND created_at < <datetime>$cut AND rand::float() >= $keepProb
               LIMIT $batch`,
            { aid: activityId, st: status, cut: coldCutoffIso, keepProb, batch: thisBatch },
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

  const durationMs = Date.now() - startedAt;
  logger.info('[trace-retention] sweep complete', {
    dryRun: cfg.dryRun,
    hotWindowMs: cfg.hotWindowMs,
    coldCutoff: coldCutoffIso,
    durationMs,
    strata: results.map((r) => ({
      stratum: `${r.activityId}/${r.status}`,
      coldCount: r.coldCount,
      cap: r.cap,
      [cfg.dryRun ? 'wouldDelete' : 'deleted']: cfg.dryRun ? r.deletedEstimate : r.deletedActual,
    })),
  });

  return { results, durationMs };
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
