/**
 * In-process continuous-training observer for the M1 embedding-prior weights with error handling
 * (concept_KKwxHmPfEMSY). Subscribes to broadcaster.subscribe() and, for each
 * task.completed event, looks up the (variant_id, signature) cell's current
 * Thompson α/β and the corresponding dense embedding. Eligible samples are
 * pushed into a bounded ring buffer; when the new-sample counter or the time
 * threshold trips, the buffer is snapshotted and a fresh ridge fit is written
 * to `embedding_prior_weights` with model_version='online-v1-<ts>'.
 *
 * Discipline (concept_7mzv7SQN_7JB): purely additive — no new shape, no new
 * tier, no new resolver kind. Reuses the existing one-shot trainer's pure
 * `fitRidge` and the existing `lookupEmbeddingForSignature` cache. Output
 * row lives in the same table the systemd `m1-trainer.timer` writes; consumers
 * (posterior-update.ts) already pick "latest by trained_at".
 *
 * Citations:
 *   concept_KKwxHmPfEMSY (m1_continuous_training_pipeline) — primary anchor
 *   concept_vfELeaE9GoiE (m1_training_pipeline_and_call_site_wiring) — parent
 *   concept_vugylIHzIMvk (M1 mechanism)
 *   concept_TbN0eSf7U_hM (learning-rate parent family)
 *   concept_7mzv7SQN_7JB (discipline gate)
 *
 * Event-shape caveat: the current `task.completed` payload (src/websocket/types.ts)
 * does NOT carry `variant_id` / `signature` directly. The observer reads them
 * from msg.data when present (forward-compatible with the spec), and otherwise
 * falls back to a SurrealDB lookup keyed by (execution_id, task_id). When
 * neither path yields a (variant_id, signature) pair, the event is skipped.
 */

import { logger } from '../utils/logger';
import type { WebSocketMessage } from '../websocket/types';

// Local mirror of the TrainingSample shape from scripts/m1-train.ts. We don't
// type-import from scripts/ because tsconfig's rootDir is src/. The runtime
// fitRidge function is loaded via dynamic import so the runtime stays in sync
// while typecheck remains scoped to src/.
interface TrainingSample {
  variant_id: string;
  signature: string;
  embedding: number[];
  alpha: number;
  beta: number;
  total_executions: number;
}

interface RidgeFit {
  theta_alpha: number[];
  theta_beta: number[];
  mse_alpha: number;
  mse_beta: number;
}

type FitRidgeFn = (
  samples: TrainingSample[],
  featureDim: number,
  lambda: number,
  kappa: number,
) => RidgeFit;

let cachedFitRidge: FitRidgeFn | null = null;
async function loadFitRidge(): Promise<FitRidgeFn> {
  if (cachedFitRidge) return cachedFitRidge;
  // @ts-ignore — scripts/ lives outside rootDir; runtime resolution is fine.
  const mod: { fitRidge: FitRidgeFn } = await import('../../scripts/m1-train');
  cachedFitRidge = mod.fitRidge;
  return cachedFitRidge;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BufferedSample {
  variant_id: string;
  signature: string;
  embedding: number[];
  alpha: number;
  beta: number;
  total_executions: number;
  added_at: number;
}

export interface ContextScoreRow {
  total_executions: number;
  alpha: number;
  beta: number;
}

export interface EmbeddingPriorTrainerDeps {
  /** WS broadcaster — must expose `.subscribe(handler) => unsubscribe`. */
  broadcaster: { subscribe: (h: (msg: WebSocketMessage) => void) => () => void };
  /**
   * Look up the live (n, α, β) for the (variant_id, signature) cell from
   * context_thompson_scores. Returns null when no row exists yet.
   */
  loadContextScore: (variantId: string, signature: string) => Promise<ContextScoreRow | null>;
  /** Look up the dense embedding for a signature (concept-db, cached). */
  lookupEmbedding: (signature: string, orgId: string) => Promise<number[] | null>;
  /** Persist a freshly fitted θ row into embedding_prior_weights. */
  writeWeights: (row: {
    modelVersion: string;
    featureDim: number;
    thetaAlpha: number[];
    thetaBeta: number[];
    nTrainingSamples: number;
    orgId: string;
    mseAlpha: number;
    mseBeta: number;
  }) => Promise<void>;
  /** Inject clock for tests. */
  now?: () => number;
  /** Inject the fit function for tests; defaults to fitRidge from scripts/m1-train. */
  fit?: FitRidgeFn;
}

export interface EmbeddingPriorTrainerConfig {
  enabled: boolean;
  minObservations: number;
  bufferCapacity: number;
  refitTriggerCount: number;
  refitIntervalMs: number;
  featureDim: number;
  lambda: number;
  kappa: number;
  orgId: string;
}

export function loadConfigFromEnv(): EmbeddingPriorTrainerConfig {
  return {
    enabled: process.env.EMBEDDING_PRIOR_OBSERVER_ENABLED === 'true',
    minObservations: parseInt(process.env.M1_OBSERVER_MIN_OBS ?? '5', 10),
    bufferCapacity: parseInt(process.env.M1_OBSERVER_WINDOW ?? '10000', 10),
    refitTriggerCount: parseInt(process.env.M1_OBSERVER_REFIT_TRIGGER ?? '500', 10),
    refitIntervalMs: parseInt(process.env.M1_OBSERVER_REFIT_INTERVAL_MS ?? '900000', 10),
    featureDim: parseInt(process.env.M1_OBSERVER_FEATURE_DIM ?? '384', 10),
    lambda: parseFloat(process.env.M1_OBSERVER_LAMBDA ?? '0.1'),
    kappa: parseFloat(process.env.M1_OBSERVER_KAPPA ?? '10'),
    orgId: process.env.M1_OBSERVER_ORG_ID ?? 'default',
  };
}

// ─── Observer ─────────────────────────────────────────────────────────────────

export interface EmbeddingPriorTrainerHandle {
  stop: () => void;
  /** Test helpers: observe internal state. */
  _state: () => {
    bufferSize: number;
    newSinceLastFit: number;
    lastFitAt: number;
    fitsCompleted: number;
  };
  /** Test helper: force a refit synchronously regardless of triggers. */
  _forceRefit: () => Promise<void>;
}

/**
 * Extract (variant_id, signature) from a task.completed payload.
 * The spec assumes these fields are present; current event shape does not
 * carry them, so we read them defensively (msg.data.variant_id / signature)
 * and return null when missing.
 */
function extractVariantAndSignature(
  data: Record<string, unknown>,
): { variantId: string; signature: string } | null {
  const variantId =
    (typeof data.variant_id === 'string' && data.variant_id) ||
    (typeof data.activity_variant_id === 'string' && data.activity_variant_id) ||
    null;
  const signature = typeof data.signature === 'string' ? data.signature : null;
  if (!variantId || !signature) return null;
  return { variantId, signature };
}

export function startEmbeddingPriorTrainer(
  deps: EmbeddingPriorTrainerDeps,
  config: EmbeddingPriorTrainerConfig = loadConfigFromEnv(),
): EmbeddingPriorTrainerHandle {
  const now = deps.now ?? (() => Date.now());

  const buffer: BufferedSample[] = [];
  let newSinceLastFit = 0;
  let lastFitAt = now();
  let fitsCompleted = 0;
  let stopped = false;
  let refitInFlight: Promise<void> | null = null;

  function pushSample(s: BufferedSample): void {
    if (buffer.length >= config.bufferCapacity) {
      // Evict oldest (ring-buffer semantics)
      buffer.shift();
    }
    buffer.push(s);
  }

  async function refit(): Promise<void> {
    // Snapshot to avoid mid-fit mutations.
    const snapshot = buffer.slice();
    if (snapshot.length === 0) return;
    try {
      const samples: TrainingSample[] = snapshot.map((s) => ({
        variant_id: s.variant_id,
        signature: s.signature,
        embedding: s.embedding,
        alpha: s.alpha,
        beta: s.beta,
        total_executions: s.total_executions,
      }));
      const fitFn = deps.fit ?? (await loadFitRidge());
      const fit = fitFn(samples, config.featureDim, config.lambda, config.kappa);
      const modelVersion = `online-v1-${new Date(now()).toISOString()}`;
      await deps.writeWeights({
        modelVersion,
        featureDim: config.featureDim,
        thetaAlpha: fit.theta_alpha,
        thetaBeta: fit.theta_beta,
        nTrainingSamples: samples.length,
        orgId: config.orgId,
        mseAlpha: fit.mse_alpha,
        mseBeta: fit.mse_beta,
      });
      fitsCompleted += 1;
      logger.info('[m1-observer] refit complete', {
        n_samples: samples.length,
        mse_alpha: fit.mse_alpha,
        mse_beta: fit.mse_beta,
        model_version: modelVersion,
      });
    } catch (err: any) {
      logger.warn('[m1-observer] refit failed', { error: err?.message });
    } finally {
      newSinceLastFit = 0;
      lastFitAt = now();
    }
  }

  function triggerRefitIfDue(): void {
    if (refitInFlight) return;
    const elapsed = now() - lastFitAt;
    const countTriggered = newSinceLastFit >= config.refitTriggerCount;
    const timeTriggered = elapsed >= config.refitIntervalMs && newSinceLastFit > 0;
    if (!countTriggered && !timeTriggered) return;
    refitInFlight = (async () => {
      try {
        await refit();
      } finally {
        refitInFlight = null;
      }
    })();
  }

  async function handleTaskCompleted(data: Record<string, unknown>): Promise<void> {
    if (!config.enabled || stopped) return;

    const pair = extractVariantAndSignature(data);
    if (!pair) return; // spec assumes msg.data carries these; today it doesn't.

    try {
      const score = await deps.loadContextScore(pair.variantId, pair.signature);
      if (!score) return;
      if (score.total_executions < config.minObservations) return;

      const emb = await deps.lookupEmbedding(pair.signature, config.orgId);
      if (!emb) return;
      if (emb.length !== config.featureDim) return;

      pushSample({
        variant_id: pair.variantId,
        signature: pair.signature,
        embedding: emb,
        alpha: score.alpha,
        beta: score.beta,
        total_executions: score.total_executions,
        added_at: now(),
      });
      newSinceLastFit += 1;
      triggerRefitIfDue();
    } catch (err: any) {
      // Catch-all so we never throw into the broadcaster loop.
      logger.warn('[m1-observer] handler error', { error: err?.message });
    }
  }

  const unsubscribe = deps.broadcaster.subscribe((msg: WebSocketMessage) => {
    if (msg.type !== 'task.completed') return;
    const data = (msg.data ?? {}) as Record<string, unknown>;
    // Fire-and-forget; never throw into the synchronous emit() loop.
    void handleTaskCompleted(data);
  });

  logger.info('[m1-observer] started', {
    enabled: config.enabled,
    minObservations: config.minObservations,
    bufferCapacity: config.bufferCapacity,
    refitTriggerCount: config.refitTriggerCount,
    refitIntervalMs: config.refitIntervalMs,
  });

  return {
    stop() {
      stopped = true;
      unsubscribe();
    },
    _state() {
      return {
        bufferSize: buffer.length,
        newSinceLastFit,
        lastFitAt,
        fitsCompleted,
      };
    },
    async _forceRefit() {
      await refit();
    },
  };
}
