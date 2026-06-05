/**
 * validateEvidenceGate — evidence-gated template-lifecycle gate.
 *
 * Substrate-callable replacement for the prior admin-scope-only gate. The
 * gate must reject non-admin calls that lack auditable evidence AND admit
 * calls whose evidence shows the loser is statistically dominated by the
 * winner (defaults: ≥10 loser samples, ≥0.15 success-rate delta).
 */
import { describe, test, expect } from 'bun:test';
import { validateEvidenceGate } from '../src/routes/impulses';

describe('validateEvidenceGate (deprecate)', () => {
  test('rejects undefined evidence', () => {
    const v = validateEvidenceGate(undefined, 'deprecate');
    expect(v.ok).toBe(false);
  });

  test('rejects evidence missing reason', () => {
    const v = validateEvidenceGate(
      { winner_alpha: 20, winner_beta: 5, loser_alpha: 5, loser_beta: 20 },
      'deprecate',
    );
    expect(v.ok).toBe(false);
  });

  test('rejects evidence with too few loser samples', () => {
    const v = validateEvidenceGate(
      {
        reason: 'winner dominates',
        winner_alpha: 8,
        winner_beta: 2,
        loser_alpha: 2,
        loser_beta: 5,  // alpha+beta-2 = 5 < 10
      },
      'deprecate',
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(JSON.stringify(v.insufficient_evidence.required)).toContain('loser_samples');
    }
  });

  test('rejects evidence with insufficient posterior delta', () => {
    const v = validateEvidenceGate(
      {
        reason: 'winner barely ahead',
        winner_alpha: 6, winner_beta: 5,   // 0.545
        loser_alpha: 5, loser_beta: 6,     // 0.454 — delta 0.09 < 0.15
        loser_samples: 11,
      },
      'deprecate',
    );
    expect(v.ok).toBe(false);
  });

  test('admits evidence with sufficient samples + delta', () => {
    const v = validateEvidenceGate(
      {
        reason: 'winner dominates after 20 runs each',
        winner_alpha: 18, winner_beta: 2,  // 0.9
        loser_alpha: 5, loser_beta: 15,    // 0.25 — delta 0.65 ≥ 0.15
        loser_samples: 20,
      },
      'deprecate',
    );
    expect(v.ok).toBe(true);
  });

  test('accepts caller-supplied confidence_threshold override', () => {
    // delta 0.10, threshold 0.10 → pass
    const v = validateEvidenceGate(
      {
        reason: 'winner ahead by 0.10 with caller-confirmed threshold',
        winner_alpha: 11, winner_beta: 9,  // 0.55
        loser_alpha: 9, loser_beta: 11,    // 0.45
        loser_samples: 18,
        confidence_threshold: 0.10,
      },
      'deprecate',
    );
    expect(v.ok).toBe(true);
  });
});

describe('validateEvidenceGate (update)', () => {
  test('requires evidence with reason but no Thompson check', () => {
    // _update doesn't compare two variants — it just needs an auditable reason.
    const v = validateEvidenceGate({ reason: 'fix off-by-one in interpolation' }, 'update');
    expect(v.ok).toBe(true);
  });

  test('rejects update without reason', () => {
    const v = validateEvidenceGate({} as any, 'update');
    expect(v.ok).toBe(false);
  });
});
