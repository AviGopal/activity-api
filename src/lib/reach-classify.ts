export type ReachVerdict = 'reached' | 'not-reached' | 'ungraded' | 'legacy-success';

/** Structural satisfier satellite — a walk artifact, not a graded outcome. */
export function isHollowSatellite(t: { execution_id?: string; activity_id?: string }): boolean {
  return (
    (typeof t.execution_id === 'string' && t.execution_id.startsWith('walk-satisfier-')) ||
    (typeof t.activity_id === 'string' && t.activity_id.startsWith('satisfier:'))
  );
}

/**
 * The ONE honest-reach primitive shared by the ribosome (extract-or-not) and the
 * posterior (credit / penalize / skip). Order mirrors the reach verdict's authority:
 * explicit tag -> structural satellite -> goal-host provenance (walk-emitted but
 * ungraded == unknown) -> fail-open on legacy success.
 *
 *   reached        -> credit (alpha)      tags include 'reached:true'
 *   not-reached    -> penalize (beta)     tags include 'reached:false', OR legacy fail
 *   ungraded       -> SKIP                satellite, OR goal-host with no reach tag
 *   legacy-success -> credit (fail-open)  no tags, success=true (pre-reach-tag rows)
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
  if (tags.includes('dispatcher_used:goal-host')) return 'ungraded';
  return t.success ? 'legacy-success' : 'not-reached';
}
