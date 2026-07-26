/**
 * cluster-posterior — cluster-level Thompson posterior coarsening write (D4).
 *
 * Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
 *       (tasks D4.1–D4.4).
 *
 * WHAT THIS DOES (the coarsening write):
 *   Every time an execution updates a LEAF signature posterior in
 *   `context_thompson_scores` (context_bucket = <signature hash>), it ALSO applies
 *   the SAME (alpha_delta, beta_delta) to that signature's CLUSTER posterior — a row
 *   in the SAME table with `context_bucket = "cluster:" + cluster_id` (the D1.4
 *   composite-key convention). A cluster bucket therefore accumulates the pooled
 *   outcomes of all its member signatures, giving the selector (D5) a well-sampled
 *   posterior to fall back to when a leaf signature is cold.
 *
 * CONTENTION — the cluster row is a SHARED HOT ROW:
 *   Every signature in a cluster writes the same `cluster:<id>` row, so it sees N×
 *   the write rate of a leaf row. The 2026-06-21 write-contention incident showed
 *   SurrealDB silently DROPPING learning writes under a SELECT-then-CREATE race.
 *   Two guards:
 *     (a) ADVISORY / best-effort — this write NEVER blocks or fails the leaf write.
 *         The caller wraps the call; we additionally wrap internally in try/catch.
 *         A dropped cluster write leaves the leaf posterior fully correct.
 *     (b) CONFLICT-SAFE upsert — we give the cluster row a DETERMINISTIC record id
 *         derived from (org_id, template_id, signature_version, cluster_id) and use
 *         SurrealDB 2.x `UPSERT type::thing(<table>, ⟨id⟩) SET alpha = (alpha ?? 1) + $delta ...`.
 *         UPSERT-by-id is an atomic create-or-update keyed on the primary id — there
 *         is NO SELECT, so there is no SELECT→CREATE race that could mint duplicate
 *         rows. The server-side `(field ?? 1) + $delta` increment is the same atomic
 *         idiom used across the codebase (variant_performance_metrics chain-credit
 *         write, activities.ts relevance feedback) and is safe under concurrency.
 *
 *   CONCURRENCY PRIMITIVE CHOICE: UPSERT-by-id (not BEGIN/COMMIT TRANSACTION).
 *   SurrealDB server is 2.3.3 (confirmed via `surreal version`). In 2.x, a single
 *   `UPSERT record:id SET f = (f ?? 1) + $d` statement is itself atomic and
 *   create-or-update on the id — exactly what a shared hot counter needs. A
 *   transaction wrapper would only add a SELECT/lock round-trip and broaden the
 *   conflict window without giving us anything an id-keyed UPSERT doesn't already
 *   guarantee. This matches the existing `INSERT ... ON DUPLICATE KEY UPDATE` /
 *   `UPSERT ...:[...]` idiom in src/routes/activities.ts (~line 9222, ~line 8817).
 *
 * LOOKUP CACHE:
 *   `applyClusterPosterior` needs each signature's cluster_id + contaminated flag
 *   from `signature_cluster_assignment`. Posterior writes are frequent — a DB read
 *   per write is too costly — so we keep a small in-memory TTL cache keyed by
 *   `${signature_version}|${signature}`, including a NEGATIVE cache for signatures
 *   with no assignment (the ~132 unrecoverable ones + brand-new not-yet-clustered
 *   signatures). On cache miss we issue one query and cache the result (positive or
 *   negative) for CACHE_TTL_MS.
 *
 * CONTAMINATION GATE:
 *   If the signature's cluster is `contaminated = true`, we SKIP the cluster write
 *   (the cluster pools dissimilar success rates → its posterior is misleading). The
 *   selector (D5) likewise ignores contaminated clusters.
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// DB interface — thin, mirrors posterior-update.ts so tests can inject a mock.
// ---------------------------------------------------------------------------

export interface DBQueryable {
  query<T = any>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// D4.4 — clusterUpdate metric counters.
//
// No src/lib/metrics.ts exists in this codebase and there is no central counter
// registry, so per the task fallback we expose the counters on a module-level
// object and surface them on GET /v2/cluster/status (see src/routes/cluster.ts).
// ---------------------------------------------------------------------------

export interface ClusterUpdateCounters {
  /** Cluster writes we tried to perform (signature had a non-contaminated cluster). */
  attempted: number;
  /** Cluster UPSERTs that completed without throwing. */
  succeeded: number;
  /** Skipped because the signature has no cluster assignment (noise / not-yet-clustered). */
  skipped_no_assignment: number;
  /** Skipped because the signature's cluster is flagged contaminated. */
  skipped_contaminated: number;
  /** Cluster UPSERTs that threw (swallowed; leaf posterior unaffected). */
  failed: number;
}

const clusterUpdateCounters: ClusterUpdateCounters = {
  attempted: 0,
  succeeded: 0,
  skipped_no_assignment: 0,
  skipped_contaminated: 0,
  failed: 0,
};

/** Snapshot of the clusterUpdate counters (for GET /v2/cluster/status). */
export function getClusterUpdateCounters(): ClusterUpdateCounters {
  return { ...clusterUpdateCounters };
}

/** Reset counters — test-only convenience. */
export function resetClusterUpdateCounters(): void {
  clusterUpdateCounters.attempted = 0;
  clusterUpdateCounters.succeeded = 0;
  clusterUpdateCounters.skipped_no_assignment = 0;
  clusterUpdateCounters.skipped_contaminated = 0;
  clusterUpdateCounters.failed = 0;
}

// ---------------------------------------------------------------------------
// Lookup cache — signature → cluster assignment, with TTL + negative caching.
// ---------------------------------------------------------------------------

interface CachedAssignment {
  cluster_id: string;
  contaminated: boolean;
}

interface CacheEntry {
  /** null = negative cache (no assignment for this signature). */
  value: CachedAssignment | null;
  expires_at: number;
}

const CACHE_TTL_MS = parseInt(process.env.CLUSTER_ASSIGNMENT_CACHE_TTL_MS ?? '300000', 10); // 5 min
const assignmentCache = new Map<string, CacheEntry>();

function cacheKey(signature: string, signatureVersion: number): string {
  return `${signatureVersion}|${signature}`;
}

/** Clear the assignment cache — test-only convenience. */
export function clearClusterAssignmentCache(): void {
  assignmentCache.clear();
}

/** Public shape of a resolved cluster assignment (D5 selector read). */
export type ClusterAssignment = CachedAssignment;

/**
 * Public, best-effort cluster-assignment lookup for the D5 partial-pooling read.
 *
 * Reuses the SAME TTL + negative cache as the D4 write path, so a signature
 * looked up on the write side is already warm here (and vice versa). Returns
 * `null` when the signature has no current assignment (noise / not-yet-clustered)
 * OR on any transient lookup failure — callers MUST treat `null` as "no cluster,
 * fall back to leaf/Beta(1,1)" and never throw.
 */
export async function lookupAssignment(
  db: DBQueryable,
  signature: string,
  signatureVersion: number,
): Promise<ClusterAssignment | null> {
  return resolveAssignment(db, signature, signatureVersion);
}

/**
 * Resolve a signature's cluster assignment, using the TTL cache. On miss, issues
 * ONE query and caches the result (including the negative "no assignment" case).
 * Returns null when the signature has no (current) cluster assignment.
 *
 * Best-effort: a DB error is treated as a transient miss (returns null) and is
 * NOT cached, so a later write can retry.
 */
async function resolveAssignment(
  db: DBQueryable,
  signature: string,
  signatureVersion: number,
): Promise<CachedAssignment | null> {
  const key = cacheKey(signature, signatureVersion);
  const now = Date.now();

  const cached = assignmentCache.get(key);
  if (cached && cached.expires_at > now) {
    return cached.value;
  }

  try {
    const rows = await db.query<{ cluster_id?: string; contaminated?: boolean }>(
      `
      SELECT cluster_id, contaminated FROM signature_cluster_assignment
      WHERE signature = $signature AND signature_version = $signature_version
      LIMIT 1
      `,
      { signature, signature_version: signatureVersion },
    );

    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    const value: CachedAssignment | null =
      row && typeof row.cluster_id === 'string' && row.cluster_id.length > 0
        ? { cluster_id: row.cluster_id, contaminated: row.contaminated === true }
        : null;

    // Cache both positive and negative results.
    assignmentCache.set(key, { value, expires_at: now + CACHE_TTL_MS });
    return value;
  } catch (err) {
    // Transient lookup failure — do NOT cache; treat as no-assignment for this call.
    logger.debug('cluster-posterior: assignment lookup failed (non-blocking)', {
      signature,
      signature_version: signatureVersion,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deterministic cluster-row id.
// ---------------------------------------------------------------------------

/**
 * Deterministic record-id SLUG for the cluster posterior row, derived from
 * (org_id, template_id, signature_version, cluster_id). Hashed to a fixed-length
 * hex so it is a safe SurrealDB record id regardless of the input characters
 * (org ids, template ids and cluster ids can all contain `:`/`⟨⟩`-unfriendly
 * bytes). `type::record('context_thompson_scores', $slug)` turns this into the
 * concrete record id at query time, giving UPSERT a stable target.
 */
export function clusterRowSlug(
  orgId: string,
  templateId: string,
  signatureVersion: number,
  clusterId: string,
): string {
  const canonical = `${orgId} ${templateId} ${signatureVersion} ${clusterId}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// The coarsening read (D5 selector partial-pooling).
// ---------------------------------------------------------------------------

/** A cluster-level posterior row, as read for selector fallback. */
export interface ClusterPosterior {
  alpha: number;
  beta: number;
  n_observations: number;
}

/**
 * Read the CLUSTER posterior row for (org, template, signatureVersion, clusterId),
 * addressed by the SAME deterministic `clusterRowSlug` the D4 write uses. This is
 * the well-sampled posterior the selector falls back to when a leaf signature is
 * cold.
 *
 * Best-effort: returns `null` on a missing row OR any error — callers MUST then
 * fall back to leaf/Beta(1,1) and never throw. Does NOT touch the leaf path.
 */
export async function readClusterPosterior(
  db: DBQueryable,
  orgId: string | null | undefined,
  templateId: string,
  signatureVersion: number,
  clusterId: string,
): Promise<ClusterPosterior | null> {
  if (!orgId || !templateId || !clusterId) return null;
  try {
    const slug = clusterRowSlug(orgId, templateId, signatureVersion, clusterId);
    const rows = await db.query<{ alpha?: number; beta?: number; n_observations?: number }>(
      `SELECT alpha, beta, n_observations FROM type::thing('context_thompson_scores', $slug)`,
      { slug },
    );
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!row) return null;
    return {
      alpha: typeof row.alpha === 'number' ? row.alpha : 1,
      beta: typeof row.beta === 'number' ? row.beta : 1,
      n_observations: typeof row.n_observations === 'number' ? row.n_observations : 0,
    };
  } catch (err) {
    logger.debug('cluster-posterior: cluster read failed (non-blocking)', {
      template_id: templateId,
      signature_version: signatureVersion,
      cluster_id: clusterId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// The coarsening write.
// ---------------------------------------------------------------------------

export interface ApplyClusterPosteriorArgs {
  orgId: string;
  templateId: string;
  signature: string;
  signatureVersion: number;
  alphaDelta: number;
  betaDelta: number;
}

/**
 * Apply (alphaDelta, betaDelta) to the CLUSTER posterior for `signature`, if the
 * signature belongs to a non-contaminated cluster.
 *
 * MUST be called AFTER the leaf write succeeds, and MUST NOT be allowed to fail
 * the leaf write — it is fully self-contained (own try/catch, swallow+log) and
 * never throws. The single call site contract is: `void applyClusterPosterior(...)`
 * or `await applyClusterPosterior(...)` — either way a rejection is impossible.
 *
 * Skips silently when:
 *   - both deltas are 0 (nothing to write),
 *   - the signature has no cluster assignment (noise / not-yet-clustered),
 *   - the signature's cluster is contaminated.
 */
export async function applyClusterPosterior(
  db: DBQueryable,
  args: ApplyClusterPosteriorArgs,
): Promise<void> {
  const { orgId, templateId, signature, signatureVersion, alphaDelta, betaDelta } = args;

  if (alphaDelta === 0 && betaDelta === 0) return;
  if (!signature || !templateId || !orgId) return;

  try {
    const assignment = await resolveAssignment(db, signature, signatureVersion);

    if (assignment === null) {
      clusterUpdateCounters.skipped_no_assignment++;
      return;
    }
    if (assignment.contaminated) {
      clusterUpdateCounters.skipped_contaminated++;
      return;
    }

    const clusterId = assignment.cluster_id;
    const slug = clusterRowSlug(orgId, templateId, signatureVersion, clusterId);
    const contextBucket = `cluster:${clusterId}`;

    clusterUpdateCounters.attempted++;

    // Conflict-safe atomic create-or-update on a DETERMINISTIC record id.
    // `UPSERT <table>:⟨id⟩ SET f = (f ?? 1) + $delta` has no SELECT, so no
    // SELECT→CREATE race; the `(f ?? 1) + $delta` increment is server-side atomic
    // and safe for the shared hot `cluster:<id>` row under concurrent writers.
    await db.query(
      `
      UPSERT type::thing('context_thompson_scores', $slug) SET
        org_id            = $org_id,
        template_id       = $template_id,
        signature_version = $sig_version,
        cluster_id        = $cluster_id,
        context_bucket    = $context_bucket,
        alpha             = (alpha ?? 1) + $alpha_delta,
        beta              = (beta  ?? 1) + $beta_delta,
        n_observations    = (n_observations ?? 0) + 1,
        last_updated_at   = time::now(),
        created_at        = created_at ?? time::now()
      `,
      {
        slug,
        org_id: orgId,
        template_id: templateId,
        sig_version: signatureVersion,
        cluster_id: clusterId,
        context_bucket: contextBucket,
        alpha_delta: alphaDelta,
        beta_delta: betaDelta,
      },
    );

    clusterUpdateCounters.succeeded++;
  } catch (err) {
    // Advisory: a dropped cluster write leaves the leaf posterior correct.
    clusterUpdateCounters.failed++;
    logger.warn('cluster-posterior: cluster write failed (non-blocking)', {
      template_id: templateId,
      signature,
      signature_version: signatureVersion,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
