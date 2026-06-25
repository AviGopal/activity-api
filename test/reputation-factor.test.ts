/**
 * Unit tests for the cross-signature reputation penalty (2026-06-25 lever 3).
 *
 * Proves the core behavioral claim from
 * openspec/changes/2026-06-25-cross-signature-reputation-penalty/proposal.md:
 *   - With the flag ON, a genuine producer (good global) beats a gaming
 *     candidate (strong-local / bad-global) over a seeded batch, and the
 *     genuine producer's margin over the gaming candidate WIDENS vs flag OFF.
 *   - With the flag OFF, the factor is 1.0 for both (current behavior).
 *   - blendWeight==0 => factor 1.0 (no double-damp of the fresh-signature regime).
 *   - No global row / below MIN_GLOBAL_OBS => factor 1.0 (novelty preserved).
 */
import { describe, it, expect } from 'bun:test';
import beta from '@stdlib/random-base-beta';
import { applyReputationFactor } from '../src/services/thompson-sampling';

// Deterministic Beta sampler for the head-to-head batch.
function seededSampler(seed: number) {
  return beta.factory({ seed });
}

// Mean expected post-factor score over a seeded sample batch.
function expectedScore(
  alphaBlended: number,
  betaBlended: number,
  reputationFactor: number,
  seed: number,
  n = 5000
): number {
  const sampler = seededSampler(seed);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += sampler(alphaBlended, betaBlended) * reputationFactor;
  }
  return sum / n;
}

describe('applyReputationFactor', () => {
  it('blendWeight==0 yields factor 1.0 (no double-damp of fresh-signature regime)', () => {
    // Even with a terrible global posterior, a fresh signature is untouched.
    expect(
      applyReputationFactor(0.0, 2, 30, { enabled: true })
    ).toBe(1.0);
  });

  it('missing global row yields factor 1.0 (novelty preserved)', () => {
    expect(
      applyReputationFactor(0.7, null, null, { enabled: true })
    ).toBe(1.0);
    expect(
      applyReputationFactor(0.7, undefined, undefined, { enabled: true })
    ).toBe(1.0);
  });

  it('below MIN_GLOBAL_OBS yields factor 1.0 (one unlucky failure not suppressed)', () => {
    // alpha+beta-2 = 2 observations < default floor 5.
    expect(
      applyReputationFactor(0.7, 1, 3, { enabled: true })
    ).toBe(1.0);
    // Custom floor respected.
    expect(
      applyReputationFactor(0.7, 5, 5, { enabled: true, minObs: 20 })
    ).toBe(1.0);
  });

  it('disabled flag yields factor 1.0 regardless of inputs', () => {
    expect(
      applyReputationFactor(0.7, 2, 30, { enabled: false })
    ).toBe(1.0);
  });

  it('matches the spec worked examples (bad global vs good global)', () => {
    // Bad global mu_g = 2/(2+30) = 0.0625; factor = 1 - 0.7*(1-0.0625) = 0.34375
    expect(
      applyReputationFactor(0.7, 2, 30, { enabled: true })
    ).toBeCloseTo(1 - 0.7 * (1 - 2 / 32), 10);
    // Good global mu_g = 40/45 ≈ 0.8889; factor = 1 - 0.7*(1-0.8889) ≈ 0.9222
    expect(
      applyReputationFactor(0.7, 40, 5, { enabled: true })
    ).toBeCloseTo(1 - 0.7 * (1 - 40 / 45), 10);
  });

  it('factor is clamped to [0,1] and never amplifies', () => {
    // mu_g near 1 with blendWeight near 1 -> factor near 1, never above.
    const f = applyReputationFactor(1.0, 100, 1, { enabled: true });
    expect(f).toBeLessThanOrEqual(1.0);
    expect(f).toBeGreaterThanOrEqual(0.0);
  });
});

describe('cross-signature reputation penalty — gaming A vs genuine B (core proof)', () => {
  // Same gamed signature, blendWeight 0.7 (nContext >= 5).
  const blendWeight = 0.7;

  // Candidate A (gaming): strong LOCAL ctx Beta(20,1), BAD global Beta(2,30).
  const A_ctxAlpha = 20, A_ctxBeta = 1;
  const A_globalAlpha = 2, A_globalBeta = 30;

  // Candidate B (genuine): ctx Beta(10,2), GOOD global Beta(40,5).
  const B_ctxAlpha = 10, B_ctxBeta = 2;
  const B_globalAlpha = 40, B_globalBeta = 5;

  // Blended Beta params (linear interpolation, as in the recommend handler).
  // Use the global as the non-context arm (alpha = scores.alpha).
  const A_alphaBlended = blendWeight * A_ctxAlpha + (1 - blendWeight) * A_globalAlpha;
  const A_betaBlended = blendWeight * A_ctxBeta + (1 - blendWeight) * A_globalBeta;
  const B_alphaBlended = blendWeight * B_ctxAlpha + (1 - blendWeight) * B_globalAlpha;
  const B_betaBlended = blendWeight * B_ctxBeta + (1 - blendWeight) * B_globalBeta;

  it('flag OFF: factor is 1.0 for both (current behavior, byte-for-byte)', () => {
    const fA = applyReputationFactor(blendWeight, A_globalAlpha, A_globalBeta, { enabled: false });
    const fB = applyReputationFactor(blendWeight, B_globalAlpha, B_globalBeta, { enabled: false });
    expect(fA).toBe(1.0);
    expect(fB).toBe(1.0);
  });

  it('flag ON: genuine B beats gaming A, and the margin widens vs flag OFF', () => {
    const fA = applyReputationFactor(blendWeight, A_globalAlpha, A_globalBeta, { enabled: true });
    const fB = applyReputationFactor(blendWeight, B_globalAlpha, B_globalBeta, { enabled: true });

    // A heavily damped (bad global), B barely touched (good global).
    expect(fA).toBeLessThan(0.5);
    expect(fB).toBeGreaterThan(0.85);

    // Post-factor: genuine B's expected score is strictly above gaming A's.
    const meanA_on = expectedScore(A_alphaBlended, A_betaBlended, fA, 12345);
    const meanB_on = expectedScore(B_alphaBlended, B_betaBlended, fB, 67890);
    expect(meanB_on).toBeGreaterThan(meanA_on);

    // The flag tilts selection further toward the genuine producer: B's margin
    // over A is strictly larger with the flag ON than with it OFF (factor 1.0).
    const meanA_off = expectedScore(A_alphaBlended, A_betaBlended, 1.0, 12345);
    const meanB_off = expectedScore(B_alphaBlended, B_betaBlended, 1.0, 67890);
    expect(meanB_on - meanA_on).toBeGreaterThan(meanB_off - meanA_off);
  });
});
