import { describe, test, expect } from 'bun:test';
import { computeStateSpaceSignature } from '../src/utils/session-context';

// ---------------------------------------------------------------------------
// Phase 24 §4: conditional posterior scoring rules
//
// These tests validate the override thresholds and signature determinism
// that the recommend handler relies on. The handler itself is stateful
// (SurrealDB-bound), so we test the scoring logic functions independently.
// ---------------------------------------------------------------------------

const SIGNATURE_SAMPLING_FLOOR = 5;

function applyConditionalOverride(opts: {
  sigRow: { alpha: number; beta: number; n_observations: number } | null;
  alphaBlended: number;
  betaBlended: number;
  blendWeight: number;
  scoreMethod: string;
  totalBoost: number;
  impulseBetaPenalty: number;
}): { alpha: number; beta: number; posteriorSource: string } {
  const { sigRow, alphaBlended, betaBlended, blendWeight, scoreMethod, totalBoost, impulseBetaPenalty } = opts;
  let alpha = alphaBlended;
  let beta = betaBlended;
  let posteriorSource = blendWeight > 0 ? 'context_bucketed' : scoreMethod;

  if (sigRow && sigRow.n_observations >= SIGNATURE_SAMPLING_FLOOR) {
    alpha = sigRow.alpha + totalBoost;
    beta  = sigRow.beta  + impulseBetaPenalty;
    posteriorSource = 'conditional';
  }

  return { alpha, beta, posteriorSource };
}

describe('conditional posterior — floor threshold', () => {
  test('below floor: posteriorSource unchanged (uses v0 blend)', () => {
    const result = applyConditionalOverride({
      sigRow: { alpha: 3, beta: 1, n_observations: 4 },
      alphaBlended: 2.5,
      betaBlended: 1.2,
      blendWeight: 0.3,
      scoreMethod: 'global',
      totalBoost: 0,
      impulseBetaPenalty: 0,
    });
    expect(result.posteriorSource).toBe('context_bucketed');
    expect(result.alpha).toBeCloseTo(2.5);
    expect(result.beta).toBeCloseTo(1.2);
  });

  test('at floor: posteriorSource becomes conditional', () => {
    const result = applyConditionalOverride({
      sigRow: { alpha: 3, beta: 1, n_observations: 5 },
      alphaBlended: 2.5,
      betaBlended: 1.2,
      blendWeight: 0.3,
      scoreMethod: 'global',
      totalBoost: 0,
      impulseBetaPenalty: 0,
    });
    expect(result.posteriorSource).toBe('conditional');
    expect(result.alpha).toBeCloseTo(3);
    expect(result.beta).toBeCloseTo(1);
  });

  test('above floor: conditional overrides with boosts applied', () => {
    const result = applyConditionalOverride({
      sigRow: { alpha: 4, beta: 2, n_observations: 12 },
      alphaBlended: 2.0,
      betaBlended: 3.0,
      blendWeight: 0.7,
      scoreMethod: 'global',
      totalBoost: 0.5,
      impulseBetaPenalty: 0.2,
    });
    expect(result.posteriorSource).toBe('conditional');
    expect(result.alpha).toBeCloseTo(4.5);  // 4 + 0.5
    expect(result.beta).toBeCloseTo(2.2);   // 2 + 0.2
  });

  test('null sigRow: no override applied', () => {
    const result = applyConditionalOverride({
      sigRow: null,
      alphaBlended: 2.5,
      betaBlended: 1.2,
      blendWeight: 0,
      scoreMethod: 'shape_conditioned',
      totalBoost: 0,
      impulseBetaPenalty: 0,
    });
    expect(result.posteriorSource).toBe('shape_conditioned');
    expect(result.alpha).toBeCloseTo(2.5);
  });
});

describe('conditional posterior — signature stability', () => {
  test('same impulse pool produces same signature (deterministic lookup key)', () => {
    const pool = [
      { shape: 'activityTemplate', produced_by: 'activity-api' },
      { shape: 'executionTrace' },
    ];
    const sig1 = computeStateSpaceSignature({
      shapes: pool.map(e => e.shape),
      provenance: pool
        .filter(e => (e as any).produced_by)
        .map(e => ({ shape: e.shape, producedBy: (e as any).produced_by })),
      missing: [],
    });
    const sig2 = computeStateSpaceSignature({
      shapes: pool.map(e => e.shape),
      provenance: pool
        .filter(e => (e as any).produced_by)
        .map(e => ({ shape: e.shape, producedBy: (e as any).produced_by })),
      missing: [],
    });
    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(16);
  });

  test('different pools produce different signatures', () => {
    const sigA = computeStateSpaceSignature({ shapes: ['goal'], provenance: [], missing: [] });
    const sigB = computeStateSpaceSignature({ shapes: ['goal', 'codeFile'], provenance: [], missing: [] });
    expect(sigA).not.toBe(sigB);
  });

  test('empty pool produces stable 16-char signature', () => {
    const sig = computeStateSpaceSignature({ shapes: [], provenance: [], missing: [] });
    expect(sig).toHaveLength(16);
    expect(computeStateSpaceSignature({ shapes: [], provenance: [], missing: [] })).toBe(sig);
  });
});
