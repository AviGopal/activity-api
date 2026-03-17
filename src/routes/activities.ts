/**
 * Activity Template Routes
 * 
 * Implements GET /v2/activities/templates endpoint with:
 * - Thompson Sampling scores from SurrealDB
 * - Multi-tenant filtering (org_id/project_id scope)
 * - Redis cache-aside pattern (1hr TTL)
 * 
 * Replaces Python RPC API with identical dataflows
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { logger } from '../utils/logger';
import type { SessionData } from '../models/schemas';
import { ExecutionRecordSchema, type ExecutionRecord, type ExecutionRecordResponse } from '../models/schemas';

const app = new Hono();

// Cache configuration
const TEMPLATE_CACHE_TTL = 3600; // 1 hour in seconds
const CACHE_KEY_PREFIX = 'activity:template:';
const CACHE_LIST_KEY = 'activity:templates:list';

interface ActivityTemplate {
  variant_id: string;
  activity_id: string;
  variant_name: string;
  description: string;
  category: string;
  task_steps?: any[];
  scope: string | null;
  org_id: string | null;
  project_id: string | null;
  genealogy?: Record<string, any>;
  created_at: string;
  updated_at: string;
  metrics?: {
    variant_id: string;
    activity_id: string;
    total_executions: number;
    successful_executions: number;
    failed_executions: number;
    success_rate: number;
    avg_duration_ms: number;
    avg_cost_usd: number;
    thompson_alpha: number;
    thompson_beta: number;
    total_selections?: number;
    last_executed_at?: string;
    created_at: string;
    updated_at: string;
  };
}

/**
 * Fetch all templates from SurrealDB with multi-tenant filtering
 */
async function listAllTemplatesFromDB(
  limit: number,
  orgId?: string | null,
  projectId?: string | null
): Promise<ActivityTemplate[]> {
  let query: string;
  let params: Record<string, any>;

  if (orgId) {
    if (projectId) {
      // User has both org_id and project_id: return global + org + project templates
      query = `
        SELECT * FROM activity_template
        WHERE (
          scope IS NULL
          OR scope = 'global'
          OR (scope = 'org' AND org_id = $org_id)
          OR (scope = 'project' AND project_id = $project_id)
        )
        ORDER BY created_at DESC
        LIMIT $limit
      `;
      params = { limit, org_id: orgId, project_id: projectId };
    } else {
      // User has org_id but no project_id: return global + org templates
      query = `
        SELECT * FROM activity_template
        WHERE (
          scope IS NULL
          OR scope = 'global'
          OR (scope = 'org' AND org_id = $org_id)
        )
        ORDER BY created_at DESC
        LIMIT $limit
      `;
      params = { limit, org_id: orgId };
    }
  } else {
    // No org_id: return only global templates
    query = `
      SELECT * FROM activity_template
      WHERE (
        scope IS NULL
        OR scope = 'global'
      )
      ORDER BY created_at DESC
      LIMIT $limit
    `;
    params = { limit };
  }

  logger.debug('Fetching templates from SurrealDB', { query, params });
  const result = await surrealDB.query<ActivityTemplate>(query, params);
  
  logger.info('SurrealDB templates fetched', { 
    count: result.length,
    orgId,
    projectId
  });

  return result;
}

/**
 * GET /v2/activities/templates
 * List all activity templates with Thompson Sampling scores
 */
app.get('/templates', async (c) => {
  try {
    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = session?.org_id || null;
    const projectId = session?.project_id || null;

    // Extract query parameters
    const category = c.req.query('category') || null;
    const limitStr = c.req.query('limit') || '50';
    let limit = parseInt(limitStr, 10);
    
    // Validate limit (consistent with impulses.ts pattern)
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    }
    limit = Math.min(limit, 100);

    logger.info('GET /v2/activities/templates', {
      category,
      limit,
      orgId,
      projectId,
    });

    // CACHE-ASIDE PATTERN
    // Step 1: Check Redis cache for template list
    const redis = RedisClient.getInstance();
    const templateIdsSet = await redis.smembers(CACHE_LIST_KEY);

    let templates: ActivityTemplate[] = [];
    let cacheHit = false;

    if (templateIdsSet.length > 0) {
      // CACHE HIT - Load templates from Redis
      logger.debug('Template list cache hit', { count: templateIdsSet.length });
      cacheHit = true;

      // Load each template from cache
      const templatePromises = templateIdsSet.map(async (variantId) => {
        const cachedData = await redis.get(`${CACHE_KEY_PREFIX}${variantId}`);
        if (cachedData) {
          return JSON.parse(cachedData) as ActivityTemplate;
        }
        return null;
      });

      const cachedTemplates = await Promise.all(templatePromises);
      
      // Filter out null values (cache inconsistencies)
      templates = cachedTemplates.filter((t): t is ActivityTemplate => t !== null);

      // If we have cache inconsistencies, fall back to SurrealDB
      if (templates.length < templateIdsSet.length * 0.8) {
        logger.warn('Cache inconsistency detected, falling back to SurrealDB', {
          expected: templateIdsSet.length,
          actual: templates.length
        });
        cacheHit = false;
        templates = [];
      }
    }

    if (!cacheHit) {
      // CACHE MISS - Load from SurrealDB
      logger.info('Template list cache miss, loading from SurrealDB');
      
      templates = await listAllTemplatesFromDB(limit * 2, orgId, projectId);

      // Populate Redis cache
      if (templates.length > 0) {
        const cachePromises: Promise<any>[] = [];

        for (const template of templates) {
          const variantId = template.variant_id;
          
          // Store template data with TTL
          cachePromises.push(
            redis.set(
              `${CACHE_KEY_PREFIX}${variantId}`,
              JSON.stringify(template),
              TEMPLATE_CACHE_TTL
            )
          );

          // Add to template list set
          cachePromises.push(
            redis.sadd(CACHE_LIST_KEY, variantId)
          );
        }

        await Promise.all(cachePromises);
        logger.info(`Cached ${templates.length} templates from SurrealDB`);
      }
    }

    // Filter by category if specified
    if (category) {
      templates = templates.filter((t) => t.category === category);
    }

    // Apply limit
    templates = templates.slice(0, limit);

    // Filter by scope and org_id/project_id (client-side filtering)
    // This enforces multi-tenant isolation
    templates = templates.filter((template) => {
      const scope = template.scope;
      
      // Global templates visible to all
      if (!scope || scope === 'global') {
        return true;
      }

      // Org-scoped templates visible only to users in that org
      if (scope === 'org') {
        return orgId && template.org_id === orgId;
      }

      // Project-scoped templates visible only to users in that project
      if (scope === 'project') {
        return projectId && template.project_id === projectId;
      }

      return false;
    });

    logger.info('Templates filtered and ready', {
      count: templates.length,
      category,
      scope: { orgId, projectId }
    });

    return c.json({
      templates,
      total: templates.length,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/templates failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch templates',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/templates/:variantId
 * Get specific template variant by ID
 */
app.get('/templates/:variantId', async (c) => {
  try {
    const variantId = c.req.param('variantId');
    
    logger.info('GET /v2/activities/templates/:variantId', { variantId });

    // Check Redis cache first
    const redis = RedisClient.getInstance();
    const cachedData = await redis.get(`${CACHE_KEY_PREFIX}${variantId}`);

    if (cachedData) {
      logger.debug('Template cache hit', { variantId });
      const template = JSON.parse(cachedData) as ActivityTemplate;
      return c.json(template);
    }

    // Cache miss - fetch from SurrealDB
    logger.debug('Template cache miss, fetching from SurrealDB', { variantId });
    
    const query = `
      SELECT * FROM activity_template
      WHERE variant_id = $variant_id
      LIMIT 1
    `;
    
    const result = await surrealDB.query<ActivityTemplate>(query, { variant_id: variantId });

    if (result.length === 0) {
      return c.json({
        error: 'Template not found',
        variant_id: variantId,
      }, 404);
    }

    const template = result[0];

    // Cache the result
    await redis.set(
      `${CACHE_KEY_PREFIX}${variantId}`,
      JSON.stringify(template),
      TEMPLATE_CACHE_TTL
    );

    logger.info('Template fetched from SurrealDB', { variantId });

    return c.json(template);

  } catch (error: any) {
    logger.error('GET /v2/activities/templates/:variantId failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch template',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/executions
 * Record activity execution and update Thompson Sampling metrics
 * 
 * This endpoint closes the learning loop by:
 * 1. Recording execution result in activity_executions table
 * 2. Updating variant_performance_metrics with Thompson Sampling parameters
 * 3. Invalidating Redis cache for updated template
 */
app.post('/executions', async (c) => {
  try {
    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = session?.org_id || null;
    const projectId = session?.project_id || null;

    // Parse and validate request body
    const body = await c.req.json();
    const validated = ExecutionRecordSchema.parse(body);

    logger.info('POST /v2/activities/executions', {
      variant_id: validated.variant_id,
      success: validated.success,
      duration_ms: validated.duration_ms,
      cost: validated.cost,
      orgId,
      projectId,
    });

    // Generate execution ID
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

    // Step 1: Record execution in activity_executions table
    const insertExecutionQuery = `
      INSERT INTO activity_executions {
        execution_id: $execution_id,
        variant_id: $variant_id,
        org_id: $org_id,
        project_id: $project_id,
        success: $success,
        duration_ms: $duration_ms,
        cost_usd: $cost,
        tokens_input: $tokens_input,
        tokens_output: $tokens_output,
        tokens_cache: $tokens_cache,
        error_message: $error_message,
        error_type: $error_type,
        failed_task_id: $failed_task_id,
        impulses_used: $impulses_used,
        component_changes: $component_changes,
        executed_at: time::now(),
        created_at: time::now()
      }
    `;

    await surrealDB.query(insertExecutionQuery, {
      execution_id: executionId,
      variant_id: validated.variant_id,
      org_id: orgId,
      project_id: projectId,
      success: validated.success,
      duration_ms: validated.duration_ms,
      cost: validated.cost,
      tokens_input: validated.tokens.input,
      tokens_output: validated.tokens.output,
      tokens_cache: validated.tokens.cache,
      error_message: validated.error_message || null,
      error_type: validated.error_type || null,
      failed_task_id: validated.failed_task_id || null,
      impulses_used: validated.impulses_used || [],
      component_changes: validated.component_changes || [],
    });

    logger.debug('Execution recorded in activity_executions', { executionId });

    // Step 2: Update Thompson Sampling metrics in variant_performance_metrics
    // Thompson Sampling uses Beta distribution: Beta(alpha, beta)
    // - alpha: number of successes + 1
    // - beta: number of failures + 1
    
    const updateMetricsQuery = `
      LET $current_metrics = (
        SELECT * FROM variant_performance_metrics 
        WHERE variant_id = $variant_id 
        LIMIT 1
      )[0];
      
      LET $total_executions = $current_metrics.total_executions OR 0;
      LET $successful_executions = $current_metrics.successful_executions OR 0;
      LET $failed_executions = $current_metrics.failed_executions OR 0;
      
      LET $new_total = $total_executions + 1;
      LET $new_successes = $successful_executions + (IF $success THEN 1 ELSE 0 END);
      LET $new_failures = $failed_executions + (IF $success THEN 0 ELSE 1 END);
      LET $new_success_rate = $new_successes / $new_total;
      
      LET $prev_avg_duration = $current_metrics.avg_duration_ms OR 0;
      LET $prev_avg_cost = $current_metrics.avg_cost_usd OR 0;
      
      LET $new_avg_duration = (($prev_avg_duration * $total_executions) + $duration_ms) / $new_total;
      LET $new_avg_cost = (($prev_avg_cost * $total_executions) + $cost) / $new_total;
      
      LET $thompson_alpha = $new_successes + 1;
      LET $thompson_beta = $new_failures + 1;
      
      UPDATE variant_performance_metrics 
      SET 
        total_executions = $new_total,
        successful_executions = $new_successes,
        failed_executions = $new_failures,
        success_rate = $new_success_rate,
        avg_duration_ms = $new_avg_duration,
        avg_cost_usd = $new_avg_cost,
        thompson_alpha = $thompson_alpha,
        thompson_beta = $thompson_beta,
        last_executed_at = time::now(),
        updated_at = time::now()
      WHERE variant_id = $variant_id
      RETURN AFTER;
    `;

    const metricsResult = await surrealDB.query(updateMetricsQuery, {
      variant_id: validated.variant_id,
      success: validated.success,
      duration_ms: validated.duration_ms,
      cost: validated.cost,
    });

    logger.info('Thompson Sampling metrics updated', {
      variant_id: validated.variant_id,
      metricsUpdated: metricsResult.length > 0,
    });

    // Step 3: Invalidate Redis cache for this template
    const redis = RedisClient.getInstance();
    await redis.del(`${CACHE_KEY_PREFIX}${validated.variant_id}`);
    await redis.srem(CACHE_LIST_KEY, validated.variant_id);

    logger.debug('Redis cache invalidated for template', {
      variant_id: validated.variant_id,
    });

    // Return response with updated metrics
    const response: ExecutionRecordResponse = {
      success: true,
      execution_id: executionId,
      metrics: metricsResult.length > 0 ? metricsResult[0] : undefined,
    };

    return c.json(response, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/executions failed', {
      error: error.message,
      stack: error.stack,
    });

    // Check if it's a validation error
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record execution',
      message: error.message,
    }, 500);
  }
});

export default app;
