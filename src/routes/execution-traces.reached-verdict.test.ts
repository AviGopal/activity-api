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

// TASK #55's SECOND CONJUNCT, RESTORED (2026-09-03).
//
// The docstring on reachedVerdict states the defect it fixes as: `reached: true` persisted
// on executions that reported `failure_mode.type = 'execution_error'` AND PRODUCED ZERO
// SHAPES. The implementation kept the failure-mode half and dropped the zero-shapes half,
// so it downgrades ANY claimed reach carrying that mode — including executions that plainly
// completed.
//
// Measured on the live store 2026-09-03:
//   failure_mode='execution_error' AND status='success'          6,275
//   failure_mode='execution_error' AND produced output shapes    9,679  (83%)
//   reached=true                                                   478
//   reached=true AND failure_mode='execution_error'                430  (90%)
//
// And a worked case: walk-satisfier-1-1788364637686 is the goal "count the TypeScript files
// under repos/ribosome-vessel/src". Its answer, 7, was INDEPENDENTLY VERIFIED by a host-side
// recount. It carries failure_mode=execution_error and was downgraded to reached=False. The
// downgrade fired on a walk that demonstrably reached.
//
// An execution_error that completes and emits shapes is not a non-completing failure.
// Restoring the conjunct narrows the rule back to what Task #55 described, and cannot
// re-admit the case it was written for: zero shapes still downgrades.
describe('reachedVerdict — the produced-shapes conjunct', () => {
  it('STILL downgrades the Task #55 case: execution_error with zero shapes', () => {
    expect(reachedVerdict(true, 'execution_error', 0)).toBe(false);
  });

  it('does NOT downgrade an execution_error that produced shapes — it completed', () => {
    expect(reachedVerdict(true, 'execution_error', 3)).toBe(true);
  });

  it('leaves a non-completing mode with shapes alone regardless of count', () => {
    expect(reachedVerdict(true, 'execution_error', 1)).toBe(true);
  });

  it('preserves existing behaviour when the count is not supplied (conservative default)', () => {
    // Callers that have not been updated keep the old, stricter reading.
    expect(reachedVerdict(true, 'execution_error')).toBe(false);
  });

  it('never upgrades, and never touches a non-true claim', () => {
    expect(reachedVerdict(false, 'execution_error', 5)).toBe(false);
    expect(reachedVerdict(undefined, 'execution_error', 5)).toBeUndefined();
  });

  it('is unaffected for modes that were never non-completing', () => {
    expect(reachedVerdict(true, 'budget_exhausted', 0)).toBe(true);
  });
});
