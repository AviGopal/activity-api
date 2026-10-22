/**
 * gradeReach leaves an INFRA-CLASS failure ungraded (D8a follow-up:
 * infra-class-failures-are-charged-as-beta-to-the-arm-instead-of-being-ungraded; and
 * environment-failure-classifier-misses-aborted-and-socket-closed-so-outages-blame-arms).
 *
 * The decision, as pure functions of the CLOSED module (posterior-update.ts): isEnvironmentalFailureReason recognises
 * the provider's 402 / 429 / quota refusals, a peer mid-restart, a caller deadline and goal-host's spend-rate breaker;
 * gradeReach answers 'ungraded' for an execution_error carrying one, ahead of both failure arms; posteriorGrade does
 * not let the ungraded-failure arm blame it; computeDeltas charges it beta 0.
 *
 *   - MUST-FAIL: the reasons below are environmental; an untagged failed execution carrying one is ungraded; a
 *     reached:false verdict on one is ungraded; posteriorGrade does not grade it.
 *   - CONTROL: arm faults (including one that contains the digits, and a credential failure) are not environmental and
 *     keep the not-reached verdict; a failure with no failure_mode keeps it; reached:true is still reached; a
 *     non-execution_error type (a judge's verdict quoting a 429) is not intercepted.
 */
import { describe, expect, test } from 'bun:test';

process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

// gradeReach is new: on the parent it is absent, and the must-fail falls back to classifyReach (which ignores the
// failure_mode there), so it fails on its assertions, not on an import.
const { classifyReach } = await import('./reach-classify');
const PU = await import('./posterior-update');
const { posteriorGrade, computeDeltas, isEnvironmentalFailureReason } = PU;
const gradeReach = ((PU as any).gradeReach ?? classifyReach) as (t: Record<string, unknown>) => string;

const INFRA_REASONS = [
  'HTTP 429 Too Many Requests',
  'status code 429',
  'HTTP 402 Payment Required: Insufficient credits',
  'Your credit balance is too low to access the API',
  'You exceeded your current quota, please check your plan and billing details',
  'insufficient_quota',
  'Rate limit exceeded: free-models-per-day',
  'rate_limit_error',
  'quota exceeded for this model',
  'Unable to connect. Is the computer able to access the url?',
  'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
  'The operation timed out.',
  'The operation was aborted.',
  // goal-host's spend-rate breaker, both surfaces, both decisions (the receiver's window, not the arm).
  'deterministic:spend-rate-refused - 6 dispatches of goal 3f2a9c in the last 3600 s (per_hash_max 6, dispatchRatePolicy)',
  'spend-rate breaker: 240 dispatches in the last 3600 s (global_max 240, dispatchRatePolicy)',
];
const ARM_FAULTS = [
  'returned 4021 rows, expected 402',
  'expected 429 items, got 428',
  'assertion failed: expected 2 got 3',
  'unauthorized: invalid api key',
  'rate limit config missing from template',
  'oldString not found in repos/activity-api/src/index.ts',
  // The row's two arm-ambiguous reasons stay the arm's (qa ruling): a template can author either.
  'fetch() URL is invalid',
  'no resolver registered for shape fooResult',
  // Mentions a spend rate, but is not the breaker's sentence.
  'spend-rate breaker misconfigured in template: per_hash_max missing',
];
const fm = (reason: string) => ({ type: 'execution_error', reason });

describe('MUST-FAIL — infra-class reasons are environmental and ungraded', () => {
  test('each reason is recognised as environmental', () => {
    for (const r of INFRA_REASONS) expect([r, isEnvironmentalFailureReason(r)]).toEqual([r, true]);
  });

  test('an untagged failed execution carrying one is ungraded, not not-reached', () => {
    for (const r of INFRA_REASONS) {
      expect([r, gradeReach({ success: false, activity_id: 'arm', failure_mode: fm(r) })]).toEqual([r, 'ungraded']);
    }
  });

  test('an execution_error carrying one costs the arm beta 0 (computeDeltas)', () => {
    for (const r of INFRA_REASONS) expect([r, computeDeltas(false, fm(r) as never, [])]).toEqual([r, { alphaDelta: 0, betaDelta: 0 }]);
  });

  test('a reached:false verdict on an infra failure is ungraded', () => {
    expect(gradeReach({ success: false, activity_id: 'arm', tags: ['reached:false'], failure_mode: fm('HTTP 429 Too Many Requests') })).toBe('ungraded');
  });

  test('posteriorGrade grades nothing: not by the failure arm, not by the ungraded-failure arm', () => {
    const untagged = posteriorGrade({ success: false, activity_id: 'arm', tasks: null, failure_mode: fm('HTTP 402 Payment Required') as never });
    expect({ graded: untagged.graded, failedByTask: untagged.failedByTask, infra: untagged.infraFailure }).toEqual({ graded: false, failedByTask: false, infra: true });
    const child = posteriorGrade({ success: false, activity_id: 'arm', tags: ['dispatcher_used:goal-host'], tasks: [{ success: false }], failure_mode: fm('Unable to connect. Is the computer able to access the url?') as never });
    expect({ graded: child.graded, failedByTask: child.failedByTask }).toEqual({ graded: false, failedByTask: false });
  });
});

describe('CONTROL — an arm fault keeps its blame', () => {
  test('arm-fault reasons are not environmental, and the failure stays not-reached with beta 1', () => {
    for (const r of ARM_FAULTS) {
      expect([r, isEnvironmentalFailureReason(r)]).toEqual([r, false]);
      expect([r, gradeReach({ success: false, activity_id: 'arm', failure_mode: fm(r) })]).toEqual([r, 'not-reached']);
      expect([r, computeDeltas(false, fm(r) as never, [])]).toEqual([r, { alphaDelta: 0, betaDelta: 1 }]);
    }
  });

  test('no failure_mode (absent, null, or a bare string): an untagged failure is still not-reached', () => {
    expect(gradeReach({ success: false, activity_id: 'arm' })).toBe('not-reached');
    expect(gradeReach({ success: false, activity_id: 'arm', failure_mode: null })).toBe('not-reached');
    expect(gradeReach({ success: false, activity_id: 'arm', failure_mode: 'HTTP 429' })).toBe('not-reached');
  });

  test('reached:true is still reached, whatever the failure_mode says', () => {
    expect(gradeReach({ success: false, activity_id: 'arm', tags: ['reached:true'], failure_mode: fm('HTTP 429') })).toBe('reached');
  });

  test('only an execution_error is intercepted: a verifier_negative quoting a 429 keeps its verdict', () => {
    expect(gradeReach({ success: false, activity_id: 'arm', failure_mode: { type: 'verifier_negative', reason: 'HTTP 429 in the output' } })).toBe('not-reached');
  });
});
