/**
 * A CALLER-FAULT OUTCOME NEVER COUNTS TOWARD A TEMPLATE'S RETIREMENT EVIDENCE (check-first).
 *
 * Gap: a-malformed-llm-request-is-graded-as-a-quality-failure-of-whichever-model-arm-was-drawn
 * (qa: caller-fault outcomes never count toward a template's retirement evidence).
 *
 * MEASURED, node 1, 2026-10-03. The walk ran the learned satisfier template for
 * llm_completion_dispatch with no prompt bound. The request was refused before any provider call —
 * a fault of the REQUEST — yet the template was graded failed on every run (~71 executions, 0
 * successes) and walked toward retirement.
 *
 * WHERE RETIREMENT EVIDENCE LIVES. checkAndRetireByPosterior (services/variant-creator.ts), fired
 * from POST /v2/activities/execution-traces on a graded failure, retires on the posterior mean of
 * variant_performance_metrics.thompson_alpha/_beta. Those are written only by
 * applyOutcomeToPosteriors, which skips the variant write when computeDeltas returns {0,0}. So the
 * exclusion belongs in computeDeltas, exactly where the environmental-failure abstention already
 * sits. (checkAndRetireTemplate reads `execution.success` and is inert — no fleet caller posts to its
 * route; documented in variant-creator.ts — so it is not tested here.)
 *
 * THE CARRIER (pinned). development-vessel refuses a prompt-less dispatch with
 * structuredError { failure_mode: "malformed_request" } (development-vessel
 * test/resolvers/llm-completion-dispatch-refuses-a-missing-prompt.test.ts); goal-host's proxy
 * resolver turns that into the thrown task error
 *     dev-vessel <shape> resolver returned structuredError (failure_mode=malformed_request): <detail>
 * which reaches this store as failure_mode { type: "execution_error", reason: <that text> }.
 * The token `malformed_request` in the reason is the caller-fault mark:
 *   - computeDeltas abstains ({0,0}): no alpha, no beta, so no retirement evidence;
 *   - failureClassOf names class `malformed_request` (closed vocabulary) and its step is the
 *     calling task, so the fault is recorded against the step that sent the bad request.
 *
 * SCOPE. Only the caller-fault token abstains. "unbindable required input: <name>" — the walk
 * declining to invoke a producer it could not bind — stays blamed: after the binding gate, a
 * template that still cannot bind a required input carries a broken config of its own.
 */
import { describe, expect, test } from 'bun:test';

// config.ts throws at import without these and posterior-update imports it transitively.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

const { computeDeltas } = await import('./posterior-update');
const { failureClassOf, FAILURE_CLASSES } = await import('./failure-class');

const PROXY_REASON =
  "dev-vessel llm_completion_dispatch resolver returned structuredError (failure_mode=malformed_request): malformed_request: pointer must include a non-empty 'prompt' string";
const w = (): string[] => [];

describe('MUST-FAIL — a caller-fault failure gives no alpha and no beta', () => {
  test('the goal-host proxy carrier (execution_error, failure_mode=malformed_request) abstains', () => {
    expect(computeDeltas(false, { type: 'execution_error', reason: PROXY_REASON } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0 });
  });

  test('the bare dispatcher detail abstains too (same token, no proxy prefix)', () => {
    expect(computeDeltas(false, { type: 'execution_error', reason: "malformed_request: pointer must include a non-empty 'prompt' string" } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0 });
  });
});

describe('MUST-FAIL — the caller fault is classified and attributed to the calling step', () => {
  test('failureClassOf names malformed_request, at the task that sent the request', () => {
    const fc = failureClassOf(
      { type: 'execution_error', reason: PROXY_REASON },
      { tasks: [{ task_id: 'gather', success: true }, { task_id: 'format_answer', success: false }] },
    );
    expect(fc).toEqual({ class: 'malformed_request', step: 'format_answer' });
  });

  test('malformed_request is a member of the closed failure-class vocabulary', () => {
    expect(FAILURE_CLASSES.has('malformed_request')).toBe(true);
  });
});

describe('CONTROL — real failures keep their blame and their class', () => {
  test('a resolver structuredError that is not a caller fault is still blamed (beta 1) and stays resolver_error', () => {
    const reason = 'dev-vessel llm_completion_dispatch resolver returned structuredError (failure_mode=verifier_negative): LLM vessel returned error or resolved=false';
    expect(computeDeltas(false, { type: 'execution_error', reason } as never, w())).toEqual({ alphaDelta: 0, betaDelta: 1 });
    expect(failureClassOf({ type: 'execution_error', reason }, {}).class).toBe('resolver_error');
  });

  test('an unbindable required input is the template\'s own fault: still blamed', () => {
    const reason = 'unbindable required input: prompt (producer llm_completion_dispatch)';
    expect(computeDeltas(false, { type: 'execution_error', reason } as never, w())).toEqual({ alphaDelta: 0, betaDelta: 1 });
  });

  test('an environmental failure still abstains, and a success still credits', () => {
    expect(computeDeltas(false, { type: 'execution_error', reason: 'connect ECONNREFUSED 127.0.0.1:8090' } as never, w()))
      .toEqual({ alphaDelta: 0, betaDelta: 0 });
    expect(computeDeltas(true, null, w())).toEqual({ alphaDelta: 1, betaDelta: 0 });
  });
});
