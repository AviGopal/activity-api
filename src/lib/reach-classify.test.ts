import { describe, expect, it } from 'bun:test';

import { classifyReach, isHollowSatellite, stripSatelliteReachTags } from './reach-classify';

/**
 * This primitive decides whether an execution moves a Thompson posterior and whether the
 * ribosome may extract it. Every claim the system makes about what it has learned is
 * downstream of these six lines, so the branches are pinned rather than trusted.
 */
describe('classifyReach', () => {
  it('grades an explicit reach tag, in both directions', () => {
    expect(classifyReach({ success: false, tags: ['reached:true'] })).toBe('reached');
    expect(classifyReach({ success: true, tags: ['reached:false'] })).toBe('not-reached');
  });

  it('lets the reach tag OVERRIDE exit status, which is the whole point of the gate', () => {
    // A satisfier reach (status failed + reached true) and a hollow completion
    // (status success + reached false) are both common on the live path.
    expect(classifyReach({ success: false, tags: ['reached:true'] })).toBe('reached');
    expect(classifyReach({ success: true, tags: ['reached:false'] })).toBe('not-reached');
  });

  it('THE FIX: an untagged success is ungraded, never credited', () => {
    // Was `legacy-success` => full alpha. Measured on the live hub: 38.0% of a 2,000-row
    // window, 100% of it minted the same day, so the "pre-reach-tag legacy rows"
    // rationale was false. Top consumers were machinery ticks that never call /reach.
    expect(classifyReach({ success: true, tags: [] })).toBe('ungraded');
    expect(classifyReach({ success: true })).toBe('ungraded');
    expect(classifyReach({ success: true, tags: ['dispatcher_used:light-dispatch'] })).toBe('ungraded');
  });

  it('THE ASYMMETRY: an untagged FAILURE still penalizes', () => {
    // Exiting cleanly is not evidence of reaching; exiting with a failure is evidence the
    // thing did not work, whatever the goal was. Dropping this arm too would leave the
    // learner with no negative signal at all outside explicitly graded walks.
    expect(classifyReach({ success: false, tags: [] })).toBe('not-reached');
    expect(classifyReach({ success: false, tags: ['dispatcher_used:light-dispatch'] })).toBe('not-reached');
  });

  it('UNBLOCKS THE LATE VERDICT: an untagged success must be gradable by POST /reach', () => {
    // /reach grades a row only when its pre-verdict is 'ungraded' (the guard against
    // double-counting the insert path). While this returned 'legacy-success', an honest
    // late `reached:false` was discarded as "insert path already graded this trace" — a
    // walk that truthfully reported failure could not penalize a template that exited 0.
    const preTags: string[] = ['dispatcher_used:light-dispatch'];
    expect(classifyReach({ success: true, tags: preTags })).toBe('ungraded');
    // ...and once the verdict is appended, it grades as the walk reported.
    expect(classifyReach({ success: true, tags: [...preTags, 'reached:false'] })).toBe('not-reached');
  });

  it('never grades a structural satisfier satellite', () => {
    // Satellites carry ~37% of executions; crediting them would swamp every real signal.
    expect(classifyReach({ success: true, execution_id: 'walk-satisfier-2-1786050294875' })).toBe('ungraded');
    expect(classifyReach({ success: true, activity_id: 'satisfier:memoryNote_write' })).toBe('ungraded');
    expect(classifyReach({ success: false, activity_id: 'satisfier:shellResult' })).toBe('ungraded');
  });

  it('still lets an explicit tag outrank the satellite check, as /reach relies on', () => {
    // /reach guards satellites itself, BEFORE appending a tag, precisely because the tag
    // branch is tested first here. Pin that ordering so the guard stays necessary.
    expect(classifyReach({ success: true, activity_id: 'satisfier:x', tags: ['reached:true'] })).toBe('reached');
  });

  it('STRIPS a rode-along verdict from a satellite at the insert boundary', () => {
    // The complement of the test above. That ordering is only safe while the ONLY way a
    // satellite acquires a reach tag is POST /reach, which guards them. It wasn't: a
    // walk hands its own tag set to every satisfier sub-trace it emits, so satellites
    // arrived pre-tagged and classified 'reached' on their own account — 475 of 694
    // 'reached' rows in a 24h exhaustive census (n=41,600), 68.4%, with a null `reached`
    // COLUMN proving no gate ever issued the verdict.
    const walkTags = ['state_signature:b728569f', 'dispatcher_used:goal-host', 'reached:true'];
    expect(stripSatelliteReachTags(walkTags, { execution_id: 'walk-satisfier-1-1786182238304' }))
      .toEqual(['state_signature:b728569f', 'dispatcher_used:goal-host']);
    expect(stripSatelliteReachTags(walkTags, { activity_id: 'satisfier:shellResult' }))
      .toEqual(['state_signature:b728569f', 'dispatcher_used:goal-host']);
    // reached:false rides along the same way and is equally not the satellite's own.
    expect(stripSatelliteReachTags(['reached:false', 'operator:human-surface'], { activity_id: 'satisfier:llm_completion' }))
      .toEqual(['operator:human-surface']);
    // A real execution keeps its verdict untouched.
    expect(stripSatelliteReachTags(walkTags, { execution_id: 'exec_002cxza0', activity_id: 'feature_compose' }))
      .toEqual(walkTags);
    // And the stripped satellite now classifies as the gate always intended.
    expect(classifyReach({
      success: true,
      execution_id: 'walk-satisfier-1-1786182238304',
      tags: stripSatelliteReachTags(walkTags, { execution_id: 'walk-satisfier-1-1786182238304' }),
    })).toBe('ungraded');
  });

  it('treats a goal-host walk with no verdict yet as ungraded, not as a success', () => {
    expect(classifyReach({ success: true, tags: ['dispatcher_used:goal-host'] })).toBe('ungraded');
  });

  it('REGRESSION: a FAILED goal-host walk awaiting its verdict is ungraded, not beta', () => {
    // Caught by re-measuring the corpus after the fix, not by reading it: dropping the
    // goal-host branch reintroduces the blocking bug with the sign flipped — the walk is
    // penalized at insert, and POST /reach then discards the real verdict because the
    // pre-verdict is no longer 'ungraded'. It moved 4.4% of a 2,000-row window into beta.
    expect(classifyReach({ success: false, tags: ['dispatcher_used:goal-host'] })).toBe('ungraded');
    // The verdict, when it lands, still governs.
    expect(classifyReach({ success: false, tags: ['dispatcher_used:goal-host', 'reached:false'] })).toBe('not-reached');
    expect(classifyReach({ success: false, tags: ['dispatcher_used:goal-host', 'reached:true'] })).toBe('reached');
  });
});

describe('isHollowSatellite', () => {
  it('matches on either the execution id or the activity id', () => {
    expect(isHollowSatellite({ execution_id: 'walk-satisfier-1-123' })).toBe(true);
    expect(isHollowSatellite({ activity_id: 'satisfier:shellResult' })).toBe(true);
    expect(isHollowSatellite({ execution_id: 'exec_2b9e42a8', activity_id: 'development-vessel:mitosis-tick' })).toBe(false);
    expect(isHollowSatellite({})).toBe(false);
  });
});
