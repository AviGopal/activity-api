/**
 * Paradigm Schema Helpers (schema-paradigm-alignment)
 *
 * Provides dual-path query functions that:
 * 1. Try the new 4-table paradigm schema first (activity, execution, impulse, vessel)
 * 2. Fall back to legacy tables if new tables fail or are empty
 * 3. Log which path is taken for monitoring
 *
 * This enables gradual migration from legacy schema to unified paradigm schema.
 */

import { surrealDB, queryWithAuth } from './surreal';
import { logger } from '../utils/logger';

// =============================================================================
// FEATURE FLAGS (P4.1: Dual-write control)
// =============================================================================

/**
 * Check if dual-write to new paradigm tables is enabled.
 * Controlled via DUAL_WRITE_ENABLED environment variable.
 * Default: true (enabled) during migration period.
 */
export function isDualWriteEnabled(): boolean {
  const envValue = process.env.DUAL_WRITE_ENABLED;
  // Default to true unless explicitly disabled
  return envValue !== 'false' && envValue !== '0';
}

/**
 * Check if reads should prefer new paradigm tables.
 * Controlled via PARADIGM_READ_ENABLED environment variable.
 * Default: true (try new tables first, fall back to legacy)
 */
export function isParadigmReadEnabled(): boolean {
  const envValue = process.env.PARADIGM_READ_ENABLED;
  // Default to true unless explicitly disabled
  return envValue !== 'false' && envValue !== '0';
}

/**
 * P5.2: Get percentage of traffic that should use new paradigm tables.
 * Controlled via PARADIGM_READ_PERCENTAGE environment variable.
 * Default: 100 (all traffic uses new tables when enabled)
 *
 * Use this for gradual rollout:
 * - 10: 10% of requests use new tables
 * - 50: 50% of requests use new tables
 * - 100: All requests use new tables
 */
export function getParadigmReadPercentage(): number {
  const envValue = process.env.PARADIGM_READ_PERCENTAGE;
  if (!envValue) return 100;
  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}

/**
 * P5.1: Check if this specific request should use new paradigm tables.
 * Combines isParadigmReadEnabled() with percentage-based rollout.
 *
 * @returns true if this request should read from new tables
 */
export function shouldUseParadigmRead(): boolean {
  if (!isParadigmReadEnabled()) {
    return false;
  }
  const percentage = getParadigmReadPercentage();
  if (percentage >= 100) {
    return true;
  }
  if (percentage <= 0) {
    return false;
  }
  // Random selection based on percentage
  return Math.random() * 100 < percentage;
}

/**
 * P5.1: Check if fallback to legacy tables should be skipped.
 * When PARADIGM_READ_NO_FALLBACK=true, errors from new tables are not caught.
 * Use this after gradual rollout is complete (100%) to ensure clean reads.
 */
export function shouldSkipLegacyFallback(): boolean {
  const envValue = process.env.PARADIGM_READ_NO_FALLBACK;
  return envValue === 'true' || envValue === '1';
}

/**
 * Log dual-write configuration on startup
 */
export function logDualWriteConfig(): void {
  logger.info('[paradigm] Feature flags:', {
    DUAL_WRITE_ENABLED: isDualWriteEnabled(),
    PARADIGM_READ_ENABLED: isParadigmReadEnabled(),
    PARADIGM_READ_PERCENTAGE: getParadigmReadPercentage(),
    PARADIGM_READ_NO_FALLBACK: shouldSkipLegacyFallback(),
  });
}

// Field mapping: legacy -> new schema
const ACTIVITY_FIELD_MAP = {
  variant_id: 'id',
  activity_id: 'id', // In new schema, activity_id is just id
  variant_name: 'name',
  description: 'description',
  tags: 'tags',
  tag_prefixes: 'tag_prefixes',
  category: 'category',
  task_steps: 'tasks',
  scope: 'scope',
  org_id: 'org_id',
  project_id: 'project_id',
  created_at: 'created_at',
  updated_at: 'updated_at',
} as const;

// Reverse mapping for compatibility
const ACTIVITY_REVERSE_MAP = {
  id: 'variant_id',
  name: 'variant_name',
  tasks: 'task_steps',
} as const;

export interface ParadigmActivity {
  id: string;
  name: string;
  description?: string;
  input_shapes: string[];
  output_shapes: string[];
  /**
   * Execution type determines how this activity is executed and which patterns it matches.
   *
   * - `template`: Multi-task workflows with LLM-guided execution (e.g., debug-activity, create-feature)
   * - `tool`: Single tool invocations wrapped as activities (e.g., bash-run, file-read)
   * - `composition`: Multi-activity sequences orchestrated together (e.g., test-and-deploy pipeline)
   * - `vessel_function`: Code-based resolvers that transform impulses directly (e.g., extract-error-from-logs)
   *
   * This differentiation improves Thompson Sampling by preventing tool wrappers from being mixed
   * with templates in recommendations, and enables specialized execution paths for each type.
   */
  execution_type: 'template' | 'tool' | 'composition' | 'vessel_function';
  // Hierarchical tags (primary classification)
  tags?: string[];
  tag_prefixes?: string[];
  // Legacy category for backward compatibility
  category?: string;
  tasks?: any[];
  tool_name?: string;
  child_activities?: string[];
  scope: string;
  public: boolean;
  org_id: string;
  project_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ParadigmExecution {
  id: string;
  activity_id: string;
  input_impulses: string[];
  output_impulses: string[];
  success: boolean;
  error?: {
    message?: string;
    type?: string;
    task_id?: string;
    stack?: string;
  };
  duration_ms: number;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  parent_execution_id?: string;
  trace?: any;
  org_id: string;
  project_id?: string;
  vessel_id?: string;
  executed_at: string;
  created_at: string;
}

export interface ActivityScore {
  activity_id: string;
  org_id: string;
  total_executions: number;
  alpha: number;  // Thompson Sampling: successes + 1
  beta: number;   // Thompson Sampling: failures + 1
  successes: number;
  failures: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  last_executed_at?: string;
  first_executed_at?: string;
}

/**
 * Query path result for monitoring
 */
export interface QueryPathResult<T> {
  data: T[];
  path: 'new' | 'legacy';
  latency_ms: number;
}

/**
 * Insert into activity table (new paradigm schema)
 * Returns the inserted record or null on failure
 */
export async function insertActivity(
  activity: Partial<ParadigmActivity>,
  jwtToken?: string | null
): Promise<ParadigmActivity | null> {
  const startTime = Date.now();

  try {
    // Build insert query
    const record: Record<string, any> = {
      id: activity.id,
      name: activity.name,
      description: activity.description,
      input_shapes: activity.input_shapes || [],
      output_shapes: activity.output_shapes || [],
      execution_type: activity.execution_type || 'template',
      category: activity.category,
      tasks: activity.tasks,
      scope: activity.scope || 'org',
      public: activity.public || false,
    };

    // Optional fields (non-record types)
    if (activity.tool_name) record.tool_name = activity.tool_name;
    if (activity.child_activities) record.child_activities = activity.child_activities;

    // Build dynamic field list
    const fields = Object.keys(record)
      .filter(k => record[k] !== undefined)
      .map(k => `${k}: $${k}`)
      .join(',\n        ');

    // For org_id: org_id is a STRING field in paradigm schema (not a record)
    // $auth.org_id is already a plain string like "metabob_internal"
    const orgIdClause = jwtToken
      ? `,\n        org_id: $auth.org_id` // Use string directly from $auth
      : (activity.org_id ? `,\n        org_id: $org_id` : '');
    if (!jwtToken && activity.org_id) record.org_id = activity.org_id;

    // For project_id: optional record field, let schema VALUE clause handle it from $auth
    const projectIdClause = jwtToken
      ? '' // Let schema auto-populate from $auth.project_id
      : (activity.project_id ? `,\n        project_id: $project_id` : '');
    if (!jwtToken && activity.project_id) record.project_id = activity.project_id;

    const query = `
      INSERT INTO activity_template {
        ${fields}${orgIdClause}${projectIdClause},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    logger.info('[paradigm] insertActivity query', {
      hasJwtToken: !!jwtToken,
      orgIdClause,
      query: query.substring(0, 200),
    });

    const result = jwtToken
      ? await queryWithAuth<ParadigmActivity>(jwtToken, query, record)
      : await surrealDB.query<ParadigmActivity>(query, record);

    logger.info('[paradigm] Activity inserted into new schema', {
      id: activity.id,
      path: 'new',
      latency_ms: Date.now() - startTime,
    });

    return result?.[0] || null;

  } catch (error) {
    logger.error('[paradigm] Failed to insert activity into new schema', {
      id: activity.id,
      error: error instanceof Error ? error.message : String(error),
      latency_ms: Date.now() - startTime,
    });
    return null;
  }
}

/**
 * Insert into execution table (new paradigm schema)
 * Returns the inserted record or null on failure
 */
export async function insertExecution(
  execution: Partial<ParadigmExecution>,
  jwtToken?: string | null
): Promise<ParadigmExecution | null> {
  const startTime = Date.now();

  try {
    const record: Record<string, any> = {
      id: execution.id,
      activity_id: execution.activity_id,
      input_impulses: execution.input_impulses || [],
      output_impulses: execution.output_impulses || [],
      success: execution.success,
      duration_ms: execution.duration_ms || 0,
      cost_usd: execution.cost_usd || 0,
      tokens_in: execution.tokens_in || 0,
      tokens_out: execution.tokens_out || 0,
    };

    // Optional fields
    if (execution.error) record.error = execution.error;
    if (execution.parent_execution_id) record.parent_execution_id = execution.parent_execution_id;
    if (execution.trace) record.trace = execution.trace;
    // org_id and project_id are handled separately - they need record type conversion
    // or should be populated from $auth context
    if (execution.vessel_id) record.vessel_id = execution.vessel_id;

    // Build field list - org_id/project_id are special: use $auth if JWT, or convert to record type
    const fields = Object.keys(record)
      .filter(k => record[k] !== undefined)
      .map(k => `${k}: $${k}`)
      .join(',\n        ');

    // For org_id: org_id is a STRING field in paradigm schema (not a record)
    // $auth.org_id is already a plain string like "metabob_internal"
    const orgIdClause = jwtToken
      ? `,\n        org_id: $auth.org_id` // Use string directly from $auth
      : (execution.org_id ? `,\n        org_id: $org_id` : '');
    if (!jwtToken && execution.org_id) record.org_id = execution.org_id;

    // For project_id: optional record field, let schema VALUE clause handle it from $auth
    const projectIdClause = jwtToken
      ? '' // Let schema auto-populate from $auth.project_id
      : (execution.project_id ? `,\n        project_id: $project_id` : '');
    if (!jwtToken && execution.project_id) record.project_id = execution.project_id;

    const query = `
      INSERT INTO execution {
        ${fields}${orgIdClause}${projectIdClause},
        executed_at: time::now(),
        created_at: time::now()
      }
    `;

    logger.info('[paradigm] insertExecution query', {
      hasJwtToken: !!jwtToken,
      orgIdClause,
      query: query.substring(0, 200),
    });

    const result = jwtToken
      ? await queryWithAuth<ParadigmExecution>(jwtToken, query, record)
      : await surrealDB.query<ParadigmExecution>(query, record);

    logger.info('[paradigm] Execution inserted into new schema', {
      id: execution.id,
      activity_id: execution.activity_id,
      success: execution.success,
      path: 'new',
      latency_ms: Date.now() - startTime,
    });

    return result?.[0] || null;

  } catch (error) {
    logger.error('[paradigm] Failed to insert execution into new schema', {
      id: execution.id,
      error: error instanceof Error ? error.message : String(error),
      latency_ms: Date.now() - startTime,
    });
    return null;
  }
}

/**
 * Get activity scores from v_activity_score view
 * Falls back to variant_performance_metrics on failure (unless no-fallback mode)
 *
 * P5.1/P5.2: Respects PARADIGM_READ_PERCENTAGE for gradual rollout
 */
export async function getActivityScores(
  orgId: string,
  activityIds?: string[],
  jwtToken?: string | null
): Promise<QueryPathResult<ActivityScore>> {
  const startTime = Date.now();
  const useParadigm = shouldUseParadigmRead();
  const noFallback = shouldSkipLegacyFallback();

  // P5.1: Try new v_activity_score view if paradigm read is enabled for this request
  if (useParadigm) {
    try {
      let query = `SELECT * FROM v_activity_score WHERE org_id = $org_id`;
      // org_id in v_activity_score is stored as record ID (e.g., "organizations:metabob_internal")
      const fullOrgId = orgId.startsWith('organizations:') ? orgId : `organizations:${orgId}`;
      const params: Record<string, any> = { org_id: fullOrgId };

      if (activityIds && activityIds.length > 0) {
        query += ` AND activity_id IN $activity_ids`;
        params.activity_ids = activityIds;
      }

      const result = jwtToken
        ? await queryWithAuth<ActivityScore>(jwtToken, query, params)
        : await surrealDB.query<ActivityScore>(query, params);

      if (result && result.length > 0) {
        logger.debug('[paradigm] Activity scores fetched from new view', {
          count: result.length,
          path: 'new',
          latency_ms: Date.now() - startTime,
        });

        return {
          data: result,
          path: 'new',
          latency_ms: Date.now() - startTime,
        };
      }

      // P5.1: If no fallback mode and empty result, return empty (don't try legacy)
      if (noFallback) {
        logger.debug('[paradigm] Activity scores empty from new view (no fallback)', {
          path: 'new',
          latency_ms: Date.now() - startTime,
        });
        return {
          data: [],
          path: 'new',
          latency_ms: Date.now() - startTime,
        };
      }
    } catch (error) {
      // P5.1: If no fallback mode, propagate error
      if (noFallback) {
        logger.error('[paradigm] v_activity_score query failed (no fallback)', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.warn('[paradigm] v_activity_score query failed, falling back', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fall back to legacy variant_performance_metrics
  try {
    let query = `SELECT
      variant_id AS activity_id,
      org_id,
      total_executions,
      thompson_alpha AS alpha,
      thompson_beta AS beta,
      successful_executions AS successes,
      failed_executions AS failures,
      avg_duration_ms,
      avg_cost_usd,
      0.0 AS total_cost_usd,
      0 AS total_tokens_in,
      0 AS total_tokens_out,
      last_executed_at
    FROM variant_performance_metrics`;

    const params: Record<string, any> = {};

    if (orgId) {
      query += ` WHERE org_id = $org_id`;
      // Legacy table stores org_id as plain string (e.g., "metabob_internal")
      // Strip organizations: prefix if present
      params.org_id = orgId.startsWith('organizations:') ? orgId.replace('organizations:', '') : orgId;
    }

    if (activityIds && activityIds.length > 0) {
      query += ` AND variant_id IN $activity_ids`;
      params.activity_ids = activityIds;
    }

    const result = await surrealDB.query<ActivityScore>(query, params);

    logger.info('[paradigm] Activity scores fetched from legacy table', {
      count: result?.length || 0,
      path: 'legacy',
      latency_ms: Date.now() - startTime,
    });

    return {
      data: result || [],
      path: 'legacy',
      latency_ms: Date.now() - startTime,
    };

  } catch (error) {
    logger.error('[paradigm] Both new and legacy activity score queries failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      data: [],
      path: 'legacy',
      latency_ms: Date.now() - startTime,
    };
  }
}

/**
 * Query activities with shape-based filtering
 * Uses ALLINSIDE operator for shape matching
 *
 * @param availableShapes - Shapes the caller has available (impulse_shapes)
 * @param orgId - Organization ID for multi-tenant filtering
 * @param category - Optional category filter
 * @param executionType - Optional execution_type filter (template, tool, composition, vessel_function)
 * @param limit - Maximum number of results to return
 * @param jwtToken - Optional JWT token for RBAC
 */
export async function queryActivitiesByShapes(
  availableShapes: string[],
  orgId?: string | null,
  category?: string | null,
  executionType?: 'template' | 'tool' | 'composition' | 'vessel_function' | null,
  limit: number = 50,
  jwtToken?: string | null
): Promise<QueryPathResult<ParadigmActivity>> {
  const startTime = Date.now();
  const useParadigm = shouldUseParadigmRead();
  const noFallback = shouldSkipLegacyFallback();

  // P5.1: Try new activity table with shape matching if paradigm read is enabled
  if (useParadigm) {
    try {
    const whereClauses: string[] = [];
    const params: Record<string, any> = { limit };

    // Shape matching: activity.input_shapes must be subset of availableShapes
    if (availableShapes && availableShapes.length > 0) {
      whereClauses.push(`input_shapes ALLINSIDE $available_shapes`);
      params.available_shapes = availableShapes;
    }

    // Include activities with empty input_shapes (backward compat)
    if (availableShapes && availableShapes.length > 0) {
      whereClauses.push(`(input_shapes = [] OR input_shapes ALLINSIDE $available_shapes)`);
    }

    if (category) {
      whereClauses.push(`category = $category`);
      params.category = category;
    }

    // T8: Filter by execution_type if provided
    if (executionType) {
      whereClauses.push(`execution_type = $execution_type`);
      params.execution_type = executionType;
    }

    // Multi-tenant filtering
    if (!jwtToken && orgId) {
      whereClauses.push(`(scope = 'global' OR org_id = $org_id)`);
      params.org_id = orgId;
    }

    const whereClause = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    const query = `
      SELECT * FROM activity
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $limit
    `;

    const result = jwtToken
      ? await queryWithAuth<ParadigmActivity>(jwtToken, query, params)
      : await surrealDB.query<ParadigmActivity>(query, params);

    if (result && result.length > 0) {
      logger.info('[paradigm] Activities fetched with shape matching', {
        count: result.length,
        path: 'new',
        availableShapes,
        latency_ms: Date.now() - startTime,
      });

      return {
        data: result,
        path: 'new',
        latency_ms: Date.now() - startTime,
      };
    }

    // P5.1: If no fallback mode and empty result, return empty
    if (noFallback) {
      logger.debug('[paradigm] Activities empty from new table (no fallback)', {
        path: 'new',
        latency_ms: Date.now() - startTime,
      });
      return {
        data: [],
        path: 'new',
        latency_ms: Date.now() - startTime,
      };
    }
    } catch (error) {
      // P5.1: If no fallback mode, propagate error
      if (noFallback) {
        logger.error('[paradigm] Shape-based query failed (no fallback)', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      logger.warn('[paradigm] Shape-based query failed, falling back to legacy', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fall back to legacy activity_template table
  // (no shape matching, just category filtering)
  try {
    const whereClauses: string[] = [];
    const params: Record<string, any> = { limit };

    if (category) {
      whereClauses.push(`category = $category`);
      params.category = category;
    }

    if (orgId) {
      whereClauses.push(`(scope IS NULL OR scope = 'global' OR (scope = 'org' AND org_id = $org_id))`);
      params.org_id = orgId;
    } else {
      whereClauses.push(`(scope IS NULL OR scope = 'global')`);
    }

    const whereClause = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    const query = `
      SELECT
        variant_id AS id,
        variant_name AS name,
        description,
        category,
        tags,
        tag_prefixes,
        task_steps AS tasks,
        scope,
        org_id,
        project_id,
        input_schema,
        output_schema,
        created_at,
        updated_at
      FROM activity_template
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $limit
    `;

    const result = await surrealDB.query<any>(query, params);

    // Transform legacy results to paradigm format
    const transformed = (result || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      input_shapes: [], // Legacy templates don't have shapes
      output_shapes: [],
      execution_type: 'template' as const,
      category: t.category,
      tags: t.tags || [],
      tag_prefixes: t.tag_prefixes || [],
      tasks: t.tasks,
      scope: t.scope || 'global',
      public: t.scope === 'global',
      org_id: t.org_id,
      project_id: t.project_id,
      created_at: t.created_at,
      updated_at: t.updated_at,
    }));

    logger.info('[paradigm] Activities fetched from legacy table (no shape matching)', {
      count: transformed.length,
      path: 'legacy',
      latency_ms: Date.now() - startTime,
    });

    return {
      data: transformed,
      path: 'legacy',
      latency_ms: Date.now() - startTime,
    };

  } catch (error) {
    logger.error('[paradigm] Both activity queries failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      data: [],
      path: 'legacy',
      latency_ms: Date.now() - startTime,
    };
  }
}

/**
 * Transform legacy template format to paradigm Activity format
 */
export function transformLegacyTemplate(legacy: any): ParadigmActivity {
  return {
    id: legacy.variant_id,
    name: legacy.variant_name,
    description: legacy.description,
    input_shapes: legacy.input_schema?.required_shapes || [],
    output_shapes: legacy.output_schema?.produces_shapes || [],
    execution_type: 'template',
    category: legacy.category,
    tasks: legacy.task_steps,
    scope: legacy.scope || 'global',
    public: legacy.scope === 'global' || !legacy.scope,
    org_id: legacy.org_id,
    project_id: legacy.project_id,
    created_at: legacy.created_at,
    updated_at: legacy.updated_at,
  };
}

/**
 * Transform paradigm Activity to legacy template format (for backward compat)
 */
export function transformToLegacyTemplate(activity: ParadigmActivity): any {
  return {
    variant_id: activity.id,
    activity_id: activity.id,
    variant_name: activity.name,
    description: activity.description,
    category: activity.category,
    task_steps: activity.tasks,
    scope: activity.scope,
    org_id: activity.org_id,
    project_id: activity.project_id,
    input_schema: activity.input_shapes.length > 0
      ? { required_shapes: activity.input_shapes }
      : undefined,
    output_schema: activity.output_shapes.length > 0
      ? { produces_shapes: activity.output_shapes }
      : undefined,
    created_at: activity.created_at,
    updated_at: activity.updated_at,
  };
}

// =============================================================================
// Shape-Conditioned Thompson Sampling (goal-aware recommendations)
// =============================================================================

export interface ShapeConditionedScore extends ActivityScore {
  shape_signature: string[];
}

/**
 * Compute canonical shape signature from an array of shapes.
 * This is a sorted, deduplicated array for consistent grouping.
 */
export function computeShapeSignature(shapes: string[]): string[] {
  return [...new Set(shapes)].sort();
}

/**
 * Get shape-conditioned Thompson priors for activities.
 *
 * This allows recommendations to be informed by how well an activity
 * performs with specific input shape combinations (goals).
 *
 * Example: "debug-null-pointer" might have:
 *   - α=15, β=3 when input_shapes = ['error', 'source_code']
 *   - α=5, β=8 when input_shapes = ['goal']
 *
 * This lets us learn that the activity works great for debugging errors
 * but poorly when given just a vague goal.
 *
 * @param orgId - Organization ID
 * @param activityIds - Activity IDs to get scores for
 * @param inputShapes - Input shapes being provided (for matching)
 * @param jwtToken - Optional JWT for RBAC
 */
export async function getShapeConditionedScores(
  orgId: string,
  activityIds: string[],
  inputShapes: string[],
  jwtToken?: string | null
): Promise<QueryPathResult<ShapeConditionedScore>> {
  const startTime = Date.now();

  if (!inputShapes || inputShapes.length === 0) {
    // No shapes provided - fall back to global scores
    const globalResult = await getActivityScores(orgId, activityIds, jwtToken);
    return {
      data: globalResult.data.map(score => ({
        ...score,
        shape_signature: [],
      })),
      path: globalResult.path,
      latency_ms: Date.now() - startTime,
    };
  }

  // Compute canonical signature for matching
  const signature = computeShapeSignature(inputShapes);
  const fullOrgId = orgId.startsWith('organizations:') ? orgId : `organizations:${orgId}`;

  try {
    // Query shape-conditioned scores
    // Note: We look for exact match on shape_signature
    const query = `
      SELECT * FROM v_shape_conditioned_score
      WHERE org_id = $org_id
        AND activity_id IN $activity_ids
        AND shape_signature = $signature
    `;

    const params = {
      org_id: fullOrgId,
      activity_ids: activityIds,
      signature,
    };

    const result = jwtToken
      ? await queryWithAuth<ShapeConditionedScore>(jwtToken, query, params)
      : await surrealDB.query<ShapeConditionedScore>(query, params);

    if (result && result.length > 0) {
      logger.info('[paradigm] Shape-conditioned scores fetched', {
        count: result.length,
        signature,
        path: 'new',
        latency_ms: Date.now() - startTime,
      });

      return {
        data: result,
        path: 'new',
        latency_ms: Date.now() - startTime,
      };
    }

    // No exact match - try partial match (shapes that are subsets)
    // This handles the case where the activity has been used with similar
    // but not identical shape combinations
    const subsetQuery = `
      SELECT * FROM v_shape_conditioned_score
      WHERE org_id = $org_id
        AND activity_id IN $activity_ids
        AND shape_signature ALLINSIDE $signature
      ORDER BY total_executions DESC
      LIMIT 1
    `;

    const subsetResult = jwtToken
      ? await queryWithAuth<ShapeConditionedScore>(jwtToken, subsetQuery, params)
      : await surrealDB.query<ShapeConditionedScore>(subsetQuery, params);

    if (subsetResult && subsetResult.length > 0) {
      logger.debug('[paradigm] Shape-conditioned scores found via subset match', {
        count: subsetResult.length,
        signature,
        matched_signatures: subsetResult.map(s => s.shape_signature),
      });

      return {
        data: subsetResult,
        path: 'new',
        latency_ms: Date.now() - startTime,
      };
    }

    // No shape-conditioned data - fall back to global scores
    logger.debug('[paradigm] No shape-conditioned scores, falling back to global', {
      signature,
      activityIds,
    });

  } catch (error) {
    logger.warn('[paradigm] Shape-conditioned score query failed, falling back', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Fallback to global activity scores
  const globalResult = await getActivityScores(orgId, activityIds, jwtToken);
  return {
    data: globalResult.data.map(score => ({
      ...score,
      shape_signature: [],
    })),
    path: globalResult.path,
    latency_ms: Date.now() - startTime,
  };
}

/**
 * Get best shape patterns for an activity.
 * Returns patterns ordered by success rate - useful for debugging
 * which input combinations work best.
 */
export async function getActivityShapePatterns(
  activityId: string,
  orgId: string,
  jwtToken?: string | null
): Promise<QueryPathResult<ShapeConditionedScore>> {
  const startTime = Date.now();
  const fullOrgId = orgId.startsWith('organizations:') ? orgId : `organizations:${orgId}`;

  try {
    const query = `
      SELECT * FROM v_shape_conditioned_score
      WHERE org_id = $org_id
        AND activity_id = $activity_id
      ORDER BY total_executions DESC
      LIMIT 20
    `;

    const params = { org_id: fullOrgId, activity_id: activityId };

    const result = jwtToken
      ? await queryWithAuth<ShapeConditionedScore>(jwtToken, query, params)
      : await surrealDB.query<ShapeConditionedScore>(query, params);

    logger.debug('[paradigm] Activity shape patterns fetched', {
      activityId,
      count: result?.length || 0,
    });

    return {
      data: result || [],
      path: 'new',
      latency_ms: Date.now() - startTime,
    };

  } catch (error) {
    logger.warn('[paradigm] Shape patterns query failed', {
      activityId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      data: [],
      path: 'legacy',
      latency_ms: Date.now() - startTime,
    };
  }
}
