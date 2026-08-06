export type ReachVerdict = 'reached' | 'not-reached' | 'ungraded';

/** Structural satisfier satellite — a walk artifact, not a graded outcome. */
export function isHollowSatellite(t: { execution_id?: string; activity_id?: string }): boolean {
  return (
    (typeof t.execution_id === 'string' && t.execution_id.startsWith('walk-satisfier-')) ||
    (typeof t.activity_id === 'string' && t.activity_id.startsWith('satisfier:'))
  );
}

/**
 * The ONE honest-reach primitive shared by the ribosome (extract-or-not) and the
 * posterior (credit / penalize / skip).
 *
 *   reached     -> credit (alpha)    tags include 'reached:true'
 *   not-reached -> penalize (beta)   tags include 'reached:false', OR the run FAILED
 *   ungraded    -> SKIP              no reach tag yet, or a structural satellite
 *
 * THE ASYMMETRY IS DELIBERATE. Exiting cleanly is not evidence a goal was reached —
 * that is precisely the signal `reached` exists to replace — so an untagged success is
 * `ungraded`. Exiting with a failure IS evidence: the thing did not work, whatever the
 * goal was. Success needs a verdict; failure speaks for itself.
 *
 * This branch used to fail OPEN, returning a `legacy-success` verdict that
 * `posterior-update.ts` and the ribosome both counted as a success. It was documented as
 * covering "pre-reach-tag rows", and that rationale did not survive measurement: over a
 * 2,000-row window of the live hub, `legacy-success` was **38.0% of all executions and
 * 100% of those rows were minted the same day** — current traffic, not legacy. The
 * genuinely graded slice was 0.6% `reached` and 1.9% `not-reached`. Its top consumers
 * were machinery ticks (`gap-to-scenario-bridge-tick`, `validator-dispatch`,
 * `mitosis-tick`), dispatched by light-dispatch, which never call POST /reach at all.
 *
 * And it did worse than inflate: it BLOCKED the honest verdict. POST /reach grades a row
 * only when its pre-verdict is `ungraded` (guarding against double-counting the insert
 * path). A `legacy-success` pre-verdict therefore made a late, truthful `reached:false`
 * land as "skipped; insert path already graded this trace" — a walk that honestly
 * reported failure could not penalize a template that had exited zero. Returning
 * `ungraded` here is what lets the reach gate be the sole grading authority it was
 * built to be.
 *
 * `legacy-success` is REMOVED from the union rather than left unreachable, so it cannot
 * be quietly reintroduced at a call site later.
 */
export function classifyReach(t: {
  success: boolean;
  execution_id?: string;
  activity_id?: string;
  tags?: string[];
}): ReachVerdict {
  const tags = t.tags ?? [];
  if (tags.includes('reached:true')) return 'reached';
  if (tags.includes('reached:false')) return 'not-reached';
  if (isHollowSatellite(t)) return 'ungraded';
  // A goal-host walk with no reach tag is AWAITING its verdict — ungraded in BOTH
  // directions. This branch must stay ahead of the failure arm below: dropping it
  // reintroduces the same blocking bug with the sign flipped, β-penalizing a walk at
  // insert time and then making POST /reach discard the real verdict as already-graded.
  // Measured on the same 2,000-row window: removing it moved 4.4% of rows into β.
  if (tags.includes('dispatcher_used:goal-host')) return 'ungraded';
  // No reach tag and no pending verdict. A failure is self-evidencing; a success is
  // merely unobserved.
  return t.success ? 'ungraded' : 'not-reached';
}
