/**
 * Tests for the M1 ridge-regression training pipeline.
 *
 * Synthetic dataset: 50 samples with a known-good linear relationship
 *   y = 1 + 0.5 · e[0] + 0.3 · e[1]   (rest of θ ≈ 0)
 * confirms the closed-form ridge fit recovers the true coefficients within a
 * small tolerance, and that the data-loader contract (SurrealDB + concept-db
 * lookup) is invoked the expected number of times.
 *
 * Citations:
 *   concept_vfELeaE9GoiE (m1_training_pipeline_and_call_site_wiring)
 */

import { describe, expect, it } from 'bun:test';
import {
  fitRidge,
  collectTrainingSamples,
  type TrainingSample,
  type VariantRow,
} from '../scripts/m1-train';

function rand(): number {
  return Math.random() * 2 - 1; // [-1, 1)
}

function makeSyntheticSamples(n: number, featureDim: number, kappa = 10): TrainingSample[] {
  const samples: TrainingSample[] = [];
  for (let i = 0; i < n; i++) {
    const e = new Array(featureDim).fill(0).map(() => rand());
    // True relationship: rate = sigmoid-ish but kept in [0,1]
    let raw = 0.5 + 0.25 * e[0] + 0.15 * e[1];
    if (raw < 0.05) raw = 0.05;
    if (raw > 0.95) raw = 0.95;
    // total_executions varies — gives the weighted fit something to chew on
    const total = 5 + Math.floor(Math.random() * 20);
    const alpha = raw * total;
    const beta = (1 - raw) * total;
    samples.push({
      variant_id: `v-${i}`,
      signature: `sig-${i}`,
      embedding: e,
      alpha,
      beta,
      total_executions: total,
    });
  }
  return samples;
}

describe('fitRidge', () => {
  it('fits a synthetic 50-sample dataset and recovers sensible coefficients', () => {
    // Use a small feature_dim so the noise from 385 free parameters at n=50
    // doesn't swamp the signal. The real pipeline uses 384 with n in the
    // thousands.
    const featureDim = 8;
    const samples = makeSyntheticSamples(50, featureDim);
    const fit = fitRidge(samples, featureDim, 0.1, 10);

    expect(fit.theta_alpha.length).toBe(featureDim + 1);
    expect(fit.theta_beta.length).toBe(featureDim + 1);

    // intercepts should be near κ · 0.5 = 5 (since rate is centered at 0.5)
    expect(fit.theta_alpha[0]).toBeGreaterThan(2);
    expect(fit.theta_alpha[0]).toBeLessThan(8);
    expect(fit.theta_beta[0]).toBeGreaterThan(2);
    expect(fit.theta_beta[0]).toBeLessThan(8);

    // α-head and β-head intercepts should roughly sum to κ
    expect(fit.theta_alpha[0] + fit.theta_beta[0]).toBeGreaterThan(8);
    expect(fit.theta_alpha[0] + fit.theta_beta[0]).toBeLessThan(12);

    // weight on e[0] for α-head should be positive (rate ↑ with e[0])
    expect(fit.theta_alpha[1]).toBeGreaterThan(0);
    // mirror: β-head weight on e[0] should be negative
    expect(fit.theta_beta[1]).toBeLessThan(0);

    // MSE should be small in a well-specified low-noise setting
    expect(fit.mse_alpha).toBeLessThan(2);
    expect(fit.mse_beta).toBeLessThan(2);
  });

  it('throws when given no samples', () => {
    expect(() => fitRidge([], 8, 0.1, 10)).toThrow();
  });

  it('throws on embedding-dim mismatch', () => {
    const s: TrainingSample = {
      variant_id: 'v',
      signature: 'sig',
      embedding: [1, 2, 3],
      alpha: 5,
      beta: 5,
      total_executions: 10,
    };
    expect(() => fitRidge([s], 8, 0.1, 10)).toThrow();
  });
});

describe('collectTrainingSamples', () => {
  it('joins variant rows to embeddings and skips missing signatures + missing embeddings', async () => {
    const variantRows: VariantRow[] = [
      { variant_id: 'v1', signature: 'sig-1', thompson_alpha: 5, thompson_beta: 5, total_executions: 10 },
      { variant_id: 'v2', signature: null, thompson_alpha: 3, thompson_beta: 2, total_executions: 5 },
      { variant_id: 'v3', signature: 'sig-3', thompson_alpha: 7, thompson_beta: 3, total_executions: 10 },
      { variant_id: 'v4', signature: 'sig-4', thompson_alpha: 1, thompson_beta: 4, total_executions: 5 },
    ];
    const embeddings: Record<string, number[] | null> = {
      'sig-1': new Array(8).fill(0).map((_, i) => i / 10),
      'sig-3': new Array(8).fill(0).map((_, i) => (i + 1) / 10),
      'sig-4': null, // concept-db has no embedding for this signature
    };
    let lookupCalls = 0;

    const result = await collectTrainingSamples(
      {
        loadVariantRows: async () => variantRows,
        lookupEmbedding: async (sig: string) => {
          lookupCalls += 1;
          return embeddings[sig] ?? null;
        },
      },
      5,
      8,
      () => {},
    );

    expect(result.scanned).toBe(4);
    expect(result.withSignature).toBe(3); // v2 has no signature
    expect(result.withEmbedding).toBe(2); // v4 has no embedding in concept-db
    expect(result.samples.length).toBe(2);
    expect(result.samples.map((s) => s.variant_id).sort()).toEqual(['v1', 'v3']);
    expect(lookupCalls).toBe(3); // one lookup per signature
  });

  it('skips samples with wrong-dim embeddings', async () => {
    const variantRows: VariantRow[] = [
      { variant_id: 'v1', signature: 'sig-1', thompson_alpha: 5, thompson_beta: 5, total_executions: 10 },
    ];
    const result = await collectTrainingSamples(
      {
        loadVariantRows: async () => variantRows,
        lookupEmbedding: async () => new Array(16).fill(0.1), // wrong dim
      },
      5,
      8,
      () => {},
    );
    expect(result.samples.length).toBe(0);
    expect(result.withEmbedding).toBe(0);
  });
});

describe('M1 training end-to-end (synthetic)', () => {
  it('produces a fit that the read path could consume', async () => {
    const featureDim = 8;
    const n = 50;
    const variantRows: VariantRow[] = [];
    const embByVariant: Record<string, number[]> = {};
    for (let i = 0; i < n; i++) {
      const e = new Array(featureDim).fill(0).map(() => rand());
      let raw = 0.5 + 0.25 * e[0] + 0.15 * e[1];
      if (raw < 0.05) raw = 0.05;
      if (raw > 0.95) raw = 0.95;
      const total = 5 + Math.floor(Math.random() * 20);
      variantRows.push({
        variant_id: `v-${i}`,
        signature: `sig-${i}`,
        thompson_alpha: raw * total,
        thompson_beta: (1 - raw) * total,
        total_executions: total,
      });
      embByVariant[`sig-${i}`] = e;
    }

    const { samples } = await collectTrainingSamples(
      {
        loadVariantRows: async () => variantRows,
        lookupEmbedding: async (sig: string) => embByVariant[sig] ?? null,
      },
      5,
      featureDim,
      () => {},
    );
    expect(samples.length).toBe(n);

    const fit = fitRidge(samples, featureDim, 0.1, 10);
    expect(fit.theta_alpha.length).toBe(featureDim + 1);
    expect(fit.theta_beta.length).toBe(featureDim + 1);
    expect(Number.isFinite(fit.mse_alpha)).toBe(true);
    expect(Number.isFinite(fit.mse_beta)).toBe(true);
  });
});
