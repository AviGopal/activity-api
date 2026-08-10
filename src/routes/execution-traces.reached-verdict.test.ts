// Pins the reach/failure_mode contradiction guard (task #55).
//
// THE ROW THIS EXISTS FOR: `reached: true` persisted on an execution whose own
// trace reported `failure_mode.type = 'execution_error'` and produced zero
// shapes. The verdict and the failure mode were written side by side and never
// compared, so the store held a self-contradicting row — and every downstream
// reader trusted it: the reach rate, Thompson credit, and the ribosome's
// "extract only from reached executions" filter.
import { describe, expect, it } from 'bun:test';

// execution-traces.ts pulls in the DB config at import time, which throws
// without these. Set BEFORE the import so the module can load — the same
// constraint every colocated route test in this vessel has (they fail
// identically without it; verified against activities.account-id.test.ts).
// No connection is made: reachedVerdict is pure, and importing the REAL module
// is the point — a re-implemented copy would pass while the shipped guard rots.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { reachedVerdict } = await import('./execution-traces');

describe('reachedVerdict', () => {
  it('DOWNGRADES a true verdict contradicted by execution_error', () => {
    // The whole point: the execution's own testimony that it threw outranks a
    // grader's claim that the goal was met.
    expect(reachedVerdict(true, 'execution_error')).toBe(false);
  });

  it('keeps a true verdict when the execution completed', () => {
    expect(reachedVerdict(true, undefined)).toBe(true);
  });

  it('does NOT downgrade budget_exhausted — a goal can be reached then run out', () => {
    // Guards the over-correction. Treating every failure mode as non-completing
    // would erase real successes, which is the opposite defect and just as bad.
    expect(reachedVerdict(true, 'budget_exhausted')).toBe(true);
  });

  it('leaves an ungraded verdict ungraded', () => {
    // undefined means "no verdict", NOT "false". Fabricating a negative here
    // would poison the learner exactly like fabricating a positive does.
    expect(reachedVerdict(undefined, 'execution_error')).toBeUndefined();
    expect(reachedVerdict(undefined, undefined)).toBeUndefined();
  });

  it('leaves an explicit false alone', () => {
    expect(reachedVerdict(false, 'execution_error')).toBe(false);
    expect(reachedVerdict(false, undefined)).toBe(false);
  });

  it('ignores unknown failure modes rather than guessing', () => {
    // A type nobody has classified must not silently become a downgrade — the
    // set is opt-in, so a new failure mode defaults to trusting the verdict
    // until someone decides it means "did not complete".
    expect(reachedVerdict(true, 'some_future_mode')).toBe(true);
  });
});
