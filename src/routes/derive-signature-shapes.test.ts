/**
 * deriveSignatureShapes tier selection (seam L1-credit-03).
 *
 * This function decides the KEY every conditional posterior is written under.
 * Tier 2 read `input_impulse_shapes` / `inputShapes` off each task, but
 * `normalizePersistedTask` writes `input_shapes` — zero key intersection, so
 * tier 2 could never fire on a stored row and every trace fell through to
 * tier 3, which keys on the PRODUCED pool as a proxy for the INPUT pool.
 *
 * That is a different state space than the one `/recommend` derives when it
 * reads back, which is why the credit seam never closed. Measured on the live
 * stack before the fix: 0 of 50 traces carried a signature at all, and the v1
 * conditional lookup reported hits:0 against a correctly-formed 16-hex key
 * because there was nothing keyed to match it.
 *
 * The precise regression these pin: a tier must read the key the store actually
 * writes, and tier precedence must not change while fixing that.
 */
import { describe, expect, test } from 'bun:test';
import { deriveSignatureShapes } from './execution-traces';

describe('deriveSignatureShapes (L1-credit-03)', () => {
  test('tier 2 reads the PERSISTED key (input_shapes)', () => {
    // THE REGRESSION: returned [] before the fix.
    expect(deriveSignatureShapes({ tasks: [{ input_shapes: ['goal'] }] })).toEqual(['goal']);
  });

  test('tier 2 still reads the camelCase wire form from ias-executor', () => {
    expect(deriveSignatureShapes({ tasks: [{ inputShapes: ['goal'] }] })).toEqual(['goal']);
    expect(deriveSignatureShapes({ tasks: [{ input_impulse_shapes: ['goal'] }] })).toEqual(['goal']);
  });

  test('tier 1 (canonical input pool) still takes precedence over tier 2', () => {
    expect(
      deriveSignatureShapes({ input_impulse_shapes: ['a'], tasks: [{ input_shapes: ['b'] }] }),
    ).toEqual(['a']);
  });

  test('tier 3 reads the persisted output key too', () => {
    expect(deriveSignatureShapes({ tasks: [{ output_shapes: ['z'] }] })).toEqual(['z']);
  });

  test('an INPUT-bearing task never falls through to the produced proxy', () => {
    // The whole point of the tier order: input and produced are different state
    // spaces, and silently substituting one for the other is what made the write
    // key and the read key disagree.
    expect(
      deriveSignatureShapes({ tasks: [{ input_shapes: ['in'], output_shapes: ['out'] }] }),
    ).toEqual(['in']);
  });

  test('dedupes across tasks', () => {
    expect(
      deriveSignatureShapes({ tasks: [{ input_shapes: ['a', 'b'] }, { input_shapes: ['b'] }] }),
    ).toEqual(['a', 'b']);
  });

  test('NEGATIVE CONTROL: an empty trace still yields nothing', () => {
    // Without this, `return ['goal']` passes every assertion above.
    expect(deriveSignatureShapes({ tasks: [] })).toEqual([]);
    expect(deriveSignatureShapes({})).toEqual([]);
  });
});
