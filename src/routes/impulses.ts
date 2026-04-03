/**
 * Impulse Management Routes
 *
 * Implements impulse endpoints using the new `impulse` table schema:
 * - POST /v2/impulses - Create impulse with org-scoped isolation
 * - GET /v2/impulses/:id - Retrieve impulse by ID
 * - GET /v2/impulses - List impulses with pagination
 * - POST /v2/impulses/resolve - Resolve impulse pointers to content
 * - POST /v2/impulses/:id/usage - Track impulse usage for analytics
 *
 * Multi-tenant isolation enforced via SurrealDB PERMISSIONS (org_id from JWT auth).
 */

import { Hono } from 'hono';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import {
  ImpulseCreateRequestSchema,
  ImpulseResolveRequestSchema,
  type ImpulseResponse,
  type ImpulseListResponse,
  type ImpulseResolveResponse,
  type SessionData,
} from '../models/schemas';
import { config } from '../config';
import {
  formatAnalysisResultAsMarkdown,
  formatCochangeAsMarkdown,
  formatImpactAsMarkdown,
  formatSearchResultsAsMarkdown,
} from '../services/impulse-formatters';
import { getJwtAuthFromContext, type JwtAuthContext } from '../middleware/jwtAuth';
import activitiesRouter from './activities';

const router = new Hono();

/**
 * Proxy request to Analysis API [DEPRECATED - ARCHITECTURE DRIFT]
 *
 * TODO: This violates "Resolvers live WHERE THE DATA IS" principle.
 *
 * PROBLEM: The activity-api backend is proxying Analysis API data through
 * impulse resolution. This makes the backend act as a universal resolver
 * instead of letting vessels access the Analysis API directly.
 *
 * SOLUTION: Analysis API should provide its own /v2/impulses/resolve endpoint
 * - Vessels can call Analysis API directly for their impulse types
 * - Analysis API resolves impulses like 'analysisResult', 'cochangeSuggestions', etc.
 * - Activity-api backend only stores traces, doesn't proxy data
 *
 * This function is retained for reference but analysis types now return
 * an error directing vessels to use the Analysis API directly.
 *
 * Original: Proxy request to Analysis API with retry and timeout
 * Returns null on failure (graceful degradation)
 */
async function proxyToAnalysisApi<T>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    sessionId?: string;
    params?: Record<string, string | number>;
  } = {}
): Promise<T | null> {
  const { method = 'GET', body, sessionId, params } = options;
  const baseUrl = config.analysisApi.url;

  // Build URL with query params
  let url = `${baseUrl}${endpoint}`;
  if (params && Object.keys(params).length > 0) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      searchParams.append(key, String(value));
    }
    url += `?${searchParams.toString()}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Internal service key for service-to-service calls
    'X-Internal-Api-Key': process.env.INTERNAL_API_KEY || 'metabob-internal-service-key-dev',
  };
  if (sessionId) {
    headers['X-Session-ID'] = sessionId;
  }

  for (let attempt = 0; attempt < config.analysisApi.retryAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.analysisApi.timeout);

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn('Analysis API error', {
          endpoint,
          status: response.status,
          attempt: attempt + 1,
        });

        if (response.status >= 500 && attempt < config.analysisApi.retryAttempts - 1) {
          await new Promise(r => setTimeout(r, config.analysisApi.retryDelay * (attempt + 1)));
          continue;
        }
        return null;
      }

      return await response.json() as T;
    } catch (error) {
      logger.warn('Analysis API request failed', {
        endpoint,
        error: error instanceof Error ? error.message : 'Unknown error',
        attempt: attempt + 1,
      });

      if (attempt < config.analysisApi.retryAttempts - 1) {
        await new Promise(r => setTimeout(r, config.analysisApi.retryDelay * (attempt + 1)));
      }
    }
  }

  return null;
}

/**
 * POST /v2/impulses
 * Create impulse with org-scoped isolation
 *
 * Uses the new `impulse` table from 020-paradigm-core-tables.surql.
 * Multi-tenant isolation via org_id from JWT auth context.
 * SurrealDB PERMISSIONS handle RBAC filtering automatically.
 *
 * Flow:
 * 1. Extract org_id from JWT auth context
 * 2. Parse request body with ImpulseCreateRequestSchema
 * 3. Check if impulse already exists (by id and org_id)
 * 4. If exists, return 400 error
 * 5. Create impulse in SurrealDB impulse table
 * 6. Return 201 with impulse data
 */
router.post('/', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);

    // Allow internal service calls with X-Internal-Api-Key header
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    // Debug: log all headers
    logger.debug('POST /v2/impulses headers', {
      hasJwtAuth: !!jwtAuth,
      hasInternalKey: !!internalApiKey,
      internalKeyPrefix: internalApiKey ? internalApiKey.substring(0, 10) + '...' : 'none',
      authorization: c.req.header('Authorization') ? 'present' : 'missing',
    });

    // Get org_id from JWT auth or internal header
    let org_id: string;
    let created_by: string;

    if (jwtAuth) {
      // JWT auth from MiniBob instances or users
      org_id = jwtAuth.orgId;
      created_by = jwtAuth.instanceId || jwtAuth.orgId || 'unknown';
      logger.debug('Using JWT auth', { orgId: jwtAuth.orgId, projectId: jwtAuth.projectId });
    } else if (internalApiKey) {
      // Use record format for consistency with JWT $auth.org_id
      org_id = 'organizations:metabob_internal'; // Default for internal services
      created_by = 'internal-service';
      logger.debug('Using internal service api_key', { key: internalApiKey.substring(0, 8) + '...' });
    } else {
      logger.warn('POST /v2/impulses: no auth', { hasJwtAuth: !!jwtAuth, hasInternalKey: !!internalApiKey });
      return c.json({ error: 'Unauthorized - valid JWT token or X-Internal-Api-Key required' }, 401);
    }

    // Parse request body
    const body = await c.req.json();
    const request = ImpulseCreateRequestSchema.parse(body);

    const { impulse_id, project_id, impulse_data } = request;

    logger.info('POST /v2/impulses', {
      impulse_id,
      project_id,
      org_id: org_id.substring(0, 20) + '...',
      impulse_type: impulse_data.type
    });

    // Helper to execute queries with proper auth context
    // Use authenticated query when JWT is present (for RBAC), otherwise root
    const executeQuery = async <T>(sql: string, params: Record<string, any>): Promise<T[]> => {
      if (jwtAuth?.jwtToken) {
        logger.debug('Using authenticated query with JWT', { hasToken: true });
        return queryWithAuth<T>(jwtAuth.jwtToken, sql, params);
      }
      return surrealDB.query<T>(sql, params);
    };

    // Check if impulse already exists (by id, RBAC handles org_id filtering)
    const existsQuery = `
      SELECT id FROM impulse
      WHERE id = $impulse_id
      LIMIT 1
    `;

    const existing = await executeQuery<any>(existsQuery, {
      impulse_id,
    });

    if (existing.length > 0) {
      logger.warn('Impulse already exists', { impulse_id, project_id });
      return c.json({
        error: 'Impulse already exists',
        impulse_id,
        project_id,
      }, 400);
    }

    // Derive shape from impulse_data.type, use pointer directly from impulse_data
    const shape = impulse_data.type || 'unknown';
    // Use the pointer from impulse_data directly (already has proper structure)
    const pointer = impulse_data.pointer;

    // Build query params dynamically to avoid sending null for optional fields
    // SurrealDB's option<T> expects either a value or the field to be omitted, not null
    const params: Record<string, any> = {
      impulse_id,
      pointer,
      shape,
      metadata: impulse_data.metadata || {},
      token_estimate: impulse_data.budget || 0,
      org_id,
      project_id,
      created_by,
    };

    // Only include content if it has a value (avoid null → NULL coercion issue)
    const contentField = pointer.content ? 'content: $content,' : '';
    if (pointer.content) {
      params.content = pointer.content;
    }

    // Create impulse record using new schema
    const createQuery = `
      CREATE impulse CONTENT {
        id: $impulse_id,
        pointer: $pointer,
        shape: $shape,
        ${contentField}
        metadata: $metadata,
        token_estimate: $token_estimate,
        org_id: $org_id,
        project_id: $project_id,
        created_by: $created_by,
        created_at: time::now()
      }
    `;

    await executeQuery<any>(createQuery, params);

    // Query the created record to get timestamps
    const selectQuery = `SELECT * FROM impulse WHERE id = $impulse_id LIMIT 1`;
    const selectResult = await executeQuery<any>(selectQuery, {
      impulse_id,
    });

    if (!selectResult || selectResult.length === 0) {
      logger.error('Failed to retrieve created impulse', { impulse_id });
      throw new Error('Failed to create impulse in SurrealDB');
    }

    const created = selectResult[0];

    logger.info('Impulse created', {
      impulse_id,
      project_id,
      created_at: created.created_at,
    });

    // Return response matching ImpulseResponse schema
    // Map new schema fields back to legacy response format for compatibility
    const response: ImpulseResponse = {
      impulse_id: created.id,
      api_key: created_by, // Legacy field - use created_by
      project_id: created.project_id,
      impulse_data: {
        type: created.shape,
        content: created.content,
        ...created.pointer,
        ...created.metadata,
      },
      created_at: created.created_at,
      updated_at: created.created_at, // New schema doesn't have updated_at
    };

    return c.json(response, 201);

  } catch (error: any) {
    logger.error('POST /v2/impulses failed', {
      error: error.message,
      stack: error.stack,
    });

    // Handle Zod validation errors
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Invalid request body',
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to create impulse',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/impulses/:impulseId
 * Retrieve impulse by ID with multi-tenant isolation
 *
 * Uses the new `impulse` table from 020-paradigm-core-tables.surql.
 * SurrealDB PERMISSIONS handle org_id filtering automatically via JWT auth.
 *
 * Flow:
 * 1. Extract JWT auth context
 * 2. Extract impulse_id from URL params
 * 3. Query SurrealDB (RBAC handles org_id filtering)
 * 4. Return 200 with impulse data or 404 if not found
 */
router.get('/:impulseId', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    if (!jwtAuth && !internalApiKey) {
      return c.json({ error: 'Unauthorized - valid JWT token or X-Internal-Api-Key required' }, 401);
    }

    const impulse_id = c.req.param('impulseId');
    const project_id = c.req.query('project_id'); // Optional filter

    logger.info('GET /v2/impulses/:impulseId', {
      impulse_id,
      project_id: project_id || 'not specified',
    });

    // Query impulse by id - RBAC permissions handle org_id filtering
    let query = `SELECT * FROM impulse WHERE id = $impulse_id`;
    const params: Record<string, any> = { impulse_id };

    // Add optional project_id filter
    if (project_id) {
      query += ` AND project_id = $project_id`;
      params.project_id = project_id;
    }
    query += ` LIMIT 1`;

    // Use authenticated query when JWT is present
    let result: any[];
    if (jwtAuth?.jwtToken) {
      result = await queryWithAuth<any>(jwtAuth.jwtToken, query, params);
    } else {
      result = await surrealDB.query<any>(query, params);
    }

    if (result.length === 0) {
      logger.debug('Impulse not found', { impulse_id, project_id });
      return c.json({
        error: 'Impulse not found',
        impulse_id,
        project_id,
      }, 404);
    }

    const impulse = result[0];

    logger.info('Impulse retrieved', { impulse_id, project_id: impulse.project_id });

    // Return response mapping new schema to legacy ImpulseResponse format
    const response: ImpulseResponse = {
      impulse_id: impulse.id,
      api_key: impulse.created_by || 'unknown', // Legacy field
      project_id: impulse.project_id,
      impulse_data: {
        type: impulse.shape,
        content: impulse.content,
        ...impulse.pointer,
        ...impulse.metadata,
      },
      created_at: impulse.created_at,
      updated_at: impulse.created_at, // New schema doesn't have updated_at
    };

    return c.json(response, 200);

  } catch (error: any) {
    logger.error('GET /v2/impulses/:impulseId failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to retrieve impulse',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/impulses
 * List impulses with pagination and multi-tenant filtering
 *
 * Uses the new `impulse` table from 020-paradigm-core-tables.surql.
 * SurrealDB PERMISSIONS handle org_id filtering automatically via JWT auth.
 *
 * Flow:
 * 1. Extract JWT auth context
 * 2. Extract query params: project_id (optional), limit (default=100, max=1000), offset (default=0)
 * 3. Query SurrealDB with RBAC-enforced filtering
 * 4. Return 200 with array of impulses
 */
router.get('/', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    if (!jwtAuth && !internalApiKey) {
      return c.json({ error: 'Unauthorized - valid JWT token or X-Internal-Api-Key required' }, 401);
    }

    const project_id = c.req.query('project_id'); // Now optional

    // Parse pagination params
    const limitStr = c.req.query('limit') || '100';
    const offsetStr = c.req.query('offset') || '0';

    let limit = parseInt(limitStr, 10);
    let offset = parseInt(offsetStr, 10);

    // Validate and cap limit (max=1000)
    if (isNaN(limit) || limit < 1) {
      limit = 100;
    }
    if (limit > 1000) {
      limit = 1000;
    }

    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }

    logger.info('GET /v2/impulses', {
      project_id: project_id || 'all',
      limit,
      offset,
    });

    // Build query with optional project_id filter
    // RBAC permissions handle org_id filtering automatically
    let query = `SELECT * FROM impulse`;
    const params: Record<string, any> = { limit, offset };

    if (project_id) {
      query += ` WHERE project_id = $project_id`;
      params.project_id = project_id;
    }

    query += ` ORDER BY created_at DESC LIMIT $limit START $offset`;

    // Use authenticated query when JWT is present
    let result: any[];
    if (jwtAuth?.jwtToken) {
      result = await queryWithAuth<any>(jwtAuth.jwtToken, query, params);
    } else {
      result = await surrealDB.query<any>(query, params);
    }

    logger.info('Impulses retrieved', {
      count: result.length,
      project_id: project_id || 'all',
      limit,
      offset,
    });

    // Map new schema to legacy ImpulseResponse format
    const impulses: ImpulseResponse[] = result.map((impulse: any) => ({
      impulse_id: impulse.id,
      api_key: impulse.created_by || 'unknown', // Legacy field
      project_id: impulse.project_id,
      impulse_data: {
        type: impulse.shape,
        content: impulse.content,
        ...impulse.pointer,
        ...impulse.metadata,
      },
      created_at: impulse.created_at,
      updated_at: impulse.created_at, // New schema doesn't have updated_at
    }));

    // Return response matching ImpulseListResponse schema
    const response: ImpulseListResponse = {
      impulses,
      total: impulses.length,
      limit,
      offset,
    };

    return c.json(response, 200);

  } catch (error: any) {
    logger.error('GET /v2/impulses failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to list impulses',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/impulses/resolve
 * Resolve impulse pointer to content string
 * 
 * This endpoint enables MiniBob to delegate non-local impulse resolution to the backend.
 * 
 * Architecture (Phase 1.8 - Unified Impulse-Driven):
 * - MiniBob handles local pointers: memo, file
 * - Backend handles all others: activityExecutionTrace, activityTemplate, activityMetrics, etc.
 * - This enables backend to add new pointer types without MiniBob code changes
 * 
 * Pointer types supported:
 * - activityExecutionTrace: Format trace as markdown for debugging
 * - activityTemplate: Format template as markdown for review
 * - activityMetrics: Format metrics as structured data
 * - (Backend can add more types without MiniBob changes)
 * 
 * Flow:
 * 1. Receive pointer object { type, executionId?, templateId?, ... }
 * 2. Switch on pointer.type
 * 3. Load data from appropriate table (execution_traces, activity_template, etc.)
 * 4. Format as markdown/structured text
 * 5. Return content string
 */
router.post('/resolve', async (c) => {
  try {
    const body = await c.req.json();
    const validated = ImpulseResolveRequestSchema.parse(body);
    
    logger.info('POST /v2/impulses/resolve', { 
      pointer_type: validated.pointer.type,
      has_execution_id: !!validated.pointer.executionId,
      has_template_id: !!validated.pointer.templateId,
    });

    const { pointer } = validated;
    let content: string;

    switch (pointer.type) {
      case 'activityExecutionTrace': {
        if (!pointer.executionId) {
          return c.json({
            success: false,
            error: 'executionId required for activityExecutionTrace pointer',
          } as ImpulseResolveResponse, 400);
        }

        // PARADIGM PATH: Try new execution table first (schema-paradigm-alignment)
        let trace: any = null;
        let queryPath: 'new' | 'legacy' = 'legacy';

        try {
          const newQuery = `
            SELECT * FROM execution
            WHERE id = $execution_id
            LIMIT 1
          `;

          const newResult = await surrealDB.query<any>(newQuery, {
            execution_id: pointer.executionId,
          });

          if (newResult && newResult.length > 0) {
            trace = newResult[0];
            queryPath = 'new';

            // Load referenced impulses if includeImpulses=true
            if (pointer.includeImpulses && trace.input_impulses?.length > 0) {
              const impulseQuery = `
                SELECT id, shape, summary, content FROM impulse
                WHERE id IN $impulse_ids
              `;
              const impulses = await surrealDB.query<any>(impulseQuery, {
                impulse_ids: trace.input_impulses,
              });
              trace.resolved_impulses = impulses;
            }

            logger.debug('[paradigm] Execution trace resolved from new schema', {
              execution_id: pointer.executionId,
              path: queryPath,
              has_impulses: !!trace.resolved_impulses,
            });
          }
        } catch (error) {
          logger.warn('[paradigm] New execution table query failed, falling back', {
            execution_id: pointer.executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        // Fall back to legacy activity_execution_traces table
        if (!trace) {
          const legacyQuery = `
            SELECT * FROM activity_execution_traces
            WHERE execution_id = $execution_id
            LIMIT 1
          `;

          const legacyResult = await surrealDB.query<any>(legacyQuery, {
            execution_id: pointer.executionId,
          });

          if (legacyResult && legacyResult.length > 0) {
            trace = legacyResult[0];
            queryPath = 'legacy';
          }
        }

        if (!trace) {
          return c.json({
            success: false,
            error: `Execution trace not found: ${pointer.executionId}`,
          } as ImpulseResolveResponse, 404);
        }

        logger.info('Execution trace resolved', {
          execution_id: pointer.executionId,
          path: queryPath,
        });

        // Format execution trace as markdown
        content = formatExecutionTraceAsMarkdown(trace, queryPath === 'new');
        break;
      }

      case 'activityTemplate': {
        if (!pointer.templateId) {
          return c.json({
            success: false,
            error: 'templateId required for activityTemplate pointer',
          } as ImpulseResolveResponse, 400);
        }

        // Load template from canonical 'activity' table using 'id' field
        const query = `
          SELECT * FROM activity
          WHERE id = $activity_id
          LIMIT 1
        `;

        const result = await surrealDB.query<any>(query, {
          activity_id: pointer.templateId,
        });

        if (result.length === 0) {
          return c.json({
            success: false,
            error: `Activity template not found: ${pointer.templateId}`,
          } as ImpulseResolveResponse, 404);
        }

        const template = result[0];

        // Format template as markdown
        content = formatTemplateAsMarkdown(template);
        break;
      }

      case 'activityMetrics': {
        if (!pointer.activityId) {
          return c.json({
            success: false,
            error: 'activityId required for activityMetrics pointer',
          } as ImpulseResolveResponse, 400);
        }

        // Load metrics for all variants of activity
        const query = `
          SELECT * FROM variant_performance_metrics
          WHERE activity_id = $activity_id
          ORDER BY success_rate DESC
        `;

        const result = await surrealDB.query<any>(query, {
          activity_id: pointer.activityId,
        });

        if (result.length === 0) {
          return c.json({
            success: false,
            error: `Activity metrics not found: ${pointer.activityId}`,
          } as ImpulseResolveResponse, 404);
        }

        // Format metrics as markdown table
        content = formatMetricsAsMarkdown(result);
        break;
      }

      case 'recentExecutions': {
        // Query recent executions with optional filters
        // Supports: filter (failed|successful|all), limit, activityId, templateId, since
        const filter = pointer.filter || 'all';
        const limit = pointer.limit || 10;
        const activityId = pointer.activityId;
        const templateId = pointer.templateId;
        const since = pointer.since; // ISO date string

        let whereClause = '';
        const params: Record<string, any> = { limit };

        // Build WHERE clause based on filters
        const conditions: string[] = [];

        if (filter === 'failed') {
          conditions.push('status = "failed"');
        } else if (filter === 'successful') {
          conditions.push('status = "completed"');
        }

        if (activityId) {
          conditions.push('activity_id = $activity_id');
          params.activity_id = activityId;
        }

        if (templateId) {
          conditions.push('template_id = $template_id');
          params.template_id = templateId;
        }

        if (since) {
          conditions.push('created_at >= $since');
          params.since = since;
        }

        if (conditions.length > 0) {
          whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        const query = `
          SELECT * FROM activity_execution_traces
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $limit
        `;

        const result = await surrealDB.query<any>(query, params);

        if (result.length === 0) {
          content = `# Recent Executions\n\nNo executions found matching filter: ${filter}`;
        } else {
          // Format as summary markdown with links to individual traces
          content = formatRecentExecutionsAsMarkdown(result, filter);
        }
        break;
      }

      case 'failurePatterns': {
        // Analyze failure patterns across recent executions
        // Groups failures by error type, template, and suggests improvements
        const limit = pointer.limit || 50;
        const since = pointer.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const query = `
          SELECT
            variant_id as template_id,
            status,
            execution_trace.tasks.*.result.error as errors,
            execution_trace.tasks.*.toolCalls.*.result.error as tool_errors,
            created_at
          FROM activity_execution_traces
          WHERE status = "failure" AND created_at >= $since
          ORDER BY created_at DESC
          LIMIT $limit
        `;

        const result = await surrealDB.query<any>(query, { limit, since });

        if (result.length === 0) {
          content = `# Failure Patterns\n\nNo failures found in the last 7 days. System is healthy!`;
        } else {
          content = formatFailurePatternsAsMarkdown(result);
        }
        break;
      }

      case 'successPatterns': {
        // Analyze success patterns to identify what works well
        const limit = pointer.limit || 50;
        const since = pointer.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const query = `
          SELECT
            variant_id as template_id,
            duration_ms,
            cost_usd,
            execution_trace.tasks.*.toolCalls as tool_usage,
            created_at
          FROM activity_execution_traces
          WHERE status = "success" AND created_at >= $since
          ORDER BY duration_ms ASC
          LIMIT $limit
        `;

        const result = await surrealDB.query<any>(query, { limit, since });

        if (result.length === 0) {
          content = `# Success Patterns\n\nNo successful executions found in the last 7 days.`;
        } else {
          content = formatSuccessPatternsAsMarkdown(result);
        }
        break;
      }

      case 'templateComparison': {
        // Compare performance between template variants
        if (!pointer.activityId) {
          return c.json({
            success: false,
            error: 'activityId required for templateComparison pointer',
          } as ImpulseResolveResponse, 400);
        }

        const query = `
          SELECT
            variant_id as template_id,
            count() as executions,
            math::mean(duration_ms) as avg_duration,
            math::mean(cost_usd) as avg_cost,
            count(success = true) / count() as success_rate
          FROM activity_execution_traces
          WHERE activity_id = $activity_id
          GROUP BY variant_id
          ORDER BY success_rate DESC
        `;

        const result = await surrealDB.query<any>(query, { activity_id: pointer.activityId });

        if (result.length === 0) {
          content = `# Template Comparison\n\nNo executions found for activity: ${pointer.activityId}`;
        } else {
          content = formatTemplateComparisonAsMarkdown(result, pointer.activityId);
        }
        break;
      }

      // =============================================================================
      // ANALYSIS API POINTER TYPES (M3 - Impulse Bridge) [DEPRECATED]
      // TODO: These cases violate "Resolvers live WHERE THE DATA IS"
      // Analysis API should provide its own /v2/impulses/resolve endpoint
      // Vessels should call Analysis API directly, not proxy through activity-api
      // =============================================================================

      case 'analysisResult':
      case 'cochangeSuggestions':
      case 'impactAnalysis':
      case 'codebaseSearch': {
        // Return helpful error directing vessels to Analysis API
        return c.json({
          success: false,
          error: 'resolver_moved',
          message: `Analysis API impulse types (${pointer.type}) should be resolved by calling ` +
                   `the Analysis API directly, not through activity-api. ` +
                   `This follows the "Resolvers live WHERE THE DATA IS" principle.`,
          todo: 'Analysis API should implement /v2/impulses/resolve endpoint',
          analysis_api_url: config.analysisApi.url,
          pointer_type: pointer.type,
          suggested_approach: 'Vessels should include Analysis API client code to resolve these impulse types locally'
        } as ImpulseResolveResponse, 410); // 410 Gone - permanent deprecation
      }

      /* ORIGINAL IMPLEMENTATION - COMMENTED OUT FOR REFERENCE
      case 'analysisResult': {
        // Load a single analysis problem/issue
        if (!pointer.resultId) {
          return c.json({
            success: false,
            error: 'resultId required for analysisResult pointer',
          } as ImpulseResolveResponse, 400);
        }

        const sessionId = c.req.header('X-Session-ID');
        const analysisResult = await proxyToAnalysisApi<{ problem: any }>(
          `/v2/analysis/problems/${pointer.resultId}`,
          { method: 'GET', sessionId: sessionId || undefined }
        );

        if (!analysisResult || !analysisResult.problem) {
          content = `# Analysis Result\n\nProblem not found: ${pointer.resultId}\n\n*The analysis API may be unavailable or the problem does not exist.*`;
        } else {
          content = formatAnalysisResultAsMarkdown(
            analysisResult.problem,
            pointer.format || 'full'
          );
        }
        break;
      }

      case 'cochangeSuggestions': {
        // Get co-change suggestions for components
        if (!pointer.componentIds || pointer.componentIds.length === 0) {
          return c.json({
            success: false,
            error: 'componentIds required for cochangeSuggestions pointer',
          } as ImpulseResolveResponse, 400);
        }

        const sessionId = c.req.header('X-Session-ID');

        // Extract file paths from component IDs
        const changedFiles = [...new Set(
          pointer.componentIds.map(id => id.split('::')[0])
        )];

        const cochangeResult = await proxyToAnalysisApi<{ suggestions: any[] }>(
          '/v2/analysis/cochange/suggest',
          {
            method: 'POST',
            sessionId: sessionId || undefined,
            body: {
              changed_files: changedFiles,
              limit: pointer.limit || 5,
              confidence_threshold: 0.3,
            },
          }
        );

        if (!cochangeResult || !cochangeResult.suggestions) {
          content = `# Co-Change Suggestions\n\nUnable to get co-change suggestions.\n\n*The analysis API may be unavailable or the codebase is not indexed.*`;
        } else {
          content = formatCochangeAsMarkdown(cochangeResult.suggestions);
        }
        break;
      }

      case 'impactAnalysis': {
        // Get impact analysis for changed files
        if (!pointer.changedFiles || pointer.changedFiles.length === 0) {
          return c.json({
            success: false,
            error: 'changedFiles required for impactAnalysis pointer',
          } as ImpulseResolveResponse, 400);
        }

        const sessionId = c.req.header('X-Session-ID');
        const impactResult = await proxyToAnalysisApi<any>(
          '/v2/analysis/impact',
          {
            method: 'POST',
            sessionId: sessionId || undefined,
            body: {
              changed_files: pointer.changedFiles,
              max_depth: pointer.maxDepth || 2,
              include_tests: true,
            },
          }
        );

        if (!impactResult) {
          content = `# Impact Analysis\n\nUnable to perform impact analysis.\n\n*The analysis API may be unavailable or the codebase is not indexed.*`;
        } else {
          content = formatImpactAsMarkdown(impactResult);
        }
        break;
      }

      case 'codebaseSearch': {
        // Search the indexed codebase
        if (!pointer.query) {
          return c.json({
            success: false,
            error: 'query required for codebaseSearch pointer',
          } as ImpulseResolveResponse, 400);
        }

        const sessionId = c.req.header('X-Session-ID');
        const searchResult = await proxyToAnalysisApi<{ results: any[] }>(
          '/v2/analysis/search',
          {
            method: 'POST',
            sessionId: sessionId || undefined,
            body: {
              query: pointer.query,
              limit: pointer.limit || 10,
              filters: {
                severity: pointer.severity,
                category: pointer.category,
              },
            },
          }
        );

        if (!searchResult || !searchResult.results) {
          content = `# Codebase Search: "${pointer.query}"\n\nUnable to search codebase.\n\n*The analysis API may be unavailable or the codebase is not indexed.*`;
        } else {
          content = formatSearchResultsAsMarkdown(searchResult.results, pointer.query);
        }
        break;
      }
      END COMMENTED OUT ORIGINAL IMPLEMENTATION */

      case 'problemCluster': {
        // Impulse-driven problem investigation - returns METADATA not content
        // This enables LLM to reason about problem shape before loading full data
        const sessionId = c.req.header('X-Session-ID');
        if (!sessionId) {
          return c.json({
            success: false,
            error: 'X-Session-ID header required for problemCluster pointer',
          } as ImpulseResolveResponse, 400);
        }

        // Call analysis-api impulse endpoint with filter params from pointer
        const impulseResult = await proxyToAnalysisApi<{
          success: boolean;
          loaded: boolean;
          metadata: {
            shape: string;
            rowCount: number;
            summary: string;
            bySeverity: Record<string, number>;
            byCategory: Record<string, number>;
            topIssue?: {
              category: string;
              brief: string;
              impactScore?: number;
              severity: string;
            };
            availableOps: string[];
            filterParams: {
              severity?: string[];
              category?: string[];
              status?: string;
              sessionId: string;
            };
          };
          pointer: {
            type: string;
            sessionId: string;
            severity?: string[];
            category?: string[];
            status?: string;
          };
          query_time_ms: number;
        }>(
          '/v2/analysis/problems/impulse',
          {
            method: 'POST',
            sessionId,
            body: {
              severity: pointer.severity ? (Array.isArray(pointer.severity) ? pointer.severity : [pointer.severity]) : undefined,
              category: pointer.category ? (Array.isArray(pointer.category) ? pointer.category : [pointer.category]) : undefined,
              status: pointer.status,
            },
          }
        );

        if (!impulseResult || !impulseResult.success) {
          return c.json({
            success: false,
            error: 'Unable to get problem cluster metadata from analysis API',
          } as ImpulseResolveResponse, 500);
        }

        // Return metadata response directly - NOT markdown content
        // This is the impulse-driven pattern: metadata first, drill down via process_impulse
        logger.info('problemCluster impulse resolved with metadata', {
          rowCount: impulseResult.metadata?.rowCount,
          summary: impulseResult.metadata?.summary,
          filterParams: impulseResult.metadata?.filterParams,
          pointer: impulseResult.pointer,
        });

        return c.json({
          success: true,
          loaded: false, // Metadata only, not full content
          metadata: {
            shape: impulseResult.metadata?.shape,
            rowCount: impulseResult.metadata?.rowCount,
            summary: impulseResult.metadata?.summary,
            bySeverity: impulseResult.metadata?.bySeverity,
            byCategory: impulseResult.metadata?.byCategory,
            topIssue: impulseResult.metadata?.topIssue,
            availableOps: impulseResult.metadata?.availableOps || ['filter', 'expand', 'group', 'resolve'],
            // Lineage tracking for investigation chains
            producedBy: 'problemCluster',
            producedAt: new Date().toISOString(),
          },
          // Include pointer for process_impulse operations
          content: JSON.stringify({
            pointer: impulseResult.pointer,
            filterParams: impulseResult.metadata?.filterParams,
          }),
        } as ImpulseResolveResponse, 200);
      }

      // =============================================================================
      // BOOTSTRAP TEMPLATE POINTER TYPES
      // These support the self-hosting genesis and trailblazer templates
      // =============================================================================

      case 'activityTemplateRecommendation': {
        // Search for templates similar to a goal/query
        // Used by genesis template to learn from existing templates
        const query_text = pointer.query || '';
        const category = pointer.category;
        const limit = pointer.limit || 3;

        logger.info('Resolving activityTemplateRecommendation', { query_text, category, limit });

        // Query templates with optional category filter
        let whereClause = '';
        const params: Record<string, any> = { limit };

        // Handle category filter - can be string or array
        const categoryValue = Array.isArray(category) ? category[0] : category;
        // NOTE: Category is now a soft boost in Thompson Sampling, not a hard filter
        // The /recommend endpoint handles category as a preference signal
        // if (categoryValue && categoryValue !== 'tool') {
        //   whereClause = 'WHERE category = $category';
        //   params.category = categoryValue;
        // }

        const templatesQuery = `
          SELECT variant_id, variant_name, description, category, task_steps, created_at
          FROM activity_template
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $limit
        `;

        const templates = await surrealDB.query<any>(templatesQuery, params);

        if (templates.length === 0) {
          content = `# Similar Templates\n\nNo templates found matching query: "${query_text}"`;
        } else {
          content = formatTemplateListAsMarkdown(templates, `Templates similar to: "${query_text}"`);
        }
        break;
      }

      case 'activityTemplatesByMetrics': {
        // Get top-performing templates by metrics
        // Used by genesis template to learn task structure from successful templates
        const sortBy = pointer.sortBy || 'success_rate';
        const minExecutions = pointer.minExecutions || 5;
        const limit = pointer.limit || 2;

        logger.info('Resolving activityTemplatesByMetrics', { sortBy, minExecutions, limit });

        // First get metrics for top-performing templates
        const orderField = sortBy === 'success_rate' ? 'success_rate' : 'total_executions';
        const metricsQuery = `
          SELECT variant_id, total_executions, success_rate, avg_duration_ms, avg_cost_usd
          FROM variant_performance_metrics
          WHERE total_executions >= $min_executions
          ORDER BY ${orderField} DESC
          LIMIT $limit
        `;

        const metrics = await surrealDB.query<any>(metricsQuery, {
          min_executions: minExecutions,
          limit
        });

        if (metrics.length === 0) {
          content = `# Top Performing Templates\n\nNo templates found with at least ${minExecutions} executions.`;
        } else {
          // Fetch template details for the top performers
          const variantIds = metrics.map((m: any) => m.variant_id);
          const templateQuery = `
            SELECT variant_id, variant_name, description, category, task_steps
            FROM activity_template
            WHERE variant_id IN $variant_ids
          `;
          const templateDetails = await surrealDB.query<any>(templateQuery, { variant_ids: variantIds });

          // Merge metrics with template details
          const templates = metrics.map((m: any) => {
            const template = templateDetails.find((t: any) => t.variant_id === m.variant_id) || {};
            return {
              ...template,
              total_executions: m.total_executions,
              success_rate: m.success_rate,
              avg_duration_ms: m.avg_duration_ms,
              avg_cost_usd: m.avg_cost_usd,
            };
          });

          content = formatTemplateListWithMetricsAsMarkdown(templates);
        }
        break;
      }

      case 'executionTraces': {
        // Get multiple execution traces for a template
        // Used by trailblazer template to analyze failure patterns
        const templateId = pointer.templateId;
        const success = pointer.success; // boolean or undefined
        const limit = pointer.limit || 5;

        if (!templateId) {
          return c.json({
            success: false,
            error: 'templateId required for executionTraces pointer',
          } as ImpulseResolveResponse, 400);
        }

        logger.info('Resolving executionTraces', { templateId, success, limit });

        let whereClause = 'WHERE variant_id = $template_id';
        const params: Record<string, any> = { template_id: templateId, limit };

        if (success === true) {
          whereClause += ' AND status = "success"';
        } else if (success === false) {
          whereClause += ' AND (status = "failure" OR status = "failed")';
        }

        const tracesQuery = `
          SELECT execution_id, variant_id, status, duration_ms, cost_usd,
                 error_message, failed_task_id, execution_trace, created_at
          FROM activity_execution_traces
          ${whereClause}
          ORDER BY created_at DESC
          LIMIT $limit
        `;

        const traces = await surrealDB.query<any>(tracesQuery, params);

        if (traces.length === 0) {
          const filterDesc = success === true ? 'successful' : success === false ? 'failed' : 'any';
          content = `# Execution Traces\n\nNo ${filterDesc} executions found for template: ${templateId}`;
        } else {
          content = formatMultipleTracesAsMarkdown(traces, templateId, success);
        }
        break;
      }

      case 'goal': {
        // Goal impulse resolver: Returns activity recommendations via Thompson Sampling
        // Used by MiniBob to get recommendations based on goal description + impulse context
        // NOTE: impulseRefs and excludeActivities are extended pointer fields not in base schema
        const extendedPointer = pointer as typeof pointer & {
          impulseRefs?: string[];
          excludeActivities?: string[];
        };

        const goalDescription = pointer.content;
        const category = pointer.category;
        const impulseRefs = extendedPointer.impulseRefs || [];
        const limit = pointer.limit || 3;
        const excludeActivities = extendedPointer.excludeActivities || [];

        // Validate required fields
        if (!goalDescription) {
          return c.json({
            success: false,
            error: 'content (goal description) required for goal pointer',
          } as ImpulseResolveResponse, 400);
        }

        logger.info('Resolving goal impulse', {
          goal: goalDescription.substring(0, 100),
          category,
          impulseRefsCount: impulseRefs.length,
          limit,
        });

        // Get session data for multi-tenant filtering
        const sessionData = (c.get as any)('session') as SessionData | undefined;
        const jwtAuth = getJwtAuthFromContext(c);
        const orgId = jwtAuth?.orgId || sessionData?.org_id || null;
        const projectId = jwtAuth?.projectId || sessionData?.project_id || null;

        // Load impulse metadata for context (optional - used by Thompson Sampling for relevance scoring)
        let impulseContext: any[] = [];
        let impulseShapes: string[] = [];
        if (impulseRefs.length > 0) {
          try {
            const contextQuery = `
              SELECT id, shape, summary FROM impulse
              WHERE id IN $impulse_ids
            `;
            impulseContext = await surrealDB.query(contextQuery, {
              impulse_ids: impulseRefs,
            });
            impulseShapes = impulseContext.map((i: any) => i.shape).filter(Boolean);
            logger.debug('Loaded impulse context for goal', {
              count: impulseContext.length,
              shapes: impulseShapes,
            });
          } catch (error) {
            logger.warn('Failed to load impulse context', {
              error: error instanceof Error ? error.message : String(error),
            });
            // Continue without context - not critical
          }
        }

        // Call internal recommendation logic (reusing existing /recommend endpoint logic)
        // This is essentially an internal API call to avoid code duplication
        try {
          const recommendRequest = new Request(`http://internal/recommend`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // Forward auth headers
              ...(jwtAuth?.jwtToken ? { 'Authorization': `Bearer ${jwtAuth.jwtToken}` } : {}),
            },
            body: JSON.stringify({
              task_description: goalDescription,
              category,
              loaded_impulses: impulseRefs,
              impulse_shapes: impulseShapes,
              limit,
              exclude_activities: excludeActivities,
            }),
          });

          const recommendResponse = await activitiesRouter.fetch(recommendRequest);

          if (!recommendResponse.ok) {
            const errorData = await recommendResponse.json() as { error?: string };
            logger.error('Recommendation request failed', {
              status: recommendResponse.status,
              error: errorData,
            });
            return c.json({
              success: false,
              error: `Failed to get recommendations: ${errorData.error || 'Unknown error'}`,
            } as ImpulseResolveResponse, 500);
          }

          const recommendData = await recommendResponse.json() as { recommendations?: any[] };
          const recommendations = recommendData.recommendations || [];

          // Format as impulse content
          const contentData = {
            recommendations,
            metadata: {
              impulse_context_size: impulseRefs.length,
              impulse_context_shapes: impulseShapes,
              sampling_method: 'thompson',
              total_candidates: recommendations.length,
            },
          };

          content = JSON.stringify(contentData, null, 2);

          // Return with metadata
          logger.info('Goal impulse resolved successfully', {
            recommendationsCount: recommendations.length,
            topActivity: recommendations[0]?.template_id,
          });

          return c.json({
            success: true,
            content,
            metadata: {
              shape: 'activityRecommendations',
              rowCount: recommendations.length,
              summary: `${recommendations.length} activities recommended for: "${goalDescription.substring(0, 50)}..."`,
              availableOps: ['select', 'execute', 'compare'],
            },
          } as ImpulseResolveResponse, 200);

        } catch (error: any) {
          logger.error('Goal impulse resolution failed', {
            error: error.message,
            stack: error.stack,
          });
          return c.json({
            success: false,
            error: `Failed to resolve goal impulse: ${error.message}`,
          } as ImpulseResolveResponse, 500);
        }
      }

      default:
        return c.json({
          success: false,
          error: `Unknown pointer type: ${pointer.type}`,
        } as ImpulseResolveResponse, 400);
    }

    logger.info('Impulse resolved successfully', {
      pointer_type: pointer.type,
      content_length: content.length,
    });

    return c.json({
      success: true,
      content,
    } as ImpulseResolveResponse, 200);

  } catch (error: any) {
    logger.error('POST /v2/impulses/resolve failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        success: false,
        error: 'Validation failed',
      } as ImpulseResolveResponse, 400);
    }

    return c.json({
      success: false,
      error: error.message,
    } as ImpulseResolveResponse, 500);
  }
});

/**
 * Format execution trace as markdown for LLM consumption
 *
 * Supports both legacy activity_execution_traces schema and new execution table schema.
 *
 * @param trace - The execution trace record
 * @param isNewSchema - If true, trace is from new `execution` table (paradigm schema)
 */
function formatExecutionTraceAsMarkdown(trace: any, isNewSchema: boolean = false): string {
  if (isNewSchema) {
    // Format new paradigm schema execution
    return formatParadigmExecutionAsMarkdown(trace);
  }

  // Format legacy activity_execution_traces schema
  const { execution_id, template_id, status, duration_ms, cost_usd, execution_trace } = trace;

  let md = `# Execution Trace: ${execution_id}\n\n`;
  md += `**Template**: ${template_id}\n`;
  md += `**Status**: ${status}\n`;
  md += `**Duration**: ${duration_ms}ms\n`;
  md += `**Cost**: $${cost_usd?.toFixed?.(4) || cost_usd || 0}\n\n`;

  if (!execution_trace) {
    md += `_No detailed trace available_\n`;
    return md;
  }

  if (execution_trace.goalContext) {
    md += `## Goal Context\n\n`;
    md += `**Goal**: ${execution_trace.goalContext.goal}\n`;
    md += `**Intent**: ${execution_trace.goalContext.intent}\n\n`;
  }

  if (execution_trace.tasks && execution_trace.tasks.length > 0) {
    md += `## Task Execution\n\n`;

    for (const task of execution_trace.tasks) {
      md += `### Task: ${task.id || task.task_id}\n\n`;
      md += `**Description**: ${task.description}\n\n`;

      if (task.inputState) {
        md += `**Input State**:\n`;
        md += `- Files available: ${task.inputState.filesAvailable?.length || 0}\n`;
        md += `- Impulses: ${task.inputState.impulses?.join(', ') || 'none'}\n\n`;
      }

      if (task.actualPrompt) {
        md += `**Prompt**: \n\`\`\`\n${task.actualPrompt}\n\`\`\`\n\n`;
      }

      if (task.toolCalls && task.toolCalls.length > 0) {
        md += `**Tool Calls**:\n`;
        for (const toolCall of task.toolCalls) {
          md += `- ${toolCall.name}(${JSON.stringify(toolCall.arguments || {}).substring(0, 100)}...)\n`;
          if (toolCall.result) {
            md += `  - Success: ${toolCall.result.success}\n`;
            if (toolCall.result.error) {
              md += `  - Error: ${toolCall.result.error}\n`;
            }
          }
        }
        md += `\n`;
      }

      if (task.response) {
        md += `**Response**: \n\`\`\`\n${task.response.substring(0, 500)}...\n\`\`\`\n\n`;
      }

      if (task.outputState) {
        md += `**Output State**:\n`;
        md += `- Files modified: ${task.outputState.filesModified?.join(', ') || 'none'}\n`;
        md += `- Files created: ${task.outputState.filesCreated?.join(', ') || 'none'}\n`;
        if (task.outputState.stderr) {
          md += `- Stderr: ${task.outputState.stderr}\n`;
        }
        md += `\n`;
      }

      if (task.result) {
        md += `**Result**: ${task.result.status}\n`;
        if (task.result.error) {
          md += `**Error**: ${task.result.error}\n`;
        }
      }
      md += `\n---\n\n`;
    }
  }

  if (execution_trace.filesModified && execution_trace.filesModified.length > 0) {
    md += `## Files Modified\n\n`;
    md += execution_trace.filesModified.map((f: string) => `- ${f}`).join('\n');
    md += `\n\n`;
  }

  return md;
}

/**
 * Format new paradigm execution schema as markdown
 * Handles: execution table with input_impulses, output_impulses, trace, etc.
 */
function formatParadigmExecutionAsMarkdown(exec: any): string {
  const { id, activity_id, success, duration_ms, cost_usd, trace, error, executed_at } = exec;

  let md = `# Execution: ${id}\n\n`;
  md += `**Activity**: ${activity_id}\n`;
  md += `**Success**: ${success ? '✓' : '✗'}\n`;
  md += `**Duration**: ${duration_ms}ms\n`;
  md += `**Cost**: $${cost_usd?.toFixed?.(4) || cost_usd || 0}\n`;
  md += `**Executed**: ${executed_at}\n\n`;

  // Error details
  if (error) {
    md += `## Error\n\n`;
    md += `**Type**: ${error.type || 'unknown'}\n`;
    md += `**Message**: ${error.message || 'No message'}\n`;
    if (error.task_id) {
      md += `**Failed Task**: ${error.task_id}\n`;
    }
    md += `\n`;
  }

  // Input/Output impulses
  if (exec.input_impulses && exec.input_impulses.length > 0) {
    md += `## Input Impulses\n\n`;
    for (const impulseId of exec.input_impulses) {
      md += `- ${impulseId}\n`;
    }
    md += `\n`;
  }

  if (exec.output_impulses && exec.output_impulses.length > 0) {
    md += `## Output Impulses\n\n`;
    for (const impulseId of exec.output_impulses) {
      md += `- ${impulseId}\n`;
    }
    md += `\n`;
  }

  // Resolved impulses (if loaded via includeImpulses=true)
  if (exec.resolved_impulses && exec.resolved_impulses.length > 0) {
    md += `## Resolved Impulse Content\n\n`;
    for (const impulse of exec.resolved_impulses) {
      md += `### ${impulse.id} (${impulse.shape})\n\n`;
      if (impulse.summary) {
        md += `_${impulse.summary}_\n\n`;
      }
      if (impulse.content) {
        md += `\`\`\`\n${impulse.content.substring(0, 1000)}${impulse.content.length > 1000 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
      }
    }
  }

  // Trace details (task-by-task)
  if (trace?.tasks && trace.tasks.length > 0) {
    md += `## Task Execution\n\n`;

    for (const task of trace.tasks) {
      md += `### Task: ${task.task_id || task.id}\n\n`;
      if (task.description) {
        md += `**Description**: ${task.description}\n`;
      }
      md += `**Status**: ${task.status}\n`;
      if (task.duration_ms) {
        md += `**Duration**: ${task.duration_ms}ms\n`;
      }
      md += `\n`;

      if (task.tool_calls && task.tool_calls.length > 0) {
        md += `**Tool Calls**:\n`;
        for (const call of task.tool_calls) {
          md += `- ${call.tool}: ${call.success ? '✓' : '✗'} (${call.duration_ms}ms)\n`;
        }
        md += `\n`;
      }

      md += `---\n\n`;
    }
  }

  // State transition
  if (trace?.state_snapshot) {
    md += `## State Transition\n\n`;
    const { input_state, output_state, stateTransition } = trace.state_snapshot;

    if (input_state?.filesAvailable?.length > 0) {
      md += `**Input Files**: ${input_state.filesAvailable.length} files\n`;
    }
    if (output_state?.filesModified?.length > 0) {
      md += `**Modified**: ${output_state.filesModified.join(', ')}\n`;
    }
    if (output_state?.filesCreated?.length > 0) {
      md += `**Created**: ${output_state.filesCreated.join(', ')}\n`;
    }
    md += `\n`;
  }

  return md;
}

/**
 * Format activity template as markdown
 * Uses canonical field names: id, name, tasks (not variant_id, variant_name, task_steps)
 */
function formatTemplateAsMarkdown(template: any): string {
  // Use canonical 'name' field, fall back to legacy 'variant_name'
  const name = template.name || template.variant_name;
  // Use canonical 'id' field, fall back to legacy 'variant_id'
  const id = template.id || template.variant_id;
  // Use canonical 'tasks' field, fall back to legacy 'task_steps'
  const tasks = template.tasks || template.task_steps;

  let md = `# Activity Template: ${name}\n\n`;
  md += `**ID**: ${id}\n`;
  md += `**Category**: ${template.category || 'uncategorized'}\n`;
  md += `**Description**: ${template.description}\n`;
  if (template.execution_type) {
    md += `**Execution Type**: ${template.execution_type}\n`;
  }
  if (template.input_shapes?.length) {
    md += `**Input Shapes**: ${template.input_shapes.join(', ')}\n`;
  }
  if (template.output_shapes?.length) {
    md += `**Output Shapes**: ${template.output_shapes.join(', ')}\n`;
  }
  md += `\n`;

  if (tasks && tasks.length > 0) {
    md += `## Tasks\n\n`;
    for (const task of tasks) {
      md += `### ${task.id}\n\n`;
      md += `**Description**: ${task.description}\n`;
      if (task.subagent) {
        md += `**Subagent**: ${task.subagent}\n`;
      }
      if (task.dependencies?.length > 0) {
        md += `**Dependencies**: ${task.dependencies.join(', ')}\n`;
      }
      md += `\n`;

      if (task.prompt?.variables && task.prompt.variables.length > 0) {
        md += `**Variables**:\n`;
        for (const v of task.prompt.variables) {
          md += `- ${v.name} (${v.type})${v.required ? ' *required*' : ''}: ${v.description || ''}\n`;
        }
        md += `\n`;
      }

      if (task.prompt?.template) {
        md += `**Prompt Template**:\n\`\`\`\n${task.prompt.template}\n\`\`\`\n\n`;
      }
    }
  }

  return md;
}

/**
 * Format metrics as markdown table
 */
function formatMetricsAsMarkdown(metrics: any[]): string {
  let md = `# Activity Metrics\n\n`;
  md += `| Variant | Success Rate | Executions | Avg Duration | Avg Cost | Thompson α/β |\n`;
  md += `|---------|--------------|------------|--------------|----------|-------------|\n`;

  for (const m of metrics) {
    md += `| ${m.variant_id} | ${(m.success_rate * 100).toFixed(1)}% | ${m.total_executions} | ${m.avg_duration_ms}ms | $${m.avg_cost_usd.toFixed(4)} | ${m.thompson_alpha.toFixed(1)}/${m.thompson_beta.toFixed(1)} |\n`;
  }

  return md;
}

/**
 * Format recent executions as summary markdown
 */
function formatRecentExecutionsAsMarkdown(executions: any[], filter: string): string {
  let md = `# Recent Executions (${filter})\n\n`;
  md += `Found ${executions.length} execution(s)\n\n`;
  md += `| ID | Template | Status | Duration | Cost | Time |\n`;
  md += `|----|----------|--------|----------|------|------|\n`;

  for (const exec of executions) {
    const id = exec.execution_id || exec.id;
    const template = exec.template_id || 'unknown';
    const status = exec.status || 'unknown';
    const duration = exec.duration_ms ? `${exec.duration_ms}ms` : '-';
    const cost = exec.cost_usd ? `$${exec.cost_usd.toFixed(4)}` : '-';
    const time = exec.created_at ? new Date(exec.created_at).toISOString().split('T')[0] : '-';

    md += `| ${id} | ${template} | ${status} | ${duration} | ${cost} | ${time} |\n`;
  }

  md += `\n## Execution Details\n\n`;

  for (const exec of executions.slice(0, 5)) {
    md += `### ${exec.execution_id || exec.id}\n\n`;

    if (exec.execution_trace?.goalContext) {
      md += `**Goal**: ${exec.execution_trace.goalContext.goal}\n\n`;
    }

    if (exec.status === 'failed' && exec.execution_trace?.tasks) {
      const failedTasks = exec.execution_trace.tasks.filter((t: any) => t.result?.status === 'failed');
      if (failedTasks.length > 0) {
        md += `**Failed Tasks**:\n`;
        for (const task of failedTasks) {
          md += `- ${task.id}: ${task.result?.error || 'unknown error'}\n`;
        }
        md += `\n`;
      }
    }

    md += `---\n\n`;
  }

  return md;
}

/**
 * Format failure patterns for analysis
 */
function formatFailurePatternsAsMarkdown(failures: any[]): string {
  let md = `# Failure Patterns Analysis\n\n`;
  md += `Analyzed ${failures.length} failed execution(s)\n\n`;

  // Group by template
  const byTemplate: Record<string, any[]> = {};
  for (const f of failures) {
    const template = f.template_id || 'unknown';
    if (!byTemplate[template]) {
      byTemplate[template] = [];
    }
    byTemplate[template].push(f);
  }

  md += `## Failures by Template\n\n`;
  md += `| Template | Failure Count | Most Common Error |\n`;
  md += `|----------|---------------|-------------------|\n`;

  for (const [template, executions] of Object.entries(byTemplate)) {
    // Extract errors
    const errors: string[] = [];
    for (const exec of executions) {
      if (exec.errors) {
        errors.push(...(Array.isArray(exec.errors) ? exec.errors.flat() : [exec.errors]));
      }
      if (exec.tool_errors) {
        errors.push(...(Array.isArray(exec.tool_errors) ? exec.tool_errors.flat().filter(Boolean) : []));
      }
    }

    // Find most common error
    const errorCounts: Record<string, number> = {};
    for (const err of errors.filter(Boolean)) {
      const errStr = String(err).substring(0, 50);
      errorCounts[errStr] = (errorCounts[errStr] || 0) + 1;
    }

    const sortedErrors = Object.entries(errorCounts).sort((a, b) => b[1] - a[1]);
    const mostCommon = sortedErrors.length > 0 ? sortedErrors[0][0] : 'N/A';

    md += `| ${template} | ${executions.length} | ${mostCommon}... |\n`;
  }

  md += `\n## Recommendations\n\n`;

  // Generate recommendations based on patterns
  const totalFailures = failures.length;
  const templateFailures = Object.entries(byTemplate).sort((a, b) => b[1].length - a[1].length);

  if (templateFailures.length > 0) {
    const [worstTemplate, worstFailures] = templateFailures[0];
    if (worstFailures.length > totalFailures * 0.5) {
      md += `1. **High-priority**: Template \`${worstTemplate}\` accounts for ${Math.round(worstFailures.length / totalFailures * 100)}% of failures. Consider creating a variant.\n`;
    }
  }

  md += `2. Create debug activity for templates with >3 failures\n`;
  md += `3. Review tool call patterns in failed executions\n`;

  return md;
}

/**
 * Format success patterns for analysis
 */
function formatSuccessPatternsAsMarkdown(successes: any[]): string {
  let md = `# Success Patterns Analysis\n\n`;
  md += `Analyzed ${successes.length} successful execution(s)\n\n`;

  // Calculate averages
  const totalDuration = successes.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
  const totalCost = successes.reduce((sum, s) => sum + (s.cost_usd || 0), 0);
  const avgDuration = totalDuration / successes.length;
  const avgCost = totalCost / successes.length;

  md += `## Performance Summary\n\n`;
  md += `- **Average Duration**: ${avgDuration.toFixed(0)}ms\n`;
  md += `- **Average Cost**: $${avgCost.toFixed(4)}\n`;
  md += `- **Fastest Execution**: ${Math.min(...successes.map(s => s.duration_ms || Infinity))}ms\n`;
  md += `- **Slowest Execution**: ${Math.max(...successes.map(s => s.duration_ms || 0))}ms\n\n`;

  // Group by template for comparison
  const byTemplate: Record<string, any[]> = {};
  for (const s of successes) {
    const template = s.template_id || 'unknown';
    if (!byTemplate[template]) {
      byTemplate[template] = [];
    }
    byTemplate[template].push(s);
  }

  md += `## Template Performance\n\n`;
  md += `| Template | Executions | Avg Duration | Avg Cost |\n`;
  md += `|----------|------------|--------------|----------|\n`;

  for (const [template, executions] of Object.entries(byTemplate)) {
    const avgDur = executions.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / executions.length;
    const avgCst = executions.reduce((sum, e) => sum + (e.cost_usd || 0), 0) / executions.length;

    md += `| ${template} | ${executions.length} | ${avgDur.toFixed(0)}ms | $${avgCst.toFixed(4)} |\n`;
  }

  md += `\n## Tool Usage Patterns\n\n`;

  // Analyze tool usage across successes
  const toolCounts: Record<string, number> = {};
  for (const s of successes) {
    if (s.tool_usage) {
      const tools = Array.isArray(s.tool_usage) ? s.tool_usage.flat() : [];
      for (const toolCall of tools) {
        if (toolCall?.name) {
          toolCounts[toolCall.name] = (toolCounts[toolCall.name] || 0) + 1;
        }
      }
    }
  }

  const sortedTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (sortedTools.length > 0) {
    md += `Most used tools in successful executions:\n`;
    for (const [tool, count] of sortedTools) {
      md += `- ${tool}: ${count} calls\n`;
    }
  } else {
    md += `No tool usage data available.\n`;
  }

  return md;
}

/**
 * Format a list of templates as markdown
 * Used by activityTemplateRecommendation resolver
 */
function formatTemplateListAsMarkdown(templates: any[], heading: string): string {
  let md = `# ${heading}\n\n`;
  md += `Found ${templates.length} template(s)\n\n`;

  for (const template of templates) {
    md += `## ${template.variant_name || template.variant_id}\n\n`;
    md += `**ID**: \`${template.variant_id}\`\n`;
    md += `**Category**: ${template.category}\n`;
    md += `**Description**: ${template.description || 'No description'}\n\n`;

    if (template.task_steps && template.task_steps.length > 0) {
      md += `### Task Structure (${template.task_steps.length} tasks)\n\n`;
      for (const task of template.task_steps) {
        md += `#### ${task.id}\n`;
        md += `- **Description**: ${task.description}\n`;
        md += `- **Subagent**: ${task.subagent || 'default'}\n`;
        if (task.dependencies && task.dependencies.length > 0) {
          md += `- **Dependencies**: ${task.dependencies.join(', ')}\n`;
        }
        if (task.prompt?.variables && task.prompt.variables.length > 0) {
          md += `- **Variables**: ${task.prompt.variables.map((v: any) => `${v.name} (${v.type})`).join(', ')}\n`;
        }
        md += `\n**Prompt Template**:\n\`\`\`\n${task.prompt?.template?.substring(0, 500) || 'No template'}${task.prompt?.template?.length > 500 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
      }
    }
    md += `---\n\n`;
  }

  return md;
}

/**
 * Format templates with performance metrics as markdown
 * Used by activityTemplatesByMetrics resolver
 */
function formatTemplateListWithMetricsAsMarkdown(templates: any[]): string {
  let md = `# Top Performing Templates\n\n`;
  md += `Found ${templates.length} template(s) with sufficient execution history\n\n`;

  md += `## Performance Summary\n\n`;
  md += `| Template | Success Rate | Executions | Avg Duration | Avg Cost |\n`;
  md += `|----------|--------------|------------|--------------|----------|\n`;

  for (const t of templates) {
    const successRate = t.success_rate ? `${(t.success_rate * 100).toFixed(1)}%` : 'N/A';
    const avgDuration = t.avg_duration_ms ? `${t.avg_duration_ms.toFixed(0)}ms` : 'N/A';
    const avgCost = t.avg_cost_usd ? `$${t.avg_cost_usd.toFixed(4)}` : 'N/A';
    md += `| ${t.variant_name || t.variant_id} | ${successRate} | ${t.total_executions || 0} | ${avgDuration} | ${avgCost} |\n`;
  }
  md += `\n`;

  // Detailed task structure for learning
  for (const template of templates) {
    md += `## ${template.variant_name || template.variant_id}\n\n`;
    md += `**ID**: \`${template.variant_id}\`\n`;
    md += `**Category**: ${template.category}\n`;
    md += `**Description**: ${template.description || 'No description'}\n`;
    md += `**Success Rate**: ${template.success_rate ? `${(template.success_rate * 100).toFixed(1)}%` : 'N/A'}\n\n`;

    if (template.task_steps && template.task_steps.length > 0) {
      md += `### Task Structure\n\n`;
      for (const task of template.task_steps) {
        md += `#### ${task.id}\n`;
        md += `**Description**: ${task.description}\n`;
        if (task.prompt?.template) {
          md += `\n**Prompt** (truncated):\n\`\`\`\n${task.prompt.template.substring(0, 300)}${task.prompt.template.length > 300 ? '\n...' : ''}\n\`\`\`\n`;
        }
        md += `\n`;
      }
    }
    md += `---\n\n`;
  }

  return md;
}

/**
 * Format multiple execution traces as markdown
 * Used by executionTraces resolver for trailblazer template
 */
function formatMultipleTracesAsMarkdown(traces: any[], templateId: string, successFilter?: boolean): string {
  const filterDesc = successFilter === true ? 'Successful' : successFilter === false ? 'Failed' : 'All';
  let md = `# ${filterDesc} Execution Traces for ${templateId}\n\n`;
  md += `Found ${traces.length} execution(s)\n\n`;

  // Summary table
  md += `## Summary\n\n`;
  md += `| Execution ID | Status | Duration | Cost | Time |\n`;
  md += `|--------------|--------|----------|------|------|\n`;

  for (const trace of traces) {
    const id = trace.execution_id?.substring(0, 12) || 'unknown';
    const status = trace.status || 'unknown';
    const duration = trace.duration_ms ? `${trace.duration_ms}ms` : 'N/A';
    const cost = trace.cost_usd ? `$${trace.cost_usd.toFixed(4)}` : 'N/A';
    const time = trace.created_at ? new Date(trace.created_at).toISOString().split('T')[0] : 'N/A';
    md += `| ${id}... | ${status} | ${duration} | ${cost} | ${time} |\n`;
  }
  md += `\n`;

  // Detailed traces
  for (const trace of traces) {
    md += `## Execution: ${trace.execution_id}\n\n`;
    md += `**Status**: ${trace.status}\n`;
    md += `**Duration**: ${trace.duration_ms || 'N/A'}ms\n`;
    md += `**Cost**: $${trace.cost_usd?.toFixed(4) || 'N/A'}\n\n`;

    // Error details for failed executions
    if (trace.status === 'failure' || trace.status === 'failed') {
      md += `### Error Details\n\n`;
      if (trace.error_message) {
        md += `**Error**: ${trace.error_message}\n`;
      }
      if (trace.failed_task_id) {
        md += `**Failed Task**: ${trace.failed_task_id}\n`;
      }
      md += `\n`;
    }

    // Task execution details
    if (trace.execution_trace?.tasks && trace.execution_trace.tasks.length > 0) {
      md += `### Task Execution Flow\n\n`;
      for (const task of trace.execution_trace.tasks) {
        const taskStatus = task.result?.status || task.status || 'unknown';
        const statusIcon = taskStatus === 'completed' || taskStatus === 'success' ? '✓' : taskStatus === 'failed' ? '✗' : '○';
        md += `#### ${statusIcon} ${task.id || task.task_id}\n`;

        if (task.description) {
          md += `${task.description}\n\n`;
        }

        // Tool calls
        if (task.toolCalls && task.toolCalls.length > 0) {
          md += `**Tool Calls**:\n`;
          for (const call of task.toolCalls.slice(0, 5)) { // Limit to 5 calls per task
            const callStatus = call.result?.success ? '✓' : '✗';
            md += `- ${callStatus} \`${call.name}\``;
            if (call.result?.error) {
              md += ` - Error: ${call.result.error.substring(0, 100)}`;
            }
            md += `\n`;
          }
          if (task.toolCalls.length > 5) {
            md += `- ... and ${task.toolCalls.length - 5} more calls\n`;
          }
          md += `\n`;
        }

        // Error for failed task
        if (task.result?.error) {
          md += `**Error**: ${task.result.error}\n\n`;
        }
      }
    }

    // Output state if available
    if (trace.execution_trace?.filesModified?.length > 0) {
      md += `### Files Modified\n\n`;
      for (const file of trace.execution_trace.filesModified) {
        md += `- ${file}\n`;
      }
      md += `\n`;
    }

    md += `---\n\n`;
  }

  // Pattern analysis for failed traces
  if (successFilter === false && traces.length > 1) {
    md += `## Failure Pattern Analysis\n\n`;

    // Group by failed task
    const failedTasks: Record<string, number> = {};
    const errorPatterns: Record<string, number> = {};

    for (const trace of traces) {
      if (trace.failed_task_id) {
        failedTasks[trace.failed_task_id] = (failedTasks[trace.failed_task_id] || 0) + 1;
      }
      if (trace.error_message) {
        const errorKey = trace.error_message.substring(0, 50);
        errorPatterns[errorKey] = (errorPatterns[errorKey] || 0) + 1;
      }
    }

    if (Object.keys(failedTasks).length > 0) {
      md += `**Most Common Failing Tasks**:\n`;
      const sortedTasks = Object.entries(failedTasks).sort((a, b) => b[1] - a[1]);
      for (const [task, count] of sortedTasks.slice(0, 3)) {
        md += `- \`${task}\`: ${count} failures (${Math.round(count / traces.length * 100)}%)\n`;
      }
      md += `\n`;
    }

    if (Object.keys(errorPatterns).length > 0) {
      md += `**Common Error Patterns**:\n`;
      const sortedErrors = Object.entries(errorPatterns).sort((a, b) => b[1] - a[1]);
      for (const [error, count] of sortedErrors.slice(0, 3)) {
        md += `- "${error}...": ${count} occurrences\n`;
      }
      md += `\n`;
    }
  }

  return md;
}

/**
 * Format template comparison
 */
function formatTemplateComparisonAsMarkdown(comparisons: any[], activityId: string): string {
  let md = `# Template Comparison: ${activityId}\n\n`;
  md += `Comparing ${comparisons.length} template variant(s)\n\n`;

  md += `| Template | Success Rate | Executions | Avg Duration | Avg Cost |\n`;
  md += `|----------|--------------|------------|--------------|----------|\n`;

  for (const c of comparisons) {
    const successRate = c.success_rate ? `${(c.success_rate * 100).toFixed(1)}%` : 'N/A';
    const avgDuration = c.avg_duration ? `${c.avg_duration.toFixed(0)}ms` : 'N/A';
    const avgCost = c.avg_cost ? `$${c.avg_cost.toFixed(4)}` : 'N/A';

    md += `| ${c.template_id} | ${successRate} | ${c.executions || 0} | ${avgDuration} | ${avgCost} |\n`;
  }

  md += `\n## Recommendations\n\n`;

  if (comparisons.length > 1) {
    const best = comparisons[0];
    md += `1. **Best performing variant**: \`${best.template_id}\` with ${((best.success_rate || 0) * 100).toFixed(1)}% success rate\n`;

    const worst = comparisons[comparisons.length - 1];
    if (worst.success_rate !== undefined && worst.success_rate < 0.5) {
      md += `2. **Consider deprecating**: \`${worst.template_id}\` (${((worst.success_rate || 0) * 100).toFixed(1)}% success rate)\n`;
    }

    md += `3. Use Thompson Sampling to automatically route to better variants\n`;
  } else {
    md += `1. Only one variant exists - consider creating variants for A/B testing\n`;
  }

  return md;
}

/**
 * POST /v2/impulses/:impulseId/usage
 * Track impulse usage for analytics and learning
 *
 * MiniBob calls this endpoint to record when an impulse is used in an activity.
 * This enables:
 * - Usage analytics (most/least used impulses)
 * - Cleanup of unused impulses
 * - Learning about impulse relevance
 * - Budget learning (impulse-budget-learning enhancement)
 *
 * Budget learning fields (optional):
 * - budgetRequested: original budget for this impulse
 * - wasTruncated: whether content was truncated to fit budget
 * - priorityLevel: impulse priority (critical, high, medium, low)
 * - truncationRatio: originalTokenCount / budget (>1.0 means truncation)
 *
 * Flow:
 * 1. Verify impulse exists in `impulse` table (404 if not found)
 * 2. Store usage record in impulse_usage_history (with budget metadata if provided)
 * 3. Return success (usage stats tracked via impulse_usage_history queries)
 */
router.post('/:impulseId/usage', async (c) => {
  try {
    const { impulseId } = c.req.param();
    const body = await c.req.json();

    // Core fields
    const { activityId, taskId, executionId, tokensUsed, success } = body;

    // Budget learning fields (impulse-budget-learning enhancement)
    const { budgetRequested, wasTruncated, priorityLevel, truncationRatio } = body;

    logger.info('POST /v2/impulses/:impulseId/usage', {
      impulse_id: impulseId,
      activity_id: activityId,
      task_id: taskId,
      tokens_used: tokensUsed,
      budget_requested: budgetRequested,
      was_truncated: wasTruncated,
    });

    // Check if impulse exists in new `impulse` table
    const checkQuery = `
      SELECT id FROM impulse
      WHERE id = $impulse_id
      LIMIT 1
    `;

    const existing = await surrealDB.query<any>(checkQuery, { impulse_id: impulseId });

    if (existing.length === 0) {
      return c.json({
        success: false,
        error: `Impulse not found: ${impulseId}`,
      }, 404);
    }

    // Create usage record in impulse_usage_history
    // Note: org_id and project_id would be set via $auth in RBAC context
    // Includes budget learning fields for impulse-budget-learning enhancement
    const usageQuery = `
      CREATE impulse_usage_history SET
        impulse_id = $impulse_id,
        activity_id = $activity_id,
        task_id = $task_id,
        execution_id = $execution_id,
        tokens_consumed = $tokens_consumed,
        success = $success,
        budget_requested = $budget_requested,
        was_truncated = $was_truncated,
        priority_level = $priority_level,
        truncation_ratio = $truncation_ratio,
        used_at = time::now()
    `;

    await surrealDB.query(usageQuery, {
      impulse_id: impulseId,
      activity_id: activityId || null,
      task_id: taskId || null,
      execution_id: executionId || null,
      tokens_consumed: tokensUsed || 0,
      success: success ?? true,
      // Budget learning fields (null if not provided)
      budget_requested: budgetRequested ?? null,
      was_truncated: wasTruncated ?? null,
      priority_level: priorityLevel ?? null,
      truncation_ratio: truncationRatio ?? null,
    });

    // Note: In new schema, usage stats are tracked via impulse_usage_history queries.
    // The `impulse` table does not have usage_count/last_used_at fields.
    // Usage analytics should query impulse_usage_history instead.

    logger.info('Impulse usage recorded', {
      impulse_id: impulseId,
      was_truncated: wasTruncated,
      truncation_ratio: truncationRatio,
    });

    return c.json({ success: true }, 200);

  } catch (error: any) {
    logger.error('POST /v2/impulses/:impulseId/usage failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      success: false,
      error: error.message,
    }, 500);
  }
});

export default router;
