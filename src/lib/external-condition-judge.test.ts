/**
 * THE EXTERNAL-CONDITION JUDGE, as pure functions of the closed module (posterior-update.ts).
 *
 * environment-failure-classifier-misses-aborted-and-socket-closed-so-outages-blame-arms (FOLD: the external-condition
 * record) and traces-recorded-during-a-hub-outage-replay-later-as-arm-blame-because-the-learner-cannot-see-the-outage.
 * The TRUST RULE (user ruling, verbatim): a condition moves blame only to "unattributed (environment)", never to success;
 * never overrides a red check or a revert; unconfirmed → REVIEW; holder/reporter stamped from the credential.
 *
 *   MUST-FAIL: a confirmed, attested record covering the failure is unattributed, holder from attested.key_id; an
 *     unconfirmed one, estimated times, an unknown up, a missing or prose evidence, a missing source and a rule that is
 *     not verbatim are each REVIEW; a record whose only holder / source is in its body is REFUSED; a red check (and a
 *     success) is never eligible; the judged time is the trace's own recorded_at, bounded by arrival.
 *   CONTROL: a window that does not cover the node, the unit or the time is no_match; an execution_error and a failure
 *     with no failure_mode are eligible; a pointer is accepted in URI and path form.
 *
 * Fixture node / unit names are placeholders.
 */
import { describe, expect, test } from 'bun:test';

process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

// New names: absent on the parent, so each must-fail falls back to a stand-in that fails on its assertion, not on import.
const PU = (await import('./posterior-update')) as Record<string, any>;
const missing = () => { throw new Error('absent on the parent'); };
const judge: (row: unknown, ctx: unknown) => any = PU.judgeExternalCondition ?? missing;
const eligible: (s: boolean, fm: unknown, d: unknown) => boolean = PU.conditionEligible ?? missing;
const timeAt: (r: unknown, now: number) => number = PU.conditionTimeMs ?? missing;
const pointer: (v: unknown) => boolean = PU.isEvidencePointer ?? missing;
const RULE: string = PU.CONDITION_ATTRIBUTION_RULE ?? 'absent';

const DOWN = '2026-10-21T23:42:23Z';
const UP = '2026-10-21T23:46:57Z';
const INSIDE = Date.parse('2026-10-21T23:44:00Z');
const ctx = (over: Record<string, unknown> = {}) => ({ node: 'node-a', vessels: ['vessel-x'], atMs: INSIDE, ...over });
const body = (over: Record<string, unknown> = {}) => ({
  kind: 'POWER-LOSS host reboot', node: 'node-a', unit: 'ALL', down: DOWN, up: UP, times: 'observed',
  source: { observer: 'research', method: 'journal read of every unit' }, evidence: 'file:infra-events.json#events[12]',
  attribution_rule: RULE, confirmed: true, ...over,
});
const row = (b: Record<string, unknown> = body(), over: Record<string, unknown> = {}) => ({
  id: 'cond-1', shape: 'externalCondition', status: 'open', source: 'operator', body: b,
  attested: { by: 'operator', key_id: 'key_cred1', at: DOWN, sig: 'x' }, attested_verified: true, ...over,
});

describe('MUST-FAIL — a confirmed record moves the failure to unattributed (environment), holder from the credential', () => {
  test('an attested, confirmed, observed record covering the failure is unattributed', () => {
    expect(judge(row(), ctx())).toEqual({ verdict: 'unattributed', record_id: 'cond-1', holder: 'key_cred1', kind: 'POWER-LOSS host reboot', unit: 'ALL' });
  });

  test('the holder is the attestation key id, never a body-supplied holder or reporter', () => {
    const v = judge(row(body({ holder: 'someone-else', reporter: 'someone-else' })), ctx());
    expect(v.verdict).toBe('unattributed');
    expect(v.holder).toBe('key_cred1');
  });

  test('a unit-scoped record covers a trace naming that vessel', () => {
    expect(judge(row(body({ unit: 'vessel-x' })), ctx()).verdict).toBe('unattributed');
  });
});

describe('MUST-FAIL — unconfirmed → REVIEW', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['not confirmed', { confirmed: false }],
    ['confirmed absent', { confirmed: undefined }],
    ['estimated times', { times: 'estimated' }],
    ['inferred times', { times: 'inferred' }],
    ['up unknown (open-ended window)', { up: undefined }],
    ['no evidence pointer', { evidence: undefined }],
    ['prose evidence', { evidence: 'the journal shows the unit died' }],
    ['a bare word is not a pointer', { evidence: 'journal' }],
    ['no source', { source: undefined }],
    ['source without a method', { source: { observer: 'research' } }],
    ['rule not verbatim', { attribution_rule: 'conditions move blame' }],
  ];
  for (const [name, over] of cases) {
    test(name, () => {
      const v = judge(row(body(over)), ctx());
      expect([name, v.verdict]).toEqual([name, 'review']);
      expect(v.record_id).toBe('cond-1');
    });
  }

  test('an attestation carrying no key id is REVIEW (the holder is not stamped from a credential)', () => {
    expect(judge(row(body(), { attested: { by: 'operator', key_id: null, at: DOWN } }), ctx()).verdict).toBe('review');
  });
});

describe('MUST-FAIL — the credential, never the body: an unattested record is refused', () => {
  test('a body-supplied holder and source with no attestation is refused', () => {
    const v = judge(row(body({ holder: 'operator', source: { observer: 'operator', method: 'said so' } }), { attested: undefined, attested_verified: undefined }), ctx());
    expect(v.verdict).toBe('refused');
  });

  test('an attestation development-vessel did not verify is refused', () => {
    expect(judge(row(body(), { attested_verified: false }), ctx()).verdict).toBe('refused');
  });

  test('an attestation by anyone but an operator is refused', () => {
    expect(judge(row(body(), { attested: { by: 'evaluator', key_id: 'k', at: DOWN }, attested_verified: true }), ctx()).verdict).toBe('refused');
  });

  test('a row of another shape, or a retired one, is refused', () => {
    expect(judge(row(body(), { shape: 'operatorHold' }), ctx()).verdict).toBe('refused');
    expect(judge(row(body(), { status: 'retired' }), ctx()).verdict).toBe('refused');
  });

  test('a malformed window (no down, up before down) is refused', () => {
    expect(judge(row(body({ down: 'yesterday' })), ctx()).verdict).toBe('refused');
    expect(judge(row(body({ up: '2026-10-21T23:00:00Z' })), ctx()).verdict).toBe('refused');
  });
});

describe('MUST-FAIL — never a red check, never success', () => {
  const d = (alphaDelta: number, betaDelta: number) => ({ alphaDelta, betaDelta });
  test('a verifier_negative, a safety_breach, a prediction_disagreement and a budget_exhausted are not eligible', () => {
    for (const type of ['verifier_negative', 'safety_breach', 'prediction_disagreement', 'budget_exhausted']) {
      expect([type, eligible(false, { type }, d(0, 1))]).toEqual([type, false]);
    }
  });

  test('a success (any alpha) is not eligible, even with beta from the graded yield', () => {
    expect(eligible(true, null, d(0.75, 0.25))).toBe(false);
    expect(eligible(false, null, d(0.75, 0.25))).toBe(false);
  });

  test('a zero delta is not eligible (nothing to withhold)', () => {
    expect(eligible(false, { type: 'execution_error', reason: 'x' }, d(0, 0))).toBe(false);
  });
});

describe('MUST-FAIL — the judged time is the trace\'s own, bounded by arrival', () => {
  const NOW = Date.parse('2026-10-22T03:00:00Z');
  test('a replayed trace is judged at its recorded_at', () => {
    expect(timeAt('2026-10-21T23:44:00Z', NOW)).toBe(INSIDE);
  });
  test('absent, unparseable or later than arrival reads as arrival', () => {
    expect(timeAt(undefined, NOW)).toBe(NOW);
    expect(timeAt('soon', NOW)).toBe(NOW);
    expect(timeAt('2026-10-23T00:00:00Z', NOW)).toBe(NOW);
  });
});

describe('CONTROL — a window that does not cover the failure, and what is eligible', () => {
  test('another node, another unit, before down or after up is no_match', () => {
    expect(judge(row(), ctx({ node: 'node-b' })).verdict).toBe('no_match');
    expect(judge(row(), ctx({ node: null })).verdict).toBe('no_match');
    expect(judge(row(body({ unit: 'vessel-y' })), ctx()).verdict).toBe('no_match');
    expect(judge(row(body({ unit: 'vessel-y' })), ctx({ vessels: [] })).verdict).toBe('no_match');
    expect(judge(row(), ctx({ atMs: Date.parse(DOWN) - 1 })).verdict).toBe('no_match');
    expect(judge(row(), ctx({ atMs: Date.parse(UP) + 1 })).verdict).toBe('no_match');
  });

  test('the window is inclusive at both ends, with no settle grace', () => {
    expect(judge(row(), ctx({ atMs: Date.parse(DOWN) })).verdict).toBe('unattributed');
    expect(judge(row(), ctx({ atMs: Date.parse(UP) })).verdict).toBe('unattributed');
  });

  test('an execution_error and a failure with no failure_mode are eligible', () => {
    expect(eligible(false, { type: 'execution_error', reason: 'boom' }, { alphaDelta: 0, betaDelta: 1 })).toBe(true);
    expect(eligible(false, null, { alphaDelta: 0, betaDelta: 1 })).toBe(true);
    expect(eligible(false, undefined, { alphaDelta: 0, betaDelta: 1 })).toBe(true);
  });

  test('pointers in URI and path form are accepted, and a list of them', () => {
    expect(pointer('file:infra-events.json#events[12]')).toBe(true);
    expect(pointer('https://example.invalid/run/1')).toBe(true);
    expect(pointer('validation/reports/outage/journal.txt')).toBe(true);
    expect(pointer(['gap:some-row-id', 'exec:exec_123'])).toBe(true);
    expect(pointer([])).toBe(false);
  });
});
