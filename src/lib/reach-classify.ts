export type ReachVerdict = 'reached' | 'not-reached' | 'ungraded';

/** Structural satisfier satellite — a walk artifact, not a graded outcome. */
export function isHollowSatellite(t: { execution_id?: string; activity_id?: string }): boolean {
  return (
    (typeof t.execution_id === 'string' && t.execution_id.startsWith('walk-satisfier-')) ||
    (typeof t.activity_id === 'string' && t.activity_id.startsWith('satisfier:'))
  );
}

/**
 * Telemetry / infra probe — an execution that was never attempting a goal, so a
 * goal-level `reached:false` verdict is INAPPLICABLE to it (not evidence it failed).
 * Marked by a `telemetry:` tag (e.g. an identity-vessel auth resolve). Like a hollow
 * satellite, such a run must be neither credited nor blamed.
 *
 * Why this exists: `auth_resolve_v1` — the sole `telemetry:` emitter — ran hundreds of
 * thousands of times, every one `success:true` but stamped `reached:false` (reach is
 * meaningless for an auth sub-step), and every one was read as a genuine not-reached
 * failure. Its posterior collapsed to alpha=1 (FROZEN) / beta≈4e5 and CLIMBING ~1.9/min,
 * pure blame with zero credit ever. Abstaining is the conservative side of the reach
 * gate's own asymmetry: a false rejection is worse than a false reach.
 */
export function isReachInapplicable(t: { tags?: string[] }): boolean {
  return (t.tags ?? []).some((tag) => typeof tag === 'string' && 
    (tag.startsWith('telemetry:') || (tag.startsWith('declined:') && tag.length > 'declined:'.length)) );
}

/**
 * A reach verdict RETRACTED by a recorded correction (lib/reach-correction.ts): the row carries
 * `reach_retracted:<list_sha>`, naming the frozen list whose provenance (rule, commit) says the latched
 * `reached:false` was produced by a wrong grading rule. The verdict is withdrawn, not reversed: the
 * per-task shapes a fresh verdict would need were never stored, so the row can only go back to ungraded.
 */
export const REACH_RETRACTED_PREFIX = 'reach_retracted:';

/**
 * The trace insert GRADED this execution (POST /execution-traces stamps it in the authoritative write when
 * posteriorGrade says the insert hands a verdict to the posterior). POST /reach grades nothing for a row carrying it:
 * one execution, one grading writer. Not a verdict itself, and not read by classifyReach.
 */
export const INSERT_GRADED_TAG = 'insert_graded:true';

/**
 * A row AWAITING its late reach verdict, as the trace insert can state it: tagged dispatcher_used:goal-host, no reach
 * tag, not a satellite, and TOP-LEVEL (no parent execution, no composition chain). The executor's own top-level rule
 * (`!parentExecutionId && compositionChain.length === 0`) is what makes it the run a goal-host dispatch record names
 * and POST /reach grades; a lifecycle subscriber inherits the parent's tags but always carries the parent, so it is
 * never awaiting and keeps the ungraded-failure arm's blame.
 */
export function isAwaitingVerdict(t: { execution_id?: string; activity_id?: string; tags?: string[]; parent_execution_id?: unknown; composition_chain?: unknown }): boolean {
  const tags = t.tags ?? [];
  if (!tags.includes('dispatcher_used:goal-host') || tags.includes('reached:true') || tags.includes('reached:false')) return false;
  if (isHollowSatellite(t)) return false;
  const hasParent = typeof t.parent_execution_id === 'string' && t.parent_execution_id.length > 0;
  const hasChain = Array.isArray(t.composition_chain) && t.composition_chain.length > 0;
  return !hasParent && !hasChain;
}
export function isReachRetracted(t: { tags?: string[] }): boolean {
  return (t.tags ?? []).some((tag) => typeof tag === 'string' && tag.startsWith(REACH_RETRACTED_PREFIX) && tag.length > REACH_RETRACTED_PREFIX.length);
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
/**
 * AN OBSERVE EXECUTION IS NEVER GRADED. goal-host's observe dispatch (learning_mode "observe": a probe, a held-out
 * measurement) tags its traces learning_mode:observe, and POST /reach / POST / stamp reach_observe:true on a row they
 * recorded as observe. Such a row's verdict is a measurement, not a lesson: classifyReach answers 'ungraded' for it
 * AHEAD of its reached:* tag, so the readers of THIS gate (posterior credit via applyOutcomeToPosteriors, the
 * shape-score counter and its seed, this repo's ribosome route) learn nothing from it.
 *
 * NOT every reader goes through classifyReach. Readers that count straight from the stored columns bind
 * OBSERVE_TRACE_TAGS in their own query instead: trace-aggregate-report (failure-class counts) and
 * grouped-execution-stats (reached / graded counts). The ribosome-vessel reads the reached column/tag directly; it is
 * protected only because POST / does not broadcast execution_completed for an observe row.
 */
/** The tags that mark an observe execution (read by isObserveTrace, and bound by the SQL readers that cannot call it). */
export const OBSERVE_TRACE_TAGS: readonly string[] = ['learning_mode:observe', 'reach_observe:true'];
export function isObserveTrace(t: { tags?: string[] }): boolean {
  const tags = t.tags ?? [];
  return OBSERVE_TRACE_TAGS.some((x) => tags.includes(x));
}
let observeSkips = 0;
/** Count one observe execution or verdict a learning writer skipped; returns the running count. */
export function noteObserveSkip(): number { return ++observeSkips; }
/** Observe executions and verdicts skipped by a learning writer since process start. */
export function observeSkipCount(): number { return observeSkips; }

export function classifyReach(t: {
  success: boolean;
  execution_id?: string;
  activity_id?: string;
  tags?: string[];
}): ReachVerdict {
  const tags = t.tags ?? [];
  if (isObserveTrace(t)) return 'ungraded';
  if (tags.includes('reached:true')) return 'reached';
  // A RETRACTED verdict is no verdict: ahead of the not-reached arm (the latched `reached:false` tag stays on
  // the row, since tags are only ever unioned) and ahead of the failure arm, so the row reads ungraded. Only
  // a `success:true` row is ever retracted (reach-correction.ts refuses a failed one: failure speaks for itself).
  if (isReachRetracted(t)) return 'ungraded';
  // A telemetry/infra probe's or declined execution's `reached:false` is INAPPLICABLE, not a failure verdict —
  // intercept it here, ahead of the not-reached arm, so infra sub-steps (auth resolves) and principled declines
  // are ungraded {0,0} rather than β-penalized. Placed after `reached:true` so a genuine
  // reach is still honored; only the false-blame path is diverted.
  if (isReachInapplicable(t)) return 'ungraded';
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
