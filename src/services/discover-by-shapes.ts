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

export type DiscoverByShapesMode = 'forward' | 'backward' | 'candidates_with_scores';

export interface DiscoverByShapesInput {
  required_shapes: string[];
  mode?: DiscoverByShapesMode;
  limit?: number;
  current_shapes?: string[];
  output_shapes?: string[];
  predecessor_activity_id?: string;
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
      (SELECT alpha, beta, total_executions, successful_executions, success_rate
       FROM activity_metrics WHERE activity = $parent.id LIMIT 1)[0] AS metrics_row${compositionSubquery}
    FROM activity
    WHERE ${whereClause}
    ORDER BY created_at DESC
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
            successful_executions: score.successful_executions || 0,
            success_rate: score.success_rate || 0,
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
