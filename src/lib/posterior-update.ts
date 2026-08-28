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
import { enqueueVariantDelta, installPosteriorFlushOnShutdown } from './posterior-aggregator';
import { embedSignatureForShapes } from '../jobs/signature-embed-backfill';
import { applyClusterPosterior } from './cluster-posterior';
import { getTuningParam } from './tuning-params';
import { classifyReach } from './reach-classify';
import { recordDecisionOutcome, recordExecutionDecisionOutcome } from './decision-credit';

// Install the SIGTERM/SIGINT flush hook once on module load so buffered α/β
// deltas are written out on shutdown rather than lost.
installPosteriorFlushOnShutdown();

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
  /** Execution id — read by the honest-reach gate to detect satisfier satellites (walk-satisfier- prefix). Absent on non-ingest callers. */
  execution_id?: string;
  /** Trace tags carrying the walk's persisted reach verdict ('reached:true'/'reached:false'/'dispatcher_used:goal-host'). Absent => legacy success-based (fail-open). */
  tags?: string[];
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
  /**
   * The impulse shapes the signature was derived from. When present alongside a
   * newly-created context_thompson_scores row, applyOutcomeToPosteriors fires a
   * fire-and-forget embed of the signature's SEMANTIC content (the sorted shape
   * set, not the hash) so the clustering pass (D3) can place it. Best-effort;
   * absence simply means the backfill job will pick the signature up later.
   */
  input_impulse_shapes?: string[];
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

// Lifecycle-hook subscriber templates (validator-dispatch, slot-binding,
// create-shape-provider-goal) measure hook mechanics, not goal-reach. Their
// traces are excluded from the state-conditioned context_thompson_scores
// posterior so hook volume cannot poison goal-reach selection; they still
// update their own variant_performance_metrics posterior.
const HOOK_SUBSCRIBER_PATTERN = /validator-dispatch|slot-binding|create-shape-provider-goal/;

/**
 * Resolve the TD(λ) eligibility-trace decay, consuming the substrate_tuning_param
 * row 'TD_LAMBDA' (seam 3a) with the historical env→default fallback chain. The
 * out-of-range guard (λ must be in (0,1)) is preserved: a row/env value outside the
 * open interval falls back to the default with a warn-log, exactly as before. With
 * no tuning row authored, getTuningParam returns Number(process.env.TD_LAMBDA) (or
 * the default), so behavior is identical to the prior module-level const.
 */
async function resolveTdLambda(): Promise<number> {
  const value = await getTuningParam('TD_LAMBDA', process.env.TD_LAMBDA, TD_LAMBDA_DEFAULT);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    logger.warn('td_lambda_invalid', {
      event: 'td_lambda_invalid',
      raw: value,
      fallback: TD_LAMBDA_DEFAULT,
    });
    return TD_LAMBDA_DEFAULT;
  }
  return value;
}

// Marginal-attribution instrument (law 12 / law 1). A ubiquitous ancestor arm accrues
// TD(λ) credit from EVERY chain it participates in, so its stored posterior converges to
// the GLOBAL chain reach rate rather than its own marginal quality — measured 2026-08-25:
// validator-dispatch stored mean 0.205 (sample_count 791k) vs its OWN outcomes 0.94–0.95.
// This shaped, TTL-cached exclusion set lets named ubiquitous/infra arms be removed from
// ANCESTOR propagation so their posterior reflects only their own LEAF outcomes. Steered by
// the substrate_tuning_param row 'CREDIT_PROPAGATION_EXCLUDED_ANCESTORS' (comma-separated
// activity ids) — a shaped impulse read at use time, never an env constant (law 1). It is
// also the counterfactual instrument: exclude one arm, watch its posterior converge to its
// empirical rate, which measures the smearing before a permanent weighting formula is chosen.
const CREDIT_EXCLUSION_TTL_MS = 30_000;
let _creditExclusionCache: { value: Set<string>; expiresAt: number } | null = null;
async function resolveCreditPropagationExclusions(db: DBQueryable): Promise<Set<string>> {
  const now = Date.now();
  if (_creditExclusionCache && _creditExclusionCache.expiresAt > now) return _creditExclusionCache.value;
  let ids = new Set<string>();
  try {
    // Same 1.5s-deadline + fail-open discipline as getTuningParam: a policy read must never
    // hang a credit write, and "no exclusions" is a correct fallback.
    const rows = await Promise.race([
      db.query<{ param_value: unknown }>(
        'SELECT `value` AS param_value FROM substrate_tuning_param WHERE name = $name LIMIT 1',
        { name: 'CREDIT_PROPAGATION_EXCLUDED_ANCESTORS' },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('credit-exclusion lookup exceeded deadline')), 1_500),
      ),
    ]);
    const raw = Array.isArray(rows) && rows.length > 0 ? (rows[0] as { param_value?: unknown }).param_value : null;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      ids = new Set(raw.split(',').map((s) => normalizeActivityId(s.trim())).filter((s) => s.length > 0));
    }
  } catch {
    // Absent table / transient / deadline: behave exactly as before (no exclusions). Fail open.
  }
  _creditExclusionCache = { value: ids, expiresAt: now + CREDIT_EXCLUSION_TTL_MS };
  return ids;
}

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
    skipped_reason?: 'all_deterministic' | 'ungraded_reach' | 'idle_yield';
}

// ---------------------------------------------------------------------------
// DB interface — thin so tests can inject a mock
// ---------------------------------------------------------------------------

export interface TraceForPosterior {
  metadata?: { information_yield?: string };
}

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
// In-code defaults (the historical hardcoded literals). These remain the final
// fallback for the seam-3a getTuningParam reads: with no authored tuning row and
// no env override, successYield resolves to exactly these values — unchanged
// behavior.
const YIELD_FLOOR_DEFAULT = 0.5;     // a success always credits at least this much α
const YIELD_COST_REF_DEFAULT = 0.02; // $0.02 → cost component 0.5 (free → 1.0)
const YIELD_PROD_REF_DEFAULT = 4;    // ≥4 output impulses → productivity 1.0

/**
 * Resolved graded-yield reference constants for one trace evaluation. Passed into
 * successYield so the (already-async) trace-ingest path can consume authored
 * tuning rows without making the pure scoring math itself async.
 */
interface YieldRefs {
  floor: number;
  costRef: number;
  prodRef: number;
}

/**
 * Resolve the three graded-yield references (seam 3a), consuming the
 * substrate_tuning_param rows with the env→default fallback chain. Absent table +
 * absent env ⇒ the historical hardcoded literals, so behavior is preserved.
 */
async function resolveYieldRefs(): Promise<YieldRefs> {
  const [floor, costRef, prodRef] = await Promise.all([
    getTuningParam('YIELD_FLOOR', process.env.YIELD_FLOOR, YIELD_FLOOR_DEFAULT),
    getTuningParam('YIELD_COST_REF', process.env.YIELD_COST_REF, YIELD_COST_REF_DEFAULT),
    getTuningParam('YIELD_PROD_REF', process.env.YIELD_PROD_REF, YIELD_PROD_REF_DEFAULT),
  ]);
  return { floor, costRef, prodRef };
}

export function successYield(
  trace: {
    cost_usd?: number;
    tasks?: Array<{ output_impulse_ids?: string[] }>;
  },
  refs: YieldRefs = {
    floor: YIELD_FLOOR_DEFAULT,
    costRef: YIELD_COST_REF_DEFAULT,
    prodRef: YIELD_PROD_REF_DEFAULT,
  },
): number {
  const cost = typeof trace.cost_usd === 'number' && trace.cost_usd > 0 ? trace.cost_usd : 0;
  const costScore = 1 / (1 + cost / refs.costRef);            // free → 1, expensive → →0
  const tasks = trace.tasks ?? [];
  const outputs = tasks.reduce((sum, t) => sum + (t.output_impulse_ids?.length ?? 0), 0);
  const productivity = Math.min(1, outputs / refs.prodRef);
  const quality = 0.5 * costScore + 0.5 * productivity;
  const y = refs.floor + (1 - refs.floor) * quality;
  return Math.max(refs.floor, Math.min(1, y));
}

/**
 * Does this failure reason describe the ENVIRONMENT rather than the arm?
 *
 * An infrastructure failure is not the activity's fault. When the trace store is
 * unreachable or a vessel is mid-restart, every arm that happens to run records a
 * failure it did not cause — and under the old `default:` branch every one of them took
 * a full β=1 penalty. That is how an outage silently condemns arms wholesale, and it is
 * the reason the posterior decay had to be aggressive enough to forget real evidence
 * (see posterior-decay-halflife.test.ts for the conflict that created).
 *
 * Matching is deliberately NARROW: transport and availability signatures only. A resolver
 * that threw because its own logic is wrong must still be penalised, so anything not
 * recognised here keeps the strict default. False abstention costs a lost blame signal;
 * false blame condemns a working arm — and the second is what this codebase keeps paying
 * for, so the asymmetry is chosen on purpose.
 */
const ENVIRONMENTAL_FAILURE_PATTERNS: RegExp[] = [
  /\bECONNREFUSED\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /\bENOTFOUND\b/i,
  /\bEHOSTUNREACH\b/i,
  /\bENETUNREACH\b/i,
  /\bEPIPE\b/i,
  /connection refused/i,
  /connection reset/i,
  /socket hang ?up/i,
  /network (?:is )?unreachable/i,
  /fetch failed/i,
  /failed to fetch/i,
  /request timed? ?out/i,
  // Status codes only in an explicit HTTP context. A bare /\b50[234]\b/ was tried and
  // its own negative control caught it matching "returned 5031 rows, expected 502" —
  // an arm-fault message that would then have escaped blame. Gateway errors in practice
  // always carry either the HTTP prefix or the phrase forms below.
  /\bHTTP[\/ ]?\s*(?:502|503|504)\b/i,
  /\bstatus\s*(?:code\s*)?(?:502|503|504)\b/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway time-?out/i,
  /upstream connect error/i,
];

export function isEnvironmentalFailureReason(reason: unknown): boolean {
  if (typeof reason !== 'string' || reason.length === 0) return false;
  return ENVIRONMENTAL_FAILURE_PATTERNS.some((re) => re.test(reason));
}

// Exported for direct test: the delta this returns IS the blame decision, and asserting
// it through applyOutcomeToPosteriors would require a DB mock, which in this repo is
// global and order-dependent (a sibling test passed in isolation and failed in a
// full-suite run for exactly that reason). A pure function deserves a pure test.
export function computeDeltas(
  success: boolean,
  failureMode: FailureMode | null | undefined,
  warnings: string[],
  trace?: { cost_usd?: number; tasks?: Array<{ output_impulse_ids?: string[] }> },
  yieldRefs?: YieldRefs,
): Deltas {
  if (success) {
    // Graded-yield reward — see successYield. Falls back to the binary update when
    // disabled or when no trace context is available (defensive).
    if (GRADED_YIELD_ENABLED && trace) {
      const y = successYield(trace, yieldRefs);
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

    case 'execution_error': {
      // THE 98% CASE. Measured 2026-08-22: 1,761 of 1,801 recorded failures are this
      // type, against 36 cascading and 4 verifier_negative. It previously fell through
      // to `default:` and took a FULL β=1 penalty while warning "unknown
      // failure_mode.type" — so the overwhelming majority of all blame in this system
      // was assigned by a branch that did not know what it was looking at.
      //
      // An unhandled resolver throw is two different events wearing one label: the
      // resolver's own logic failed (the arm's fault), or the infrastructure it called
      // was unreachable (not the arm's fault). Blame the first, abstain on the second —
      // exactly the distinction `cascading` already makes for a downstream victim.
      const reason = (failureMode as unknown as { reason?: unknown }).reason;
      if (isEnvironmentalFailureReason(reason)) {
        // {0,0} matches 'cascading' / 'user_abort' and suppresses the S1-S4 side-writes
        // through their existing (alphaDelta!==0||betaDelta!==0) guards.
        return { alphaDelta: 0, betaDelta: 0 };
      }
      if (typeof reason !== 'string' || reason.length === 0) {
        // No reason to judge by. Historical rows carry none, because the trace sink
        // stripped it at the wire boundary before 2026-08-22. Keep the strict penalty
        // rather than abstaining blind: silently forgiving every unlabelled failure
        // would be a much larger behaviour change than the one being made here.
        warnings.push('execution_error with no reason; cannot distinguish environmental failure, applying strict penalty');
        return { alphaDelta: 0, betaDelta: 1 };
      }
      return { alphaDelta: 0, betaDelta: 1 };
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

const RELEVANCE_SINK_ENDPOINT =
  process.env.RELEVANCE_SINK_ENDPOINT ?? "http://127.0.0.1:8255";

export async function writeImpulseRelevancePenalty(
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

  // Fire-and-forget shaped write — the penalty crosses as an impulse resolve
  // (impulseRelevancePenalty_write) on the vessel's standard resolve surface,
  // not a bespoke /penalty REST verb. Endpoint is bootstrap config; the SHAPE
  // is what discovery routes and the learning loop can grade.
  fetch(`${RELEVANCE_SINK_ENDPOINT}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { pointer: { type: "impulseRelevancePenalty_write", impulse_ids: uniqueIds, org_id: orgId } } }),
  }).catch(() => {
    // swallow errors; penalty writes are best-effort
  });

  return uniqueIds.length;
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
/**
 * EMBEDDING_PRIOR_ENABLED, read as data rather than frozen at process start.
 *
 * Audit finding 3.8 (law 1). This flag selects WHICH PRIOR seeds a new cell — the θ-scored
 * embedding prior or the concept-neighbour query — so it decides where every uninformed arm
 * starts, which is squarely selection behaviour and squarely what law 1 says may not live in
 * a constant the system cannot observe.
 *
 * Mirrors `successorBlendEnabled` in routes/activities.scoring.ts exactly (law 3 — the repo's
 * established boolean-through-getTuningParam idiom, not a second one): env wins when set to a
 * truthy literal, otherwise an authored `substrate_tuning_param` row decides, otherwise the
 * documented default. With no row and no env — the shipped state — this returns false, which
 * is byte-for-byte what `process.env.EMBEDDING_PRIOR_ENABLED === 'true'` returned.
 *
 * The env tier is deliberately kept: dropping it would be a behaviour change disguised as a
 * law-1 fix, silently disabling the prior on every deployment that sets the var.
 */
let embeddingPriorCache: { value: boolean; expiresAt: number } | null = null;
let embeddingPriorRefreshing = false;
const EMBEDDING_PRIOR_TTL_MS = 30_000;

/**
 * Is the embedding prior enabled? NEVER BLOCKS, NEVER THROWS, NEVER TOUCHES THE DB INLINE.
 *
 * Two defects produced this shape, both mine, both caught by the convergence gate refusing to
 * deploy the commit that carried them:
 *
 *  1. INJECTION. `getTuningParam` uses the module-level `surrealDB` singleton, while both call
 *     sites sit in functions that receive an INJECTED `db`. Consulting it reached past the
 *     dependency the caller had deliberately mocked.
 *
 *  2. BLOCKING — the one that actually mattered. With no reachable store the lookup did not
 *     fail fast, it HUNG: `applyOutcomeToPosteriors` timed out after 5000ms. A policy flag had
 *     acquired the power to stall a credit write, so the same store saturation that already
 *     loses reach verdicts would now also stall the code path that records them. That is a
 *     strictly worse failure than the one this flag was made configurable to help with.
 *
 * ★ A TUNING FLAG IS NOT DATA THE CALLER NEEDS TO BE CORRECT. It selects which prior seeds a
 *   new cell; being one refresh window stale is harmless, and being unavailable must mean
 *   "keep the last answer", never "wait" and never "fail". So the read is synchronous against
 *   a cache, and the refresh happens OUT OF BAND with its own deadline, fire-and-forget.
 *
 * The env value remains the immediate answer when set, so the shipped configuration path never
 * depends on the store at all.
 */
function embeddingPriorEnabled(): boolean {
  const raw = process.env.EMBEDDING_PRIOR_ENABLED;
  if (raw === 'true' || raw === '1') return true;

  const now = Date.now();
  if (!embeddingPriorCache || embeddingPriorCache.expiresAt <= now) {
    // Kick a refresh and DO NOT await it. The current answer is returned either way.
    if (!embeddingPriorRefreshing) {
      embeddingPriorRefreshing = true;
      void (async () => {
        let value = embeddingPriorCache?.value ?? false;
        try {
          value = (await getTuningParam('EMBEDDING_PRIOR_ENABLED', raw, 0)) >= 1;
        } catch {
          // Keep the last known answer. An unreachable store must not silently switch which
          // prior seeds every new cell.
        } finally {
          embeddingPriorCache = { value, expiresAt: Date.now() + EMBEDDING_PRIOR_TTL_MS };
          embeddingPriorRefreshing = false;
        }
      })();
    }
  }
  return embeddingPriorCache?.value ?? false;
}

/** Tests only — drop the cached verdict so a case can set the env and observe the change. */
export function _resetEmbeddingPriorCache(): void { embeddingPriorCache = null; }

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

  // Route the ancestor VPM delta through the coalescing aggregator just like the
  // leaf write (applyOutcomeToPosteriors). Chain-credit fans out to ≤4 ancestor
  // hot rows per composed trace; sending those as direct read-modify-write UPDATEs
  // reintroduced exactly the optimistic-concurrency conflict storm the coalescer
  // was built to remove. enqueueVariantDelta folds them into Σδ; it returns false
  // only when coalescing is disabled, in which case we fall back to the sync UPDATE.
  try {
    if (!enqueueVariantDelta(ancestorId, orgId, alphaDelta, betaDelta)) {
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
    }
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
      if (embeddingPriorEnabled()) {
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

    // D4.2 — coarsening write: mirror the ancestor's leaf signature delta onto its
    // cluster posterior. Self-contained + non-throwing; never affects chain credit.
    void applyClusterPosterior(db, {
      orgId,
      templateId: ancestorId,
      signature,
      signatureVersion,
      alphaDelta,
      betaDelta,
    });
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

  // Seam 3a: resolve TD(λ) from the authored tuning row (TTL-cached, env→default
  // fallback, (0,1) guard preserved). Resolved once per propagation, not per ancestor.
  const tdLambda = await resolveTdLambda();
  const excludedAncestors = await resolveCreditPropagationExclusions(db);

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
  type AncestorMeta = { variant_id: string; signature?: string; signature_version?: number };
  let ancestorMetaByExecId: Map<string, AncestorMeta> = new Map();
  try {
    const limited = ancestors.slice(0, CREDIT_PROPAGATION_MAX_DEPTH);
    // NOTE: do NOT add `AND org_id = $org_id` here. execution_id has a UNIQUE
    // index (idx_activity_executions_execution_id); the moment org_id is in the
    // WHERE the SurrealDB planner switches to the low-selectivity org index and
    // scans the entire org partition (~2s on 160K rows vs ~27ms point lookup —
    // EXPLAIN-verified 2026-06-21). The $ids come from THIS execution's own
    // composition_chain, so they are already org-scoped by provenance.
    const rows = await db.query<{ execution_id: string; variant_id: string; signature?: string; signature_version?: number }>(
      `SELECT execution_id, variant_id, signature, signature_version FROM v_paradigm_execution_traces
       WHERE execution_id IN $ids`,
      { ids: limited },
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row.execution_id && row.variant_id) {
        ancestorMetaByExecId.set(row.execution_id, {
          variant_id: row.variant_id,
          signature: typeof row.signature === 'string' ? row.signature : undefined,
          signature_version: typeof row.signature_version === 'number' ? row.signature_version : undefined,
        });
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
    // Marginal-attribution (law 12): a shaped exclusion list removes named ubiquitous/infra
    // arms from ancestor credit so their posterior reflects only their own leaf outcomes,
    // instead of converging to the global chain rate.
    if (excludedAncestors.has(ancestorId)) continue;
    const depth = i + 1; // 1-indexed depth from leaf
    const decayFactor = Math.pow(tdLambda, depth);

    // Use per-ancestor v1 signature when available.
    // When absent (transition period), skip the conditional write for this ancestor.
    const sigEntry = execution.ancestor_signatures?.[ancestorExecId];
    // Fall back to the ancestor's OWN recorded v1 signature (from its trace row, exposed
    // on v_paradigm_execution_traces by migration 158) when the caller did not thread an
    // explicit ancestor_signatures override. ancestor_signatures has NO populating caller,
    // so WITHOUT this fallback the signature-conditioned chain-credit write in
    // writeAncestorDelta was dead for every composition — composed pathways could never
    // out-rank single-shot ones on the conditioned posterior the selector reads.
    const ancestorSig = sigEntry?.signature ?? meta?.signature ?? null;
    const ancestorSigVersion = sigEntry?.signature_version ?? meta?.signature_version ?? 1;
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
/**
 * Default posterior-decay half-life in days. Overridable at use time via the
 * authored `substrate_tuning_param` row THOMPSON_DECAY_HALFLIFE_DAYS (a shaped
 * config the substrate can steer without a restart — see
 * resolveThompsonDecayHalfLifeDays).
 *
 * RAISED 3 -> 30 on 2026-08-22, and only after blame attribution was fixed.
 *
 * The 3 came from "matching the llm-resolver-vessel decayedCounts fix this mirrors".
 * That was a constant calibrated for arms that fire many times an hour, applied to
 * activity templates that fire on a cycle of weeks. Measured cost over the 1,821 arms
 * carrying real evidence (alpha+beta > 4): 95.4% retained LESS THAN 5% of it and the
 * median retained 0.0002%. Credit accumulated correctly and was forgotten faster than
 * arms re-executed, which is what "learning does not compound" meant mechanically.
 *
 * WHY IT COULD NOT SIMPLY BE RAISED BEFORE. One constant was serving two incompatible
 * jobs. Fast forgetting existed to heal posteriors poisoned by transient outages —
 * alpha=1, beta=81, failures the arm did not earn — and slow forgetting is what lets
 * earned credit compound. Swept across 15 half-lives from 0.5 to 1000 days, the set
 * satisfying both was EMPTY (posterior-decay-halflife.test.ts proves it).
 *
 * WHAT CHANGED. The conflict was dissolved rather than traded: `execution_error` now
 * carries its reason across the wire, and computeDeltas abstains (beta += 0) when that
 * reason is a transport/availability failure. Outage poison is no longer CREATED, so
 * decay no longer has to erase real evidence to remove it. Blame for a genuinely broken
 * arm is unchanged at beta=1.
 *
 * RESIDUAL, measured and accepted: 32 of 509 arms with real beta still carry the historic
 * poison signature (beta > 10, alpha <= 2). A beta=81 row crosses back to re-selectable
 * at roughly 220 days rather than 30 — stated rather than rounded, because at 180 days it
 * is still suppressed at mean 0.308. The two worst are `auth_resolve_v1` (beta=399,770,
 * the credential storm — environmental by definition and not a selectable activity) and
 * `create-shape-provider-goal` (a hook subscriber already excluded from the conditional
 * posterior), so the slow fade lands where it costs least.
 *
 * Steer with the shaped substrate_tuning_param row THOMPSON_DECAY_HALFLIFE_DAYS rather
 * than editing this constant.
 */
export const THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT = 30;

/**
 * Resolve the posterior-decay half-life (days), consuming the
 * substrate_tuning_param row 'THOMPSON_DECAY_HALFLIFE_DAYS' (seam 3a pattern,
 * same as resolveTdLambda). No env fallback by design — decay is runtime
 * behavior and must stay steerable through the shaped tuning row, not a
 * process-start-frozen variable. Non-finite / non-positive values fall back
 * to the default with a warn-log.
 */
export async function resolveThompsonDecayHalfLifeDays(): Promise<number> {
  const value = await getTuningParam(
    'THOMPSON_DECAY_HALFLIFE_DAYS',
    undefined,
    THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
  );
  if (!Number.isFinite(value) || value <= 0) {
    logger.warn('thompson_decay_halflife_invalid', {
      event: 'thompson_decay_halflife_invalid',
      raw: value,
      fallback: THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
    });
    return THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT;
  }
  return value;
}

/**
 * Decay Thompson posterior counts toward the neutral prior 1 with an
 * exponential half-life (default 3 days).
 *
 * @param alpha Last observed alpha count
 * @param beta Last observed beta count
 * @param lastUpdatedMs Timestamp when the counts were last updated (milliseconds since epoch)
 * @param nowMs Current time (milliseconds since epoch)
 * @param halfLifeDays Half-life in days (default THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT)
 * @returns Decayed alpha and beta counts
 */
export function decayedThompsonCounts(
  alpha: number,
  beta: number,
  lastUpdatedMs: number,
  nowMs: number,
  halfLifeDays: number = THOMPSON_DECAY_HALFLIFE_DAYS_DEFAULT,
): { alpha: number; beta: number } {
  const d = Math.pow(0.5, Math.max(0, nowMs - lastUpdatedMs) / (halfLifeDays * 24 * 60 * 60 * 1000));
  return {
    alpha: 1 + (alpha - 1) * d,
    beta: 1 + (beta - 1) * d,
  };
}
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
  // Seam 3a: resolve the graded-yield references from authored tuning rows (TTL-cached,
  // env→default fallback). Behavior-preserving when no row exists.
  const yieldRefs = await resolveYieldRefs();
  // Honest-reach gate (three-way). The walk's persisted reach verdict (trace.tags)
  // overrides exit-status `success` for posterior credit/blame: reached -> credit,
  // not-reached -> penalize, ungraded (satellite OR goal-host walk with no reach tag)
  // -> SKIP so an ungraded outcome is neither credited nor BLAMED. Legacy no-tag rows
  // fall through to success-based behavior (unchanged). {0,0} for ungraded is idiomatic
  // (matches computeDeltas' 'cascading'/'user_abort') and suppresses S1-S4 via their
  // existing (alphaDelta!==0||betaDelta!==0) guards for free.
  const reachVerdict = classifyReach({
    success: trace.success,
    execution_id: trace.execution_id,
    activity_id: trace.activity_id,
    tags: trace.tags,
  });
  const ungraded = reachVerdict === 'ungraded';
  const effectiveSuccess = reachVerdict === 'reached';
  const { alphaDelta, betaDelta } = ungraded
    ? { alphaDelta: 0, betaDelta: 0 }
    : computeDeltas(effectiveSuccess, trace.failure_mode, warnings, trace, yieldRefs);
  const failureModeType = trace.failure_mode?.type ?? null;

  // Decision-level outcome capture (law 12), best-effort + NON-BLOCKING. This is
  // the additive consumer of the selection→outcome join: it persists a durable
  // decision_outcome row (survives execution-row retention) keyed on the walk's
  // correlation id, WITHOUT touching variant_performance_metrics or selection
  // behavior — so it cannot corrupt existing credit. Fire-and-forget (the callee
  // self-guards and never rejects) so it adds no latency to the credit path, and a
  // fast no-op when the trace carries no correlation tag (the common case).
  {
    const corrTag = (trace.tags ?? []).find(
      (t): t is string => typeof t === 'string' && t.startsWith('correlation:'),
    );
    const correlationId = corrTag ? corrTag.slice('correlation:'.length) : null;
    if (correlationId) {
      void recordDecisionOutcome(db, {
        correlationId,
        success: trace.success,
        reached: ungraded ? null : effectiveSuccess,
      });
    } else if (!ungraded && trace.execution_id && activityId) {
      // Universal capture: the substrate mostly executes via walks and pathway-reuse
      // (producers picked through discover-by-shapes, which writes no selection log),
      // so most executions carry no correlation tag to join. But a reach-GRADED
      // execution is itself a decision (run this arm) with a prediction (its
      // posterior) and an outcome (reached?). Record that, keyed on execution_id.
      // ungraded (satisfier/no-reach-tag) is skipped — no honest outcome to grade.
      void recordExecutionDecisionOutcome(db, {
        executionId: trace.execution_id,
        activityId,
        orgId,
        success: trace.success,
        reached: effectiveSuccess,
      });
    }
  }

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
  const skipVariantUpdate = tierClass === 'all_deterministic' || trace.metadata?.information_yield === 'idle';

  // Atomic UPDATE — mirrors the pattern in execution-traces.ts:2235
  // Uses variant_performance_metrics (not activity_template) to avoid the
  // BM25 FTS scorer regression (F-V46, SurrealDB 3.0).
  // M4: skip the UPDATE entirely for all-deterministic templates.
  // 2026-06-21 write-contention fix: route the hot-row α/β increment through the
  // coalescing aggregator (collapses N concurrent +δ on the same row into one
  // +Σδ flush) so concurrent executions of the same template no longer abort each
  // other with read/write conflicts. enqueueVariantDelta returns true when it
  // accepted the delta (coalescing ON); the `&& !` then skips the synchronous
  // UPDATE below. With POSTERIOR_COALESCE=0 it returns false → sync fallback.
  if (
    !skipVariantUpdate &&
    (alphaDelta !== 0 || betaDelta !== 0) &&
    !enqueueVariantDelta(activityId, orgId, alphaDelta, betaDelta)
  ) {
    try {
      // Read current Thompson counts and apply decay before writing
      const selectResult = await db.query<{
        thompson_alpha?: number | null;
        thompson_beta?: number | null;
        updated_at?: string | null;
      }>(
        `SELECT thompson_alpha, thompson_beta, updated_at FROM variant_performance_metrics WHERE variant_id = $activity_id AND org_id = $org_id LIMIT 1`,
        { activity_id: activityId, org_id: orgId },
      );

      const row = selectResult[0];
      const alpha = row?.thompson_alpha ?? 1;
      const beta = row?.thompson_beta ?? 1;
      let lastUpdatedMs = 0;
      if (row?.updated_at && typeof row.updated_at === 'string') {
        const parsed = new Date(row.updated_at).getTime();
        if (!Number.isNaN(parsed)) {
          lastUpdatedMs = parsed;
        }
      }

      const decayHalfLifeDays = await resolveThompsonDecayHalfLifeDays();
      const decayed = decayedThompsonCounts(alpha, beta, lastUpdatedMs, Date.now(), decayHalfLifeDays);
      const newAlpha = decayed.alpha + alphaDelta;
      const newBeta = decayed.beta + betaDelta;

      // SELF-HEALING DERIVED RATE. `success_rate` was written by the executions
      // endpoint as int/int on two TYPE int columns, so SurrealDB truncated every
      // value to exactly 0 or 1. Measured over the full template population: 438 of
      // 1,059 rows carrying counters have MIXED outcomes (0 < successful < total)
      // and ALL 438 read 0 or 1 — a mathematically impossible value for every one
      // of them.
      //
      // That is not cosmetic, because the value is read back and amplified:
      // composition-graph.ts reconstructs alpha = success_rate * total_executions + 1
      // and beta = (1 - success_rate) * total_executions + 1. A row like
      // development-vessel:trace-store-reconcile (20 successes of 23, genuinely 87%)
      // stored 0 and therefore reconstructs to alpha=1 / beta=24 — a working arm
      // handed a maximally pessimistic posterior and suppressed in selection.
      //
      // Recomputing it HERE heals it. This statement already runs on every graded
      // execution, it targets the row that holds the counters, and — unlike the
      // executions-endpoint UPDATE — it does not increment them, so reading them in
      // the same statement carries no SET-clause evaluation-order dependence. Each
      // affected row therefore repairs itself the next time its arm executes, with
      // no backfill activity, no hand-run SQL, and no separate write path to keep
      // consistent. math::max([1, ...]) makes the divide safe on a zero-count row.
      await db.query(
        `
        UPDATE variant_performance_metrics
        SET
          thompson_alpha = $new_alpha,
          thompson_beta  = $new_beta,
          success_rate = (successful_executions ?? 0) * 1.0 / math::max([1, total_executions ?? 0]),
          updated_at = time::now()
        WHERE variant_id = $activity_id AND org_id = $org_id
        `,
        { new_alpha: newAlpha, new_beta: newBeta, activity_id: activityId, org_id: orgId },
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
    !HOOK_SUBSCRIBER_PATTERN.test(activityId) &&
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
      if (embeddingPriorEnabled() && trace.signature) {
        const e = await lookupEmbeddingForSignature(trace.signature, orgId);
        if (e) embedding = e;
      }
      const seed = await seedPriorFromConcepts(activityId, trace.signature, orgId, embedding);
      // Write-time posterior decay (openspec 2026-07-29-thompson-posterior-time-decay):
      // decay the STORED alpha/beta toward the neutral prior (1,1) before adding the
      // delta, using the row's own last_updated_at. Done in SurrealQL (not TS) here
      // because the existence-check + cardinality-capped CREATE below is one atomic
      // script — a TS read-modify-write would reintroduce the race the script avoids.
      // math::max([0, ...]) clamps clock skew (datetime subtraction errors on negative
      // durations in SurrealDB 2.3.3, so we diff time::unix seconds instead).
      // Expression verified against the live 2.3.3 instance.
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
          SET alpha = 1 + (alpha - 1) * math::pow(0.5, math::max([0, time::unix(time::now()) - time::unix(last_updated_at ?? time::now())]) / $half_life_secs) + $alpha_delta,
              beta  = 1 + (beta - 1) * math::pow(0.5, math::max([0, time::unix(time::now()) - time::unix(last_updated_at ?? time::now())]) / $half_life_secs) + $beta_delta,
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
          half_life_secs: (await resolveThompsonDecayHalfLifeDays()) * 86400,
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

    // D4.1 — coarsening write: after the leaf signature posterior is updated above,
    // mirror the SAME (alphaDelta, betaDelta) onto the signature's CLUSTER posterior
    // (context_bucket = "cluster:" + cluster_id) so a well-sampled cluster bucket can
    // back a cold leaf at selection time (D5). Self-contained + non-throwing.
    void applyClusterPosterior(db, {
      orgId,
      templateId: activityId,
      signature: trace.signature,
      signatureVersion: trace.signature_version,
      alphaDelta,
      betaDelta,
    });

    // D2.3 — fire-and-forget: embed the signature's SEMANTIC content (the sorted
    // shape set, NOT the hash) so the clustering pass (D3) can place it. Idempotent
    // (skips if already embedded), advisory (concept-db down => no-op), non-blocking.
    // Only fires when the originating shapes are available; otherwise the backfill
    // job (D2.2) will pick the signature up later. Errors are fully swallowed inside
    // embedSignatureForShapes — never let a clustering enhancement affect ingestion.
    if (Array.isArray(trace.input_impulse_shapes) && trace.input_impulse_shapes.length > 0) {
      void embedSignatureForShapes(
        orgId,
        trace.signature,
        trace.signature_version,
        trace.input_impulse_shapes,
      );
    }
  }

  // Impulse-relevance side-write for verifier_negative (and null→verifier fallback)
  let impulseRelevanceWrites = 0;
  const isVerifierFailure =
    !ungraded &&
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
    skipped_reason: ungraded ? 'ungraded_reach' : (skipVariantUpdate ? (trace.metadata?.information_yield === 'idle' ? 'idle_yield' : 'all_deterministic') : undefined),
  };

  emitPosteriorUpdateMetric(summary);

  // Phase 18.4: fire-and-forget chain credit propagation when a composition
  // chain is present on the trace.
  if (!ungraded && trace.composition_chain && trace.composition_chain.length > 0) {
    propagateCreditAlongChain(
      {
        activity_id: activityId,
        composition_chain: trace.composition_chain,
        success: effectiveSuccess,
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
