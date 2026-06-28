import { describe, it, expect } from 'bun:test';
import {
  computeTraceOccupancy,
  rewardFromCompletionShapes,
  successorValue,
  successorFeatureCellKey,
} from './successor-features';

describe('successor-features ψ estimator', () => {
  it('computes discounted per-task shape-occupancy ψ̂_τ = Σ_t γ^t φ_t', () => {
    // t=0: {diagnosis_report, patch_proposal}; t=1: {patch_proposal, verification_result}
    const psi = computeTraceOccupancy(
      {
        activity_id: 'x',
        tasks: [
          { output_impulse_shapes: ['diagnosis_report', 'patch_proposal'] },
          { output_impulse_shapes: ['patch_proposal', 'verification_result'] },
        ],
      },
      0.9,
    );
    // diagnosis_report: γ^0 = 1
    expect(psi.diagnosis_report).toBeCloseTo(1.0, 6);
    // patch_proposal: γ^0 + γ^1 = 1 + 0.9 = 1.9
    expect(psi.patch_proposal).toBeCloseTo(1.9, 6);
    // verification_result: γ^1 = 0.9
    expect(psi.verification_result).toBeCloseTo(0.9, 6);
  });

  it('falls back to trace-level output shapes (weight 1) when no per-task shapes', () => {
    const psi = computeTraceOccupancy({
      activity_id: 'x',
      output_impulse_shapes: ['a', 'b'],
      tasks: [],
    });
    expect(psi).toEqual({ a: 1, b: 1 });
  });

  it('produces empty ψ when nothing is produced', () => {
    expect(computeTraceOccupancy({ activity_id: 'x' })).toEqual({});
  });

  it('successorValue ⟨ψ,R⟩ reads out transfer value for different goal directions off ONE ψ', () => {
    const psi = { diagnosis_report: 1.0, patch_proposal: 1.9, verification_result: 0.9 };
    // R_old: the well-known direction
    expect(successorValue(psi, rewardFromCompletionShapes(['patch_proposal']))).toBeCloseTo(1.9, 6);
    // R_new: a DIFFERENT goal direction — zero-shot transfer, non-zero value
    expect(successorValue(psi, rewardFromCompletionShapes(['verification_result']))).toBeCloseTo(0.9, 6);
    // R_combo
    expect(
      successorValue(psi, rewardFromCompletionShapes(['diagnosis_report', 'verification_result'])),
    ).toBeCloseTo(1.9, 6);
    // R_unrelated: correctly zero (no transition toward it)
    expect(successorValue(psi, rewardFromCompletionShapes(['xyz']))).toBe(0);
  });

  it('cell key normalizes the activity wrapper so candidate ids match stored template_id', () => {
    expect(successorFeatureCellKey('sig1', 'activity:⟨foo:bar⟩')).toBe('sig1 foo:bar');
    expect(successorFeatureCellKey('sig1', 'foo:bar')).toBe('sig1 foo:bar');
  });
});
