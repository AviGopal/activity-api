/**
 * Execution Traces Routes
 *
 * Provides endpoints for retrieving execution traces with full state information
 * Used by dashboard to display execution history timeline
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import type { SessionData } from '../models/schemas';

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
      arguments?: Record<string, unknown>;  // Tool parameters for debugging
      error?: string;  // Error message if tool failed
      output?: string;  // Tool output if successful
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
}

interface ListExecutionTracesResponse {
  executions: ExecutionTrace[];
  total: number;
  limit: number;
  offset: number;
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
    // Session may be undefined for internal/unauthenticated calls
    const session = (c.get('session') as SessionData | undefined) || {
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

    // Validate and cap limit
    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build SurrealDB query dynamically
    let whereConditions: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    // Multi-tenant filtering
    if (session.org_id) {
      whereConditions.push('(org_id = $org_id OR org_id = NULL)');
      params.org_id = session.org_id;
    }

    if (session.project_id) {
      whereConditions.push('(project_id = $project_id OR project_id = NULL)');
      params.project_id = session.project_id;
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
    });

    const executions = await surrealDB.query<ExecutionTrace>(query, params);

    logger.info('Raw executions result from SurrealDB', {
      executionsType: typeof executions,
      executionsIsArray: Array.isArray(executions),
      executionsLength: executions?.length || 0,
      firstExecution: executions?.[0] || null,
    });

    // Count total matching records (for pagination)
    const countQuery = `
      SELECT count() as total FROM activity_execution_traces
      ${whereClause}
      GROUP ALL
    `;

    const countResult = await surrealDB.query<{ total: number }>(countQuery, params);
    const total = countResult?.[0]?.total || 0;

    logger.info('Execution traces fetched', {
      count: executions?.length || 0,
      total,
      limit,
      offset,
    });

    const response: ListExecutionTracesResponse = {
      executions: executions || [],
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
 */
app.get('/:executionId', async (c) => {
  try {
    const executionId = c.req.param('executionId');

    const query = `
      SELECT * FROM activity_execution_traces
      WHERE execution_id = $execution_id
      LIMIT 1
    `;

    const result = await surrealDB.query<ExecutionTrace>(query, {
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
        query,
        params: { execution_id: executionId },
      });
      return c.json({
        error: 'Execution trace not found',
        execution_id: executionId,
      }, 404);
    }

    return c.json(result[0]);

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
 * POST /v2/activities/execution-traces
 *
 * Store execution trace for future reference (debugging, ribosome, impulses)
 */
app.post('/', async (c) => {
  try {
    // Session may be undefined for internal/unauthenticated calls
    const session = (c.get('session') as SessionData | undefined) || { session_id: 'internal', org_id: null, project_id: null, api_key: null, latest_job_id: null };
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
      cost: body.cost_usd || body.cost || 0,
      tokens: {
        input: body.tokens?.input || 0,
        output: body.tokens?.output || 0,
        cache: body.tokens?.cache || 0,
      },
      // Optional fields - omit (undefined) if not provided to avoid NULL vs NONE issues
      // SurrealDB schema expects NONE (omitted) or value, not JSON NULL
      ...(body.error_message && { error_message: body.error_message }),
      ...(body.error_type && { error_type: body.error_type }),
      ...(body.failed_task_id && { failed_task_id: body.failed_task_id }),
      // Array fields use empty array instead of null
      impulses_used: body.impulses_used && body.impulses_used.length > 0 ? body.impulses_used : [],
      component_changes: body.component_changes && body.component_changes.length > 0 ? body.component_changes : [],

      // Extract task details from execution_trace if available
      tasks: body.execution_trace?.tasks && body.execution_trace.tasks.length > 0
        ? body.execution_trace.tasks.map((task: any) => ({
            task_id: task.taskId || task.task_id || task.id,
            description: task.description,
            status: task.status,
            duration_ms: task.duration || task.duration_ms,
            // Transform tool calls to dashboard format
            tool_calls: task.toolCalls?.map((tc: any) => ({
              tool: tc.name || tc.tool,  // MiniBob uses 'name', dashboard expects 'tool'
              duration_ms: tc.duration_ms || 0,
              success: tc.result?.success ?? tc.success ?? false,
              // Include debugging information
              arguments: tc.arguments,  // Tool parameters for debugging
              error: tc.result?.error,  // Error message if tool failed
              output: tc.result?.output,  // Tool output if successful
            })) || [],
          }))
        : [],

      // Extract state snapshot from execution_trace
      state_snapshot: body.execution_trace
        ? {
            input_state: body.execution_trace.tasks?.[0]?.inputState || {},
            output_state: body.execution_trace.tasks?.[body.execution_trace.tasks?.length - 1]?.outputState || {},
            stateTransition: body.execution_trace.tasks?.[body.execution_trace.tasks?.length - 1]?.stateTransition || {},
          }
        : null,

      // Multi-tenancy - omit if not provided
      ...(session.org_id && { org_id: session.org_id }),
      ...(session.project_id && { project_id: session.project_id }),

      // Timestamps (SurrealDB datetime type)
      executed_at: new Date(),
      created_at: new Date(),
    };

    // Build INSERT query dynamically to only include fields that are present
    // This avoids NULL vs NONE issues with optional string fields
    const fields = Object.keys(trace)
      .map(key => `${key}: $${key}`)
      .join(',\n        ');

    const query = `
      INSERT INTO activity_execution_traces {
        ${fields}
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
