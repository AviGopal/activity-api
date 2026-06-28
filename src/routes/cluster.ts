/**
 * Cluster status route — observability for the hierarchical signature clustering
 * pass (D3).
 *
 * Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
 *       (task D3.4).
 *
 * GET /v2/cluster/status — last clustering-run timestamp + cluster / noise /
 * contamination counts for the caller's org. Auth: gated by the global `/v2/*`
 * jwtAuthMiddleware in src/index.ts; reads are org-scoped via queryWithAuth
 * ($token.org_id PERMISSIONS), mirroring the read shape used by other GET routes.
 *
 * This task group surfaces status only — it does NOT write cluster-level
 * posteriors (D4) or read them in the selector (D5).
 */

import { Hono } from 'hono';
import { queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';
import { getClusterUpdateCounters } from '../lib/cluster-posterior';

const cluster = new Hono();

interface ClusterRunRow {
  ran_at?: string;
  n_signatures?: number;
  n_clusters?: number;
  n_noise?: number;
  n_contaminated?: number;
  duration_ms?: number;
}

/**
 * GET /v2/cluster/status
 * Returns the most-recent signature_cluster_run for the org plus live counts from
 * signature_cluster_assignment (cluster count = distinct cluster_id, contamination
 * count = distinct contaminated cluster_id).
 */
cluster.get('/status', async (c) => {
  try {
    if (!hasJwtAuth(c)) {
      return c.json({ error: 'unauthorized', message: 'JWT authentication required' }, 401);
    }
    const jwtAuth = getJwtAuthFromContext(c);

    // Last run row (most recent by ran_at).
    const runRows = await queryWithAuth<ClusterRunRow>(
      jwtAuth!.jwtToken,
      `
      SELECT ran_at, n_signatures, n_clusters, n_noise, n_contaminated, duration_ms
      FROM signature_cluster_run
      ORDER BY ran_at DESC
      LIMIT 1
    `
    );
    const lastRun = Array.isArray(runRows) && runRows.length > 0 ? runRows[0] : null;

    // Live counts from the assignment table (authoritative for "current" state,
    // independent of when the last run-log row landed).
    const clusterCountRows = await queryWithAuth<{ count: number }>(
      jwtAuth!.jwtToken,
      `
      SELECT count() AS count FROM (
        SELECT cluster_id FROM signature_cluster_assignment GROUP BY cluster_id
      ) GROUP ALL
    `
    );
    const contaminatedCountRows = await queryWithAuth<{ count: number }>(
      jwtAuth!.jwtToken,
      `
      SELECT count() AS count FROM (
        SELECT cluster_id FROM signature_cluster_assignment
        WHERE contaminated = true GROUP BY cluster_id
      ) GROUP ALL
    `
    );

    const liveClusterCount =
      Array.isArray(clusterCountRows) && clusterCountRows.length > 0
        ? clusterCountRows[0].count ?? 0
        : 0;
    const liveContaminatedCount =
      Array.isArray(contaminatedCountRows) && contaminatedCountRows.length > 0
        ? contaminatedCountRows[0].count ?? 0
        : 0;

    return c.json({
      last_run_at: lastRun?.ran_at ?? null,
      // From the last run-log row (per-pass snapshot):
      last_run: lastRun
        ? {
            n_signatures: lastRun.n_signatures ?? 0,
            n_clusters: lastRun.n_clusters ?? 0,
            n_noise: lastRun.n_noise ?? 0,
            n_contaminated: lastRun.n_contaminated ?? 0,
            duration_ms: lastRun.duration_ms ?? 0,
          }
        : null,
      // Live counts from current assignment rows:
      cluster_count: liveClusterCount,
      contamination_count: liveContaminatedCount,
      // Noise is only meaningfully recorded at run time (signatures embedded but
      // unassigned this pass); surface the last run's value.
      noise_count: lastRun?.n_noise ?? 0,
      // D4.4 — cluster-level Thompson write counters (process-local; no central
      // metrics registry exists in this codebase, so they are surfaced here).
      cluster_update_counters: getClusterUpdateCounters(),
    });
  } catch (err) {
    logger.error('cluster/status: query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: 'internal_error', message: 'failed to read cluster status' }, 500);
  }
});

export default cluster;
