/**
 * Impulse Management Routes
 * 
 * Implements impulse endpoints matching Python RPC API:
 * - POST /v2/impulses - Store impulse data with project-scoped isolation
 * - GET /v2/impulses/:id - Retrieve impulse by impulse_id with tenant filtering
 * - GET /v2/impulses - List impulses with pagination
 * 
 * Reference: repos/metabob-rpc-api/server/routes/impulse.py
 * Database: repos/metabob-rpc-api/server/db/operations/impulse_data.py
 * 
 * Multi-tenant isolation enforced via composite key: (api_key, project_id, impulse_id)
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import {
  ImpulseCreateRequestSchema,
  ImpulseResolveRequestSchema,
  type ImpulseResponse,
  type ImpulseListResponse,
  type ImpulseResolveResponse,
  type SessionData,
} from '../models/schemas';

const router = new Hono();

/**
 * POST /v2/impulses
 * Create impulse with project-scoped isolation
 * 
 * Matches Python implementation:
 * repos/metabob-rpc-api/server/routes/impulse.py:104-189
 * repos/metabob-rpc-api/server/db/operations/impulse_data.py:create_impulse
 * 
 * Flow:
 * 1. Extract session from context (authMiddleware provides api_key, project_id)
 * 2. Parse request body with ImpulseCreateRequestSchema
 * 3. Check if impulse already exists (composite key lookup)
 * 4. If exists, return 400 error
 * 5. Create impulse in SurrealDB impulse_data table
 * 6. Return 201 with impulse data
 */
router.post('/', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | null;

    // Allow internal service calls with X-Internal-Api-Key header
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    // Debug: log all headers
    logger.debug('POST /v2/impulses headers', {
      hasSession: !!session,
      hasInternalKey: !!internalApiKey,
      internalKeyPrefix: internalApiKey ? internalApiKey.substring(0, 10) + '...' : 'none',
      authorization: c.req.header('Authorization') ? 'present' : 'missing',
    });

    // Get api_key from session or internal header
    let api_key: string;
    if (session?.api_key) {
      api_key = session.api_key;
    } else if (internalApiKey) {
      api_key = internalApiKey;
      logger.debug('Using internal service api_key', { api_key: api_key.substring(0, 8) + '...' });
    } else {
      logger.warn('POST /v2/impulses: no auth', { hasSession: !!session, hasInternalKey: !!internalApiKey });
      return c.json({ error: 'Unauthorized - valid session or X-Internal-Api-Key required' }, 401);
    }

    // Parse request body
    const body = await c.req.json();
    const request = ImpulseCreateRequestSchema.parse(body);

    const { impulse_id, project_id, impulse_data } = request;
    
    logger.info('POST /v2/impulses', { 
      impulse_id, 
      project_id, 
      api_key: api_key.substring(0, 8) + '...',
      impulse_type: impulse_data.type 
    });

    // Check if impulse already exists (composite key: api_key, project_id, impulse_id)
    const existsQuery = `
      SELECT * FROM impulse_data
      WHERE impulse_id = $impulse_id
        AND api_key = $api_key
        AND project_id = $project_id
      LIMIT 1
    `;
    
    const existing = await surrealDB.query<any>(existsQuery, {
      impulse_id,
      api_key,
      project_id,
    });

    if (existing.length > 0) {
      logger.warn('Impulse already exists', { impulse_id, project_id });
      return c.json({
        error: 'Impulse already exists',
        impulse_id,
        project_id,
      }, 400);
    }

    // Create impulse record with timestamps
    const now = new Date().toISOString();
    const createQuery = `
      CREATE impulse_data CONTENT {
        impulse_id: $impulse_id,
        api_key: $api_key,
        project_id: $project_id,
        impulse_data: $impulse_data,
        created_at: $created_at,
        updated_at: $updated_at
      }
    `;

    const result = await surrealDB.query<any>(createQuery, {
      impulse_id,
      api_key,
      project_id,
      impulse_data,
      created_at: now,
      updated_at: now,
    });

    if (!result || result.length === 0) {
      throw new Error('Failed to create impulse in SurrealDB');
    }

    logger.info('Impulse created', {
      impulse_id,
      project_id,
      created_at: now,
    });

    // Return response matching Python ImpulseResponse schema
    const response: ImpulseResponse = {
      impulse_id,
      api_key,
      project_id,
      impulse_data,
      created_at: now,
      updated_at: now,
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
 * Matches Python implementation:
 * repos/metabob-rpc-api/server/routes/impulse.py:192-231
 * repos/metabob-rpc-api/server/db/operations/impulse_data.py:get_impulse
 * 
 * Flow:
 * 1. Extract session (api_key) from context
 * 2. Extract impulse_id from URL params
 * 3. Extract project_id from query params (required)
 * 4. Query SurrealDB with composite key (api_key, project_id, impulse_id)
 * 5. Return 200 with impulse data or 404 if not found
 */
router.get('/:impulseId', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | null;
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    let api_key: string;
    if (session?.api_key) {
      api_key = session.api_key;
    } else if (internalApiKey) {
      api_key = internalApiKey;
    } else {
      return c.json({ error: 'Unauthorized - valid session or X-Internal-Api-Key required' }, 401);
    }

    const impulse_id = c.req.param('impulseId');
    const project_id = c.req.query('project_id');

    if (!project_id) {
      return c.json({
        error: 'Missing required query parameter: project_id',
      }, 400);
    }

    logger.info('GET /v2/impulses/:impulseId', {
      impulse_id,
      project_id,
      api_key: api_key.substring(0, 8) + '...',
    });

    // Query with composite key for multi-tenant isolation
    const query = `
      SELECT * FROM impulse_data
      WHERE impulse_id = $impulse_id
        AND api_key = $api_key
        AND project_id = $project_id
      LIMIT 1
    `;

    const result = await surrealDB.query<any>(query, {
      impulse_id,
      api_key,
      project_id,
    });

    if (result.length === 0) {
      logger.debug('Impulse not found', { impulse_id, project_id });
      return c.json({
        error: 'Impulse not found',
        impulse_id,
        project_id,
      }, 404);
    }

    const impulse = result[0];

    logger.info('Impulse retrieved', { impulse_id, project_id });

    // Return response matching Python ImpulseResponse schema
    const response: ImpulseResponse = {
      impulse_id: impulse.impulse_id,
      api_key: impulse.api_key,
      project_id: impulse.project_id,
      impulse_data: impulse.impulse_data,
      created_at: impulse.created_at,
      updated_at: impulse.updated_at,
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
 * Matches Python implementation:
 * repos/metabob-rpc-api/server/routes/impulse.py:234-283
 * repos/metabob-rpc-api/server/db/operations/impulse_data.py:list_impulses
 * 
 * Flow:
 * 1. Extract session (api_key) from context
 * 2. Extract query params: project_id (required), limit (default=100, max=1000), offset (default=0)
 * 3. Query SurrealDB with composite key (api_key, project_id) and pagination
 * 4. Return 200 with array of impulses
 */
router.get('/', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | null;
    const internalApiKey = c.req.header('X-Internal-Api-Key');

    let api_key: string;
    if (session?.api_key) {
      api_key = session.api_key;
    } else if (internalApiKey) {
      api_key = internalApiKey;
    } else {
      return c.json({ error: 'Unauthorized - valid session or X-Internal-Api-Key required' }, 401);
    }

    const project_id = c.req.query('project_id');
    
    if (!project_id) {
      return c.json({
        error: 'Missing required query parameter: project_id',
      }, 400);
    }

    // Parse pagination params (match Python defaults)
    const limitStr = c.req.query('limit') || '100';
    const offsetStr = c.req.query('offset') || '0';
    
    let limit = parseInt(limitStr, 10);
    let offset = parseInt(offsetStr, 10);
    
    // Validate and cap limit (Python max=1000)
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
      project_id,
      limit,
      offset,
      api_key: api_key.substring(0, 8) + '...',
    });

    // Query with composite key and pagination (ORDER BY created_at DESC matches Python)
    const query = `
      SELECT * FROM impulse_data
      WHERE api_key = $api_key
        AND project_id = $project_id
      ORDER BY created_at DESC
      LIMIT $limit
      START $offset
    `;

    const result = await surrealDB.query<any>(query, {
      api_key,
      project_id,
      limit,
      offset,
    });

    logger.info('Impulses retrieved', {
      count: result.length,
      project_id,
      limit,
      offset,
    });

    // Map to ImpulseResponse schema
    const impulses: ImpulseResponse[] = result.map((impulse: any) => ({
      impulse_id: impulse.impulse_id,
      api_key: impulse.api_key,
      project_id: impulse.project_id,
      impulse_data: impulse.impulse_data,
      created_at: impulse.created_at,
      updated_at: impulse.updated_at,
    }));

    // Return response matching Python ImpulseListResponse schema
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

        // Load execution trace from database
        const query = `
          SELECT * FROM execution_traces
          WHERE execution_id = $execution_id
          LIMIT 1
        `;
        
        const result = await surrealDB.query<any>(query, {
          execution_id: pointer.executionId,
        });

        if (result.length === 0) {
          return c.json({
            success: false,
            error: `Execution trace not found: ${pointer.executionId}`,
          } as ImpulseResolveResponse, 404);
        }

        const trace = result[0];
        
        // Format execution trace as markdown
        content = formatExecutionTraceAsMarkdown(trace);
        break;
      }

      case 'activityTemplate': {
        if (!pointer.templateId) {
          return c.json({
            success: false,
            error: 'templateId required for activityTemplate pointer',
          } as ImpulseResolveResponse, 400);
        }

        // Load template from database
        const query = `
          SELECT * FROM activity_template
          WHERE variant_id = $variant_id
          LIMIT 1
        `;
        
        const result = await surrealDB.query<any>(query, {
          variant_id: pointer.templateId,
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
          SELECT * FROM execution_traces
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
            template_id,
            status,
            execution_trace.tasks.*.result.error as errors,
            execution_trace.tasks.*.toolCalls.*.result.error as tool_errors,
            created_at
          FROM execution_traces
          WHERE status = "failed" AND created_at >= $since
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
            template_id,
            duration_ms,
            cost_usd,
            execution_trace.tasks.*.toolCalls as tool_usage,
            created_at
          FROM execution_traces
          WHERE status = "completed" AND created_at >= $since
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
            template_id,
            count() as executions,
            math::mean(duration_ms) as avg_duration,
            math::mean(cost_usd) as avg_cost,
            count(status = "completed") / count() as success_rate
          FROM execution_traces
          WHERE activity_id = $activity_id
          GROUP BY template_id
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
 */
function formatExecutionTraceAsMarkdown(trace: any): string {
  const { execution_id, template_id, status, duration_ms, cost_usd, execution_trace } = trace;
  
  let md = `# Execution Trace: ${execution_id}\n\n`;
  md += `**Template**: ${template_id}\n`;
  md += `**Status**: ${status}\n`;
  md += `**Duration**: ${duration_ms}ms\n`;
  md += `**Cost**: $${cost_usd.toFixed(4)}\n\n`;
  
  if (execution_trace.goalContext) {
    md += `## Goal Context\n\n`;
    md += `**Goal**: ${execution_trace.goalContext.goal}\n`;
    md += `**Intent**: ${execution_trace.goalContext.intent}\n\n`;
  }
  
  md += `## Task Execution\n\n`;
  
  for (const task of execution_trace.tasks) {
    md += `### Task: ${task.id}\n\n`;
    md += `**Description**: ${task.description}\n\n`;
    
    if (task.inputState) {
      md += `**Input State**:\n`;
      md += `- Files available: ${task.inputState.filesAvailable.length}\n`;
      md += `- Impulses: ${task.inputState.impulses.join(', ') || 'none'}\n\n`;
    }
    
    md += `**Prompt**: \n\`\`\`\n${task.actualPrompt}\n\`\`\`\n\n`;
    
    if (task.toolCalls.length > 0) {
      md += `**Tool Calls**:\n`;
      for (const toolCall of task.toolCalls) {
        md += `- ${toolCall.name}(${JSON.stringify(toolCall.arguments).substring(0, 100)}...)\n`;
        if (toolCall.result) {
          md += `  - Success: ${toolCall.result.success}\n`;
          if (toolCall.result.error) {
            md += `  - Error: ${toolCall.result.error}\n`;
          }
        }
      }
      md += `\n`;
    }
    
    md += `**Response**: \n\`\`\`\n${task.response.substring(0, 500)}...\n\`\`\`\n\n`;
    
    if (task.outputState) {
      md += `**Output State**:\n`;
      md += `- Files modified: ${task.outputState.filesModified.join(', ') || 'none'}\n`;
      md += `- Files created: ${task.outputState.filesCreated.join(', ') || 'none'}\n`;
      if (task.outputState.stderr) {
        md += `- Stderr: ${task.outputState.stderr}\n`;
      }
      md += `\n`;
    }
    
    md += `**Result**: ${task.result.status}\n`;
    if (task.result.error) {
      md += `**Error**: ${task.result.error}\n`;
    }
    md += `\n---\n\n`;
  }
  
  if (execution_trace.filesModified.length > 0) {
    md += `## Files Modified\n\n`;
    md += execution_trace.filesModified.map((f: string) => `- ${f}`).join('\n');
    md += `\n\n`;
  }
  
  return md;
}

/**
 * Format activity template as markdown
 */
function formatTemplateAsMarkdown(template: any): string {
  let md = `# Activity Template: ${template.variant_name}\n\n`;
  md += `**ID**: ${template.variant_id}\n`;
  md += `**Category**: ${template.category}\n`;
  md += `**Description**: ${template.description}\n\n`;
  
  if (template.task_steps && template.task_steps.length > 0) {
    md += `## Tasks\n\n`;
    for (const task of template.task_steps) {
      md += `### ${task.id}\n\n`;
      md += `**Description**: ${task.description}\n`;
      md += `**Subagent**: ${task.subagent}\n`;
      md += `**Dependencies**: ${task.dependencies.join(', ') || 'none'}\n\n`;
      
      if (task.prompt.variables && task.prompt.variables.length > 0) {
        md += `**Variables**:\n`;
        for (const v of task.prompt.variables) {
          md += `- ${v.name} (${v.type})${v.required ? ' *required*' : ''}: ${v.description}\n`;
        }
        md += `\n`;
      }
      
      md += `**Prompt Template**:\n\`\`\`\n${task.prompt.template}\n\`\`\`\n\n`;
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

export default router;
