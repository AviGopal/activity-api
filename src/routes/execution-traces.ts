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
import { insertExecution, isDualWriteEnabled, type ParadigmExecution } from '../db/paradigm';

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

    const response: ListExecutionTracesResponse = {
      executions: executionsWithSelection,
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
    return c.json({
      ...trace,
      selection_attribution: selectionData,
    });

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
    const orgId = jwtAuth?.orgId || session.org_id || null;
    const projectId = jwtAuth?.projectId || session.project_id || null;

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
    const trace = {
      execution_id: body.execution_id,
      variant_id: body.template_id, // MiniBob's template_id maps to variant_id
      activity_id: body.activity_id || body.template_id, // Default to template_id
      success: body.status === 'completed' || body.success === true,
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

    const optionalFieldsStr = optionalFields.length > 0 ? `,\n        ${optionalFields.join(',\n        ')}` : '';

    // NOTE: org_id is a STRING field in schema (not a record link)
    // project_id is option<record<projects>> but can be passed as string if set
    const query = `
      INSERT INTO activity_execution_traces {
        execution_id: $execution_id,
        variant_id: $variant_id,
        activity_id: $activity_id,
        success: $success,
        duration_ms: $duration_ms,
        cost_usd: $cost_usd,
        tokens_input: $tokens_input,
        tokens_output: $tokens_output,
        tokens_cache: $tokens_cache,
        org_id: $org_id,
        project_id: $project_id,
        executed_at: $executed_at,
        created_at: $created_at${optionalFieldsStr}
      }
    `;

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

export default app;
