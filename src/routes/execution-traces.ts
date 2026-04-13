/**
 * Execution Traces Routes
 *
 * Provides endpoints for retrieving execution traces with full state information
 * Used by dashboard to display execution history timeline
 */

import { Hono } from 'hono';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import type { SessionData } from '../models/schemas';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';
import { config } from '../config';
import { insertExecution, isDualWriteEnabled, updateShapeActivityScores, type ParadigmExecution } from '../db/paradigm';

const app = new Hono();

interface ExecutionTrace {
  execution_id: string;
  variant_id: string;
  activity_id: string;
  success: boolean;
  duration_ms: number;
  cost: number;
  tokens: {
    input: number;
    output: number;
    cache: number;
  };
  error_message?: string;
  error_type?: string;
  failed_task_id?: string;
  impulses_used?: string[];
  component_changes?: Array<{
    file_path: string;
    component_name: string;
    component_type: string;
    change_type: 'added' | 'modified' | 'deleted';
    reason?: string;
  }>;
  tasks?: Array<{
    task_id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    duration_ms?: number;
    tool_calls?: Array<{
      tool: string;
      duration_ms: number;
      success: boolean;
    }>;
  }>;
  state_snapshot?: {
    input_state: {
      filesAvailable?: string[];
      environment?: Record<string, string>;
      impulses?: string[];
      variables?: Record<string, unknown>;
    };
    output_state: {
      filesModified?: string[];
      filesCreated?: string[];
      filesDeleted?: string[];
      exitCode?: number;
      stderr?: string;
    };
    stateTransition?: {
      before?: Record<string, string>;
      after?: Record<string, string>;
      workingDirectory?: string;
    };
  };
  org_id: string | null;
  project_id: string | null;
  vessel_id?: string;
  vessel_version?: string;
  executed_at: string;
  created_at: string;
  // Edge learning fields
  improvisation?: boolean;
  input_impulse_shapes?: string[];
  output_impulse_shapes?: string[];
  output_impulses?: Array<{ shape: string; pointer: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

interface ListExecutionTracesResponse {
  executions: ExecutionTrace[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Forward co-change event to analysis-api learning service (async/non-blocking)
 * This updates co-change patterns based on files modified in execution traces.
 *
 * M4.2: Wire Activity API to Learning
 */
async function forwardToLearning(
  sessionId: string,
  changedFiles: string[],
  projectId: string | null
): Promise<void> {
  // Only forward if we have at least 2 files changed (co-change requires pairs)
  if (changedFiles.length < 2) {
    logger.debug('Skipping learning forward - less than 2 files changed', {
      session_id: sessionId,
      files_count: changedFiles.length,
    });
    return;
  }

  const analysisApiUrl = config.analysisApi.url;
  const endpoint = `${analysisApiUrl}/v2/analysis/learning/cochange`;

  try {
    // Fire and forget - don't await the response
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
      },
      body: JSON.stringify({
        session_id: sessionId,
        changed_files: changedFiles,
        project_id: projectId || 'default',
      }),
      // Short timeout since this is non-blocking
      signal: AbortSignal.timeout(config.analysisApi.timeout),
    }).then(async (response) => {
      if (response.ok) {
        logger.info('[learning] Co-change event forwarded successfully', {
          session_id: sessionId,
          files_count: changedFiles.length,
        });
      } else {
        const errorText = await response.text();
        logger.warn('[learning] Co-change forward failed', {
          session_id: sessionId,
          status: response.status,
          error: errorText,
        });
      }
    }).catch((error) => {
      // Log but don't fail - learning is non-critical
      logger.warn('[learning] Co-change forward error (non-blocking)', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    // Catch synchronous errors (shouldn't happen with fetch)
    logger.warn('[learning] Co-change forward setup error', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GET /v2/activities/execution-traces
 *
 * List execution traces with filtering and pagination
 *
 * Query params:
 * - variant_id: Filter by variant ID
 * - activity_id: Filter by activity ID
 * - success: Filter by success status (true/false)
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 * - start_date: Filter executions after this ISO timestamp
 * - end_date: Filter executions before this ISO timestamp
 */
app.get('/', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Session may be undefined for internal/unauthenticated calls
    const session = ((c.get as any)('session') as SessionData | undefined) || {
      session_id: 'internal', org_id: null, project_id: null, api_key: null, latest_job_id: null
    };

    // Parse query params
    const variantId = c.req.query('variant_id');
    const activityId = c.req.query('activity_id');
    const successParam = c.req.query('success');
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);
    const startDate = c.req.query('start_date');
    const endDate = c.req.query('end_date');
    const includeSelection = c.req.query('include_selection') === 'true';

    // Validate and cap limit
    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build SurrealDB query dynamically
    let whereConditions: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    // Multi-tenant filtering (skip when using JWT - RBAC handles it via PERMISSIONS)
    if (!useJwtAuth) {
      if (session.org_id) {
        whereConditions.push('(org_id = $org_id OR org_id = NULL)');
        params.org_id = session.org_id;
      }

      if (session.project_id) {
        whereConditions.push('(project_id = $project_id OR project_id = NULL)');
        params.project_id = session.project_id;
      }
    }

    // Filter by variant_id
    if (variantId) {
      whereConditions.push('variant_id = $variant_id');
      params.variant_id = variantId;
    }

    // Filter by activity_id
    if (activityId) {
      whereConditions.push('activity_id = $activity_id');
      params.activity_id = activityId;
    }

    // Filter by success status
    if (successParam !== undefined) {
      const success = successParam === 'true';
      whereConditions.push('success = $success');
      params.success = success;
    }

    // Filter by date range
    if (startDate) {
      whereConditions.push('executed_at >= $start_date');
      params.start_date = startDate;
    }

    if (endDate) {
      whereConditions.push('executed_at <= $end_date');
      params.end_date = endDate;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Query execution traces (ordered by most recent first)
    const query = `
      SELECT * FROM activity_execution_traces
      ${whereClause}
      ORDER BY executed_at DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching execution traces', {
      whereClause,
      params,
      query,
      authMethod: useJwtAuth ? 'jwt' : 'session',
    });

    // Execute query with appropriate auth method
    let executions: ExecutionTrace[];
    let countResult: { total: number }[];

    if (useJwtAuth && jwtAuth?.jwtToken) {
      // JWT AUTH PATH: Use RBAC-enforced query
      executions = await queryWithAuth<ExecutionTrace>(jwtAuth.jwtToken, query, params);
      const countQuery = `
        SELECT count() as total FROM activity_execution_traces
        ${whereClause}
        GROUP ALL
      `;
      countResult = await queryWithAuth<{ total: number }>(jwtAuth.jwtToken, countQuery, params);
    } else {
      // LEGACY PATH: Direct query with application-level filtering
      executions = await surrealDB.query<ExecutionTrace>(query, params);
      const countQuery = `
        SELECT count() as total FROM activity_execution_traces
        ${whereClause}
        GROUP ALL
      `;
      countResult = await surrealDB.query<{ total: number }>(countQuery, params);
    }

    logger.info('Raw executions result from SurrealDB', {
      executionsType: typeof executions,
      executionsIsArray: Array.isArray(executions),
      executionsLength: executions?.length || 0,
      firstExecution: executions?.[0] || null,
      rbacEnforced: useJwtAuth,
    });

    const total = countResult?.[0]?.total || 0;

    logger.info('Execution traces fetched', {
      count: executions?.length || 0,
      total,
      limit,
      offset,
      includeSelection,
    });

    // If include_selection is true, fetch selection data for each trace
    let executionsWithSelection = executions || [];
    if (includeSelection && executionsWithSelection.length > 0) {
      // Collect correlation_ids from traces that have them
      const correlationIds = executionsWithSelection
        .filter((e: any) => e.correlation_id)
        .map((e: any) => e.correlation_id);

      // Collect activity_ids for traces without correlation_id
      const activityIds = executionsWithSelection
        .filter((e: any) => !e.correlation_id)
        .map((e: any) => e.activity_id || e.variant_id);

      // Batch fetch selection data
      let selectionByCorrelation = new Map<string, any>();
      let selectionByActivity = new Map<string, any>();

      try {
        // Fetch by correlation_id (exact match)
        if (correlationIds.length > 0) {
          const correlationQuery = `
            SELECT
              correlation_id,
              thompson_sample,
              alpha,
              beta,
              selection_method,
              candidates_count,
              selected_at
            FROM thompson_selection_log
            WHERE correlation_id IN $correlation_ids
          `;
          const correlationResults = await surrealDB.query<any>(correlationQuery, {
            correlation_ids: correlationIds,
          });
          for (const sel of correlationResults || []) {
            selectionByCorrelation.set(sel.correlation_id, sel);
          }
        }

        // Fetch most recent by activity_id (fallback for traces without correlation_id)
        if (activityIds.length > 0) {
          const activityQuery = `
            SELECT
              activity_id,
              thompson_sample,
              alpha,
              beta,
              selection_method,
              candidates_count,
              selected_at,
              correlation_id
            FROM thompson_selection_log
            WHERE activity_id IN $activity_ids
            ORDER BY selected_at DESC
          `;
          const activityResults = await surrealDB.query<any>(activityQuery, {
            activity_ids: [...new Set(activityIds)], // Dedupe
          });
          // Take most recent per activity
          for (const sel of activityResults || []) {
            if (!selectionByActivity.has(sel.activity_id)) {
              selectionByActivity.set(sel.activity_id, sel);
            }
          }
        }

        // Attach selection_attribution to each trace
        executionsWithSelection = executionsWithSelection.map((trace: any) => {
          let selectionData = null;
          let matchType: 'exact' | 'activity_fallback' | null = null;

          if (trace.correlation_id && selectionByCorrelation.has(trace.correlation_id)) {
            const sel = selectionByCorrelation.get(trace.correlation_id);
            selectionData = {
              selection_probability: sel.thompson_sample,
              selection_method: sel.selection_method,
              alpha_at_selection: sel.alpha,
              beta_at_selection: sel.beta,
              candidates_count: sel.candidates_count,
              selected_at: sel.selected_at,
              match_type: 'exact' as const,
            };
          } else {
            const activityKey = trace.activity_id || trace.variant_id;
            if (selectionByActivity.has(activityKey)) {
              const sel = selectionByActivity.get(activityKey);
              selectionData = {
                selection_probability: sel.thompson_sample,
                selection_method: sel.selection_method,
                alpha_at_selection: sel.alpha,
                beta_at_selection: sel.beta,
                candidates_count: sel.candidates_count,
                selected_at: sel.selected_at,
                match_type: 'activity_fallback' as const,
              };
            }
          }

          return {
            ...trace,
            selection_attribution: selectionData,
          };
        });

        logger.info('Selection attribution added to traces', {
          byCorrelation: selectionByCorrelation.size,
          byActivity: selectionByActivity.size,
          totalTraces: executionsWithSelection.length,
        });
      } catch (selectionError) {
        logger.warn('Failed to fetch selection data for list', {
          error: selectionError instanceof Error ? selectionError.message : String(selectionError),
        });
        // Continue without selection data
      }
    }

    // Ensure execution_id is populated (use SurrealDB id as fallback for legacy data)
    const executionsNormalized = executionsWithSelection.map((trace: any) => ({
      ...trace,
      execution_id: trace.execution_id || trace.id?.toString().split(':')[1] || trace.id,
    }));

    const response: ListExecutionTracesResponse = {
      executions: executionsNormalized,
      total,
      limit,
      offset,
    };

    return c.json(response);

  } catch (error) {
    logger.error('Failed to list execution traces', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to list execution traces',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/:executionId
 *
 * Get detailed information about a specific execution trace
 * Enhanced with Thompson Sampling selection data for explainability (M4.2)
 */
app.get('/:executionId', async (c) => {
  try {
    const executionId = c.req.param('executionId');

    // Fetch execution trace
    const traceQuery = `
      SELECT * FROM activity_execution_traces
      WHERE execution_id = $execution_id
      LIMIT 1
    `;

    const result = await surrealDB.query<ExecutionTrace>(traceQuery, {
      execution_id: executionId,
    });

    logger.info('GET execution trace query result', {
      executionId,
      resultLength: result?.length || 0,
      result: result,
    });

    if (!result || result.length === 0) {
      logger.warn('Execution trace not found in database', {
        executionId,
        params: { execution_id: executionId },
      });
      return c.json({
        error: 'Execution trace not found',
        execution_id: executionId,
      }, 404);
    }

    const trace = result[0];

    // M4.2: Fetch Thompson Sampling selection data for explainability
    // Priority: 1) correlation_id (exact match), 2) activity_id (approximate/most recent)
    let selectionData = null;
    try {
      let selectionResult: {
        thompson_sample: number;
        alpha: number;
        beta: number;
        selection_method: string;
        candidates_count: number | null;
        selected_at: string;
        correlation_id?: string;
      }[] = [];

      // First try exact match by correlation_id if the trace has one
      if ((trace as any).correlation_id) {
        const correlationQuery = `
          SELECT
            thompson_sample,
            alpha,
            beta,
            selection_method,
            candidates_count,
            selected_at,
            correlation_id
          FROM thompson_selection_log
          WHERE correlation_id = $correlation_id
          LIMIT 1
        `;
        selectionResult = await surrealDB.query(correlationQuery, {
          correlation_id: (trace as any).correlation_id,
        });
      }

      // Fall back to activity_id match (most recent selection for this activity)
      if (!selectionResult || selectionResult.length === 0) {
        const activityQuery = `
          SELECT
            thompson_sample,
            alpha,
            beta,
            selection_method,
            candidates_count,
            selected_at,
            correlation_id
          FROM thompson_selection_log
          WHERE activity_id = $activity_id
          ORDER BY selected_at DESC
          LIMIT 1
        `;
        selectionResult = await surrealDB.query(activityQuery, {
          activity_id: trace.activity_id || trace.variant_id,
        });
      }

      if (selectionResult && selectionResult.length > 0) {
        const sel = selectionResult[0];
        selectionData = {
          selection_probability: sel.thompson_sample,
          selection_method: sel.selection_method,
          alpha_at_selection: sel.alpha,
          beta_at_selection: sel.beta,
          candidates_count: sel.candidates_count,
          selected_at: sel.selected_at,
          // Include match type for debugging
          match_type: (trace as any).correlation_id && sel.correlation_id === (trace as any).correlation_id
            ? 'exact' : 'activity_fallback',
        };
      }
    } catch (selectionError) {
      // Don't fail the request if selection data fetch fails
      logger.warn('Failed to fetch selection data', {
        executionId,
        error: selectionError instanceof Error ? selectionError.message : String(selectionError),
      });
    }

    // Return trace with optional selection data
    // Ensure execution_id is populated (use SurrealDB id as fallback for legacy data)
    const traceNormalized = {
      ...trace,
      execution_id: trace.execution_id || (trace as any).id?.toString().split(':')[1] || (trace as any).id,
      selection_attribution: selectionData,
    };

    return c.json(traceNormalized);

  } catch (error) {
    logger.error('Failed to get execution trace', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to get execution trace',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/selection-events
 *
 * List Thompson Sampling selection events for explainability dashboard (M4.1)
 *
 * Query params:
 * - activity_id: Filter by activity ID
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 * - start_date: Filter selections after this ISO timestamp
 * - end_date: Filter selections before this ISO timestamp
 */
app.get('/selection-events', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Parse query params
    const activityId = c.req.query('activity_id');
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);
    const startDate = c.req.query('start_date');
    const endDate = c.req.query('end_date');

    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build query
    const whereConditions: string[] = [];
    const params: Record<string, any> = { limit, offset };

    if (activityId) {
      whereConditions.push('activity_id = $activity_id');
      params.activity_id = activityId;
    }

    if (startDate) {
      whereConditions.push('selected_at >= $start_date');
      params.start_date = startDate;
    }

    if (endDate) {
      whereConditions.push('selected_at <= $end_date');
      params.end_date = endDate;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const query = `
      SELECT * FROM thompson_selection_log
      ${whereClause}
      ORDER BY selected_at DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching selection events', { whereClause, params });

    let events: any[];
    let countResult: { total: number }[];

    if (useJwtAuth && jwtAuth?.jwtToken) {
      events = await queryWithAuth(jwtAuth.jwtToken, query, params);
      const countQuery = `
        SELECT count() as total FROM thompson_selection_log
        ${whereClause}
        GROUP ALL
      `;
      countResult = await queryWithAuth(jwtAuth.jwtToken, countQuery, params);
    } else {
      events = await surrealDB.query(query, params);
      const countQuery = `
        SELECT count() as total FROM thompson_selection_log
        ${whereClause}
        GROUP ALL
      `;
      countResult = await surrealDB.query(countQuery, params);
    }

    const total = countResult?.[0]?.total || 0;

    logger.info('Selection events fetched', {
      count: events?.length || 0,
      total,
    });

    return c.json({
      events: events || [],
      total,
      limit,
      offset,
    });

  } catch (error) {
    logger.error('Failed to list selection events', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to list selection events',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/activities/execution-traces
 *
 * Store execution trace for future reference (debugging, ribosome, impulses)
 */
app.post('/', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);

    // Session may be undefined for internal/unauthenticated calls
    const session = ((c.get as any)('session') as SessionData | undefined) || { session_id: 'internal', org_id: null, project_id: null, api_key: null, latest_job_id: null };

    // Use JWT auth claims if available, otherwise fall back to session
    // Default to 'public' for unauthenticated/improvised executions (schema requires non-null string)
    const orgId = jwtAuth?.orgId || session?.org_id || 'public';
    const projectId = jwtAuth?.projectId || session?.project_id || null;

    const body = await c.req.json();

    // Validate required fields
    if (!body.execution_id || !body.template_id) {
      logger.warn('Missing required fields in execution trace', { body });
      return c.json({
        error: 'Missing required fields',
        required: ['execution_id', 'template_id'],
        received: Object.keys(body),
      }, 400);
    }

    // Map MiniBob's field names to database schema
    // MiniBob sends: template_id, we store as: variant_id + activity_id
    const success = body.status === 'completed' || body.success === true;
    const trace = {
      execution_id: body.execution_id,
      variant_id: body.template_id, // MiniBob's template_id maps to variant_id
      activity_id: body.activity_id || body.template_id, // Default to template_id
      success,
      status: success ? 'success' : 'failure', // Derived status for backward compatibility
      duration_ms: body.duration_ms || 0,
      cost_usd: body.cost_usd || body.cost || 0,
      // Token counts (separate fields, not nested object)
      tokens_input: body.tokens?.input || body.total_tokens || 0,
      tokens_output: body.tokens?.output || 0,
      tokens_cache: body.tokens?.cache || 0,
      // Optional string fields - only include if set (avoid NULL vs NONE issues in SurrealDB)
      ...(body.error_message ? { error_message: body.error_message } : {}),
      ...(body.error_type ? { error_type: body.error_type } : {}),
      ...(body.failed_task_id ? { failed_task_id: body.failed_task_id } : {}),
      // Only include arrays if they have content (avoid NULL vs NONE issues in SurrealDB)
      ...(body.impulses_used && body.impulses_used.length > 0 ? { impulses_used: body.impulses_used } : {}),
      ...(body.component_changes && body.component_changes.length > 0 ? { component_changes: body.component_changes } : {}),

      // Extract task details from execution_trace if available
      tasks: body.execution_trace?.tasks && body.execution_trace.tasks.length > 0
        ? body.execution_trace.tasks.map((task: any) => ({
            task_id: task.taskId || task.task_id,
            description: task.description,
            status: task.status,
            duration_ms: task.duration || task.duration_ms,
            tool_calls: task.toolCalls || null,
          }))
        : null,

      // Extract state snapshot from execution_trace
      state_snapshot: body.execution_trace
        ? {
            input_state: body.execution_trace.tasks?.[0]?.inputState || {},
            output_state: body.execution_trace.tasks?.[body.execution_trace.tasks?.length - 1]?.outputState || {},
            stateTransition: body.execution_trace.tasks?.[body.execution_trace.tasks?.length - 1]?.stateTransition || {},
          }
        : null,

      // Multi-tenancy (prefer JWT claims over session)
      org_id: orgId,
      project_id: projectId,

      // Timestamps (SurrealDB datetime type)
      executed_at: new Date(),
      created_at: new Date(),

      // Edge learning fields (from improvisation traces)
      ...(body.improvisation ? { improvisation: body.improvisation } : {}),
      ...(body.input_impulse_shapes && body.input_impulse_shapes.length > 0
        ? { input_impulse_shapes: body.input_impulse_shapes } : {}),
      ...(body.output_impulse_shapes && body.output_impulse_shapes.length > 0
        ? { output_impulse_shapes: body.output_impulse_shapes } : {}),
      ...(body.output_impulses && body.output_impulses.length > 0
        ? { output_impulses: body.output_impulses } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),

      // Selection-to-execution correlation (from /recommend endpoint)
      ...(body.correlation_id ? { correlation_id: body.correlation_id } : {}),
    };

    // ========================================================================
    // TASK #3: Activity Shape Validation
    // Validate that output_impulses match the activity's declared output_shapes
    // ========================================================================
    if (trace.success && trace.output_impulses && trace.output_impulses.length > 0) {
      try {
        // Fetch activity template to get declared output_shapes
        const activityQuery = `
          SELECT output_shapes FROM activity_template
          WHERE id = $activity_id OR variant_id = $variant_id
          LIMIT 1
        `;
        const activityResult = await surrealDB.query(activityQuery, {
          activity_id: trace.activity_id,
          variant_id: trace.variant_id,
        });

        if (activityResult && activityResult.length > 0 && activityResult[0]?.output_shapes) {
          const declaredShapes: string[] = activityResult[0].output_shapes;
          const actualShapes: string[] = trace.output_impulses.map((imp: any) =>
            typeof imp === 'string' ? imp : (imp?.shape || 'unknown')
          );

          // Compare declared vs actual
          const shapeMismatch = {
            declared: declaredShapes,
            actual: actualShapes,
            missing: declaredShapes.filter(s => !actualShapes.includes(s)),
            unexpected: actualShapes.filter(s => !declaredShapes.includes(s)),
          };

          if (shapeMismatch.missing.length > 0 || shapeMismatch.unexpected.length > 0) {
            logger.warn('[Shape Validation] Output impulse shapes do not match activity declaration', {
              execution_id: trace.execution_id,
              activity_id: trace.activity_id,
              variant_id: trace.variant_id,
              shape_mismatch: shapeMismatch,
            });

            // Store mismatch in trace metadata for learning
            if (!trace.metadata) {
              trace.metadata = {};
            }
            (trace.metadata as any).shape_validation = {
              passed: false,
              mismatch: shapeMismatch,
              validated_at: new Date().toISOString(),
            };
          } else {
            logger.info('[Shape Validation] Output impulse shapes match activity declaration', {
              execution_id: trace.execution_id,
              shapes: actualShapes,
            });

            // Store validation success in metadata
            if (!trace.metadata) {
              trace.metadata = {};
            }
            (trace.metadata as any).shape_validation = {
              passed: true,
              shapes: actualShapes,
              validated_at: new Date().toISOString(),
            };
          }
        }
      } catch (validationError) {
        // Don't fail the trace insertion if validation fails - just log
        logger.error('[Shape Validation] Failed to validate output shapes', {
          execution_id: trace.execution_id,
          error: validationError instanceof Error ? validationError.message : String(validationError),
        });
      }
    }

    // Insert into database
    // Build query dynamically to avoid NULL vs NONE issues for optional fields
    const optionalFields: string[] = [];
    // Optional string fields
    if (trace.error_message) optionalFields.push('error_message: $error_message');
    if (trace.error_type) optionalFields.push('error_type: $error_type');
    if (trace.failed_task_id) optionalFields.push('failed_task_id: $failed_task_id');
    // Optional array/object fields
    if (trace.impulses_used) optionalFields.push('impulses_used: $impulses_used');
    if (trace.component_changes) optionalFields.push('component_changes: $component_changes');
    if (trace.tasks) optionalFields.push('tasks: $tasks');
    if (trace.state_snapshot) optionalFields.push('state_snapshot: $state_snapshot');
    // Edge learning fields
    if (trace.improvisation) optionalFields.push('improvisation: $improvisation');
    if (trace.input_impulse_shapes) optionalFields.push('input_impulse_shapes: $input_impulse_shapes');
    if (trace.output_impulse_shapes) optionalFields.push('output_impulse_shapes: $output_impulse_shapes');
    if (trace.output_impulses) optionalFields.push('output_impulses: $output_impulses');
    if (trace.metadata) optionalFields.push('metadata: $metadata');
    // Selection-to-execution correlation
    if ((trace as any).correlation_id) optionalFields.push('correlation_id: $correlation_id');
    // Project ID - only include if set (MiniBob instances may not have projects)
    if (trace.project_id) optionalFields.push('project_id: $project_id');

    const optionalFieldsStr = optionalFields.length > 0 ? `,\n        ${optionalFields.join(',\n        ')}` : '';

    // NOTE: org_id is a STRING field in schema (not a record link)
    // project_id is optional - only included in query if set (handled in optionalFields)
    const query = `
      INSERT INTO activity_execution_traces {
        execution_id: $execution_id,
        variant_id: $variant_id,
        activity_id: $activity_id,
        success: $success,
        status: $status,
        duration_ms: $duration_ms,
        cost_usd: $cost_usd,
        tokens_input: $tokens_input,
        tokens_output: $tokens_output,
        tokens_cache: $tokens_cache,
        org_id: $org_id,
        executed_at: $executed_at,
        created_at: $created_at${optionalFieldsStr}
      }
    `;

    // Ensure org_id is always a non-null string (schema requirement)
    if (!trace.org_id || typeof trace.org_id !== 'string') {
      logger.info('Fixing org_id for execution trace', {
        original_org_id: trace.org_id,
        org_id_type: typeof trace.org_id
      });
      trace.org_id = 'public';
    }

    logger.debug('Executing trace query', {
      execution_id: trace.execution_id,
      org_id: trace.org_id,
      org_id_type: typeof trace.org_id
    });

    const result = await surrealDB.query(query, trace);

    // Verify INSERT succeeded
    if (!result || result.length === 0) {
      logger.error('INSERT returned no results', {
        execution_id: trace.execution_id,
        query_result: result,
      });
      return c.json({
        success: false,
        error: 'Failed to insert execution trace - no results returned',
        execution_id: trace.execution_id,
      }, 500);
    }

    logger.info('Execution trace stored', {
      execution_id: trace.execution_id,
      variant_id: trace.variant_id,
      success: trace.success,
      task_count: body.execution_trace?.tasks?.length || 0,
      db_result: result[0],
    });

    // DUAL-WRITE: Also insert into new paradigm execution table (schema-paradigm-alignment)
    // v_activity_score view computes Thompson Sampling from execution table automatically
    // P4.1: Feature flag controlled
    if (isDualWriteEnabled()) {
      try {
        // Use new fields from MiniBob (P3.1) or fallback to legacy extraction
      const inputImpulses = body.input_impulses || trace.impulses_used || [];
      // Paradigm table expects array<string> for output_impulses (impulse IDs)
      // Convert full impulse objects to shape strings for compatibility
      const rawOutputImpulses = body.output_impulses || body.execution_trace?.impulsesCreated || [];
      const outputImpulses: string[] = rawOutputImpulses.map((imp: any) =>
        typeof imp === 'string' ? imp : (imp?.shape || 'unknown')
      );

      const paradigmExecution: Partial<ParadigmExecution> = {
        id: trace.execution_id,
        activity_id: trace.variant_id,
        input_impulses: inputImpulses,
        output_impulses: outputImpulses,
        success: trace.success,
        error: trace.error_message ? {
          message: trace.error_message,
          type: trace.error_type,
          task_id: trace.failed_task_id,
        } : undefined,
        duration_ms: trace.duration_ms,
        cost_usd: trace.cost_usd,
        tokens_in: trace.tokens_input,
        tokens_out: trace.tokens_output,
        parent_execution_id: body.parent_execution_id,
        trace: {
          tasks: trace.tasks,
          state_snapshot: trace.state_snapshot,
        },
        org_id: typeof trace.org_id === 'string' ? trace.org_id : undefined,
        project_id: typeof trace.project_id === 'string' ? trace.project_id : undefined,
        vessel_id: body.vessel_id || body.pod_name,
        vessel_version: body.vessel_version,
      };

      const paradigmResult = await insertExecution(paradigmExecution, jwtAuth?.jwtToken);
      if (paradigmResult) {
        logger.info('[paradigm] Execution trace also written to execution table', {
          id: trace.execution_id,
          activity_id: trace.variant_id,
          path: 'dual-write',
        });
      }
      } catch (paradigmError) {
        // Don't fail the request if paradigm write fails - legacy write succeeded
        logger.warn('[paradigm] Dual-write to execution table failed (non-blocking)', {
          execution_id: trace.execution_id,
          error: paradigmError instanceof Error ? paradigmError.message : String(paradigmError),
        });
      }
    } // end isDualWriteEnabled()

    // ========================================================================
    // FIX 2: Update Thompson Sampling scores in activity table
    // Enables real-time learning loop: execute → update scores → recommend
    // ========================================================================
    try {
      // Increment Thompson Sampling parameters based on execution outcome
      const scoreUpdate = trace.success
        ? { thompson_alpha: 1, successful_executions: 1 }
        : { thompson_beta: 1, failed_executions: 1 };

      const updateQuery = `
        UPDATE activity
        SET
          thompson_alpha = thompson_alpha + $alpha_delta,
          thompson_beta = thompson_beta + $beta_delta,
          total_executions = total_executions + 1,
          successful_executions = successful_executions + $success_delta,
          failed_executions = failed_executions + $failure_delta,
          last_executed_at = time::now()
        WHERE id = $activity_id
        RETURN {
          id,
          thompson_alpha,
          thompson_beta,
          total_executions
        }
      `;

      const updateParams = {
        activity_id: trace.variant_id, // variant_id is the activity ID
        alpha_delta: trace.success ? 1 : 0,
        beta_delta: trace.success ? 0 : 1,
        success_delta: trace.success ? 1 : 0,
        failure_delta: trace.success ? 0 : 1,
      };

      // Use JWT auth if available for RBAC enforcement
      const updateResult = jwtAuth?.jwtToken
        ? await queryWithAuth(jwtAuth.jwtToken, updateQuery, updateParams)
        : await surrealDB.query(updateQuery, updateParams);

      if (updateResult && updateResult.length > 0) {
        logger.info('[learning] Thompson Sampling scores updated', {
          execution_id: trace.execution_id,
          activity_id: trace.variant_id,
          success: trace.success,
          new_alpha: updateResult[0].thompson_alpha,
          new_beta: updateResult[0].thompson_beta,
          total_executions: updateResult[0].total_executions,
        });

        // FIX 3: Invalidate Redis cache to ensure fresh scores in next recommendation
        try {
          const { RedisClient } = await import('../db/redis');
          const redis = RedisClient.getInstance();

          // Invalidate both the specific template cache and the template list cache
          const CACHE_KEY_PREFIX = 'activity:template:';
          const CACHE_LIST_KEY = 'activity:templates:list';

          await redis.del(`${CACHE_KEY_PREFIX}${trace.variant_id}`);
          await redis.del(CACHE_LIST_KEY);

          logger.debug('[learning] Redis cache invalidated after score update', {
            activity_id: trace.variant_id,
          });
        } catch (cacheError) {
          // Non-critical - scores will eventually propagate when cache expires
          logger.warn('[learning] Failed to invalidate Redis cache (non-blocking)', {
            execution_id: trace.execution_id,
            error: cacheError instanceof Error ? cacheError.message : String(cacheError),
          });
        }
      } else {
        logger.warn('[learning] Thompson Sampling score update returned no results', {
          execution_id: trace.execution_id,
          activity_id: trace.variant_id,
          query_params: updateParams,
        });
      }
    } catch (scoreUpdateError) {
      // Don't fail the request if score update fails - trace is already stored
      logger.error('[learning] Failed to update Thompson Sampling scores (non-blocking)', {
        execution_id: trace.execution_id,
        activity_id: trace.variant_id,
        error: scoreUpdateError instanceof Error ? scoreUpdateError.message : String(scoreUpdateError),
      });
    }

    // Update impulse shape activity scores for shape-conditioned Thompson Sampling
    // Extract input shapes from the execution trace
    const inputShapes: string[] = body.input_impulse_shapes
      || trace.input_impulse_shapes
      || (trace.metadata as any)?.inputShapes
      || (trace.metadata as any)?.input_shapes
      || [];

    if (inputShapes.length > 0 && trace.variant_id && orgId) {
      // Fire and forget - don't block the response
      updateShapeActivityScores(trace.variant_id, inputShapes, trace.success, orgId)
        .catch(err => logger.warn('[paradigm] Shape score update failed (non-blocking)', {
          execution_id: trace.execution_id,
          error: err instanceof Error ? err.message : String(err),
        }));
    }

    // M4.2: Forward to learning service (async/non-blocking)
    // Extract modified files from execution trace
    const filesModified: string[] = [];

    // From state_snapshot output_state
    if (trace.state_snapshot?.output_state?.filesModified) {
      filesModified.push(...trace.state_snapshot.output_state.filesModified);
    }
    if (trace.state_snapshot?.output_state?.filesCreated) {
      filesModified.push(...trace.state_snapshot.output_state.filesCreated);
    }

    // From execution_trace.filesModified (MiniBob format)
    if (body.execution_trace?.filesModified) {
      filesModified.push(...body.execution_trace.filesModified);
    }

    // From component_changes (if available)
    if (trace.component_changes) {
      const componentFiles = trace.component_changes
        .filter((cc: any) => cc.change_type !== 'deleted')
        .map((cc: any) => cc.file_path);
      filesModified.push(...componentFiles);
    }

    // Deduplicate
    const uniqueFiles = [...new Set(filesModified)];

    // Forward to learning (non-blocking, don't await)
    if (uniqueFiles.length >= 2) {
      const sessionId = c.req.header('X-Session-ID') || session.session_id || 'unknown';
      forwardToLearning(sessionId, uniqueFiles, projectId);
    }

    return c.json({
      success: true,
      execution_id: trace.execution_id,
      stored: true,
      trace: result[0],
    });

  } catch (error) {
    logger.error('Failed to store execution trace', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to store execution trace',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/selection-outcomes
 *
 * Query selection-to-execution correlation data (Task 15)
 * Joins thompson_selection_log with activity_execution_traces via correlation_id
 *
 * Query params:
 * - activity_id: Filter by activity ID
 * - attribution_type: Filter by attribution type ('exact' | 'pending')
 * - success: Filter by execution success (true/false)
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 * - start_date: Filter selections after this ISO timestamp
 * - end_date: Filter selections before this ISO timestamp
 */
app.get('/selection-outcomes', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Parse query params
    const activityId = c.req.query('activity_id');
    const attributionType = c.req.query('attribution_type');
    const successParam = c.req.query('success');
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);
    const startDate = c.req.query('start_date');
    const endDate = c.req.query('end_date');

    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build selection query conditions
    const selectionConditions: string[] = [];
    const params: Record<string, any> = { limit, offset };

    if (activityId) {
      selectionConditions.push('sel.activity_id = $activity_id');
      params.activity_id = activityId;
    }

    if (startDate) {
      selectionConditions.push('sel.selected_at >= $start_date');
      params.start_date = startDate;
    }

    if (endDate) {
      selectionConditions.push('sel.selected_at <= $end_date');
      params.end_date = endDate;
    }

    const selectionWhereClause = selectionConditions.length > 0
      ? `WHERE ${selectionConditions.join(' AND ')}`
      : '';

    // Step 1: Get selections from thompson_selection_log
    const selectionsQuery = `
      SELECT
        correlation_id,
        activity_id,
        thompson_sample AS selection_probability,
        alpha AS alpha_at_selection,
        beta AS beta_at_selection,
        selection_method,
        candidates_count,
        selected_at,
        org_id,
        <float> alpha / (<float> alpha + <float> beta) AS expected_success_rate
      FROM thompson_selection_log AS sel
      ${selectionWhereClause}
      ORDER BY sel.selected_at DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching selection outcomes', { selectionWhereClause, params });

    let selections: any[];
    if (useJwtAuth && jwtAuth?.jwtToken) {
      selections = await queryWithAuth(jwtAuth.jwtToken, selectionsQuery, params);
    } else {
      selections = await surrealDB.query(selectionsQuery, params);
    }

    // Step 2: Fetch execution data for correlation_ids
    const correlationIds = (selections || [])
      .filter((s: any) => s.correlation_id)
      .map((s: any) => s.correlation_id);

    let executionsByCorrelation = new Map<string, any>();

    if (correlationIds.length > 0) {
      const executionsQuery = `
        SELECT
          correlation_id,
          execution_id,
          success,
          duration_ms,
          cost_usd,
          tokens_input,
          tokens_output,
          error_type,
          executed_at
        FROM activity_execution_traces
        WHERE correlation_id IN $correlation_ids
      `;

      let executions: any[];
      if (useJwtAuth && jwtAuth?.jwtToken) {
        executions = await queryWithAuth(jwtAuth.jwtToken, executionsQuery, { correlation_ids: correlationIds });
      } else {
        executions = await surrealDB.query(executionsQuery, { correlation_ids: correlationIds });
      }

      for (const exec of executions || []) {
        executionsByCorrelation.set(exec.correlation_id, exec);
      }
    }

    // Step 3: Merge selection and execution data
    let outcomes = (selections || []).map((sel: any) => {
      const exec = executionsByCorrelation.get(sel.correlation_id);
      const hasExecution = exec !== undefined;

      return {
        // Selection data
        correlation_id: sel.correlation_id,
        activity_id: sel.activity_id,
        selection_probability: sel.selection_probability,
        alpha_at_selection: sel.alpha_at_selection,
        beta_at_selection: sel.beta_at_selection,
        selection_method: sel.selection_method,
        candidates_count: sel.candidates_count,
        selected_at: sel.selected_at,
        org_id: sel.org_id,
        expected_success_rate: sel.expected_success_rate,

        // Execution data (may be null if not yet executed)
        execution_id: exec?.execution_id || null,
        execution_success: exec?.success ?? null,
        execution_duration_ms: exec?.duration_ms || null,
        execution_cost_usd: exec?.cost_usd || null,
        execution_tokens_in: exec?.tokens_input || null,
        execution_tokens_out: exec?.tokens_output || null,
        execution_error_type: exec?.error_type || null,
        executed_at: exec?.executed_at || null,

        // Computed fields
        attribution_type: hasExecution ? 'exact' : 'pending',
        selection_to_execution_delay: hasExecution && exec.executed_at && sel.selected_at
          ? new Date(exec.executed_at).getTime() - new Date(sel.selected_at).getTime()
          : null,
      };
    });

    // Step 4: Apply post-filters (attribution_type, success)
    if (attributionType) {
      outcomes = outcomes.filter((o: any) => o.attribution_type === attributionType);
    }

    if (successParam !== undefined) {
      const success = successParam === 'true';
      outcomes = outcomes.filter((o: any) => o.execution_success === success);
    }

    // Get total count for pagination
    const countQuery = `
      SELECT count() as total FROM thompson_selection_log AS sel
      ${selectionWhereClause}
      GROUP ALL
    `;

    let countResult: { total: number }[];
    if (useJwtAuth && jwtAuth?.jwtToken) {
      countResult = await queryWithAuth(jwtAuth.jwtToken, countQuery, params);
    } else {
      countResult = await surrealDB.query(countQuery, params);
    }

    const total = countResult?.[0]?.total || 0;

    logger.info('Selection outcomes fetched', {
      count: outcomes?.length || 0,
      total,
      withExecutions: executionsByCorrelation.size,
    });

    return c.json({
      outcomes: outcomes || [],
      total,
      limit,
      offset,
    });

  } catch (error) {
    logger.error('Failed to fetch selection outcomes', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to fetch selection outcomes',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/selection-calibration
 *
 * Get Thompson Sampling calibration metrics per activity (Task 15)
 * Computes calibration error: |predicted_success_rate - actual_success_rate|
 *
 * Query params:
 * - activity_id: Filter by activity ID
 * - min_executions: Filter activities with at least N executions (default: 1)
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 */
app.get('/selection-calibration', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Parse query params
    const activityId = c.req.query('activity_id');
    const minExecutions = parseInt(c.req.query('min_executions') || '1', 10);
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);

    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build activity filter
    const activityFilter = activityId ? 'AND sel.activity_id = $activity_id' : '';
    const params: Record<string, any> = { limit, offset, min_executions: minExecutions };
    if (activityId) {
      params.activity_id = activityId;
    }

    // Query: Aggregate selection+execution data per activity
    // This computes calibration metrics at query time
    const query = `
      SELECT
        sel.activity_id AS activity_id,
        sel.org_id AS org_id,
        count(sel.correlation_id) AS total_selections,
        count(exec.execution_id) AS executed_selections,
        count(sel.correlation_id) - count(exec.execution_id) AS pending_selections,
        count(IF exec.success = true THEN 1 ELSE NONE END) AS successful_executions,
        count(IF exec.success = false THEN 1 ELSE NONE END) AS failed_executions,
        math::mean(<float> sel.alpha / (<float> sel.alpha + <float> sel.beta)) AS avg_predicted_success,
        IF count(exec.execution_id) > 0
          THEN <float> count(IF exec.success = true THEN 1 ELSE NONE END) / <float> count(exec.execution_id)
          ELSE NONE
        END AS actual_success_rate,
        math::mean(sel.thompson_sample) AS avg_thompson_sample,
        math::mean(<float> exec.duration_ms) AS avg_duration_ms,
        math::mean(<float> exec.cost_usd) AS avg_cost_usd,
        time::min(sel.selected_at) AS first_selection_at,
        time::max(sel.selected_at) AS last_selection_at,
        time::max(exec.executed_at) AS last_execution_at
      FROM thompson_selection_log AS sel
      LEFT JOIN activity_execution_traces AS exec ON sel.correlation_id = exec.correlation_id
      WHERE 1=1 ${activityFilter}
      GROUP BY sel.activity_id, sel.org_id
      HAVING count(exec.execution_id) >= $min_executions
      ORDER BY count(exec.execution_id) DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching selection calibration', { activityId, minExecutions, limit, offset });

    let calibrationRaw: any[];

    if (useJwtAuth && jwtAuth?.jwtToken) {
      calibrationRaw = await queryWithAuth(jwtAuth.jwtToken, query, params);
    } else {
      calibrationRaw = await surrealDB.query(query, params);
    }

    // Compute calibration error for each activity
    const calibration = (calibrationRaw || []).map((row: any) => {
      const predicted = row.avg_predicted_success || 0;
      const actual = row.actual_success_rate;
      const calibrationError = actual !== null && actual !== undefined
        ? Math.abs(predicted - actual)
        : null;

      return {
        ...row,
        calibration_error: calibrationError,
      };
    });

    // Sort by calibration error (worst first)
    calibration.sort((a: any, b: any) => {
      if (a.calibration_error === null) return 1;
      if (b.calibration_error === null) return -1;
      return b.calibration_error - a.calibration_error;
    });

    // Get total count
    const countQuery = `
      SELECT count() AS total FROM (
        SELECT sel.activity_id
        FROM thompson_selection_log AS sel
        LEFT JOIN activity_execution_traces AS exec ON sel.correlation_id = exec.correlation_id
        WHERE 1=1 ${activityFilter}
        GROUP BY sel.activity_id
        HAVING count(exec.execution_id) >= $min_executions
      )
      GROUP ALL
    `;

    let countResult: { total: number }[];
    if (useJwtAuth && jwtAuth?.jwtToken) {
      countResult = await queryWithAuth(jwtAuth.jwtToken, countQuery, params);
    } else {
      countResult = await surrealDB.query(countQuery, params);
    }

    const total = countResult?.[0]?.total || 0;

    logger.info('Selection calibration fetched', {
      count: calibration?.length || 0,
      total,
    });

    return c.json({
      calibration: calibration || [],
      total,
      limit,
      offset,
    });

  } catch (error) {
    logger.error('Failed to fetch selection calibration', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to fetch selection calibration',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/calibration-summary
 *
 * Get org-level Thompson Sampling calibration health summary (Task 15)
 * Aggregates calibration metrics across all activities
 */
app.get('/calibration-summary', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Query: Org-level aggregate of selection + execution correlation
    const query = `
      SELECT
        sel.org_id AS org_id,
        count(DISTINCT sel.activity_id) AS total_activities,
        count(sel.correlation_id) AS total_selections,
        count(exec.execution_id) AS total_executions,
        count(IF exec.success = true THEN 1 ELSE NONE END) AS total_successes,
        count(IF exec.success = false THEN 1 ELSE NONE END) AS total_failures,
        IF count(exec.execution_id) > 0
          THEN <float> count(IF exec.success = true THEN 1 ELSE NONE END) / <float> count(exec.execution_id)
          ELSE NONE
        END AS org_success_rate,
        math::mean(<float> sel.alpha / (<float> sel.alpha + <float> sel.beta)) AS avg_predicted_success,
        math::sum(<float> exec.cost_usd) AS total_cost_usd,
        time::min(sel.selected_at) AS first_selection_at,
        time::max(sel.selected_at) AS last_selection_at
      FROM thompson_selection_log AS sel
      LEFT JOIN activity_execution_traces AS exec ON sel.correlation_id = exec.correlation_id
      GROUP BY sel.org_id
      LIMIT 1
    `;

    logger.info('Fetching calibration summary');

    let summaryRaw: any[];

    if (useJwtAuth && jwtAuth?.jwtToken) {
      summaryRaw = await queryWithAuth(jwtAuth.jwtToken, query, {});
    } else {
      summaryRaw = await surrealDB.query(query, {});
    }

    if (!summaryRaw || summaryRaw.length === 0) {
      return c.json({
        summary: null,
        message: 'No calibration data available yet',
      });
    }

    const row = summaryRaw[0];
    const predicted = row.avg_predicted_success || 0;
    const actual = row.org_success_rate;
    const avgCalibrationError = actual !== null && actual !== undefined
      ? Math.abs(predicted - actual)
      : null;

    const summary = {
      ...row,
      avg_calibration_error: avgCalibrationError,
      // Pending selections (not yet executed)
      pending_selections: (row.total_selections || 0) - (row.total_executions || 0),
      // Execution rate
      execution_rate: row.total_selections > 0
        ? row.total_executions / row.total_selections
        : null,
    };

    logger.info('Calibration summary fetched', { summary });

    return c.json({
      summary,
    });

  } catch (error) {
    logger.error('Failed to fetch calibration summary', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to fetch calibration summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

export default app;
