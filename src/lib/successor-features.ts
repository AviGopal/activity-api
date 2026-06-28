/**
 * Successor features ψ(s,a) — learning-rate mechanism #7.
 *
 * Substrate concept anchor: concept_49XNzJTL7E8V
 * (successor_feature_decomposition_of_q). OpenSpec change
 * `2026-06-04-learning-rate-7-successor-features`.
 *
 * Q(s,a) = ⟨ψ(s,a), R⟩. This module estimates the TRANSITION side ψ and
 * leaves the REWARD side R to the existing Thompson Beta posterior. ψ is the
 * expected DISCOUNTED SHAPE-OCCUPANCY of the trace continuation rooted at the
 * (signature, template) cell:
 *
 *     ψ̂_τ(s_0, a_0)  =  Σ_{t=0..T} γ^t · φ_t
 *
 * where φ_t is the output-shape indicator vector of task t (one occupancy unit
 * per produced shape). Each completed trace is one Monte-Carlo sample of ψ;
 * the online estimator is the Robbins-Monro running mean
 *
 *     ψ̂_{n+1}  =  ψ̂_n  +  (1/(n+1)) · ( ψ̂_τ − ψ̂_n )
 *
 * which is the empirical mean (Bayes-optimal under exchangeable traces).
 *
 * The payoff is ZERO-SHOT TRANSFER: a value estimate Q = ⟨ψ, R⟩ for a goal
 * direction R (= the goal's completion_shapes) the cell was never directly
 * Beta-rewarded on. ψ is a property of (π, P, φ, γ) only — independent of the
 * reward weights — so the SAME ψ surface reads out many goal directions.
 *
 * Storage: one row per (signature, template_id, scope) in `successor_features`
 * (migration 149). Vector is a sparse map {shape_id: discounted_count},
 * bounded to top-K shapes by occupancy (SF_TOPK, default 32).
 *
 * This path is ADDITIVE, env-flagged (SUCCESSOR_FEATURES, default ON), and
 * fire-and-forget — identical to the chain-credit path. A broken ψ-estimator
 * never blocks trace ingestion.
 */

import { logger } from '../utils/logger';
import { normalizeActivityId } from '../db/paradigm';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Discount γ applied per task index along the trace trajectory. */
const SF_DISCOUNT_DEFAULT = 0.9;
const SF_DISCOUNT: number = (() => {
  const raw = process.env.SF_DISCOUNT;
  if (raw === undefined || raw === '') return SF_DISCOUNT_DEFAULT;
  const p = parseFloat(raw);
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return SF_DISCOUNT_DEFAULT;
  return p;
})();

/** Bound on the ψ vocabulary per cell (top-K shapes by occupancy). */
const SF_TOPK_DEFAULT = 32;
const SF_TOPK: number = (() => {
  const raw = process.env.SF_TOPK;
  if (raw === undefined || raw === '') return SF_TOPK_DEFAULT;
  const p = parseInt(raw, 10);
  if (!Number.isFinite(p) || p < 1) return SF_TOPK_DEFAULT;
  return p;
})();

/** Master gate. Default ON; SUCCESSOR_FEATURES=0 fully disables the path. */
export function successorFeaturesEnabled(): boolean {
  return process.env.SUCCESSOR_FEATURES !== '0';
}

export function successorFeaturesDiscount(): number {
  return SF_DISCOUNT;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SparseVector = Record<string, number>;

export interface TraceForSuccessorFeatures {
  /** The executed template / variant id (the action a). */
  activity_id: string;
  /** v1 state-space signature (the state s). Required — ψ is keyed on it. */
  signature?: string;
  /** Trace-level produced shapes — fallback when per-task shapes are absent. */
  output_impulse_shapes?: string[];
  /** Per-task shape sequence; the discounted occupancy walks this in order. */
  tasks?: Array<{
    output_impulse_shapes?: string[];
    outputShapes?: string[];
  }>;
  org_id?: string;
}

// ---------------------------------------------------------------------------
// Estimator: ψ̂_τ for a single trace
// ---------------------------------------------------------------------------

/**
 * Compute the per-trace discounted shape-occupancy sample ψ̂_τ = Σ_t γ^t φ_t.
 *
 * φ_t is the indicator vector of task t's output shapes. When per-task output
 * shapes are absent (the common case in this substrate today — see
 * deriveSignatureShapes notes), the trace-level output_impulse_shapes are
 * treated as the single occupancy unit at t=0.
 *
 * Returns a sparse map {shape_id: discounted_count}. Pure / non-throwing.
 */
export function computeTraceOccupancy(
  trace: TraceForSuccessorFeatures,
  discount: number = SF_DISCOUNT,
): SparseVector {
  const vec: SparseVector = {};
  const add = (shapes: unknown, weight: number) => {
    if (!Array.isArray(shapes)) return;
    for (const s of shapes) {
      if (typeof s === 'string' && s.length > 0) {
        vec[s] = (vec[s] ?? 0) + weight;
      }
    }
  };

  const tasks = Array.isArray(trace.tasks) ? trace.tasks : [];
  let usedPerTask = false;
  let t = 0;
  for (const task of tasks) {
    const taskShapes = Array.isArray(task?.output_impulse_shapes)
      ? task.output_impulse_shapes
      : Array.isArray(task?.outputShapes)
        ? task.outputShapes
        : null;
    if (taskShapes && taskShapes.length > 0) {
      add(taskShapes, Math.pow(discount, t));
      usedPerTask = true;
      t++;
    }
  }

  // Fallback: no per-task shapes recorded — use the trace-level produced pool
  // as the single occupancy unit at t=0 (γ^0 = 1).
  if (!usedPerTask) {
    add(trace.output_impulse_shapes, 1);
  }

  return vec;
}

// ---------------------------------------------------------------------------
// Online update: Robbins-Monro running mean into the successor_features cell
// ---------------------------------------------------------------------------

interface DBQueryable {
  query<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]>;
}

/**
 * Accumulate one trace's discounted shape-occupancy into the
 * (signature, template) successor-feature cell using a Robbins-Monro running
 * mean. Fire-and-forget safe: never throws.
 *
 * The update is done read-modify-write (read existing ψ, blend, UPSERT). Under
 * concurrency this can lose a sample to a race; that is acceptable for a
 * running-mean statistic (it converges regardless) and keeps the path off the
 * hot trace-write contention surface. The cell is keyed by a UNIQUE index, so
 * the UPSERT collapses to one row.
 */
export async function updateSuccessorFeatures(
  trace: TraceForSuccessorFeatures,
  db: DBQueryable,
  orgId: string,
  scope: string = 'org',
): Promise<void> {
  if (!successorFeaturesEnabled()) return;
  if (!trace.signature || typeof trace.signature !== 'string') return;

  const templateId = normalizeActivityId(trace.activity_id);
  if (!templateId) return;

  const sample = computeTraceOccupancy(trace, SF_DISCOUNT);
  const sampleKeys = Object.keys(sample);
  if (sampleKeys.length === 0) return; // nothing produced — no ψ signal

  const signature = trace.signature;

  try {
    // Read the existing cell (point lookup on the UNIQUE index).
    const rows = await db.query<{
      vector?: SparseVector;
      sample_count?: number;
    }>(
      `SELECT vector, sample_count FROM successor_features
       WHERE signature = $sig AND template_id = $tid AND scope = $scope
       LIMIT 1`,
      { sig: signature, tid: templateId, scope },
    );
    const existing = Array.isArray(rows) && rows[0] ? rows[0] : null;
    const prior: SparseVector = existing?.vector ?? {};
    const n = existing?.sample_count ?? 0;

    // Robbins-Monro running mean with η = 1/(n+1):
    //   ψ_{n+1}[k] = ψ_n[k] + (sample[k] - ψ_n[k]) / (n+1)
    // Union of keys present in either prior or sample.
    const eta = 1 / (n + 1);
    const blended: SparseVector = {};
    const allKeys = new Set<string>([...Object.keys(prior), ...sampleKeys]);
    for (const k of allKeys) {
      const pv = prior[k] ?? 0;
      const sv = sample[k] ?? 0;
      const next = pv + (sv - pv) * eta;
      if (next > 1e-6) blended[k] = next;
    }

    // Bound the vocabulary: keep top-K by occupancy.
    let vector: SparseVector = blended;
    const keys = Object.keys(blended);
    if (keys.length > SF_TOPK) {
      const top = keys
        .sort((a, b) => blended[b] - blended[a])
        .slice(0, SF_TOPK);
      vector = {};
      for (const k of top) vector[k] = blended[k];
    }

    await db.query(
      `UPSERT successor_features
       SET signature = $sig,
           template_id = $tid,
           scope = $scope,
           org_id = $org,
           discount = $discount,
           vector = $vector,
           sample_count = $count,
           updated_at = time::now()
       WHERE signature = $sig AND template_id = $tid AND scope = $scope`,
      {
        sig: signature,
        tid: templateId,
        scope,
        org: orgId,
        discount: SF_DISCOUNT,
        vector,
        count: n + 1,
      },
    );

    logger.debug('successor_features_update', {
      event: 'successor_features_update',
      signature,
      template_id: templateId,
      org_id: orgId,
      sample_count: n + 1,
      vocab_size: Object.keys(vector).length,
    });
  } catch (err) {
    logger.warn('successor-features: update failed (non-blocking)', {
      signature,
      template_id: templateId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Readout: Q_sf = ⟨ψ(s,a), R⟩  for a goal direction R
// ---------------------------------------------------------------------------

/**
 * Build a reward-weight vector R from a goal's completion_shapes. Each
 * completion shape gets unit weight (uniform R direction). The dot product
 * ⟨ψ, R⟩ then reads out "how much discounted occupancy this cell directs
 * toward the goal's wanted shapes" — the transfer value.
 */
export function rewardFromCompletionShapes(completionShapes: string[]): SparseVector {
  const r: SparseVector = {};
  for (const s of completionShapes) {
    if (typeof s === 'string' && s.length > 0) r[s] = 1;
  }
  return r;
}

/** Sparse dot product ⟨ψ, R⟩. Iterates the smaller operand. */
export function successorValue(psi: SparseVector, reward: SparseVector): number {
  const [small, large] =
    Object.keys(psi).length <= Object.keys(reward).length ? [psi, reward] : [reward, psi];
  let acc = 0;
  for (const k of Object.keys(small)) {
    const rv = large[k];
    if (rv !== undefined) acc += small[k] * rv;
  }
  return acc;
}

export interface SuccessorFeatureCell {
  signature: string;
  template_id: string;
  scope: string;
  discount: number;
  vector: SparseVector;
  sample_count: number;
}

/**
 * Fetch ψ cells for a set of (signature, template) pairs in one query.
 * Returns a map keyed by `${signature} ${normalized_template_id}`.
 */
export async function fetchSuccessorFeatureCells(
  db: DBQueryable,
  signature: string,
  templateIds: string[],
  scope: string = 'org',
): Promise<Map<string, SuccessorFeatureCell>> {
  const out = new Map<string, SuccessorFeatureCell>();
  if (!signature || templateIds.length === 0) return out;
  const normIds = [...new Set(templateIds.map((t) => normalizeActivityId(t)).filter(Boolean))];
  if (normIds.length === 0) return out;
  try {
    const rows = await db.query<SuccessorFeatureCell>(
      `SELECT signature, template_id, scope, discount, vector, sample_count
       FROM successor_features
       WHERE signature = $sig AND scope = $scope AND template_id IN $tids`,
      { sig: signature, scope, tids: normIds },
    );
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.template_id) {
        out.set(`${signature} ${normalizeActivityId(row.template_id)}`, {
          signature: row.signature,
          template_id: row.template_id,
          scope: row.scope,
          discount: row.discount,
          vector: row.vector ?? {},
          sample_count: row.sample_count ?? 0,
        });
      }
    }
  } catch (err) {
    logger.warn('successor-features: fetch failed (non-blocking)', {
      signature,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

export function successorFeatureCellKey(signature: string, templateId: string): string {
  return `${signature} ${normalizeActivityId(templateId)}`;
}
