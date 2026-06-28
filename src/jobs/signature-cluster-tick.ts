/**
 * signature-cluster-tick — periodic clustering pass over `signature_embedding`.
 *
 * Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
 *       (tasks D3.2 + D3.3).
 *
 * Per pass, PER org:
 *   (a) load all `signature_embedding` rows (the embeddings D2 already wrote — we
 *       never re-embed);
 *   (b) call clusterSignatures() (delegates to concept-db, re-labels with a STABLE
 *       content-derived cluster_id — see signature-cluster.ts);
 *   (c) UPSERT one `signature_cluster_assignment` row per clustered signature
 *       (signature -> stable cluster_id, assigned_at);
 *   (d) CONTAMINATION check (D3.3): for each cluster compute each member's
 *       empirical success rate p̂_s from `context_thompson_scores`; if the spread
 *       (max p̂ − min p̂) across members with n_s ≥ 5 exceeds 0.4, mark the WHOLE
 *       cluster contaminated=true;
 *   (e) write a `signature_cluster_run` log row (counts + duration).
 *
 * NOISE: a signature that has an embedding but is not placed in any cluster this
 * pass (concept-db dropped it / it formed no group) is "noise". We DO NOT write a
 * cluster assignment for it — the selector (D5) falls back to leaf-only for any
 * signature with no assignment row, which is the correct degraded behaviour.
 *
 * CONTAMINATION AGGREGATION (exact):
 *   `context_thompson_scores` keys leaf rows on (org_id, template_id,
 *   signature_version, context_bucket), where context_bucket == the signature for
 *   sig-keyed rows, with float fields `alpha`, `beta` (Beta(α,β) posterior). A
 *   signature can have MULTIPLE rows (one per template_id). We aggregate per
 *   signature by SUMMING the Beta pseudo-counts across its rows:
 *       α_s = Σ alpha   over rows where context_bucket = signature
 *       β_s = Σ beta    over rows where context_bucket = signature
 *   Then:
 *       p̂_s = α_s / (α_s + β_s)
 *       n_s = (α_s + β_s) - 2        (observations beyond the Beta(1,1) prior;
 *                                     each leaf row carries a +1/+1 prior, so the
 *                                     summed prior is subtracted as the per-row
 *                                     unit — we subtract the single combined unit
 *                                     prior of 2, consistent with the n_observations
 *                                     intuition used elsewhere)
 *   Only members with n_s ≥ 5 ("qualifying") participate in the spread. If ≥ 2
 *   members qualify and (max p̂ − min p̂) > 0.4, the cluster is contaminated.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { clusterSignatures, type ClusterInputItem } from '../lib/signature-cluster';

const CONTAMINATION_MIN_N = 5;          // n_s threshold for a member to count
const CONTAMINATION_SPREAD = 0.4;       // max p̂ − min p̂ that trips contamination

interface ClusterTickResult {
  n_signatures: number;
  n_clusters: number;
  n_noise: number;
  n_contaminated: number;
  duration_ms: number;
}

interface EmbeddingRow {
  org_id: string;
  signature: string;
  signature_version: number;
  embedding: number[];
}

/**
 * Aggregate per-signature (α_s, β_s) from context_thompson_scores for the given
 * org. Returns a map keyed by signature (context_bucket) -> { alpha, beta }.
 * Cluster-level rows (context_bucket starting "cluster:") are excluded.
 */
async function loadSignaturePosteriors(
  orgId: string
): Promise<Map<string, { alpha: number; beta: number }>> {
  const rows = await surrealDB.query<{
    context_bucket: string;
    alpha: number;
    beta: number;
  }>(
    `
    SELECT context_bucket,
           math::sum(alpha) AS alpha,
           math::sum(beta)  AS beta
    FROM context_thompson_scores
    WHERE org_id = $org_id
      AND context_bucket IS NOT NONE
    GROUP BY context_bucket
  `,
    { org_id: orgId }
  );

  const map = new Map<string, { alpha: number; beta: number }>();
  for (const r of rows ?? []) {
    if (!r?.context_bucket) continue;
    // Exclude cluster-LEVEL rows (D1.4 convention: context_bucket "cluster:<id>")
    // — only leaf signature rows feed the contamination check.
    if (r.context_bucket.startsWith('cluster:')) continue;
    const alpha = typeof r.alpha === 'number' ? r.alpha : 0;
    const beta = typeof r.beta === 'number' ? r.beta : 0;
    map.set(r.context_bucket, { alpha, beta });
  }
  return map;
}

/**
 * Decide whether a cluster is contaminated (D3.3). See module header for the
 * exact aggregation.
 */
function isContaminated(
  members: string[],
  posteriors: Map<string, { alpha: number; beta: number }>
): boolean {
  const qualifying: number[] = [];
  for (const sig of members) {
    const post = posteriors.get(sig);
    if (!post) continue;
    const total = post.alpha + post.beta;
    if (total <= 0) continue;
    const n_s = total - 2; // observations beyond the combined Beta(1,1) prior
    if (n_s < CONTAMINATION_MIN_N) continue;
    qualifying.push(post.alpha / total); // p̂_s
  }
  if (qualifying.length < 2) return false;
  const spread = Math.max(...qualifying) - Math.min(...qualifying);
  return spread > CONTAMINATION_SPREAD;
}

/** Run one clustering pass for a single org. */
async function clusterOrg(
  orgId: string,
  rows: EmbeddingRow[]
): Promise<{ n_clusters: number; n_noise: number; n_contaminated: number; assigned: number }> {
  // Signature version is uniform within a (signature) row; we cluster across the
  // org's full embedding set and carry each signature's version onto its
  // assignment. Build the version lookup before clustering.
  const versionBySignature = new Map<string, number>();
  const items: ClusterInputItem[] = [];
  for (const r of rows) {
    if (!Array.isArray(r.embedding) || r.embedding.length !== 384) continue;
    versionBySignature.set(r.signature, r.signature_version ?? 0);
    items.push({ id: r.signature, embedding: r.embedding });
  }

  const clusters = await clusterSignatures(items);

  // Signatures placed into a cluster this pass.
  const clustered = new Set<string>();
  for (const c of clusters) for (const m of c.members) clustered.add(m);
  const n_noise = items.length - clustered.size;

  if (clusters.length === 0) {
    return { n_clusters: 0, n_noise, n_contaminated: 0, assigned: 0 };
  }

  // Contamination needs per-signature empirical success rates.
  const posteriors = await loadSignaturePosteriors(orgId);

  let n_contaminated = 0;
  let assigned = 0;
  for (const cluster of clusters) {
    const contaminated = isContaminated(cluster.members, posteriors);
    if (contaminated) n_contaminated++;

    for (const sig of cluster.members) {
      const sigVersion = versionBySignature.get(sig) ?? 0;
      try {
        // UPSERT: one assignment row per (signature_version, signature).
        // DELETE-then-CREATE keeps the assignment current under the append-only
        // PERMISSIONS (FOR update NONE) on signature_cluster_assignment — the
        // table is rewritten each pass, mirroring how the embedding pipeline
        // re-CREATEs rows.
        await surrealDB.query(
          `
          DELETE signature_cluster_assignment
            WHERE signature = $signature AND signature_version = $signature_version;
          CREATE signature_cluster_assignment CONTENT {
            org_id: $org_id,
            signature: $signature,
            signature_version: $signature_version,
            cluster_id: $cluster_id,
            contaminated: $contaminated,
            assigned_at: time::now()
          };
        `,
          {
            org_id: orgId,
            signature: sig,
            signature_version: sigVersion,
            cluster_id: cluster.cluster_id,
            contaminated,
          }
        );
        assigned++;
      } catch (err) {
        logger.warn('signature-cluster-tick: assignment upsert failed (non-blocking)', {
          signature: sig,
          cluster_id: cluster.cluster_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { n_clusters: clusters.length, n_noise, n_contaminated, assigned };
}

/**
 * Run one full clustering tick across all orgs. Never throws fatally — per-org
 * failures are logged and the pass continues. Writes one signature_cluster_run
 * log row per org processed.
 */
export async function runSignatureClusterTick(): Promise<ClusterTickResult[]> {
  const startedAll = Date.now();

  // Load all embeddings (org-scoped grouping below). 384-dim guard applied per row.
  const allRows = await surrealDB.query<EmbeddingRow>(
    `SELECT org_id, signature, signature_version, embedding FROM signature_embedding`
  );

  if (!allRows || allRows.length === 0) {
    logger.info('signature-cluster-tick: no signature_embedding rows; nothing to cluster');
    return [];
  }

  // Group by org.
  const byOrg = new Map<string, EmbeddingRow[]>();
  for (const r of allRows) {
    if (!r?.org_id) continue;
    const bucket = byOrg.get(r.org_id) ?? [];
    bucket.push(r);
    byOrg.set(r.org_id, bucket);
  }

  const results: ClusterTickResult[] = [];
  for (const [orgId, rows] of byOrg) {
    const started = Date.now();
    try {
      const { n_clusters, n_noise, n_contaminated } = await clusterOrg(orgId, rows);
      const duration_ms = Date.now() - started;
      const result: ClusterTickResult = {
        n_signatures: rows.length,
        n_clusters,
        n_noise,
        n_contaminated,
        duration_ms,
      };

      // Run-log row (D3.2).
      try {
        await surrealDB.query(
          `
          CREATE signature_cluster_run CONTENT {
            org_id: $org_id,
            n_signatures: $n_signatures,
            n_clusters: $n_clusters,
            n_noise: $n_noise,
            n_contaminated: $n_contaminated,
            duration_ms: $duration_ms,
            ran_at: time::now()
          }
        `,
          { org_id: orgId, ...result }
        );
      } catch (err) {
        logger.warn('signature-cluster-tick: run-log insert failed (non-blocking)', {
          org_id: orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info('signature-cluster-tick: org complete', { org_id: orgId, ...result });
      results.push(result);
    } catch (err) {
      logger.error('signature-cluster-tick: org pass failed (non-blocking)', {
        org_id: orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('signature-cluster-tick: complete', {
    orgs: results.length,
    total_duration_ms: Date.now() - startedAll,
  });
  return results;
}

// Allow running as a standalone script: `bun run src/jobs/signature-cluster-tick.ts`.
if (import.meta.main) {
  surrealDB
    .connect()
    .then(() => runSignatureClusterTick())
    .then((res) => {
      console.log('signature-cluster-tick result:', JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('signature-cluster-tick failed:', err);
      process.exit(1);
    });
}
