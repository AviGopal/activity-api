import { describe, it, expect } from 'bun:test';
import { successYield } from '../src/lib/posterior-update';

// Graded-yield success reward (κ⁻¹ / metric-spread lever, 2026-06-19).
// A successful execution credits α += yield, β += (1 - yield) where yield ∈
// [0.5, 1] reflects per-execution quality (cost-efficiency + output productivity),
// instead of the binary α += 1 that pinned every variant's posterior at mean≈1
// under the substrate's ~98% success rate (collapsing κ⁻¹).
describe('successYield (graded-yield reward)', () => {
  it('gives the max yield 1.0 to a free, productive success', () => {
    expect(successYield({ cost_usd: 0, tasks: [{ output_impulse_ids: ['a', 'b', 'c', 'd'] }] })).toBeCloseTo(1, 5);
  });

  it('grades a free but low-productivity success below 1 (breaks saturation)', () => {
    const y = successYield({ cost_usd: 0, tasks: [{ output_impulse_ids: ['a'] }] });
    expect(y).toBeLessThan(1);
    expect(y).toBeGreaterThanOrEqual(0.5);
  });

  it('penalises cost: an expensive success yields less than a free one of equal productivity', () => {
    const free = successYield({ cost_usd: 0, tasks: [{ output_impulse_ids: ['a', 'b'] }] });
    const pricey = successYield({ cost_usd: 0.1, tasks: [{ output_impulse_ids: ['a', 'b'] }] });
    expect(pricey).toBeLessThan(free);
  });

  it('never drops below the floor (successes stay well above failures α=0)', () => {
    expect(successYield({ cost_usd: 100, tasks: [] })).toBeGreaterThanOrEqual(0.5);
  });

  it('spreads successes across a range (the whole point — metric resolution)', () => {
    const ys = [
      successYield({ cost_usd: 0, tasks: [{ output_impulse_ids: ['a', 'b', 'c', 'd'] }] }),
      successYield({ cost_usd: 0, tasks: [{ output_impulse_ids: ['a'] }] }),
      successYield({ cost_usd: 0.1, tasks: [] }),
    ];
    const spread = Math.max(...ys) - Math.min(...ys);
    expect(spread).toBeGreaterThan(0.2); // genuine variation, not a pinned constant
  });

  it('tolerates an empty trace (defensive)', () => {
    const y = successYield({});
    expect(y).toBeGreaterThanOrEqual(0.5);
    expect(y).toBeLessThanOrEqual(1);
  });
});
