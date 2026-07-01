import { describe, it, expect } from 'bun:test';
import {
  validRepairSignature,
  repairBoostFromRows,
  priorRepairDelta,
} from '../src/lib/repair-signature-consume';

describe('validRepairSignature', () => {
  it('accepts a 16-char hex string', () => {
    expect(validRepairSignature('0123456789abcdef')).toBe('0123456789abcdef');
  });
  it('rejects uppercase hex', () => {
    expect(validRepairSignature('0123456789ABCDEF')).toBeNull();
  });
  it('rejects too-short string', () => {
    expect(validRepairSignature('0123456789abcde')).toBeNull();
  });
  it('rejects too-long string', () => {
    expect(validRepairSignature('0123456789abcdef0')).toBeNull();
  });
  it('rejects non-string', () => {
    expect(validRepairSignature(null)).toBeNull();
    expect(validRepairSignature(12345)).toBeNull();
    expect(validRepairSignature(undefined)).toBeNull();
  });
});

describe('repairBoostFromRows', () => {
  it('returns empty map for empty input', () => {
    expect(repairBoostFromRows([]).size).toBe(0);
  });
  it('excludes rows with n_observations < 3', () => {
    const rows = [
      { template_id: 'a', alpha: 3, beta: 1, n_observations: 2 },
    ];
    expect(repairBoostFromRows(rows).size).toBe(0);
  });
  it('includes rows with n_observations >= 3 and computes boost', () => {
    const rows = [
      { template_id: 'b', alpha: 3, beta: 1, n_observations: 5 },
    ];
    const map = repairBoostFromRows(rows);
    expect(map.has('b')).toBe(true);
    // boost = 2 * 3 / (3 + 1) = 1.5
    expect(map.get('b')).toBeCloseTo(1.5);
  });
  it('handles multiple rows correctly', () => {
    const rows = [
      { template_id: 'c', alpha: 2, beta: 2, n_observations: 10 },
      { template_id: 'd', alpha: 1, beta: 1, n_observations: 1 },
    ];
    const map = repairBoostFromRows(rows);
    expect(map.has('c')).toBe(true);
    expect(map.has('d')).toBe(false);
    // boost = 2 * 2 / (2 + 2) = 1
    expect(map.get('c')).toBeCloseTo(1.0);
  });
});

describe('priorRepairDelta', () => {
  it('returns dAlpha=1 dBeta=0 on success', () => {
    expect(priorRepairDelta(true)).toEqual({ dAlpha: 1, dBeta: 0 });
  });
  it('returns dAlpha=0 dBeta=1 on failure', () => {
    expect(priorRepairDelta(false)).toEqual({ dAlpha: 0, dBeta: 1 });
  });
});
