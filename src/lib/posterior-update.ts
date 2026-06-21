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
import { seedPriorFromConcepts } from './prior-seed';
import { lookupEmbeddingForSignature } from './embedding-lookup-cache';
import { classifyTemplateTiers, type ResolverTier } from '../services/tier-classifier';

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
    /**
     * Resolver tier classification carried on the trace for M4 tier-restricted
     * bandit gating. When every task is `deterministic`, the variant_performance_metrics
     * UPDATE is skipped (degenerate posterior); chain-credit propagation still fires.
     * Missing field defaults to stochastic treatment (conservative).
     */
    resolver_tier?: ResolverTier;
    /** Resolver id; used as fallback when resolver_tier is absent. */
    resolver?: string;
    /** LLM-prompt marker; treated as stochastic by the classifier when resolver is absent. */
    prompt?: unknown;
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
  /**
   * Horizontal-composition (§7) fan-out width, surfaced from the engine via
   * the persisted trace's body.metadata.siblingGroupSize. When a compose_parallel
   * task dispatched k siblings, each sibling trace carries k here so chain-credit
   * averages instead of k-fold-summing at shared ancestors. Absent ⇒ 1.
   */
  sibling_group_size?: number;
}

// ---------------------------------------------------------------------------
// Phase 18.4 — Composition-chain credit propagation
// ---------------------------------------------------------------------------

/** Maximum number of ancestors to credit/blame (counted from the leaf). */
const CREDIT_PROPAGATION_MAX_DEPTH = 4;

/**
 * TD(λ) eligibility-trace decay applied per ancestor depth.
 *
 * Substrate anchor: concept_iae171XpW50_ (eligibility_trace_credit_propagation).
 * Sutton 1988 / Sutton-Barto Ch. 12. Δα_{s_t-k, a_t-k} = λ^k · r, λ ∈ (0,1).
 *
 * Env override: TD_LAMBDA. Default 0.7 — the variance/bias sweet spot for the
 * typical chain depth observed in this substrate (mean 2-3, capped at 4).
 * Values outside (0, 1) fall back to the default with a warn-log.
 *
 * Prior name was CREDIT_PROPAGATION_GAMMA at 0.5; that constant played the
 * eligibility-trace λ role, not the per-step discount γ — renamed to match
 * Sutton-Barto convention.
 */
const TD_LAMBDA_DEFAULT = 0.7;
const TD_LAMBDA: number = (() => {
  const raw = process.env.TD_LAMBDA;
  if (raw === undefined || raw === '') return TD_LAMBDA_DEFAULT;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    logger.warn('td_lambda_invalid', {
      event: 'td_lambda_invalid',
      raw,
      fallback: TD_LAMBDA_DEFAULT,
    });
    return TD_LAMBDA_DEFAULT;
  }
  return parsed;
})();

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
  /**
   * Horizontal-composition fan-out width (SUBSTRATE_AS_MDP §7). When a
   * `compose_parallel` task dispatches k sibling trajectories, all k share an
   * identical composition_chain and each fires this propagation independently —
   * which would credit every shared ancestor k-fold. Set to k so each sibling's
   * per-ancestor delta is divided by k; the k siblings then sum to a single
   * (averaged) ancestor update. Absent / ≤1 ⇒ no division (every legacy +
   * vertical-compose trace is unaffected).
   */
  sibling_group_size?: number;
}

export interface UpdateSummary {
  activity_id: string;
  alpha_delta: number;
  beta_delta: number;
  failure_mode_type: string | null;
  impulse_relevance_writes: number;
  warnings: string[];
  /**
   * Reason the variant_performance_metrics UPDATE was skipped, if any.
   * `'all_deterministic'` — every task in the trace is deterministic-tier;
   * the cell-local Beta posterior would capture upstream uncertainty rather
   * than informative signal (M4 tier-restricted bandit).
   * Absent when the UPDATE ran normally.
   */
  skipped_reason?: 'all_deterministic';
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

// Graded-yield success reward (κ⁻¹ / metric-spread lever, 2026-06-19).
// A binary success update (α+=1) pins every variant's Beta posterior at mean≈1
// under the substrate's ~98% success rate, collapsing the metric's resolution
// (κ⁻¹) so Thompson cannot tell a good variant from a great one. Instead a
// successful execution contributes a GRADED yield ∈ [YIELD_FLOOR, 1] reflecting
// per-execution quality (cost-efficiency + output productivity), applied as the
// standard fractional-observation Beta update α+=yield, β+=(1-yield). Successes
// stay well above failures (yield ≥ floor ≫ 0) but spread out so posterior means
// differ by real value. Deterministic-tier cells are skipped from the managed
// posterior anyway (M4), so this targets exactly the stochastic (LLM) cells κ⁻¹
// measures. Gate: GRADED_YIELD_SUCCESS=0 restores the legacy binary update.
const GRADED_YIELD_ENABLED = process.env.GRADED_YIELD_SUCCESS !== '0';
const YIELD_FLOOR = 0.5;        // a success always credits at least this much α
const YIELD_COST_REF = 0.02;    // $0.02 → cost component 0.5 (free → 1.0)
const YIELD_PROD_REF = 4;       // ≥4 output impulses → productivity 1.0

export function successYield(trace: {
  cost_usd?: number;
  tasks?: Array<{ output_impulse_ids?: string[] }>;
}): number {
  const cost = typeof trace.cost_usd === 'number' && trace.cost_usd > 0 ? trace.cost_usd : 0;
  const costScore = 1 / (1 + cost / YIELD_COST_REF);          // free → 1, expensive → →0
  const tasks = trace.tasks ?? [];
  const outputs = tasks.reduce((sum, t) => sum + (t.output_impulse_ids?.length ?? 0), 0);
  const productivity = Math.min(1, outputs / YIELD_PROD_REF);
  const quality = 0.5 * costScore + 0.5 * productivity;
  const y = YIELD_FLOOR + (1 - YIELD_FLOOR) * quality;
  return Math.max(YIELD_FLOOR, Math.min(1, y));
}

function computeDeltas(
  success: boolean,
  failureMode: FailureMode | null | undefined,
  warnings: string[],
  trace?: { cost_usd?: number; tasks?: Array<{ output_impulse_ids?: string[] }> },
): Deltas {
  if (success) {
    // Graded-yield reward — see successYield. Falls back to the binary update when
    // disabled or when no trace context is available (defensive).
    if (GRADED_YIELD_ENABLED && trace) {
      const y = successYield(trace);
      return { alphaDelta: y, betaDelta: 1 - y };
    }
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

    case 'prediction_disagreement': {
      // Phase 3 (2026-06-01-closed-loop-learning-and-verification):
      // β scaling depends on the sub_case inside context. Mirrors the
      // confidence-tier scaling from 2026-05-31-display-failure-mode-extensions.
      //   * action_no_effect          → β = 1.0 (action confidently dispatched,
      //                                          world did not change — full penalty)
      //   * intent_inconsistency      → β = 0.5 (substrate produced a guess; guess
      //                                          was wrong but no action misfired)
      //   * trajectory_divergence     → β = 0.5 (same — guess-wrong, half penalty)
      const ctx = (failureMode as unknown as {
        context?: { sub_type?: string };
      }).context;
      const subType = ctx?.sub_type;
      if (subType === 'action_no_effect') {
        return { alphaDelta: 0, betaDelta: 1 };
      }
      if (subType === 'intent_inconsistency' || subType === 'trajectory_divergence') {
        return { alphaDelta: 0, betaDelta: 0.5 };
      }
      // Unknown / missing sub_type — default conservatively to the half-penalty
      // rather than full, since the half is the more common case (2 of 3
      // sub-cases) and prediction_disagreement always represents a guess that
      // was wrong rather than a validator rejection.
      warnings.push(
        `prediction_disagreement with unknown sub_type "${subType ?? "<absent>"}", defaulting to β=0.5`,
      );
      return { alphaDelta: 0, betaDelta: 0.5 };
    }

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

  // Dedup: a trace can reference the same impulse across tasks.
  const uniqueIds = [...new Set(taskImpulseIds)];
  if (uniqueIds.length === 0) return 0;

  // Batched single UPDATE over the whole id set instead of N sequential awaited
  // round-trips. The constantly-failing autonomous loop made this per-id loop
  // the single dominant DB query (~2950 UPDATEs in a 400-line log window,
  // pinning SurrealDB); the IN-list collapses it to one statement per trace.
  try {
    await db.query(
      `
      UPDATE impulse_relevance_metrics
      SET times_failed = (times_failed ?? 0) + 1,
          updated_at   = time::now()
      WHERE impulse_id IN $impulse_ids
        AND org_id     = $org_id
      `,
      { impulse_ids: uniqueIds, org_id: orgId },
    );
    return uniqueIds.length;
  } catch (err) {
    logger.warn('posterior-update: batched impulse_relevance_metrics update failed (non-blocking)', {
      count: uniqueIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
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
      // M1 hook (concept_vugylIHzIMvk): when EMBEDDING_PRIOR_ENABLED is true,
      // look up the per-cell embedding from concept-db (LRU-cached) and pass
      // it through so seedPriorFromConcepts routes to the θ-scored prior
      // instead of the concept-neighbor query. Falls back gracefully on miss.
      let embedding: number[] | undefined;
      if (process.env.EMBEDDING_PRIOR_ENABLED === 'true') {
        const e = await lookupEmbeddingForSignature(signature, orgId);
        if (e) embedding = e;
      }
      const seed = await seedPriorFromConcepts(ancestorId, signature, orgId, embedding);
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
            signature_version: $sig_version, alpha: $alpha0 + $alpha_delta,
            beta: $beta0 + $beta_delta, n_observations: 1,
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
          alpha0: seed.alpha0,
          beta0: seed.beta0,
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

  // §7 horizontal-composition averaging: k sibling trajectories share this exact
  // chain, so divide each sibling's per-ancestor delta by the fan-out width to
  // avoid k-fold inflation at every shared ancestor. Default 1 ⇒ unchanged for
  // all legacy and vertical-compose traces.
  const siblingDivisor = Math.max(1, execution.sibling_group_size ?? 1);

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
    const decayFactor = Math.pow(TD_LAMBDA, depth);

    // Use per-ancestor v1 signature when available.
    // When absent (transition period), skip the conditional write for this ancestor.
    const sigEntry = execution.ancestor_signatures?.[ancestorExecId];
    const ancestorSig = sigEntry?.signature ?? null;
    const ancestorSigVersion = sigEntry?.signature_version ?? 1;
    if (ancestorSig === null) noSigCount++;

    let alphaDelta = 0;
    let betaDelta = 0;

    if (success) {
      alphaDelta = decayFactor / siblingDivisor;
    } else if (isCascading) {
      // For cascading: propagate β only to the direct parent (depth 1).
      // Ancestors beyond depth 1 are not causally implicated by this heuristic.
      if (depth === 1) {
        betaDelta = decayFactor / siblingDivisor;
      }
      // depth > 1: skip (A receives nothing per spec 18.4.3 heuristic)
    } else {
      // All other failure types: decayed β to all ancestors
      betaDelta = decayFactor / siblingDivisor;
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

  const rawActivityId = trace.activity_variant_id ?? trace.variant_id ?? trace.activity_id;
  // Strip activity:⟨⟩ wrapper so the WHERE clause matches variant_performance_metrics rows
  // written by the legacy path (which stores bare ids like "development-vessel:harness-run-matrix").
  const activityId = normalizeActivityId(rawActivityId);
  const { alphaDelta, betaDelta } = computeDeltas(trace.success, trace.failure_mode, warnings, trace);
  const failureModeType = trace.failure_mode?.type ?? null;

  // M4 tier-restricted bandit: when every task on the trace is deterministic,
  // the cell-local Beta posterior captures propagated upstream uncertainty
  // rather than cell-local signal. Skip the variant_performance_metrics UPDATE
  // (and the v1 conditional write); chain-credit propagation still fires
  // unchanged so upstream stochastic ancestors continue to learn.
  //
  // If the trace omits `resolver_tier` on every task, the synthetic template
  // has no tier info and the classifier conservatively returns
  // `all_stochastic` — i.e. existing behaviour is preserved.
  const tierClass = classifyTemplateTiers({
    tasks: (trace.tasks ?? []).map((t) => {
      // Prefer pre-classified resolver_tier when present.
      if (t?.resolver_tier === 'deterministic') {
        // Provide a synthetic deterministic resolver name from the canonical set.
        return { resolver: 'bash' };
      }
      if (t?.resolver_tier === 'llm') {
        return { resolver: 'llm' };
      }
      if (t?.resolver_tier === 'pattern') {
        // Pattern tier is stochastic; classifier returns 'pattern' for unknown
        // resolver strings, which counts as stochastic in classifyTemplateTiers.
        return { resolver: '__pattern_tier__' };
      }
      // No pre-classified tier: pass through resolver / prompt fields and let
      // classifyTemplateTiers decide.
      return { resolver: t?.resolver, prompt: t?.prompt };
    }),
  });
  const skipVariantUpdate = tierClass === 'all_deterministic';

  // Atomic UPDATE — mirrors the pattern in execution-traces.ts:2235
  // Uses variant_performance_metrics (not activity_template) to avoid the
  // BM25 FTS scorer regression (F-V46, SurrealDB 3.0).
  // M4: skip the UPDATE entirely for all-deterministic templates.
  if (!skipVariantUpdate && (alphaDelta !== 0 || betaDelta !== 0)) {
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
  // M4: skip the v1 conditional write for all-deterministic templates as well;
  // it shares the same degenerate-posterior justification as the unconditional
  // variant_performance_metrics UPDATE above.
  if (
    !skipVariantUpdate &&
    trace.signature &&
    typeof trace.signature_version === 'number' &&
    (alphaDelta !== 0 || betaDelta !== 0)
  ) {
    try {
      // §7.5 Cardinality safety cap: check whether this is a new bucket before
      // creating it. If the template already has ≥ 200 distinct signature buckets,
      // skip the CREATE (UPDATE still proceeds for existing rows).
      const CARDINALITY_CAP = parseInt(process.env.SIGNATURE_CARDINALITY_CAP ?? '200', 10);
      // M1 hook (concept_vugylIHzIMvk): same pattern as the chain-credit path.
      let embedding: number[] | undefined;
      if (process.env.EMBEDDING_PRIOR_ENABLED === 'true' && trace.signature) {
        const e = await lookupEmbeddingForSignature(trace.signature, orgId);
        if (e) embedding = e;
      }
      const seed = await seedPriorFromConcepts(activityId, trace.signature, orgId, embedding);
      await db.query(
        `
        LET $existing = (SELECT * FROM context_thompson_scores
          WHERE org_id = $org_id
            AND template_id = $activity_id
            AND signature_version = $sig_version
            AND context_bucket = $sig
          LIMIT 1);
        LET $cardinality = (SELECT count() FROM context_thompson_scores
          WHERE org_id = $org_id
            AND template_id = $activity_id
            AND signature_version = $sig_version
          GROUP ALL)[0].count ?? 0;
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
        ELSE IF $cardinality < $cap THEN
          CREATE context_thompson_scores CONTENT {
            org_id: $org_id,
            template_id: $activity_id,
            context_bucket: $sig,
            signature_version: $sig_version,
            alpha: $alpha0 + $alpha_delta,
            beta:  $beta0 + $beta_delta,
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
          cap: CARDINALITY_CAP,
          alpha0: seed.alpha0,
          beta0: seed.beta0,
        },
      );
      logger.debug('posterior_update_v1_conditional', {
        event: 'posterior_update_v1_conditional',
        activity_id: activityId,
        signature: trace.signature,
        signature_version: trace.signature_version,
        alpha_delta: alphaDelta,
        beta_delta: betaDelta,
        cardinality_cap: CARDINALITY_CAP,
        prior_seed_source: seed.source,
        prior_seed_neighbors: seed.neighbor_count ?? 0,
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
    ...(skipVariantUpdate ? { skipped_reason: 'all_deterministic' as const } : {}),
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
        sibling_group_size: trace.sibling_group_size,
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
