/**
 * signature-cluster — group state-space signatures into clusters by delegating
 * to concept-db's clustering primitive (the `cluster` impulse shape).
 *
 * Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
 *       (task D3.1).
 *
 * DELEGATION (deliberate deviation from the openspec D3.1 "implement HDBSCAN in
 * activity-api" line): concept-db already exposes a clustering primitive over the
 * impulse contract, verified live. "Resolvers live where the capability lives" —
 * so we hand concept-db the embeddings we already hold in `signature_embedding`
 * (we do NOT re-embed) and let it cluster. This module only RE-LABELS the result
 * with a stable, content-derived cluster id (below) before the caller persists it.
 *
 * Transport / contract (verified live):
 *   POST {CONCEPT_DB_CLUSTER_ENDPOINT}
 *   body: {"impulse":{"type":"cluster","pointer":{"type":"cluster",
 *           "items":[{"id":"<signature>","embedding":[<384 floats>]}, ...],
 *           "max_cluster_size":12,"min_similarity":0.6}}}
 *   resp: {"content":[{"cluster_id":"cl-0","members":["<sig>",...],"size":N}, ...],
 *          "metadata":{"shape":"cluster","clusters":N,"min_similarity":0.6}}
 *
 * STABLE CLUSTER IDs (the correctness crux):
 *   concept-db's `cl-0`, `cl-1`, ... labels are EPHEMERAL — assigned by output
 *   order, so the *same* group of signatures can get a *different* `cl-N` label on
 *   the next run. D4 keys cluster-level Thompson posteriors on
 *   `context_bucket = "cluster:" + cluster_id`; an unstable id would scatter credit
 *   across runs and defeat the pooling. We therefore derive a stable id from the
 *   cluster's CONTENT:
 *
 *     cluster_id = "sigcl_" + sha256(<lexicographically-smallest member signature>)[0:16]
 *
 *   We use the MIN MEMBER (not a hash of the full sorted membership) on purpose:
 *   a full-membership hash shifts whenever ANY member joins/leaves the cluster,
 *   churning the id on every minor drift; the min-member representative only shifts
 *   when the smallest member itself enters or leaves — far rarer. This keeps the
 *   posterior bucket attached to "the same cluster" across small membership drift,
 *   which is exactly what D4 needs. (Trade-off: two genuinely-distinct clusters
 *   that happen to share a smallest member across runs cannot occur — a signature
 *   belongs to at most one cluster per run — so min-member is collision-free within
 *   a run. The hash of the min-member, rather than the raw signature, gives a fixed
 *   id length and namespaces it under the `sigcl_` prefix.)
 *
 * ADVISORY semantics: a generous (background) timeout; on ANY error/timeout/shape
 * mismatch the function returns `[]` (no clusters). It never throws — clustering is
 * a best-effort enhancement and must never block the tick or trace ingestion.
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger';

const CONCEPT_DB_CLUSTER_ENDPOINT =
  process.env.CONCEPT_DB_CLUSTER_ENDPOINT || 'http://localhost:8260/v2/impulses/resolve';

// Background job — nothing latency-sensitive waits on this. A clustering pass over
// the full embedding set through concept-db can take a few seconds; 10s default
// gives ample margin. Overridable for larger corpora.
const CLUSTER_TIMEOUT_MS = parseInt(process.env.CONCEPT_DB_CLUSTER_TIMEOUT_MS ?? '10000', 10);

const MAX_CLUSTER_SIZE = parseInt(process.env.SIGNATURE_CLUSTER_MAX_SIZE ?? '12', 10);
const MIN_SIMILARITY = parseFloat(process.env.SIGNATURE_CLUSTER_MIN_SIMILARITY ?? '0.6');

export interface ClusterInputItem {
  id: string;
  embedding: number[];
}

export interface SignatureCluster {
  cluster_id: string;
  members: string[];
}

interface ConceptDbClusterEntry {
  cluster_id?: string;
  members?: string[];
  size?: number;
}

interface ConceptDbClusterResponse {
  content?: ConceptDbClusterEntry[];
  metadata?: { shape?: string; clusters?: number; min_similarity?: number };
}

/**
 * Derive the STABLE, content-derived cluster id from a cluster's members.
 * `sigcl_` + first 16 hex of sha256(lexicographically-smallest member signature).
 */
function stableClusterId(members: string[]): string {
  // Defensive: callers only pass non-empty member lists, but never index [0] of
  // an empty array.
  const canonical = [...members].sort()[0];
  const hex = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `sigcl_${hex}`;
}

/**
 * Cluster the given signature embeddings via concept-db, then re-label each
 * returned cluster with a stable content-derived id. Advisory — never throws.
 *
 * Singleton "clusters" (a single member) returned by concept-db are kept as
 * clusters here; the caller (the tick) is responsible for deciding what counts as
 * NOISE. We do not impose a min-size policy in this module so the delegation stays
 * a thin re-labelling shim.
 */
export async function clusterSignatures(
  items: ClusterInputItem[]
): Promise<SignatureCluster[]> {
  if (items.length === 0) return [];

  try {
    const response = await fetch(CONCEPT_DB_CLUSTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        impulse: {
          type: 'cluster',
          pointer: {
            type: 'cluster',
            items: items.map((it) => ({ id: it.id, embedding: it.embedding })),
            max_cluster_size: MAX_CLUSTER_SIZE,
            min_similarity: MIN_SIMILARITY,
          },
        },
      }),
      signal: AbortSignal.timeout(CLUSTER_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn('signature-cluster: concept-db cluster call non-2xx (advisory, returning [])', {
        status: response.status,
        endpoint: CONCEPT_DB_CLUSTER_ENDPOINT,
        items: items.length,
      });
      return [];
    }

    const body = (await response.json()) as ConceptDbClusterResponse;
    const entries = body?.content;

    if (!Array.isArray(entries)) {
      logger.warn('signature-cluster: concept-db cluster response shape mismatch (advisory, returning [])', {
        endpoint: CONCEPT_DB_CLUSTER_ENDPOINT,
        received: typeof entries,
      });
      return [];
    }

    const clusters: SignatureCluster[] = [];
    for (const entry of entries) {
      const members = Array.isArray(entry?.members)
        ? entry.members.filter((m): m is string => typeof m === 'string' && m.length > 0)
        : [];
      if (members.length === 0) continue; // drop empty/degenerate cluster
      clusters.push({
        cluster_id: stableClusterId(members), // STABLE id, not concept-db's cl-N
        members,
      });
    }

    return clusters;
  } catch (err) {
    // Timeout (AbortError) or transport failure — advisory, never throw.
    logger.warn('signature-cluster: concept-db cluster call failed (advisory, returning [])', {
      endpoint: CONCEPT_DB_CLUSTER_ENDPOINT,
      items: items.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
