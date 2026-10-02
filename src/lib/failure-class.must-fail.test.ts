/**
 * Must-fail probes from review (qa15), kept as tests: each was mis-classified by the first cut.
 */
import { describe, expect, test } from 'bun:test';
import { failureClassOf, isFailureClass } from './failure-class';
import { isVerdictToken, verdictTokenOfReason } from './verdict-token';

const floor = { metadata: { floor: true } };

describe('failureClassOf — the floor judge is judged_hollow even when its prose quotes an error', () => {
  test('floor prose quoting "not registered" / "fetch failed" / "no producer" stays judged_hollow', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'The output says the resolver is not registered and gives no answer.' }, floor).class).toBe('judged_hollow');
    expect(failureClassOf({ type: 'execution_error', reason: 'Output only reports that fetch failed; no health status.' }, floor).class).toBe('judged_hollow');
    expect(failureClassOf({ type: 'execution_error', reason: 'There is no producer evidence cited in the answer.' }, floor).class).toBe('judged_hollow');
  });
  test('a HOLLOW-headed verdict that mentions a timeout is judged_hollow, not transport', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'HOLLOW: the answer says the operation timed out' }).class).toBe('judged_hollow');
  });
  test('a floor row still keeps a canonical deterministic token', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'deterministic:transform-mismatch — x' }, floor).class).toBe('deterministic:transform-mismatch');
  });
});

describe('failureClassOf — type maps to a class only for the six typed variants', () => {
  test('a type naming a non-variant class is not trusted', () => {
    expect(failureClassOf({ type: 'transport', reason: 'weird' }).class).toBe('unclassified');
    expect(failureClassOf({ type: 'judged_hollow', reason: 'weird' }).class).toBe('unclassified');
    expect(failureClassOf({ type: 'unreasoned', reason: 'weird' }).class).toBe('unclassified');
  });
  test('the six typed variants still map', () => {
    for (const t of ['verifier_negative', 'budget_exhausted', 'safety_breach', 'cascading', 'user_abort', 'prediction_disagreement']) {
      expect(failureClassOf({ type: t, reason: 'weird' }).class).toBe(t);
    }
  });
});

describe('failureClassOf — a stamped token is always one the filer accepts (shared verdict-token rule)', () => {
  test('a token with a date or an epoch is not trusted', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'deterministic:stale-2026-10-01 — x' }).class).toBe('unclassified');
    expect(failureClassOf({ type: 'execution_error', reason: 'deterministic:run-1759363200 x' }).class).toBe('unclassified');
  });
  test('deterministic:foo.bar is refused whole, never cut to foo', () => {
    expect(failureClassOf({ type: 'execution_error', reason: 'deterministic:foo.bar — x' }).class).not.toBe('deterministic:foo');
    expect(verdictTokenOfReason('deterministic:foo.bar — x')).toBeNull();
    expect(verdictTokenOfReason('deterministic:foo:bar')).toBeNull();
  });
  test('a double hyphen is not canonical', () => {
    expect(isFailureClass('deterministic:foo--bar')).toBe(false);
    expect(isVerdictToken('foo--bar')).toBe(false);
  });
  test('ordinary tokens are unchanged', () => {
    expect(verdictTokenOfReason('deterministic:edit-intent-no-landed-edit — x')).toBe('edit-intent-no-landed-edit');
    expect(verdictTokenOfReason('deterministic:artifact-not-written')).toBe('artifact-not-written');
    expect(verdictTokenOfReason('deterministic:early-edit-intent-landed (abc)')).toBe('early-edit-intent-landed');
  });
});

describe('failureClassOf — underscore tokens goal-host emits on reached:false are trusted (qa17)', () => {
  test('hollow_walklog_capped and the *_lines/grep_files mismatch tokens keep their class', () => {
    for (const t of ['hollow_walklog_capped', 'grep_files-mismatch', 'avg_lines-mismatch', 'total_lines-mismatch']) {
      expect(failureClassOf({ type: 'execution_error', reason: `deterministic:${t} — x` }).class).toBe(`deterministic:${t}`);
      expect(isVerdictToken(t)).toBe(true);
    }
  });
  test('an underscore at either end is still not canonical', () => {
    expect(isVerdictToken('_x')).toBe(false);
    expect(isVerdictToken('x_')).toBe(false);
  });
});
