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
  } = input;

  // candidates_with_scores treats the query as forward mode (find producers)
  // and augments each result with composition_score from activity_composition_graph.
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
  const isCandidatesMode = mode === 'candidates_with_scores';
  const compositionSubquery = isCandidatesMode
    ? predecessor_activity_id
      ? `, (SELECT success_count, execution_count FROM activity_composition_graph
           WHERE parent_activity_id = $predecessor_activity_id
             AND child_activity_id = $parent.id LIMIT 1)[0] AS comp_row`
      : `, (SELECT math::sum(success_count) AS success_count, math::sum(execution_count) AS execution_count
           FROM activity_composition_graph
           WHERE child_activity_id = $parent.id GROUP ALL)[0] AS comp_row`
    : '';

  const params: Record<string, unknown> = { required_shapes, limit };
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
    SELECT *,
      (SELECT alpha, beta, total_executions, successes
       FROM v_activity_score WHERE activity_id = record::id($parent.id) LIMIT 1)[0] AS metrics_row${compositionSubquery}
    FROM activity
    WHERE ${whereClause}
    ORDER BY ev DESC, created_at DESC
    LIMIT $limit
  `;

  const activities = await surrealDB.query(query, params);

  // Project metrics_row + comp_row into the legacy response shape.
  const activitiesWithScores = (activities || []).map((row: any) => {
    const score = row.metrics_row ?? null;
    const { metrics_row, comp_row, ...activity } = row;
    return {
      ...activity,
      metrics: score
        ? {
            total_executions: score.total_executions || 0,
            successful_executions: score.successes || 0,
            success_rate: score.total_executions ? (score.successes || 0) / score.total_executions : 0,
            thompson_alpha: score.alpha || 1,
            thompson_beta: score.beta || 1,
            confidence: (score.alpha || 1) / ((score.alpha || 1) + (score.beta || 1)),
          }
        : {
            total_executions: 0,
            successful_executions: 0,
            success_rate: 0,
            thompson_alpha: 1,
            thompson_beta: 1,
            confidence: 0.5,
          },
      _comp_row: comp_row ?? null,
    };
  });

  const legacyActivities = activitiesWithScores.map((a: any) => {
    const { _comp_row, ...rest } = a;
    return transformToLegacyTemplate(rest);
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
  if (
    isCandidatesMode &&
    successorFeaturesEnabled() &&
    typeof signature === 'string' &&
    signature.length > 0 &&
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

  return {
    ok: true,
    activities: finalActivities,
    total: finalActivities.length,
  };
}
