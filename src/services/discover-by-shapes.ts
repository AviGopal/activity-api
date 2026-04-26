/**
 * Discover-by-shapes shared helper
 *
 * Extracted from `POST /v2/activities/discover-by-shapes` (routes/activities.ts)
 * so the same logic can be reached via the impulse-resolve shape handler
 * (`discoverByShapesQuery` in routes/impulses.ts) without duplicating the SQL or
 * the composition-score augmentation.
 *
 * Architectural note (F-6 corrected, 2026-04-26):
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

  let query: string;
  let params: any;

  if (queryMode === 'forward') {
    // Forward mode: Find activities that PRODUCE the required shapes
    query = `
      SELECT * FROM activity
      WHERE output_shapes CONTAINSANY $required_shapes
        AND (retired = false OR retired IS NONE)
      ORDER BY created_at DESC
      LIMIT $limit
    `;
    params = { required_shapes, limit };
  } else {
    // Backward mode: Find activities that CONSUME the required shapes
    // Optional additive filter on output_shapes.
    const outputFilterClause = output_shapes.length > 0
      ? ' AND output_shapes CONTAINSANY $output_shapes_filter'
      : '';
    if (current_shapes.length > 0) {
      query = `
        SELECT * FROM activity
        WHERE input_shapes CONTAINSANY $required_shapes${outputFilterClause}
          AND (retired = false OR retired IS NONE)
        ORDER BY created_at DESC
        LIMIT $limit
      `;
      params = { required_shapes, current_shapes, limit };
    } else {
      query = `
        SELECT * FROM activity
        WHERE input_shapes CONTAINSANY $required_shapes${outputFilterClause}
          AND (retired = false OR retired IS NONE)
        ORDER BY created_at DESC
        LIMIT $limit
      `;
      params = { required_shapes, limit };
    }
    if (output_shapes.length > 0) {
      params.output_shapes_filter = output_shapes;
    }
  }

  const activities = await surrealDB.query(query, params);

  // Get Thompson Sampling scores for each activity
  const activitiesWithScores = await Promise.all(
    (activities || []).map(async (activity: any) => {
      try {
        const scoresQuery = `
          SELECT * FROM activity_metrics
          WHERE activity = $activity_id
          LIMIT 1
        `;
        const scores = await surrealDB.query(scoresQuery, {
          activity_id: activity.id,
        });

        const score = scores && scores.length > 0 ? scores[0] : null;

        return {
          ...activity,
          metrics: score ? {
            total_executions: score.total_executions || 0,
            successful_executions: score.successful_executions || 0,
            success_rate: score.success_rate || 0,
            thompson_alpha: score.alpha || 1,
            thompson_beta: score.beta || 1,
            confidence: (score.alpha || 1) / ((score.alpha || 1) + (score.beta || 1)),
          } : {
            total_executions: 0,
            successful_executions: 0,
            success_rate: 0,
            thompson_alpha: 1,
            thompson_beta: 1,
            confidence: 0.5,
          },
        };
      } catch (error) {
        logger.warn('Failed to fetch metrics for activity', {
          activity_id: activity.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return activity;
      }
    }),
  );

  // Transform to legacy format for compatibility
  const legacyActivities = activitiesWithScores.map(transformToLegacyTemplate);

  // Augment each result with composition_score for candidates_with_scores mode.
  const finalActivities = mode === 'candidates_with_scores'
    ? await Promise.all(
        legacyActivities.map(async (legacyActivity: any, idx: number) => {
          const sourceActivity: any = activitiesWithScores[idx];
          try {
            const compQuery = predecessor_activity_id
              ? `SELECT success_count, execution_count FROM activity_composition_graph WHERE parent_activity_id = $predecessor_activity_id AND child_activity_id = $activity_id LIMIT 1`
              : `SELECT math::sum(success_count) AS success_count, math::sum(execution_count) AS execution_count FROM activity_composition_graph WHERE child_activity_id = $activity_id GROUP ALL`;
            const compParams: Record<string, unknown> = predecessor_activity_id
              ? { predecessor_activity_id, activity_id: sourceActivity.id }
              : { activity_id: sourceActivity.id };
            const compRows: any = await surrealDB.query(compQuery, compParams);
            const row = compRows && compRows.length > 0 ? compRows[0] : null;
            const composition_score = row && (row.execution_count || 0) > 0
              ? {
                  alpha: (row.success_count || 0) + 1,
                  beta: ((row.execution_count || 0) - (row.success_count || 0)) + 1,
                  sample_count: row.execution_count || 0,
                  predecessor_id: predecessor_activity_id || undefined,
                }
              : null;
            return { ...legacyActivity, composition_score };
          } catch (error) {
            logger.warn('Failed to fetch composition score', {
              activity_id: sourceActivity.id,
              error: error instanceof Error ? error.message : String(error),
            });
            return { ...legacyActivity, composition_score: null };
          }
        }),
      )
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
