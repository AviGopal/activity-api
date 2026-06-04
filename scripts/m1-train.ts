/**
 * M1 training pipeline — fits ridge-regression θ_α, θ_β heads for the
 * embedding-conditioned Thompson posterior (concept_vugylIHzIMvk) from
 * variant_performance_metrics joined to concept-db embeddings.
 *
 * Citations:
 *   concept_vfELeaE9GoiE (m1_training_pipeline_and_call_site_wiring)
 *   concept_vugylIHzIMvk (embedding_conditioned_thompson_posterior, M1)
 *   concept_TbN0eSf7U_hM (parent — Thompson learning-rate program)
 *   concept_7mzv7SQN_7JB (discipline gate — refine existing primitives only)
 *
 * Discipline: this script does not introduce a new shape, tier, or resolver
 * kind. It produces rows in `embedding_prior_weights` (migration 143) that
 * are consumed by the EXISTING `thompson_posterior` prior-seed code path.
 *
 * Closed-form ridge solution:
 *
 *   θ = (XᵀWX + λI)⁻¹ XᵀWy
 *
 * where:
 *   X       n × (d+1) feature matrix, [1, embedding] per row
 *   W       n × n diagonal weight matrix; w_i = sqrt(total_executions_i)
 *   y       n × 1 target (mean rate for α-head: succ/total; for β-head: 1-rate)
 *   λ       L2 regularization (default 0.1)
 *
 * Targets are scaled to virtual-trial counts (× κ, default 10) so the fitted
 * θ produces α₀, β₀ in the same magnitude as the empirical-Bayes path.
 *
 *   y_α_i = κ · (α_i / (α_i + β_i))
 *   y_β_i = κ · (β_i / (α_i + β_i))
 *
 * Outputs one row into embedding_prior_weights with:
 *   model_version          = 'ridge-v1-' + ISO timestamp
 *   feature_dim            = 384
 *   theta_alpha            = (385-element) [intercept, w₁..w_d]
 *   theta_beta             = (385-element)
 *   trained_at             = now
 *   n_training_samples     = n
 *   org_id                 = 'default' (per-tenant training is a follow-up)
 *
 * Environment:
 *   SURREALDB_URL, SURREALDB_USERNAME, SURREALDB_PASSWORD,
 *   SURREALDB_NAMESPACE, SURREALDB_DATABASE (standard activity-api set)
 *   CONCEPT_DB_URL              (defaults to http://localhost:8260)
 *   M1_TRAIN_MIN_EXECUTIONS     (default 5)
 *   M1_TRAIN_LAMBDA             (default 0.1)
 *   M1_TRAIN_KAPPA              (default 10)
 *   M1_TRAIN_ORG_ID             (default 'default')
 *   M1_TRAIN_FEATURE_DIM        (default 384)
 *
 * Usage:
 *   bun scripts/m1-train.ts
 *   M1_TRAIN_MIN_EXECUTIONS=10 bun scripts/m1-train.ts
 */

import { surrealDB } from '../src/db/surreal';

export interface VariantRow {
  variant_id: string;
  signature: string | null;
  thompson_alpha: number;
  thompson_beta: number;
  total_executions: number;
}

export interface TrainingSample {
  variant_id: string;
  signature: string;
  embedding: number[];
  alpha: number;
  beta: number;
  total_executions: number;
}

export interface RidgeFit {
  theta_alpha: number[];
  theta_beta: number[];
  mse_alpha: number;
  mse_beta: number;
}

// ─── Math helpers (closed-form ridge, in pure JS) ────────────────────────────

function transpose(M: number[][]): number[][] {
  const r = M.length;
  const c = M[0]?.length ?? 0;
  const T: number[][] = Array.from({ length: c }, () => new Array(r).fill(0));
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) T[j][i] = M[i][j];
  return T;
}

function matVec(M: number[][], v: number[]): number[] {
  const r = M.length;
  const c = v.length;
  const out = new Array(r).fill(0);
  for (let i = 0; i < r; i++) {
    let s = 0;
    const row = M[i];
    for (let j = 0; j < c; j++) s += row[j] * v[j];
    out[i] = s;
  }
  return out;
}

/**
 * Compute A = XᵀWX + λI without materializing W (diagonal of squared weights
 * passed as `wSquared`). X is n × p; returns p × p.
 */
function gramRegularized(X: number[][], wSquared: number[], lambda: number): number[][] {
  const n = X.length;
  const p = X[0].length;
  const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    const wi = wSquared[i];
    for (let a = 0; a < p; a++) {
      const xa = xi[a] * wi;
      // Symmetric — write upper triangle, mirror at end
      for (let b = a; b < p; b++) {
        A[a][b] += xa * xi[b];
      }
    }
  }
  for (let a = 0; a < p; a++) {
    A[a][a] += lambda;
    for (let b = a + 1; b < p; b++) A[b][a] = A[a][b];
  }
  return A;
}

/** Compute Xᵀ W y where W is the diagonal of weights (squared, per row). */
function xtWy(X: number[][], wSquared: number[], y: number[]): number[] {
  const n = X.length;
  const p = X[0].length;
  const out = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    const wy = wSquared[i] * y[i];
    for (let a = 0; a < p; a++) out[a] += xi[a] * wy;
  }
  return out;
}

/**
 * Solve A θ = b by Cholesky decomposition for symmetric positive definite A.
 * Falls back to LDLᵀ on small diagonal pivots (regularization keeps A SPD in
 * practice).
 */
function choleskySolve(A: number[][], b: number[]): number[] {
  const n = A.length;
  // Copy A → L (lower triangular)
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 1e-12) {
          // Bump diagonal to keep SPD (effectively a touch more regularization).
          sum = 1e-9;
        }
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  // Solve L y = b
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  // Solve Lᵀ θ = y
  const theta = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * theta[k];
    theta[i] = s / L[i][i];
  }
  return theta;
}

function weightedMSE(X: number[][], y: number[], theta: number[], wSquared: number[]): number {
  const n = X.length;
  let num = 0;
  let denom = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    const xi = X[i];
    for (let j = 0; j < xi.length; j++) pred += xi[j] * theta[j];
    const r = y[i] - pred;
    num += wSquared[i] * r * r;
    denom += wSquared[i];
  }
  return denom > 0 ? num / denom : 0;
}

// ─── Public training functions (also imported by the test) ────────────────────

/**
 * Closed-form weighted ridge regression. Solves
 *   θ_α = (XᵀWX + λI)⁻¹ Xᵀ W y_α
 *   θ_β = (XᵀWX + λI)⁻¹ Xᵀ W y_β
 *
 * sample_weight_i  = sqrt(total_executions_i)  (so wSquared = total_executions)
 *
 * @param samples training samples (variant + embedding + α/β/count)
 * @param featureDim length of `embedding` array (e.g. 384 for MiniLM)
 * @param lambda L2 regularization
 * @param kappa  virtual-trial scale; targets are y_α = κ · α/(α+β), y_β = κ · β/(α+β)
 */
export function fitRidge(
  samples: TrainingSample[],
  featureDim: number,
  lambda: number,
  kappa: number,
): RidgeFit {
  if (samples.length === 0) throw new Error('fitRidge: no samples');
  const p = featureDim + 1; // [intercept, ...embedding]
  const n = samples.length;
  const X: number[][] = new Array(n);
  const y_alpha = new Array(n).fill(0);
  const y_beta = new Array(n).fill(0);
  const wSquared = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (s.embedding.length !== featureDim) {
      throw new Error(
        `fitRidge: sample ${i} (variant=${s.variant_id}) has embedding dim ${s.embedding.length}, expected ${featureDim}`,
      );
    }
    const row = new Array(p);
    row[0] = 1;
    for (let j = 0; j < featureDim; j++) row[j + 1] = s.embedding[j];
    X[i] = row;
    const sum = s.alpha + s.beta;
    const rate = sum > 0 ? s.alpha / sum : 0.5;
    y_alpha[i] = kappa * rate;
    y_beta[i] = kappa * (1 - rate);
    wSquared[i] = Math.max(1, s.total_executions); // sample-weight squared
  }
  const A = gramRegularized(X, wSquared, lambda);
  const ba = xtWy(X, wSquared, y_alpha);
  const bb = xtWy(X, wSquared, y_beta);
  const theta_alpha = choleskySolve(A, ba);
  const theta_beta = choleskySolve(A, bb);
  const mse_alpha = weightedMSE(X, y_alpha, theta_alpha, wSquared);
  const mse_beta = weightedMSE(X, y_beta, theta_beta, wSquared);
  return { theta_alpha, theta_beta, mse_alpha, mse_beta };
}

// ─── Data acquisition (SurrealDB + concept-db) ────────────────────────────────

export interface DataLoaderDeps {
  loadVariantRows: (minExecutions: number) => Promise<VariantRow[]>;
  lookupEmbedding: (signature: string) => Promise<number[] | null>;
}

export async function collectTrainingSamples(
  deps: DataLoaderDeps,
  minExecutions: number,
  featureDim: number,
  logger: (msg: string, data?: Record<string, unknown>) => void,
): Promise<{ samples: TrainingSample[]; scanned: number; withSignature: number; withEmbedding: number }> {
  const rows = await deps.loadVariantRows(minExecutions);
  let withSignature = 0;
  let withEmbedding = 0;
  const samples: TrainingSample[] = [];
  for (const r of rows) {
    if (!r.signature) continue;
    withSignature += 1;
    const emb = await deps.lookupEmbedding(r.signature);
    if (!emb) continue;
    if (emb.length !== featureDim) {
      logger('m1_train_skip_dim_mismatch', {
        variant_id: r.variant_id,
        got: emb.length,
        expected: featureDim,
      });
      continue;
    }
    withEmbedding += 1;
    samples.push({
      variant_id: r.variant_id,
      signature: r.signature,
      embedding: emb,
      alpha: r.thompson_alpha,
      beta: r.thompson_beta,
      total_executions: r.total_executions,
    });
  }
  return { samples, scanned: rows.length, withSignature, withEmbedding };
}

// ─── Real DB-backed loaders (only invoked by main(), not by tests) ────────────

async function defaultLoadVariantRows(minExecutions: number): Promise<VariantRow[]> {
  // variant_performance_metrics rows joined to the latest signature observed
  // for that variant in context_thompson_scores. A variant can have multiple
  // signatures; we pick the most recently updated row as a representative.
  // (Per-signature granularity is a follow-up; this MVP keeps it tractable.)
  const sql = `
    SELECT
      variant_id,
      thompson_alpha,
      thompson_beta,
      total_executions
    FROM variant_performance_metrics
    WHERE total_executions >= $min
  `;
  const rows = await surrealDB.query<{
    variant_id: string;
    thompson_alpha: number;
    thompson_beta: number;
    total_executions: number;
  }>(sql, { min: minExecutions });

  // Pull a representative signature per variant from context_thompson_scores.
  const sigSql = `
    SELECT template_id, context_bucket, last_updated_at
    FROM context_thompson_scores
    ORDER BY last_updated_at DESC
  `;
  const sigRows = await surrealDB.query<{
    template_id: string;
    context_bucket: string;
    last_updated_at: string;
  }>(sigSql);
  const sigByTemplate = new Map<string, string>();
  for (const r of sigRows) {
    if (!sigByTemplate.has(r.template_id)) sigByTemplate.set(r.template_id, r.context_bucket);
  }

  const out: VariantRow[] = [];
  for (const r of rows) {
    out.push({
      variant_id: r.variant_id,
      signature: sigByTemplate.get(r.variant_id) ?? null,
      thompson_alpha: typeof r.thompson_alpha === 'number' ? r.thompson_alpha : 1,
      thompson_beta: typeof r.thompson_beta === 'number' ? r.thompson_beta : 1,
      total_executions: typeof r.total_executions === 'number' ? r.total_executions : 0,
    });
  }
  return out;
}

async function defaultLookupEmbedding(signature: string): Promise<number[] | null> {
  const url = process.env.CONCEPT_DB_URL ?? 'http://localhost:8260';
  try {
    const qs = new URLSearchParams({
      query: signature,
      source_type: 'impulse_signature',
      limit: '1',
    });
    const res = await fetch(`${url}/concepts/search?${qs.toString()}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { concepts?: Array<{ content_embedding?: number[] | null }> };
    const emb = body?.concepts?.[0]?.content_embedding;
    if (!Array.isArray(emb) || emb.length === 0) return null;
    return emb;
  } catch {
    return null;
  }
}

// ─── Write θ row ──────────────────────────────────────────────────────────────

export async function writeWeights(params: {
  modelVersion: string;
  featureDim: number;
  thetaAlpha: number[];
  thetaBeta: number[];
  nTrainingSamples: number;
  orgId: string;
}): Promise<void> {
  await surrealDB.query(
    `CREATE embedding_prior_weights CONTENT {
       org_id:             $org_id,
       model_version:      $model_version,
       feature_dim:        $feature_dim,
       theta_alpha:        $theta_alpha,
       theta_beta:         $theta_beta,
       trained_at:         time::now(),
       n_training_samples: $n
     }`,
    {
      org_id: params.orgId,
      model_version: params.modelVersion,
      feature_dim: params.featureDim,
      theta_alpha: params.thetaAlpha,
      theta_beta: params.thetaBeta,
      n: params.nTrainingSamples,
    },
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const minExecutions = parseInt(process.env.M1_TRAIN_MIN_EXECUTIONS ?? '5', 10);
  const lambda = parseFloat(process.env.M1_TRAIN_LAMBDA ?? '0.1');
  const kappa = parseFloat(process.env.M1_TRAIN_KAPPA ?? '10');
  const orgId = process.env.M1_TRAIN_ORG_ID ?? 'default';
  const featureDim = parseInt(process.env.M1_TRAIN_FEATURE_DIM ?? '384', 10);

  const log = (msg: string, data?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    if (data) console.log(`[${ts}] ${msg}`, JSON.stringify(data));
    else console.log(`[${ts}] ${msg}`);
  };

  log('m1_train_start', { minExecutions, lambda, kappa, orgId, featureDim });

  const { samples, scanned, withSignature, withEmbedding } = await collectTrainingSamples(
    {
      loadVariantRows: defaultLoadVariantRows,
      lookupEmbedding: defaultLookupEmbedding,
    },
    minExecutions,
    featureDim,
    log,
  );

  log('m1_train_data_collected', {
    scanned,
    with_signature: withSignature,
    with_embedding: withEmbedding,
    n_training_samples: samples.length,
  });

  if (samples.length === 0) {
    console.error('[m1-train] no training samples — aborting (need variants with total_executions >= min AND a concept-db embedding for their signature)');
    process.exit(2);
  }

  const fit = fitRidge(samples, featureDim, lambda, kappa);
  log('m1_train_fit_complete', {
    intercept_alpha: fit.theta_alpha[0],
    intercept_beta: fit.theta_beta[0],
    mse_alpha: fit.mse_alpha,
    mse_beta: fit.mse_beta,
  });

  const modelVersion = `ridge-v1-${new Date().toISOString()}`;
  await writeWeights({
    modelVersion,
    featureDim,
    thetaAlpha: fit.theta_alpha,
    thetaBeta: fit.theta_beta,
    nTrainingSamples: samples.length,
    orgId,
  });

  log('m1_train_row_written', { model_version: modelVersion, org_id: orgId });
  log('m1_train_done', {
    scanned,
    with_signature: withSignature,
    with_embedding: withEmbedding,
    n_training_samples: samples.length,
    mse_alpha: fit.mse_alpha,
    mse_beta: fit.mse_beta,
  });
  await surrealDB.close();
  process.exit(0);
}

// Run only when executed directly (not when imported by the test file).
if (import.meta.main) {
  main().catch((err) => {
    console.error('[m1-train] fatal error:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
