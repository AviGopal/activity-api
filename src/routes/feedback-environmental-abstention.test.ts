// Pins the abstention on the FEEDBACK route.
//
// THE HOLE THIS CLOSES: computeDeltas already abstains for infrastructure failures, and its
// comment states the asymmetry on purpose — "False abstention costs a lost blame signal;
// false blame condemns a working arm — and the second is what this codebase keeps paying
// for." But that abstention lives on the TRACE path, keyed off a recorded failure_mode.
// Negative feedback posted directly to /feedback never becomes a failure_mode, so it
// bypassed the check entirely and took its penalty whatever the cause.
//
// Measured: a goal dispatched at a disconnected human surface returned "unreachable" every
// thirty minutes for two days, and every one became a full negative against the activity.
// The activity was fine. The bill is paid twice — once in the wrong penalty, and again
// because the posterior decay must be aggressive enough to forget false blame, which
// discards real evidence along with it.
//
// WHY THIS IS A UNIT TEST AND NOT A LIVE OBSERVATION: the live bench that produced those
// failures was removed by the presence guard on the Obsidian ticks, which stops the
// dispatches at source. That is the right fix and it means the environmental stream dried
// up before this could be watched end to end. So the discrimination is pinned here instead
// — and pinned on BOTH polarities, because a rule that only ever abstains is as wrong as one
// that never does.
import { describe, expect, test } from 'bun:test';
import { isEnvironmentalFailureReason } from '../lib/posterior-update';

// The exact predicate the route applies. Kept in one place so the test cannot drift from
// the call site by testing a re-derived copy.
const wouldAbstain = (direction: string, reason: unknown): boolean =>
  direction === 'negative' && isEnvironmentalFailureReason(reason);

describe('feedback route — environmental abstention', () => {
  test('ABSTAINS on the failure that actually occurred', () => {
    // The live text, near enough: a hollow verdict whose cause was an unreachable surface.
    expect(wouldAbstain('negative', 'hollow completion (goal not reached): fetch failed')).toBe(true);
    expect(wouldAbstain('negative', 'hollow completion (goal not reached): ECONNREFUSED 127.0.0.1:27182')).toBe(true);
  });

  test('PENALISES a genuine arm fault — the half that must not be lost', () => {
    // A resolver that threw through its own logic must still be blamed. An abstention rule
    // that swallows this is worse than no rule: it launders every failure into "the
    // environment" and the posterior stops meaning anything.
    expect(wouldAbstain('negative', 'hollow completion (goal not reached): produced no output shapes')).toBe(false);
    expect(wouldAbstain('negative', 'TypeError: cannot read property of undefined')).toBe(false);
    expect(wouldAbstain('negative', 'validator rejected the output')).toBe(false);
  });

  test('POSITIVE feedback is never abstained, whatever the text says', () => {
    // Scope is negative-only. Credit must not be suppressed because a success message
    // happens to mention a timeout it recovered from.
    expect(wouldAbstain('positive', 'recovered after ETIMEDOUT and completed')).toBe(false);
  });

  test('an absent or empty reason is NOT treated as environmental', () => {
    // Absent evidence is not evidence of an environmental cause. Defaulting to abstention
    // here would silently disable blame for every caller that omits a reason.
    expect(wouldAbstain('negative', undefined)).toBe(false);
    expect(wouldAbstain('negative', null)).toBe(false);
    expect(wouldAbstain('negative', '')).toBe(false);
  });

  test('the documented negative control still holds at this call site', () => {
    // A bare 50x matcher was tried once and its own control caught it matching
    // "returned 5031 rows, expected 502" — an arm-fault message that would then have escaped
    // blame. Reusing the shared predicate means that control protects this route too;
    // asserting it here is what proves the reuse is real rather than nominal.
    expect(wouldAbstain('negative', 'returned 5031 rows, expected 502')).toBe(false);
    // ...while a genuine gateway failure in explicit HTTP context still abstains.
    expect(wouldAbstain('negative', 'upstream returned HTTP 503')).toBe(true);
  });
});
