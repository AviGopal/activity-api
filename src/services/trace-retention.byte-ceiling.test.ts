// Pins the control variable of the retention valve.
//
// THE FAILURE THIS EXISTS FOR, measured on a live store: the valve reported
//
//     counted {"total":106673, "ceiling":150000, "willPrune":false}
//
// and correctly declined to prune, because the table was under its ROW ceiling. At the same
// moment the store sat at roughly 23 GB resident, in the throttle band where it stops
// answering even a trivial query while never crossing the hard limit that would trigger a
// restart — so the intended self-recovery could not fire either.
//
// The valve was not broken and its threshold was not wrong. It was measuring the WRONG
// QUANTITY, with complete fidelity. Rows are not fungible: a trace carrying a large metadata
// blob costs orders of magnitude more than a bare one, so any fixed row count corresponds to
// a footprint that can vary by orders of magnitude. A count-based ceiling cannot bound a
// byte-based resource, and lowering the row ceiling would only have worked by accident — and
// been wrong again the moment mean row size moved.
//
// WHAT THE VALVE THEN REPORTED, AND WHY THAT MATTERED MORE THAN THE FIX: once it logged the
// quantity it was bounding, the reading refuted the story above. Mean row size is small, not
// large, and the bounded working set is a tiny fraction of the store's footprint. The bytes
// are not in the rows this valve counts, and the process memory that actually wedges the
// store is not row payload at all. So these tests pin a correct bound on a real quantity that
// is NOT the one that wedges the store — worth keeping, and not to be mistaken for the remedy.
//
// The invariant that survives, and the reason the reporting is the load-bearing part: an
// instrument that reports only its verdict can be confidently wrong forever, while one that
// reports the quantity behind the verdict can refute the belief that built it. Pin the bound;
// trust the reading over the rationale.
import { describe, expect, test } from 'bun:test';

/** The decision under test: take whichever ceiling binds first. */
function effectiveCeiling(rowCeiling: number, byteBudget: number, meanRowBytes: number | null): { ceiling: number; boundBy: string } {
  if (!(byteBudget > 0) || meanRowBytes === null || !(meanRowBytes > 0)) {
    return { ceiling: rowCeiling, boundBy: 'rows' };
  }
  const byteDerived = Math.floor(byteBudget / meanRowBytes);
  return byteDerived < rowCeiling ? { ceiling: byteDerived, boundBy: 'bytes' } : { ceiling: rowCeiling, boundBy: 'rows' };
}

const GB = 1024 ** 3;

describe('retention ceiling: the binding quantity', () => {
  test('FAT rows bind on bytes long before the row ceiling', () => {
    // A hypothetical fat-row regime, NOT a measurement: the live store turned out to hold
    // small rows. It is kept because the bound must hold whenever mean row size grows, and
    // that is precisely the case a row ceiling cannot express.
    const { ceiling, boundBy } = effectiveCeiling(150_000, 8 * GB, 215_000);
    expect(boundBy).toBe('bytes');
    expect(ceiling).toBeLessThan(150_000);
    // And it must actually prune at the observed row count, where the old valve did not.
    expect(106_673 > ceiling).toBe(true);
  });

  test('THIN rows keep the row ceiling — the byte bound must not prune healthy volume', () => {
    // A 2 KB mean over an 8 GB budget allows ~4.2M rows, far above the row ceiling, so rows
    // remain the binding constraint. A byte bound that tightened here would be discarding
    // cheap, useful history for no reason.
    const { ceiling, boundBy } = effectiveCeiling(150_000, 8 * GB, 2_000);
    expect(boundBy).toBe('rows');
    expect(ceiling).toBe(150_000);
  });

  test('an unavailable size estimate falls back to rows rather than widening the bound', () => {
    // A failed sample must not silently license a larger working set. Absent evidence is not
    // evidence that there is room.
    expect(effectiveCeiling(150_000, 8 * GB, null).boundBy).toBe('rows');
    expect(effectiveCeiling(150_000, 8 * GB, 0).boundBy).toBe('rows');
  });

  test('a zero byte budget disables the byte bound entirely (previous behaviour)', () => {
    // The escape hatch has to be exact: with the budget off, the valve must behave precisely
    // as it did before, or the rollback path is not a rollback.
    const { ceiling, boundBy } = effectiveCeiling(150_000, 0, 215_000);
    expect(boundBy).toBe('rows');
    expect(ceiling).toBe(150_000);
  });

  test('the row ceiling remains an upper bound against a pathological under-estimate', () => {
    // If sampling wildly under-reports size, the byte-derived ceiling explodes upward — and
    // must still be clamped by the row ceiling, so a bad estimate can never license unbounded
    // growth. Mean size is an estimate and is treated as one.
    const { ceiling } = effectiveCeiling(150_000, 8 * GB, 1);
    expect(ceiling).toBe(150_000);
  });
});
