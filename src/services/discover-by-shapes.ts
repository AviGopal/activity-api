/**
 * Discover-by-shapes shared helper
 *
 * Extracted from `POST /v2/activities/discover-by-shapes` (routes/activities.ts)
 * so the same logic can be reached via the impulse-resolve shape handler
 * (`discoverByShapesQuery` in routes/impulses.ts) without duplicating the SQL or
 * the composition-score augmentation.
 *
 * Architectural note:
 * The vessel-integration constraint says integrating with another vessel MUST
 * NOT require source changes in the integrating vessel. Activity-api advertises
 * the `discoverByShapesQuery` shape; meta-activities call it through the existing
 * generic `impulse-resolve` resolver. Zero minibob changes.
 */
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { transformToLegacyTemplate } from '../db/paradigm';
import { betaSample } from '../routes/activities.scoring';

/**
 * Beta prior on an activity that has NEVER executed.
 *
 * NOT 1. A uniform Beta(1,1) says "an untried activity succeeds half the time", and
 * with ~100 candidates of which 97% are near-prior, the max of those draws sits near
 * 0.99 — so a learned arm can never be exploited. This value is the difference
 * between a learning loop that records evidence and one that can act on it.
 *
 * Simulated at the measured pool size (100 arms), win rate of a learned arm:
 *   beta=1  ->  0.0% (.755 arm) / 21.6% (.95 arm)   <- the defect
 *   beta=2  ->  6.5%            / 88.6%
 *   beta=3  -> 43.0%            / 98.7%             <- chosen
 *   beta=4  -> 76.1%            / 99.9%
 *
 * 3 keeps meaningful exploration (an untried arm draws with mean 0.25 and still wins
 * sometimes across ~100 draws) while letting a genuinely learned arm win more often
 * than not. Raise it to exploit harder; lower it to explore harder. Validate by
 * measuring the share of selections won by arms with >=20 observations, before and
 * after, over days rather than hours.
 */
export const UNTRIED_PRIOR_BETA = 3;

import {
  successorFeaturesEnabled,
  fetchSuccessorFeatureCells,
  successorFeatureCellKey,
  rewardFromCompletionShapes,
  successorValue,
} from '../lib/successor-features';

export type DiscoverByShapesMode = 'forward' | 'backward' | 'candidates_with_scores';

export interface DiscoverByShapesInput {
  required_shapes: string[];
  mode?: DiscoverByShapesMode;
  limit?: number;
  current_shapes?: string[];
  output_shapes?: string[];
  predecessor_activity_id?: string;
  /**
   * Attach composition_score / successor_value WITHOUT changing the query direction.
   *
   * `mode: "candidates_with_scores"` conflates two orthogonal things: it augments the
   * results AND forces queryMode to 'forward'. A caller running a BACKWARD query who wants
   * scores cannot say so — switching the mode silently inverts their query and returns the
   * wrong candidates. That trap is why the walk (which runs both directions) receives no
   * chain-aware signal at all: composition evidence and psi are computed only in a mode it
   * cannot safely request.
   *
   * This flag separates them. Direction stays whatever `mode` says; scoring is opt-in.
   */
  include_scores?: boolean;
  /**
   * Successor-features readout (mechanism #7). When `signature` (the state s)
   * and `completion_shapes` (the goal direction R) are supplied in
   * candidates_with_scores mode, each candidate is augmented with
   * `successor_value` = ⟨ψ(s,a), R⟩ — the transfer value the cell's discounted
   * shape-occupancy directs toward the goal, INDEPENDENT of its Beta reward.
   * Gated behind SUCCESSOR_FEATURES (default ON).
   */
  signature?: string;
  completion_shapes?: string[];
  /** ψ partial-pool scope; defaults to 'org'. */
  sf_scope?: string;
}

export interface DiscoverByShapesValidationError {
  ok: false;
  error: string;
  message: string;
}

export interface DiscoverByShapesResult {
  ok: true;
  activities: any[];
  total: number;
}

/**
 * Validate input fields.
 * Returns null on success or a DiscoverByShapesValidationError describing the failure.
 */
export function validateDiscoverByShapesInput(
  input: DiscoverByShapesInput,
): DiscoverByShapesValidationError | null {
  const { required_shapes, mode = 'forward' } = input;

  if (!required_shapes || !Array.isArray(required_shapes) || required_shapes.length === 0) {
    return {
      ok: false,
      error: 'Validation failed',
      message: 'required_shapes must be a non-empty array',
    };
  }

  if (!['forward', 'backward', 'candidates_with_scores'].includes(mode)) {
    return {
      ok: false,
      error: 'Validation failed',
      message: 'mode must be one of "forward", "backward", or "candidates_with_scores"',
    };
  }

  return null;
}

/**
 * Run the discover-by-shapes query and augment with metrics + composition scores.
 *
 * Caller is responsible for input validation (use `validateDiscoverByShapesInput`).
 * Throws on database errors — caller wraps in HTTP envelope.
 */
export async function runDiscoverByShapes(
  input: DiscoverByShapesInput,
): Promise<DiscoverByShapesResult> {
  const {
    required_shapes,
    mode = 'forward',
    limit = 10,
    current_shapes = [],
    output_shapes = [],
    predecessor_activity_id,
    signature,
    completion_shapes = [],
    sf_scope = 'org',
    include_scores = false,
  } = input;

  // candidates_with_scores treats the query as forward mode (find producers) and augments
  // each result with composition_score. `include_scores` requests the augmentation ALONE,
  // leaving the direction as `mode` states — so a backward query can carry scores without
  // being silently turned into a forward one.
  const queryMode = mode === 'candidates_with_scores' ? 'forward' : mode;

  logger.info('Discovering activities by shapes', {
    required_shapes,
    mode,
    current_shapes,
    limit,
  });

  // 10.S4: Single-statement query with subqueries in the SELECT projection
  // collapses the prior 1 + N + N pattern (21 round-trips for limit=10) into
  // one DB call. SurrealDB evaluates the inline subqueries per parent row
  // using `$parent.id` to scope each correlated lookup. Composition score
  // augmentation is folded in via a conditional subquery — empty predecessor
  // path uses GROUP ALL to roll up edges across all parents of the candidate.
  const isCandidatesMode = mode === 'candidates_with_scores' || include_scores === true;
  const compositionSubquery = isCandidatesMode
    ? predecessor_activity_id
      ? `, (SELECT success_count, execution_count FROM activity_composition_graph
           WHERE parent_activity_id = $predecessor_activity_id
             AND child_activity_id = $parent.id LIMIT 1)[0] AS comp_row`
      : `, (SELECT math::sum(success_count) AS success_count, math::sum(execution_count) AS execution_count
           FROM activity_composition_graph
           WHERE child_activity_id = $parent.id GROUP ALL)[0] AS comp_row`
    : '';

  // Selection-learning admission (Thompson correctness): the query's
  // `ORDER BY ev DESC, created_at DESC` truncation runs BEFORE the per-candidate
  // betaSample draw below. `ev` is ~flat across activity rows, so a bare
  // `LIMIT $limit` degenerates to RECENCY truncation and can cut a learned
  // high-posterior producer before the Thompson draw ever sees it. Admit a
  // bounded superset instead (all viable producers in practice), draw over the
  // whole pool, and slice to `limit` AFTER the sampled_score sort below —
  // sample-then-truncate, the correct order. The CONTAINSANY shape filter scans
  // every matching row regardless of LIMIT, so widening the cap barely changes
  // query cost.
  const ADMISSION_CAP = 200;
  const admissionLimit = Math.max(limit, ADMISSION_CAP);
  const params: Record<string, unknown> = { required_shapes, admission_limit: admissionLimit };
  if (predecessor_activity_id) params.predecessor_activity_id = predecessor_activity_id;

  let whereClause: string;
  if (queryMode === 'forward') {
    whereClause = 'output_shapes CONTAINSANY $required_shapes AND (retired = false OR retired IS NONE)';
  } else {
    const outputFilterClause = output_shapes.length > 0
      ? ' AND output_shapes CONTAINSANY $output_shapes_filter'
      : '';
    whereClause = `input_shapes CONTAINSANY $required_shapes${outputFilterClause} AND (retired = false OR retired IS NONE)`;
    if (current_shapes.length > 0) params.current_shapes = current_shapes;
    if (output_shapes.length > 0) params.output_shapes_filter = output_shapes;
  }

  const query = `
    SELECT id, name, description, category, tasks, scope, org_id, input_shapes, output_shapes, ev, created_at, updated_at${compositionSubquery}
    FROM activity
    WHERE ${whereClause.replace(/AND \(retired = false OR retired IS NONE\)/g, 'AND retired = false')}
    ORDER BY ev DESC, created_at DESC
    LIMIT $admission_limit
  `;

  const activities = await surrealDB.query(query, params);

    const rows = (Array.isArray(activities) ? activities : ((activities as any)?.[0]?.result ?? [])) as Array<Record<string, any>>;
    const idPairs: Array<[string, string]> = rows.map((r) => {
      const orig = String(r.id ?? '');
      const plain = orig.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');
      return [plain, orig];
    });
    const activityIds = Array.from(new Set(idPairs.map(([p]) => p).concat(idPairs.map(([, o]) => o))));
    const scoreMap = new Map<string, Record<string, any>>();
    // The computed view only covers executions written since the paradigm
    // dual-write began; the legacy variant_performance_metrics table carries
    // the full history. Query the view first, then FILL the ids it missed
    // from the legacy table (empty view result is normal, not an error).
    const addScoreRows = (list: Array<Record<string, any>>): void => {
      for (const sr of list) {
        const aid = String(sr.activity_id ?? '');
        if (aid && !scoreMap.has(aid)) scoreMap.set(aid, sr);
        const vid = String(sr.variant_id ?? '');
        if (vid && !scoreMap.has(vid)) scoreMap.set(vid, sr);
      }
    };
    const fbRes = await surrealDB.query('SELECT activity_id, variant_id, total_executions, successful_executions, thompson_alpha, thompson_beta, success_rate FROM variant_performance_metrics WHERE activity_id IN $activity_ids OR variant_id IN $activity_ids', { activity_ids: activityIds });
    addScoreRows((Array.isArray(fbRes) ? fbRes : ((fbRes as any)?.[0]?.result ?? [])) as Array<Record<string, any>>);

  // Project metrics_row + comp_row into the legacy response shape.
  const activitiesWithScores = (activities || []).map((row: any) => {
    const plainId = String(row.id ?? '').replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');
    const score = row.metrics_row ?? scoreMap.get(plainId) ?? scoreMap.get(String(row.id ?? '')) ?? null;
    const { metrics_row, comp_row, ...activity } = row;
    const total_executions = (score?.total_executions ?? 0) as number;
    const successful_executions = (score?.successful_executions ?? score?.successes ?? 0) as number;
    const success_rate = (score?.success_rate ?? (total_executions > 0 ? (successful_executions / total_executions) : 0)) as number;
    // AN UNTRIED ARM IS NOT A COIN FLIP.
    //
    // This defaulted to Beta(1,1) — a uniform prior — so an activity that has NEVER
    // run was modelled as 50% likely to succeed. With the measured candidate pool
    // (95-108 arms, 97.1% carrying <5 observations, 23.7% at exactly (1,1)) the
    // maximum of ~76 near-uniform draws lands around 0.99, and a genuinely learned
    // arm cannot clear it. Simulated at the measured pool size, an arm with a .755
    // success rate over 100 observations won 0.0% of draws; even a .95 arm won 21.8%.
    // Exploration permanently swamped exploitation, which is why credit lands and
    // posteriors diverge (0.000-0.756 across 3,290 arms) while nothing improves.
    //
    // Beta(1, UNTRIED_PRIOR_BETA) instead. Exploration is PRESERVED — an untried arm
    // still draws, with mean 1/(1+beta), and still wins sometimes among ~100 draws —
    // it is simply no longer assumed to succeed half the time. At beta=3 a .755 arm
    // wins 43% and a .95 arm 98.7%.
    //
    // Applied ONLY where there is no evidence at all: an arm with executions whose
    // metrics row merely lacks thompson fields keeps the neutral 1, so this cannot
    // penalise a real arm for a missing column. Untried templates also retain a
    // separate guaranteed route to their first run via the boredom exerciser
    // (GET /v2/activities/templates/proposed-for-exercise), so nothing is starved.
    const hasEvidence = score != null && total_executions > 0;
    const thompson_alpha = (score?.thompson_alpha ?? score?.alpha ?? 1) as number;
    const thompson_beta = (score?.thompson_beta ?? score?.beta ?? (hasEvidence ? 1 : UNTRIED_PRIOR_BETA)) as number;
    const confidence = thompson_alpha / (thompson_alpha + thompson_beta);
    return {
      ...activity,
      metrics: {
        total_executions,
        successful_executions,
        success_rate,
        thompson_alpha,
        thompson_beta,
        confidence,
      },
      _comp_row: comp_row ?? null,
    };
  });

  const legacyActivities = activitiesWithScores.map((a: any) => {
    const { _comp_row, ...rest } = a;
    const legacy = transformToLegacyTemplate(rest);
    // FM-2: attach a top-level Thompson draw from this candidate's posterior so
    // goal-host readCandidateShapes populates WalkCandidate.sampledScore in
    // forward/backward mode (previously only candidates_with_scores carried a
    // score) — letting producer-pick.scaffoldRank grant the -1 learned-pathway
    // reuse bonus (sampledScore>0.5), and feeding the FM-1 pick-order sort below.
    // Same prior as above — metrics is always populated by the map that precedes
    // this, so the ?? here is a belt-and-braces default, not the primary path.
    const sampled_score = betaSample(
      (a.metrics?.thompson_alpha ?? 1) as number,
      (a.metrics?.thompson_beta ?? UNTRIED_PRIOR_BETA) as number,
    );
    return { ...legacy, sampled_score };
  });

  const finalActivities = isCandidatesMode
    ? legacyActivities.map((legacyActivity: any, idx: number) => {
        const compRow = (activitiesWithScores[idx] as any)._comp_row;
        const composition_score = compRow && (compRow.execution_count || 0) > 0
          ? {
              alpha: (compRow.success_count || 0) + 1,
              beta: ((compRow.execution_count || 0) - (compRow.success_count || 0)) + 1,
              sample_count: compRow.execution_count || 0,
              predecessor_id: predecessor_activity_id || undefined,
            }
          : null;
        return { ...legacyActivity, composition_score };
      })
    : legacyActivities;

  // Successor-features readout (mechanism #7): Q_sf = ⟨ψ(s,a), R⟩ per candidate.
  // R = completion_shapes (the goal direction). ψ is keyed (signature, template);
  // the dot product is the TRANSFER value — non-zero even for cells the Beta
  // never rewarded on this R, because ψ encodes transition structure, not reward.
  // Additive: attaches `successor_value` alongside the unchanged Thompson scores.
  // A SIGNATURE FROM THE WRONG NAMESPACE MUST NOT PRODUCE A ZERO.
  //
  // This gate was `signature.length > 0`. A caller sending an 8-hex host-load hash (a real
  // incident, 2026-08-17) passed it, every psi cell lookup missed, and every candidate was
  // annotated `successor_value: {value: 0}` — which reads downstream as "psi measured zero
  // occupancy toward this goal", not as "the key was never in this namespace". A lookup that
  // could not be performed was reported as a measurement.
  //
  // psi cells are keyed by `computeStateSignature` = sha256(...).digest().slice(0,8) -> 16 hex
  // chars. POST /recommend already validates exactly `^[0-9a-f]{16}$` before using a
  // caller-supplied signature as a cts key; this reuses that rule rather than inventing a
  // second one that can drift from it.
  const sigUsable = typeof signature === 'string' && /^[0-9a-f]{16}$/.test(signature);
  if (isCandidatesMode && successorFeaturesEnabled() && typeof signature === 'string' && signature.length > 0 && !sigUsable) {
    // Loud, because the silent version of this cost a full wiring cycle: the chain looked
    // closed at every hop and moved no information.
    logger.warn('successor-features: signature is not a shape-space signature — psi NOT attached', {
      event: 'sf_signature_namespace_mismatch',
      received_length: signature.length,
      expected: '16 hex chars (sha256 digest slice)',
    });
  }
  if (
    isCandidatesMode &&
    successorFeaturesEnabled() &&
    sigUsable &&
    completion_shapes.length > 0
  ) {
    try {
      const reward = rewardFromCompletionShapes(completion_shapes);
      // The legacy transform emits the cell id under activity_id / variant_id
      // (not `id`). Resolve robustly so the ψ-cell lookup keys match.
      const candidateId = (a: any): string | undefined => {
        const raw = a?.activity_id ?? a?.variant_id ?? a?.id;
        if (raw == null) return undefined;
        // raw may be a string OR a SurrealDB RecordId object — String() coerces
        // both to the canonical `activity:⟨id⟩` form; normalizeActivityId (in
        // successorFeatureCellKey) then strips the wrapper.
        const s = typeof raw === 'string' ? raw : String(raw);
        return s.length > 0 ? s : undefined;
      };
      const templateIds = finalActivities
        .map((a: any) => candidateId(a))
        .filter((x: unknown): x is string => typeof x === 'string');
      const cells = await fetchSuccessorFeatureCells(surrealDB as any, signature, templateIds, sf_scope);
      for (const a of finalActivities) {
        const cid = candidateId(a);
        const cell = cid ? cells.get(successorFeatureCellKey(signature, cid)) : undefined;
        if (cell) {
          a.successor_value = {
            value: successorValue(cell.vector, reward),
            signature,
            scope: cell.scope,
            sample_count: cell.sample_count,
            discount: cell.discount,
          };
        } else {
          // ψ uninformed for this cell — value 0, marked so the consumer can
          // distinguish "no transition data" from "zero occupancy toward R".
          a.successor_value = {
            value: 0,
            signature,
            scope: sf_scope,
            sample_count: 0,
            discount: 0.9,
          };
        }
      }
    } catch (err) {
      logger.warn('successor-features: readout failed (non-blocking)', {
        signature,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Activities discovered by shapes', {
    count: finalActivities.length,
    required_shapes,
  });

  // FM-1: Thompson pick order — draw-sort so under-sampled arms (alpha≈beta≈1 →
  // ~Uniform(0,1)) can beat an ev-mean-dominant incumbent, curing the
  // composed-cap / fleet-health-pane lock-in. goal-host's stable scaffoldRank
  // sort + .find then takes the sampled-best among equal-rank genuine producers.
  finalActivities.sort((a: any, b: any) => (b.sampled_score ?? 0) - (a.sampled_score ?? 0));
  // sample-then-truncate: the caller asked for `limit` producers; return the
  // top-`limit` by Thompson draw from the admitted pool (never more than the
  // caller expects, but now drawn from ALL viable producers, not the recency
  // head). Bounded pre-draw admission cannot silently starve a learned arm.
  const selected = finalActivities.slice(0, limit);
  return {
    ok: true,
    activities: selected,
    total: selected.length,
  };
}
