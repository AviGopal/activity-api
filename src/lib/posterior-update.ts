/**
 * Stratified posterior update for Thompson Sampling (Phase 18.3 + 18.4).
 *
 * All α/β write sites should call `applyOutcomeToPosteriors` instead of
 * computing deltas inline. The function maps `failure_mode.type` to the
 * appropriate (alphaDelta, betaDelta) pair and issues the atomic UPDATE
 * against `variant_performance_metrics` (the canonical posterior store,
 * avoiding the BM25 FTS regression on `activity_template`).
 *
 * NOTE (Phase 18.3): The four existing write sites in execution-traces.ts,
 * activities.ts (×2), and goal-paths.ts still perform their own inline
 * updates. Each call site has been augmented with a parallel call to
 * `applyOutcomeToPosteriors` so both run concurrently. Once the test suite
 * confirms correctness the old inline writes should be removed (marked with
 * TODO below). This two-phase approach avoids a risky refactor in one shot.
 *
 * Phase 18.4 adds `propagateCreditAlongChain` which walks the composition
 * chain (root-first) with exponential decay (γ=0.5) to attribute credit or
 * blame to ancestor activities.
 */

import { logger } from '../utils/logger';
import { normalizeActivityId } from '../db/paradigm';
import type { FailureMode } from '../models/schemas';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Minimal trace shape required by applyOutcomeToPosteriors.
 * Intentionally not importing the full stored ExecutionTrace to keep this
 * module dependency-free and easy to test.
 */
export interface TraceForPosterior {
  activity_id: string;
  activity_variant_id?: string;
  /** variant_id is accepted as an alias for activity_variant_id */
  variant_id?: string;
  success: boolean;
  failure_mode?: FailureMode | null;
  /** Input impulse ids across all tasks — used for impulse_relevance writes on verifier_negative */
  tasks?: Array<{
    input_impulse_ids?: string[];
    output_impulse_ids?: string[];
  }>;
  org_id?: string;
  cost_usd?: number;
  /**
   * Ancestor composition chain, root-first. When present, applyOutcomeToPosteriors
   * fires propagateCreditAlongChain as a fire-and-forget side effect.
   */
  composition_chain?: string[];
  /**
   * v1 state-space signature for conditional Thompson keying.
   * When present, applyOutcomeToPosteriors writes to context_thompson_scores
   * with signature_version + context_bucket=signature using stratified deltas.
   */
  signature?: string;
  /** Must accompany signature; typically 1 for v1 signatures. */
  signature_version?: number;
}

// ---------------------------------------------------------------------------
// Phase 18.4 — Composition-chain credit propagation
// ---------------------------------------------------------------------------

/** Maximum number of ancestors to credit/blame (counted from the leaf). */
const CREDIT_PROPAGATION_MAX_DEPTH = 4;

/** Exponential decay factor per hop away from the leaf. */
const CREDIT_PROPAGATION_GAMMA = 0.5;

/**
 * Minimal execution descriptor for chain-credit propagation.
 * Callers outside applyOutcomeToPosteriors can also use this directly.
 */
export interface ExecutionForChainCredit {
  /** The leaf activity (already credited by applyOutcomeToPosteriors). */
  activity_id: string;
  /** Ancestor chain, root-first — same field stored on the execution record. */
  composition_chain: string[];
  success: boolean;
  failure_mode?: FailureMode | null;
  /**
   * Per-ancestor v1 signatures, keyed by ancestor execution_id.
   * When provided, writeAncestorDelta writes to context_thompson_scores using
   * the ancestor's own signature. Absent entries skip the conditional write
   * (expected during the transition period; log at debug, never warn).
   */
  ancestor_signatures?: Record<string, { signature: string; signature_version: number }>;
}

export interface UpdateSummary {
  activity_id: string;
  alpha_delta: number;
  beta_delta: number;
  failure_mode_type: string | null;
  impulse_relevance_writes: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// DB interface — thin so tests can inject a mock
// ---------------------------------------------------------------------------

export interface DBQueryable {
  query<T = any>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// Metric stub (18.3.6)
// ---------------------------------------------------------------------------

function emitPosteriorUpdateMetric(summary: UpdateSummary): void {
  logger.debug('posterior_update', {
    event: 'posterior_update',
    failure_mode_type: summary.failure_mode_type,
    alpha_delta: summary.alpha_delta,
    beta_delta: summary.beta_delta,
    activity_id: summary.activity_id,
  });
}

// ---------------------------------------------------------------------------
// Delta computation (stratified rules from spec 18.3.2)
// ---------------------------------------------------------------------------

interface Deltas {
  alphaDelta: number;
  betaDelta: number;
}

function computeDeltas(
  success: boolean,
  failureMode: FailureMode | null | undefined,
  warnings: string[],
): Deltas {
  if (success) {
    // Successful execution — regardless of failure_mode (defensive)
    return { alphaDelta: 1, betaDelta: 0 };
  }

  if (failureMode == null) {
    // Spec 18.3.2: null failure_mode on a failed trace → treat as verifier_negative + warn
    warnings.push('failure_mode null on failed trace, defaulting to verifier_negative');
    return { alphaDelta: 0, betaDelta: 1 };
  }

  switch (failureMode.type) {
    case 'verifier_negative':
      return { alphaDelta: 0, betaDelta: 1 };

    case 'budget_exhausted':
      // Half-penalty: execution ran but hit a budget ceiling, not necessarily wrong
      return { alphaDelta: 0, betaDelta: 0.5 };

    case 'safety_breach':
      return { alphaDelta: 0, betaDelta: 1 };

    case 'cascading':
      // Victim — upstream cause carries the penalty; don't double-count here
      return { alphaDelta: 0, betaDelta: 0 };

    case 'user_abort':
      // No signal — user cancelled; treat as neutral
      return { alphaDelta: 0, betaDelta: 0 };

    default:
      // Future failure modes default to the strict penalty
      warnings.push(`unknown failure_mode.type "${(failureMode as any).type}", defaulting to verifier_negative`);
      return { alphaDelta: 0, betaDelta: 1 };
  }
}

// ---------------------------------------------------------------------------
// Impulse-relevance side-write for verifier_negative
// ---------------------------------------------------------------------------

async function writeImpulseRelevancePenalty(
  trace: TraceForPosterior,
  db: DBQueryable,
  orgId: string,
): Promise<number> {
  const taskImpulseIds: string[] = [];
  for (const task of trace.tasks ?? []) {
    for (const id of task.input_impulse_ids ?? []) {
      if (id) taskImpulseIds.push(id);
    }
  }

  if (taskImpulseIds.length === 0) return 0;

  // Best-effort: fire-and-forget per id. One failure doesn't abort the rest.
  let written = 0;
  for (const impulseId of taskImpulseIds) {
    try {
      await db.query(
        `
        UPDATE impulse_relevance_metrics
        SET times_failed = (times_failed ?? 0) + 1,
            updated_at   = time::now()
        WHERE impulse_id = $impulse_id
          AND org_id     = $org_id
        `,
        { impulse_id: impulseId, org_id: orgId },
      );
      written++;
    } catch (err) {
      logger.warn('posterior-update: impulse_relevance_metrics update failed (non-blocking)', {
        impulse_id: impulseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return written;
}

// ---------------------------------------------------------------------------
// Phase 18.4: Composition-chain credit propagation
// ---------------------------------------------------------------------------

/**
 * Write a (alpha_delta, beta_delta) pair to `variant_performance_metrics` for
 * a single ancestor activity.  Also writes to `context_thompson_scores` when
 * signature is non-null, using LET/IF/CREATE for upsert semantics.
 *
 * All writes are best-effort — errors are logged at WARN and swallowed.
 */
async function writeAncestorDelta(
  ancestorId: string,
  alphaDelta: number,
  betaDelta: number,
  db: DBQueryable,
  orgId: string,
  signature: string | null,
  signatureVersion: number = 1,
): Promise<void> {
  if (alphaDelta === 0 && betaDelta === 0) return;

  try {
    await db.query(
      `
      UPDATE variant_performance_metrics
      SET
        thompson_alpha = (thompson_alpha ?? 1) + $alpha_delta,
        thompson_beta  = (thompson_beta  ?? 1) + $beta_delta,
        updated_at     = time::now()
      WHERE variant_id = $activity_id
        AND org_id     = $org_id
      `,
      {
        activity_id: ancestorId,
        org_id: orgId,
        alpha_delta: alphaDelta,
        beta_delta: betaDelta,
      },
    );
  } catch (err) {
    logger.warn('posterior-update: chain credit write to variant_performance_metrics failed', {
      ancestor_id: ancestorId,
      alpha_delta: alphaDelta,
      beta_delta: betaDelta,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (signature != null) {
    try {
      await db.query(
        `
        LET $existing = (SELECT * FROM context_thompson_scores
          WHERE org_id = $org_id AND template_id = $activity_id
            AND signature_version = $sig_version AND context_bucket = $sig LIMIT 1);
        IF array::len($existing) > 0 THEN
          UPDATE context_thompson_scores
          SET alpha = alpha + $alpha_delta, beta = beta + $beta_delta,
              n_observations = n_observations + 1, last_updated_at = time::now()
          WHERE org_id = $org_id AND template_id = $activity_id
            AND signature_version = $sig_version AND context_bucket = $sig
        ELSE
          CREATE context_thompson_scores CONTENT {
            org_id: $org_id, template_id: $activity_id, context_bucket: $sig,
            signature_version: $sig_version, alpha: 1.0 + $alpha_delta,
            beta: 1.0 + $beta_delta, n_observations: 1,
            last_updated_at: time::now(), created_at: time::now()
          }
        END
        `,
        {
          activity_id: ancestorId,
          org_id: orgId,
          sig: signature,
          sig_version: signatureVersion,
          alpha_delta: alphaDelta,
          beta_delta: betaDelta,
        },
      );
    } catch (err) {
      logger.warn('posterior-update: chain credit write to context_thompson_scores failed', {
        ancestor_id: ancestorId,
        signature,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Propagate execution credit (or blame) from a leaf activity up its
 * composition chain with exponential decay γ=0.5.
 *
 * Rules (spec 18.4):
 *  - Success: each ancestor at depth d receives α += γ^d  (γ=0.5)
 *  - Normal failure: each ancestor at depth d receives β += γ^d
 *  - Cascading failure: propagate β to ancestors up to (and including) the
 *    direct parent (depth-1), with the same decay. A receives nothing since
 *    it is the root and cannot be both cause and victim in the chain below.
 *    (Heuristic — full cause attribution requires task→activity mapping.)
 *  - Depth is capped at CREDIT_PROPAGATION_MAX_DEPTH (default 4).
 *
 * This function is fire-and-forget safe: it never throws.
 */
export async function propagateCreditAlongChain(
  execution: ExecutionForChainCredit,
  db: DBQueryable,
  orgId: string,
): Promise<void> {
  const { composition_chain, success, failure_mode } = execution;

  if (!composition_chain || composition_chain.length === 0) return;

  const isCascading = !success && failure_mode?.type === 'cascading';

  // composition_chain is root-first: [A, B, C, D].
  // The leaf (D, the executed activity) is NOT in composition_chain — it was
  // already credited by applyOutcomeToPosteriors.
  // We walk from the end of the chain (closest ancestor = depth 1).
  const ancestors = [...composition_chain].reverse(); // [C, B, A, ...]

  // Batch-resolve execution IDs to variant IDs.
  type AncestorMeta = { variant_id: string };
  let ancestorMetaByExecId: Map<string, AncestorMeta> = new Map();
  try {
    const limited = ancestors.slice(0, CREDIT_PROPAGATION_MAX_DEPTH);
    const rows = await db.query<{ execution_id: string; variant_id: string }>(
      `SELECT execution_id, variant_id FROM activity_execution_traces
       WHERE execution_id IN $ids AND org_id = $org_id`,
      { ids: limited, org_id: orgId },
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row.execution_id && row.variant_id) {
        ancestorMetaByExecId.set(row.execution_id, { variant_id: row.variant_id });
      }
    }
  } catch (err) {
    logger.warn('posterior-update: chain exec→variant lookup failed, using chain entries as variant IDs', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let noSigCount = 0;

  for (let i = 0; i < Math.min(ancestors.length, CREDIT_PROPAGATION_MAX_DEPTH); i++) {
    const ancestorExecId = ancestors[i];
    const meta = ancestorMetaByExecId.get(ancestorExecId);
    // Resolve to variant_id; fall back to ancestorExecId itself (unit test compat).
    // Normalize to strip the `activity:` prefix so the WHERE clause matches the
    // normalized form stored in variant_performance_metrics.
    const ancestorId = normalizeActivityId(meta?.variant_id ?? ancestorExecId);
    const depth = i + 1; // 1-indexed depth from leaf
    const decayFactor = Math.pow(CREDIT_PROPAGATION_GAMMA, depth);

    // Use per-ancestor v1 signature when available.
    // When absent (transition period), skip the conditional write for this ancestor.
    const sigEntry = execution.ancestor_signatures?.[ancestorExecId];
    const ancestorSig = sigEntry?.signature ?? null;
    const ancestorSigVersion = sigEntry?.signature_version ?? 1;
    if (ancestorSig === null) noSigCount++;

    let alphaDelta = 0;
    let betaDelta = 0;

    if (success) {
      alphaDelta = decayFactor;
    } else if (isCascading) {
      // For cascading: propagate β only to the direct parent (depth 1).
      // Ancestors beyond depth 1 are not causally implicated by this heuristic.
      if (depth === 1) {
        betaDelta = decayFactor;
      }
      // depth > 1: skip (A receives nothing per spec 18.4.3 heuristic)
    } else {
      // All other failure types: decayed β to all ancestors
      betaDelta = decayFactor;
    }

    await writeAncestorDelta(ancestorId, alphaDelta, betaDelta, db, orgId, ancestorSig, ancestorSigVersion);
  }

  if (noSigCount > 0) {
    logger.debug('chain_credit_no_sig', {
      event: 'chain_credit_no_sig',
      org_id: orgId,
      total_ancestors: Math.min(ancestors.length, CREDIT_PROPAGATION_MAX_DEPTH),
      no_sig_count: noSigCount,
      leaf_activity_id: execution.activity_id,
    });
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Apply stratified Thompson Sampling updates for a completed execution trace.
 *
 * Writes atomically to `variant_performance_metrics` using the same
 * `(field ?? 1) + $delta` pattern used throughout the codebase, so
 * concurrent updates don't race.
 *
 * @param trace    Minimal trace object with success + failure_mode
 * @param db       DB client (surrealDB singleton or mock in tests)
 * @param orgId    Org context for multi-tenant scoping
 */
export async function applyOutcomeToPosteriors(
  trace: TraceForPosterior,
  db: DBQueryable,
  orgId: string,
): Promise<UpdateSummary> {
  const warnings: string[] = [];

  const activityId = trace.activity_variant_id ?? trace.variant_id ?? trace.activity_id;
  const { alphaDelta, betaDelta } = computeDeltas(trace.success, trace.failure_mode, warnings);
  const failureModeType = trace.failure_mode?.type ?? null;

  // Atomic UPDATE — mirrors the pattern in execution-traces.ts:2235
  // Uses variant_performance_metrics (not activity_template) to avoid the
  // BM25 FTS scorer regression (F-V46, SurrealDB 3.0).
  if (alphaDelta !== 0 || betaDelta !== 0) {
    try {
      await db.query(
        `
        UPDATE variant_performance_metrics
        SET
          thompson_alpha = (thompson_alpha ?? 1) + $alpha_delta,
          thompson_beta  = (thompson_beta  ?? 1) + $beta_delta,
          updated_at     = time::now()
        WHERE variant_id = $activity_id
          AND org_id     = $org_id
        `,
        {
          activity_id: activityId,
          org_id: orgId,
          alpha_delta: alphaDelta,
          beta_delta: betaDelta,
        },
      );
    } catch (err) {
      const msg = `posterior-update DB write failed: ${err instanceof Error ? err.message : String(err)}`;
      warnings.push(msg);
      logger.warn('posterior-update: variant_performance_metrics update failed', {
        activity_id: activityId,
        org_id: orgId,
        alpha_delta: alphaDelta,
        beta_delta: betaDelta,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // v1 conditional context_thompson_scores write — stratified deltas, signature-keyed
  if (
    trace.signature &&
    typeof trace.signature_version === 'number' &&
    (alphaDelta !== 0 || betaDelta !== 0)
  ) {
    try {
      await db.query(
        `
        LET $existing = (SELECT * FROM context_thompson_scores
          WHERE org_id = $org_id
            AND template_id = $activity_id
            AND signature_version = $sig_version
            AND context_bucket = $sig
          LIMIT 1);
        IF array::len($existing) > 0 THEN
          UPDATE context_thompson_scores
          SET alpha = alpha + $alpha_delta,
              beta  = beta  + $beta_delta,
              n_observations = n_observations + 1,
              last_updated_at = time::now()
          WHERE org_id = $org_id
            AND template_id = $activity_id
            AND signature_version = $sig_version
            AND context_bucket = $sig
        ELSE
          CREATE context_thompson_scores CONTENT {
            org_id: $org_id,
            template_id: $activity_id,
            context_bucket: $sig,
            signature_version: $sig_version,
            alpha: 1.0 + $alpha_delta,
            beta:  1.0 + $beta_delta,
            n_observations: 1,
            last_updated_at: time::now(),
            created_at: time::now()
          }
        END
        `,
        {
          org_id: orgId,
          activity_id: activityId,
          sig: trace.signature,
          sig_version: trace.signature_version,
          alpha_delta: alphaDelta,
          beta_delta: betaDelta,
        },
      );
      logger.debug('posterior_update_v1_conditional', {
        event: 'posterior_update_v1_conditional',
        activity_id: activityId,
        signature: trace.signature,
        signature_version: trace.signature_version,
        alpha_delta: alphaDelta,
        beta_delta: betaDelta,
      });
    } catch (v1Err) {
      logger.warn('posterior-update: context_thompson_scores v1 write failed (non-blocking)', {
        activity_id: activityId,
        error: v1Err instanceof Error ? v1Err.message : String(v1Err),
      });
    }
  }

  // Impulse-relevance side-write for verifier_negative (and null→verifier fallback)
  let impulseRelevanceWrites = 0;
  const isVerifierFailure =
    !trace.success &&
    (failureModeType === 'verifier_negative' || failureModeType === null);

  if (isVerifierFailure) {
    impulseRelevanceWrites = await writeImpulseRelevancePenalty(trace, db, orgId);
  }

  const summary: UpdateSummary = {
    activity_id: activityId,
    alpha_delta: alphaDelta,
    beta_delta: betaDelta,
    failure_mode_type: failureModeType,
    impulse_relevance_writes: impulseRelevanceWrites,
    warnings,
  };

  emitPosteriorUpdateMetric(summary);

  // Phase 18.4: fire-and-forget chain credit propagation when a composition
  // chain is present on the trace.
  if (trace.composition_chain && trace.composition_chain.length > 0) {
    propagateCreditAlongChain(
      {
        activity_id: activityId,
        composition_chain: trace.composition_chain,
        success: trace.success,
        failure_mode: trace.failure_mode,
      },
      db,
      orgId,
    ).catch((err) => {
      logger.warn('posterior-update: propagateCreditAlongChain failed (non-blocking)', {
        activity_id: activityId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return summary;
}
