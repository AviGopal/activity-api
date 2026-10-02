/**
 * CHECK-FIRST (slice Y, step Y1a): a failure carries a CLASS and a STEP, computed in code.
 *
 * Today `failure_mode.type` has three live values and a HOLLOW verdict, an unregistered
 * resolver and a refused connection all record as `execution_error`; the distinguishing
 * fact lives only in `reason` prose that no detector parses. This module is the single
 * classifier the store applies at write time (insert path and the late /reach verdict),
 * so every reader keys on one closed vocabulary instead of re-parsing prose.
 *
 * `type` is NOT changed by classification: posterior-update maps `type` to beta, and
 * law 12 (change one thing) keeps learning untouched by this step.
 *
 * Every reason string below is copied from the live `execution` table (2026-10-02).
 */
import { describe, expect, test } from 'bun:test';
import { failureClassOf, FAILURE_CLASSES } from './failure-class';

describe('failureClassOf — class from the reason, closed vocabulary', () => {
  test('a deterministic verdict keeps its own token as the class', () => {
    const r = failureClassOf({ type: 'execution_error', reason: 'deterministic:edit-intent-no-landed-edit — an edit goal is reached only by an edit-result shape WITH landing evidence' });
    expect(r.class).toBe('deterministic:edit-intent-no-landed-edit');
  });

  test('a fetch that never left the process is transport, not a verdict', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'fetch() URL is invalid' }).class).toBe('transport');
    expect(failureClassOf({ type: 'execution_error', reason: 'dev-vessel http_fetch HTTP 500: {"success":false,"error":"fetch failed: Unable to connect. Is the computer able to access the url?"}' }).class).toBe('transport');
    expect(failureClassOf({ type: 'execution_error', reason: 'dev-vessel failureCountReport resolver returned structuredError (status=n/a): Fetch failed: The operation timed out.' }).class).toBe('transport');
  });

  test('an unregistered resolver is structural, distinct from transport', () => {
    expect(failureClassOf({ type: 'execution_error', reason: "Resolver 'learned-auto-bridge-problem-detection-1r2k9x' is not registered" }).class).toBe('structural:not-registered');
    expect(failureClassOf({ type: 'cascading', reason: 'no vessel advertises resolver cyclic_flow_scan' }).class).toBe('structural:not-registered');
  });

  test('a missing producer / template is structural:no-producer', () => {
    expect(failureClassOf({ type: 'cascading', reason: 'template_not_found' }).class).toBe('structural:no-producer');
  });

  test('a required input with no impulse is structural:missing-input', () => {
    expect(failureClassOf({ type: 'execution_error', reason: "Compose sub-activity 'activity:⟨auto-bridge-problem_detection⟩' failed: Task 'extract' requires shape 'goal' but no matching impulses were found" }).class).toBe('structural:missing-input');
  });

  test('a binding to a never-produced shape is input_binding', () => {
    expect(failureClassOf({ type: 'execution_error', reason: "Task 'compose-step-2' requires shape 'walk-codeReadResult-3', but terminal/sink shapes are never produced for binding (template-authoring bug)" }).class).toBe('input_binding');
  });

  test('a chain-depth refusal is refused:chain-depth', () => {
    expect(failureClassOf({ type: 'execution_error', reason: "safety_breach: compose dispatch refused — composition chain depth (22) has reached the cap (16). Task 'dispatch_producer' would target 'activity:x'" }).class).toBe('refused:chain-depth');
  });

  test('a degraded-output convergent-validity rejection is degraded_output', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'convergent_validity[degraded]: all 1 output(s) carry metadata.degraded=true — resolver self-reports failure via degraded impulse pattern' }).class).toBe('degraded_output');
  });

  test('an abstention is not a failure verdict', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'abstain: the judge view was cut, nothing graded' }).class).toBe('abstain');
  });

  test("the floor judge's free-text HOLLOW is judged_hollow (metadata.floor)", () => {
    const r = failureClassOf(
      { type: 'execution_error', reason: 'The output fails to provide a verified current health status of the trace store as it lacks retrieval of real-time data.' },
      { metadata: { floor: true } },
    );
    expect(r.class).toBe('judged_hollow');
  });

  test('no reason at all is unreasoned, never a guessed class', () => {
    expect(failureClassOf({ type: 'execution_error' }).class).toBe('unreasoned');
  });

  test('every class returned is in the closed vocabulary (or a deterministic:<token>)', () => {
    const samples = [
      { type: 'execution_error', reason: 'something nobody anticipated' },
      { type: 'verifier_negative', reason: 'validator rejected output' },
      { type: 'execution_error' },
    ];
    for (const s of samples) {
      const c = failureClassOf(s).class;
      expect(FAILURE_CLASSES.has(c) || /^deterministic:[a-z0-9][a-z0-9_-]{1,63}$/.test(c)).toBe(true);
    }
  });

  test('a fabricated deterministic token (spaces, caps, overlong) is not trusted as a class', () => {
    const c = failureClassOf({ type: 'execution_error', reason: 'deterministic:Has Spaces And CAPS — x' }).class;
    expect(c.startsWith('deterministic:')).toBe(false);
  });
});

describe('failureClassOf — step locator', () => {
  test('the first task that did not succeed is the step', () => {
    const r = failureClassOf(
      { type: 'execution_error', reason: 'fetch() URL is invalid' },
      { tasks: [{ task_id: 'read', success: true }, { task_id: 'resolve', success: false }, { task_id: 'write', success: false }] },
    );
    expect(r.step).toBe('resolve');
  });

  test('a cascading failure names its context task when the trace has no tasks', () => {
    const r = failureClassOf({ type: 'cascading', reason: 'no vessel advertises resolver cyclic_flow_scan', context: { task_id: 'scan_cyclic_flow' } });
    expect(r.step).toBe('scan_cyclic_flow');
  });

  test('a floor row with no tasks is located at the floor, not "zero"', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'x' }, { metadata: { floor: true } }).step).toBe('floor');
  });

  test('a walk row with no tasks is located at the walk', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'x' }, { tasks: [] }).step).toBe('walk');
  });

  test('all tasks succeeded but the run failed: the failure is after the tasks (the verdict)', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'deterministic:artifact-not-written — x' }, { tasks: [{ task_id: 'a', success: true }] }).step).toBe('post_tasks');
  });
});

describe('failureClassOf — type is never rewritten (law 12: beta reads type)', () => {
  test('the returned object carries no type field to merge over failure_mode.type', () => {
    const r = failureClassOf({ type: 'cascading', reason: 'template_not_found' }) as Record<string, unknown>;
    expect('type' in r).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['class', 'step']);
  });
});
