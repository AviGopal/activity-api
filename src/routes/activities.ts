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
import { surrealDB, queryWithAuth } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { logger } from '../utils/logger';
import type { SessionData } from '../models/schemas';
import { getJwtAuthFromContext, hasJwtAuth, type JwtAuthContext } from '../middleware/jwtAuth';
import { generateActivity } from '../services/activity-generator';
import { 
  ExecutionRecordSchema, 
  CreateTemplateRequestSchema,
  CompositionRecordRequestSchema,
  CompositionGraphQuerySchema,
  ImpulseRelevanceRecordRequestSchema,
  ImpulseRelevanceQuerySchema,
  ToolUsageRecordRequestSchema,
  ToolUsageQuerySchema,
  ExecutionSequenceRecordRequestSchema,
  ExecutionSequenceQuerySchema,
  StoreExecutionTraceRequestSchema,
  type ExecutionRecord, 
  type ExecutionRecordResponse,
  type CreateTemplateRequest,
  type CreateTemplateResponse,
  type CompositionRecordRequest,
  type CompositionGraphResponse,
  type CompositionEdge,
  type ImpulseRelevanceMetric,
  type ImpulseRelevanceResponse,
  type ToolUsagePattern,
  type ToolUsageResponse,
  type ExecutionSequence,
  type ExecutionSequenceResponse,
  type StoreExecutionTraceResponse,
} from '../models/schemas';
import { broadcaster } from '../websocket/broadcaster';

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
  public?: boolean;
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
 * Enrich templates with execution metrics from variant_performance_metrics table
 */
async function enrichTemplatesWithMetrics(
  templates: ActivityTemplate[]
): Promise<ActivityTemplate[]> {
  if (templates.length === 0) {
    return templates;
  }

  try {
    // Extract variant IDs
    const variantIds = templates.map(t => t.variant_id);
    
    logger.info('Enriching templates with metrics', { 
      templateCount: templates.length,
      sampleVariantIds: variantIds.slice(0, 3)
    });
    
    // Query metrics for all variants in one go
    const metricsQuery = `
      SELECT * FROM variant_performance_metrics
      WHERE variant_id IN $variant_ids
    `;
    
    const metricsResult = await surrealDB.query<any>(metricsQuery, {
      variant_ids: variantIds
    });

    logger.info('Metrics query result', {
      metricsFound: metricsResult?.length || 0,
      sampleMetrics: metricsResult?.slice(0, 2).map((m: any) => ({ 
        variant_id: m.variant_id, 
        alpha: m.thompson_alpha, 
        beta: m.thompson_beta 
      }))
    });

    // Create a map of variant_id -> metrics
    const metricsMap = new Map();
    for (const metric of metricsResult) {
      metricsMap.set(metric.variant_id, metric);
    }

    // Attach metrics to each template
    return templates.map(template => ({
      ...template,
      metrics: metricsMap.get(template.variant_id) || undefined
    }));
    
  } catch (error) {
    logger.error('Failed to enrich templates with metrics', {
      error: error instanceof Error ? error.message : String(error)
    });
    // Return templates without metrics rather than failing
    return templates;
  }
}
/**
 * Fetch all templates from SurrealDB with multi-tenant filtering
 *
 * When jwtToken is provided, uses queryWithAuth() which authenticates with
 * SurrealDB and lets PERMISSIONS clauses enforce org_id filtering via $auth.
 * This is the RBAC-enforced path for MiniBob instances.
 *
 * When jwtToken is not provided, uses application-level filtering with
 * explicit WHERE clauses. This is the legacy path for Redis session auth.
 */
async function listAllTemplatesFromDB(
  limit: number,
  orgId?: string | null,
  projectId?: string | null,
  jwtToken?: string | null,
  scopeFilter?: string | null
): Promise<ActivityTemplate[]> {
  let query: string;
  let params: Record<string, any>;

  if (jwtToken) {
    // JWT AUTH PATH: Use RBAC-enforced query
    // The PERMISSIONS clause on activity_template uses $auth.org_id to filter
    // We just need to query all templates - SurrealDB will filter automatically
    let whereClause = '';
    params = { limit };

    // Apply scope filter if specified
    if (scopeFilter) {
      if (scopeFilter === 'global') {
        whereClause = 'WHERE (scope IS NULL OR scope = "global")';
      } else if (scopeFilter === 'org') {
        whereClause = 'WHERE scope = "org"';
      } else if (scopeFilter === 'project') {
        whereClause = 'WHERE scope = "project"';
      }
    }

    query = `
      SELECT * FROM activity_template
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $limit
    `;

    logger.debug('Fetching templates with JWT auth (RBAC enforced)', { limit, scopeFilter });
    const result = await queryWithAuth<ActivityTemplate>(jwtToken, query, params);

    logger.info('SurrealDB templates fetched (RBAC)', {
      count: result.length,
      authMethod: 'jwt',
      scopeFilter
    });

    // Enrich templates with metrics before returning
    const enrichedTemplates = await enrichTemplatesWithMetrics(result);
    logger.info('Templates enriched with metrics', { enrichedCount: enrichedTemplates.length });
    return enrichedTemplates;
  }

  // LEGACY PATH: Application-level filtering for Redis session auth
  // Build scope filter clause if specified
  let scopeClause = '';
  if (scopeFilter === 'global') {
    scopeClause = 'AND (scope IS NULL OR scope = "global")';
  } else if (scopeFilter === 'org') {
    scopeClause = 'AND scope = "org"';
  } else if (scopeFilter === 'project') {
    scopeClause = 'AND scope = "project"';
  }

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
        ) ${scopeClause}
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
        ) ${scopeClause}
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
      ) ${scopeClause}
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

  // Enrich templates with metrics before returning
  const enrichedTemplates = await enrichTemplatesWithMetrics(result);
  logger.info('Templates enriched with metrics', { enrichedCount: enrichedTemplates.length });
  return enrichedTemplates;
}

/**
 * POST /v2/activities/templates
 * Register a new activity template variant
 * 
 * This endpoint enables template registration from:
 * - MiniBob executing local JSON templates
 * - OpenCode creating new templates
 * - External systems registering custom templates
 * 
 * Automatically creates initial performance metrics with Thompson Sampling parameters
 */
app.post('/templates', async (c) => {
  try {
    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = session?.org_id || null;
    const projectId = session?.project_id || null;

    // Parse and validate request body
    const body = await c.req.json();
    const validated = CreateTemplateRequestSchema.parse(body);

    logger.info('POST /v2/activities/templates', {
      variant_id: validated.variant_id,
      activity_id: validated.activity_id,
      variant_name: validated.variant_name,
      category: validated.category,
      scope: validated.scope,
    });

    // Check if template already exists
    const existingQuery = `
      SELECT * FROM activity_template
      WHERE variant_id = $variant_id
      LIMIT 1
    `;
    
    const existing = await surrealDB.query<ActivityTemplate>(existingQuery, {
      variant_id: validated.variant_id,
    });

    if (existing.length > 0) {
      logger.warn('Template already exists', { variant_id: validated.variant_id });
      return c.json({
        success: false,
        variant_id: validated.variant_id,
        message: 'Template variant already exists',
      } as CreateTemplateResponse, 409);
    }

    // Build template record, only include fields with values (SurrealDB doesn't accept null)
    const templateRecord: Record<string, any> = {
      variant_id: validated.variant_id,
      activity_id: validated.activity_id,
      variant_name: validated.variant_name,
      description: validated.description,
      category: validated.category,
      scope: validated.scope || 'global',
      public: validated.public || false,
    };

    // Only add optional fields if they have values
    if (validated.task_steps && validated.task_steps.length > 0) {
      templateRecord.task_steps = validated.task_steps;
    }
    if (validated.org_id || orgId) {
      templateRecord.org_id = validated.org_id || orgId;
    }
    if (validated.project_id || projectId) {
      templateRecord.project_id = validated.project_id || projectId;
    }
    if (validated.genealogy && Object.keys(validated.genealogy).length > 0) {
      templateRecord.genealogy = validated.genealogy;
    }

    // Build dynamic query with only provided fields
    const fields = Object.keys(templateRecord).map(k => `${k}: $${k}`).join(',\n        ');
    const insertTemplateQuery = `
      INSERT INTO activity_template {
        ${fields},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    await surrealDB.query(insertTemplateQuery, templateRecord);

    logger.debug('Template inserted into activity_template');

    // Create initial performance metrics
    // org_id is required by schema - use session org or default to metabob_internal for global templates
    const metricsOrgId = validated.org_id || orgId || 'organizations:metabob_internal';
    const metricsProjectId = validated.project_id || projectId;

    // Build metrics query with conditional project_id
    const insertMetricsQuery = metricsProjectId
      ? `
      INSERT INTO variant_performance_metrics {
        variant_id: $variant_id,
        activity_id: $activity_id,
        org_id: $org_id,
        project_id: $project_id,
        total_executions: 0,
        successful_executions: 0,
        failed_executions: 0,
        success_rate: 0.0,
        avg_duration_ms: 0.0,
        avg_cost_usd: 0.0,
        thompson_alpha: 1.0,
        thompson_beta: 1.0,
        total_selections: 0,
        created_at: time::now(),
        updated_at: time::now()
      }
    `
      : `
      INSERT INTO variant_performance_metrics {
        variant_id: $variant_id,
        activity_id: $activity_id,
        org_id: $org_id,
        total_executions: 0,
        successful_executions: 0,
        failed_executions: 0,
        success_rate: 0.0,
        avg_duration_ms: 0.0,
        avg_cost_usd: 0.0,
        thompson_alpha: 1.0,
        thompson_beta: 1.0,
        total_selections: 0,
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    await surrealDB.query(insertMetricsQuery, {
      variant_id: validated.variant_id,
      activity_id: validated.activity_id,
      org_id: metricsOrgId,
      ...(metricsProjectId ? { project_id: metricsProjectId } : {}),
    });

    logger.info('Template registered successfully', {
      variant_id: validated.variant_id,
    });

    return c.json({
      success: true,
      variant_id: validated.variant_id,
      message: 'Template registered successfully',
    } as CreateTemplateResponse, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/templates failed', {
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
      error: 'Failed to register template',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/templates
 * List all activity templates with Thompson Sampling scores
 *
 * Auth modes:
 * 1. JWT auth (MiniBob): RBAC enforced by SurrealDB PERMISSIONS via $auth.org_id
 * 2. Redis session auth (Dashboard): Application-level filtering via WHERE clauses
 */
app.get('/templates', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Fall back to Redis session auth for org/project context
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const projectId = jwtAuth?.projectId || session?.project_id || null;

    // Extract query parameters
    const category = c.req.query('category') || null;
    const scopeFilter = c.req.query('scope') || null; // Filter by scope: global, org, project
    const limitStr = c.req.query('limit') || '50';
    let limit = parseInt(limitStr, 10);

    // Validate limit (consistent with impulses.ts pattern)
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    }
    limit = Math.min(limit, 100);

    logger.info('GET /v2/activities/templates', {
      category,
      scopeFilter,
      limit,
      orgId,
      projectId,
      authMethod: useJwtAuth ? 'jwt' : 'session',
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
      // CACHE MISS - Load from SurrealDB with distributed lock (cache stampede prevention)
      logger.info('Template list cache miss, loading from SurrealDB');
      
      const lockKey = 'lock:templates:refresh';
      const cacheKey = CACHE_LIST_KEY;
      
      // Use distributed lock to prevent cache stampede
      templates = await redis.withLock(
        lockKey,
        cacheKey,
        async () => {
          // Load templates from database
          // Pass JWT token for RBAC enforcement when available
          const dbTemplates = await listAllTemplatesFromDB(
            limit * 2,
            orgId,
            projectId,
            jwtAuth?.jwtToken || null,
            scopeFilter
          );

          // Populate Redis cache (only for non-JWT queries to avoid polluting global cache)
          // JWT queries are already RBAC-filtered, so caching would leak isolation
          if (dbTemplates.length > 0 && !useJwtAuth) {
            const cachePromises: Promise<any>[] = [];

            for (const template of dbTemplates) {
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
            logger.info(`Cached ${dbTemplates.length} templates from SurrealDB`);
          }

          return dbTemplates;
        },
        30 // Lock TTL: 30 seconds
      );
    }

    // Filter by category if specified
    if (category) {
      templates = templates.filter((t) => t.category === category);
    }

    // Apply limit
    templates = templates.slice(0, limit);

    // Skip client-side org/project filtering when using JWT auth
    // SurrealDB PERMISSIONS clauses already enforce isolation via $auth.org_id
    if (!useJwtAuth) {
      // LEGACY PATH: Filter by scope and org_id/project_id (client-side filtering)
      // This enforces multi-tenant isolation for Redis session auth
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
    }

    logger.info('Templates filtered and ready', {
      count: templates.length,
      category,
      scope: { orgId, projectId },
      rbacEnforced: useJwtAuth,
    });

    // Enrich templates with execution metrics
    templates = await enrichTemplatesWithMetrics(templates);
    console.log("ENRICHMENT POINT REACHED", templates.length);
    logger.info('Templates enriched with metrics', { templatesWithMetrics: templates.filter(t => t.metrics).length });

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

    let result: ActivityTemplate[] = [];

    // First, try to query by variant_id field (most common case)
    const variantQuery = `
      SELECT * FROM activity_template WHERE variant_id = $variant_id LIMIT 1
    `;
    result = await surrealDB.query<ActivityTemplate>(variantQuery, { variant_id: variantId });

    // If not found by variant_id, try by SurrealDB record ID (for activity_template:xyz format)
    if (result.length === 0 && variantId.startsWith('activity_template:')) {
      try {
        const recordQuery = `
          SELECT * FROM activity_template WHERE id = type::record($variant_id)
        `;
        result = await surrealDB.query<ActivityTemplate>(recordQuery, { variant_id: variantId });
      } catch (recordError) {
        logger.debug('Record ID query failed, template not found', { variantId });
      }
    }

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

    // Emit execution_started event via WebSocket
    const executionStartedData: any = {
      execution_id: executionId,
      variant_id: validated.variant_id,
    };
    // Add pod_name if available (MiniBob execution context)
    if ((validated as any).pod_name) {
      executionStartedData.pod_name = (validated as any).pod_name;
    }
    broadcaster.emit({
      type: 'execution_started',
      timestamp: new Date().toISOString(),
      data: executionStartedData,
    });

    // Build execution record, only include fields with values (SurrealDB doesn't accept null)
    const executionRecord: Record<string, any> = {
      execution_id: executionId,
      variant_id: validated.variant_id,
      success: validated.success,
      duration_ms: validated.duration_ms,
      cost_usd: validated.cost,
      tokens_input: validated.tokens.input,
      tokens_output: validated.tokens.output,
      tokens_cache: validated.tokens.cache,
    };

    // Only add optional fields if they have values
    if (orgId) {
      executionRecord.org_id = orgId;
    }
    if (projectId) {
      executionRecord.project_id = projectId;
    }
    if (validated.error_message) {
      executionRecord.error_message = validated.error_message;
    }
    if (validated.error_type) {
      executionRecord.error_type = validated.error_type;
    }
    if (validated.failed_task_id) {
      executionRecord.failed_task_id = validated.failed_task_id;
    }
    if (validated.impulses_used && validated.impulses_used.length > 0) {
      executionRecord.impulses_used = validated.impulses_used;
    }
    if (validated.component_changes && validated.component_changes.length > 0) {
      executionRecord.component_changes = validated.component_changes;
    }

    // Build dynamic query with only provided fields
    const execFields = Object.keys(executionRecord).map(k => `${k}: $${k}`).join(',\n        ');
    const insertExecutionQuery = `
      INSERT INTO activity_executions {
        ${execFields},
        executed_at: time::now(),
        created_at: time::now()
      }
    `;

    await surrealDB.query(insertExecutionQuery, executionRecord);

    logger.debug('Execution recorded in activity_executions', { executionId });

    // Step 2: Update Thompson Sampling metrics in variant_performance_metrics
    // Thompson Sampling uses Beta distribution: Beta(alpha, beta)
    // - alpha: number of successes + 1
    // - beta: number of failures + 1
    //
    // ATOMIC UPDATE: Uses SurrealDB += operator for race-condition-free concurrent updates
    // Previous implementation had read-modify-write race condition
    
    const success_delta = validated.success ? 1 : 0;
    const failure_delta = validated.success ? 0 : 1;
    
    const updateMetricsQuery = `
      UPDATE variant_performance_metrics 
      SET 
        total_executions += 1,
        successful_executions += $success_delta,
        failed_executions += $failure_delta,
        success_rate = successful_executions / total_executions,
        avg_duration_ms = ((avg_duration_ms * (total_executions - 1)) + $duration_ms) / total_executions,
        avg_cost_usd = ((avg_cost_usd * (total_executions - 1)) + $cost) / total_executions,
        thompson_alpha = successful_executions + 1,
        thompson_beta = failed_executions + 1,
        last_executed_at = time::now(),
        updated_at = time::now()
      WHERE variant_id = $variant_id
      RETURN AFTER;
    `;

    const metricsResult = await surrealDB.query(updateMetricsQuery, {
      variant_id: validated.variant_id,
      success_delta,
      failure_delta,
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

    // Extract updated metrics from result
    const updatedMetrics = metricsResult.length > 0 ? metricsResult[0] : undefined;

    // Emit execution_completed event via WebSocket
    broadcaster.emit({
      type: 'execution_completed',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: executionId,
        variant_id: validated.variant_id,
        success: validated.success,
        duration_ms: validated.duration_ms,
        cost: validated.cost,
        completed_at: new Date().toISOString(),
      },
    });

    // Emit template_metrics_updated event via WebSocket
    if (updatedMetrics) {
      broadcaster.emit({
        type: 'template_updated',
        timestamp: new Date().toISOString(),
        data: {
          variant_id: validated.variant_id,
          metrics: {
            success_rate: updatedMetrics.success_rate || 0,
            avg_duration_ms: updatedMetrics.avg_duration_ms || 0,
            avg_cost_usd: updatedMetrics.avg_cost_usd || 0,
            thompson_alpha: updatedMetrics.thompson_alpha || 1,
            thompson_beta: updatedMetrics.thompson_beta || 1,
          },
        },
      });
    }

    // Return response with updated metrics
    const response: ExecutionRecordResponse = {
      success: true,
      execution_id: executionId,
      metrics: updatedMetrics,
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

/**
 * GET /v2/activities/executions
 * 
 * List execution history with filtering.
 * 
 * Query Parameters:
 * - variant_id: Filter by variant ID (optional)
 * - success: Filter by success status (true/false, optional)
 * - limit: Maximum number of results (1-100, default 50)
 * - offset: Pagination offset (default 0)
 * 
 * Returns:
 * - executions: Array of execution records
 * - total: Number of results returned
 * - limit: Applied limit
 * - offset: Applied offset
 * 
 * Data Flow: Dashboard → GET /executions → SurrealDB query → execution history
 */
app.get('/executions', async (c) => {
  try {
    // Extract session from context for multi-tenant filtering
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = session?.org_id || null;
    const projectId = session?.project_id || null;

    // Parse query parameters
    const variantId = c.req.query('variant_id') || null;
    const successParam = c.req.query('success');
    const limitStr = c.req.query('limit') || '50';
    const offsetStr = c.req.query('offset') || '0';
    
    const limit = Math.min(Math.max(parseInt(limitStr, 10), 1), 100);
    const offset = Math.max(parseInt(offsetStr, 10), 0);
    
    logger.info('GET /v2/activities/executions', {
      variant_id: variantId,
      success: successParam,
      limit,
      offset,
      orgId,
      projectId,
    });

    // Build query with filters
    let query = 'SELECT * FROM activity_executions WHERE 1=1';
    const params: Record<string, any> = {};
    
    // Multi-tenant filtering (same as templates)
    if (orgId) {
      query += ' AND (org_id = $org_id OR org_id = NONE)';
      params.org_id = orgId;
    }
    if (projectId) {
      query += ' AND (project_id = $project_id OR project_id = NONE OR org_id = $org_id)';
      params.project_id = projectId;
    }
    
    // Filter by variant_id
    if (variantId) {
      query += ' AND variant_id = $variant_id';
      params.variant_id = variantId;
    }
    
    // Filter by success status
    if (successParam !== undefined) {
      query += ' AND success = $success';
      params.success = successParam === 'true';
    }
    
    // Order by most recent first
    query += ' ORDER BY executed_at DESC';
    
    // Pagination
    query += ' LIMIT $limit START $offset';
    params.limit = limit;
    params.offset = offset;
    
    logger.debug('Execution history query', { query, params });
    
    const result = await surrealDB.query(query, params);
    // Note: surrealDB.query() already extracts result[0], so result is the array directly
    const executions = Array.isArray(result) ? result : [];
    
    logger.debug('Execution history results', { count: executions.length });

    return c.json({
      executions,
      total: executions.length,
      limit,
      offset,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/executions failed', { 
      error: error.message,
      stack: error.stack,
    });
    
    return c.json({
      error: 'Failed to fetch execution history',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/execution-traces
 * 
 * Store execution trace for reuse as impulse in debugging-as-activity workflow.
 * 
 * Architecture (Phase 1.8 - Unified Impulse-Driven):
 * - MiniBob executes activity with state capture enabled
 * - After completion (success OR failure), MiniBob calls this endpoint
 * - Trace stored in execution_traces table with full context
 * - Later: impulse created pointing to this trace → goal-seeking debug → fixed template
 * 
 * The unified flow:
 * 1. Activity execution → trace captured
 * 2. POST /execution-traces → trace stored
 * 3. Create impulse: { type: "activityExecutionTrace", executionId: "..." }
 * 4. Goal-seeking with impulse → generates debug activity
 * 5. Debug activity → uses trace to understand failure → proposes fix
 * 6. If debug succeeds → ribosome → new fixed template
 * 
 * Request body:
 * {
 *   execution_id: string,
 *   template_id: string,
 *   status: "success" | "failure" | "partial",
 *   duration_ms: number,
 *   cost_usd: number,
 *   execution_trace: {
 *     tasks: ExecutedTask[],
 *     impulsesCreated: string[],
 *     filesModified: string[],
 *     goalContext?: { goal, intent, context }
 *   }
 * }
 * 
 * Returns:
 * {
 *   success: boolean,
 *   execution_id: string,
 *   message?: string
 * }
 */
// DEPRECATED: This handler moved to src/routes/execution-traces.ts
// Commenting out to prevent duplicate handler conflict
/*
app.post('/execution-traces', async (c) => {
  try {
    const body = await c.req.json();
    const validated = StoreExecutionTraceRequestSchema.parse(body);
    
    logger.info('POST /v2/activities/execution-traces', {
      execution_id: validated.execution_id,
      template_id: validated.template_id,
      status: validated.status,
      tasks_count: validated.execution_trace.tasks.length,
      duration_ms: validated.duration_ms,
      cost_usd: validated.cost_usd,
    });

    // Check if trace already exists
    const existsQuery = `
      SELECT * FROM execution_traces
      WHERE execution_id = $execution_id
      LIMIT 1
    `;
    
    const existing = await surrealDB.query<any>(existsQuery, {
      execution_id: validated.execution_id,
    });

    if (existing.length > 0) {
      logger.warn('Execution trace already exists', { execution_id: validated.execution_id });
      return c.json({
        success: false,
        execution_id: validated.execution_id,
        message: 'Execution trace already exists',
      } as StoreExecutionTraceResponse, 409);
    }

    // Store execution trace
    const createQuery = `
      CREATE execution_traces CONTENT {
        execution_id: $execution_id,
        template_id: $template_id,
        status: $status,
        duration_ms: $duration_ms,
        cost_usd: $cost_usd,
        execution_trace: $execution_trace,
        stored_at: time::now(),
        created_at: time::now(),
        updated_at: time::now()
      }
    `;
    
    await surrealDB.query(createQuery, {
      execution_id: validated.execution_id,
      template_id: validated.template_id,
      status: validated.status,
      duration_ms: validated.duration_ms,
      cost_usd: validated.cost_usd,
      execution_trace: validated.execution_trace,
    });

    logger.info('Execution trace stored successfully', {
      execution_id: validated.execution_id,
      template_id: validated.template_id,
      status: validated.status,
    });

    // Post-execution hook: Generate debug tasks for failures
    if (validated.status === 'failure') {
      try {
        const { taskGenerator } = await import('../services/task-generator');
        const { enqueueTask } = await import('./boredom');

        const debugTasks = await taskGenerator.analyzeExecution({
          execution_id: validated.execution_id,
          template_id: validated.template_id,
          status: validated.status,
          duration_ms: validated.duration_ms,
          cost_usd: validated.cost_usd,
          execution_trace: validated.execution_trace,
          created_at: new Date().toISOString(),
        });

        for (const task of debugTasks) {
          await enqueueTask(task);
        }

        if (debugTasks.length > 0) {
          logger.info('[TaskGenerator] Generated debug tasks for failed execution', {
            execution_id: validated.execution_id,
            taskCount: debugTasks.length,
          });
        }
      } catch (hookError) {
        // Don't fail the request if hook fails
        logger.error('[TaskGenerator] Post-execution hook failed', { error: hookError });
      }
    }

    return c.json({
      success: true,
      execution_id: validated.execution_id,
      message: 'Execution trace stored successfully',
    } as StoreExecutionTraceResponse, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/execution-traces failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        success: false,
        execution_id: '',
        message: 'Validation failed: ' + error.message,
      } as StoreExecutionTraceResponse, 400);
    }

    return c.json({
      success: false,
      execution_id: '',
      message: error.message,
    } as StoreExecutionTraceResponse, 500);
  }
});
*/

/**
 * GET /v2/activities/execution-traces/:executionId
 * 
 * Retrieve execution trace by ID.
 * 
 * Use cases:
 * - Debugging: Load trace to understand what went wrong
 * - Analysis: Review successful execution patterns
 * - Ribosome: Extract trace to generate new template
 * 
 * Returns full trace with all tasks, tool calls, state transitions.
 */
// DEPRECATED: Moved to src/routes/execution-traces.ts
/*
app.get('/execution-traces/:executionId', async (c) => {
  try {
    const executionId = c.req.param('executionId');

    logger.info('GET /v2/activities/execution-traces/:executionId', { executionId });

    const query = `
      SELECT * FROM execution_traces
      WHERE execution_id = $execution_id
      LIMIT 1
    `;

    const result = await surrealDB.query<any>(query, {
      execution_id: executionId,
    });

    if (result.length === 0) {
      return c.json({
        error: 'Execution trace not found',
        execution_id: executionId,
      }, 404);
    }

    const trace = result[0];

    logger.info('Execution trace retrieved', { executionId });

    return c.json(trace);

  } catch (error: any) {
    logger.error('GET /v2/activities/execution-traces/:executionId failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to retrieve execution trace',
      message: error.message,
    }, 500);
  }
});
*/

// DEPRECATED: Moved to src/routes/execution-traces.ts
/*
app.get('/execution-traces', async (c) => {
  try {
    const templateId = c.req.query('template_id');
    const status = c.req.query('status');
    const limitStr = c.req.query('limit') || '50';
    const offsetStr = c.req.query('offset') || '0';

    const limit = Math.min(Math.max(parseInt(limitStr, 10), 1), 100);
    const offset = Math.max(parseInt(offsetStr, 10), 0);

    logger.info('GET /v2/activities/execution-traces', {
      template_id: templateId,
      status,
      limit,
      offset,
    });

    // Build query with filters
    let query = 'SELECT * FROM execution_traces WHERE 1=1';
    const params: Record<string, any> = {};

    if (templateId) {
      query += ' AND template_id = $template_id';
      params.template_id = templateId;
    }

    if (status) {
      query += ' AND status = $status';
      params.status = status;
    }

    query += ' ORDER BY stored_at DESC';
    query += ' LIMIT $limit START $offset';
    params.limit = limit;
    params.offset = offset;

    const result = await surrealDB.query(query, params);
    const traces = Array.isArray(result) ? result : [];

    logger.info('Execution traces retrieved', { count: traces.length });

    return c.json({
      executions: traces,
      total: traces.length,
      limit,
      offset,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/execution-traces failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to list execution traces',
      message: error.message,
    }, 500);
  }
});
*/

/**
 * GET /v2/activities/metrics/trend
 *
 * Returns daily execution metrics for charting quality trends.
 *
 * Query Parameters:
 * - days: Number of days to return (default: 30, max: 90)
 *
 * Returns:
 * {
 *   trend: [
 *     { date: "2026-03-25", success_count: 45, failure_count: 5, total_cost: 12.50 },
 *     ...
 *   ]
 * }
 */
app.get('/metrics/trend', async (c) => {
  try {
    // Parse query parameters
    const daysParam = c.req.query('days') || '30';
    const days = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 90);

    logger.info('GET /v2/activities/metrics/trend', { days });

    // Query execution metrics grouped by day
    const query = `
      SELECT
        time::format(created_at, '%Y-%m-%d') AS date,
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS success_count,
        count(IF success = false THEN 1 ELSE NONE END) AS failure_count,
        math::sum(cost_usd) AS total_cost
      FROM execution_record
      WHERE created_at > time::now() - duration::from::days($days)
      GROUP BY time::format(created_at, '%Y-%m-%d')
      ORDER BY date ASC
    `;

    const result = await surrealDB.query(query, { days });
    const trends = Array.isArray(result) ? result : [];

    // Transform to response format
    const trendData = trends.map((row: any) => ({
      date: row.date,
      success_count: row.success_count || 0,
      failure_count: row.failure_count || 0,
      total_executions: row.total_executions || 0,
      total_cost: parseFloat(row.total_cost || 0).toFixed(2),
    }));

    logger.info('Metrics trend retrieved', { days, dataPoints: trendData.length });

    return c.json({
      trend: trendData,
      days,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics/trend failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch metrics trend',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/metrics/summary
 *
 * Returns summary metrics for the dashboard.
 *
 * Returns:
 * {
 *   total_templates: number,
 *   total_executions: number,
 *   executions_today: number,
 *   average_success_rate: number,
 *   average_duration_ms: number,
 *   total_cost_usd: number,
 * }
 */
app.get('/metrics/summary', async (c) => {
  try {
    logger.info('GET /v2/activities/metrics/summary');

    // Query aggregate metrics
    const templateCountResult = await surrealDB.query('SELECT count() AS count FROM activity_template GROUP ALL');
    const totalTemplates = (templateCountResult[0] as any)?.count || 0;

    const executionStatsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF created_at > time::now() - 1d THEN 1 ELSE NONE END) AS executions_today,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
        math::mean(duration_ms) AS avg_duration,
        math::sum(cost_usd) AS total_cost
      FROM execution_record
      GROUP ALL
    `);

    const stats = executionStatsResult[0] as any || {};

    const summary = {
      total_templates: totalTemplates,
      total_executions: stats.total_executions || 0,
      executions_today: stats.executions_today || 0,
      average_success_rate: parseFloat((stats.success_rate || 0) * 100).toFixed(1),
      average_duration_ms: Math.round(stats.avg_duration || 0),
      total_cost_usd: parseFloat(stats.total_cost || 0).toFixed(2),
    };

    logger.info('Metrics summary retrieved', summary);

    return c.json(summary);

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics/summary failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch metrics summary',
      message: error.message,
    }, 500);
  }
});

export default app;

/**
 * POST /recommend
 * 
 * Get activity recommendations using Thompson Sampling
 * 
 * Request body:
 * {
 *   task_description: string,
 *   category?: string,
 *   loaded_impulses?: string[],
 *   limit?: number
 * }
 * 
 * Returns:
 * {
 *   recommendations: [
 *     {
 *       template_id: string,
 *       selection_metadata: {
 *         method: "thompson_sampling",
 *         alpha: number,
 *         beta: number,
 *         sample: number,
 *         score: number
 *       }
 *     }
 *   ]
 * }
 */
app.post('/recommend', async (c) => {
  try {
    const body = await c.req.json();
    const { task_description, category, loaded_impulses = [], limit = 3 } = body;

    logger.info('POST /recommend', { 
      task_description: task_description?.substring(0, 100),
      category,
      loaded_impulses,
      limit 
    });

    // Validate required fields
    if (!task_description) {
      return c.json({
        error: 'task_description is required',
      }, 400);
    }

    // Get session data for multi-tenant filtering
    const sessionData = (c.get as any)('session') as SessionData | undefined;
    const orgId = sessionData?.org_id || null;
    const projectId = sessionData?.project_id || null;

    // Fetch templates for Thompson Sampling recommendations
    let query = `
      SELECT 
        variant_id,
        activity_id,
        variant_name,
        category
      FROM activity_template
    `;

    const params: Record<string, any> = {};

    // Build WHERE clause for multi-tenant filtering
    const whereClauses: string[] = [];

    if (orgId) {
      whereClauses.push(`(scope IS NULL OR scope = 'global' OR (scope = 'org' AND org_id = $org_id) OR (scope = 'project' AND project_id = $project_id))`);
      params.org_id = orgId;
      params.project_id = projectId;
    } else {
      whereClauses.push(`(scope IS NULL OR scope = 'global')`);
    }

    // Filter by category if provided
    if (category) {
      whereClauses.push(`category = $category`);
      params.category = category;
    }

    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    logger.debug('Recommendation query', { query, params });

    const result = await surrealDB.query(query, params);
    let templates: any[] = result || [];

    logger.info('Templates fetched for recommendation', { count: templates.length });

    // Enrich templates with metrics (thompson_alpha, thompson_beta)
    templates = await enrichTemplatesWithMetrics(templates);

    // Apply Thompson Sampling
    const recommendations = templates
      .map((template) => {
        // Get alpha/beta from enriched metrics
        const alpha = template.metrics?.thompson_alpha || 1.0;
        const beta = template.metrics?.thompson_beta || 1.0;

        // Sample from Beta distribution (simplified: use expected value for deterministic testing)
        // In production, would use: sample = beta_random(alpha, beta)
        const sample = alpha / (alpha + beta); // Expected value of Beta(alpha, beta)

        return {
          template_id: template.variant_id,
          template_name: template.variant_name,
          category: template.category,
          selection_metadata: {
            method: 'thompson_sampling',
            alpha,
            beta,
            sample,
            score: sample, // Use sample as score for ranking
          },
        };
      })
      // Sort by Thompson sample (highest first)
      .sort((a, b) => b.selection_metadata.sample - a.selection_metadata.sample)
      // Take top N
      .slice(0, limit);

    logger.info('Recommendations generated', { 
      count: recommendations.length,
      top: recommendations[0]?.template_id 
    });

    return c.json({ recommendations });
  } catch (error: any) {
    logger.error('POST /recommend failed', { 
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to generate recommendations',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/create-goal-seeking
 * 
 * Create new activity template from goal description (improvisation/self-learning).
 * Used by MiniBob GoalProcessor when recommended activities fail.
 * 
 * Request body:
 * {
 *   goal_description: string,
 *   template_name: string,
 *   category: string,
 *   variables: Record<string, unknown>,
 *   impulse_refs?: string[],
 *   constraints?: {
 *     max_tasks?: number,
 *     max_cost?: number,
 *     prefer_composition?: boolean
 *   }
 * }
 * 
 * Response:
 * {
 *   status: "success" | "error",
 *   template_id?: string,
 *   error?: string
 * }
 */
app.post('/create-goal-seeking', async (c) => {
  try {
    const body = await c.req.json();
    const {
      goal_description,
      template_name,
      category,
      variables = {},
      impulse_refs = [],
      constraints = {},
    } = body;

    logger.info('POST /v2/activities/create-goal-seeking', {
      goal_description: goal_description?.substring(0, 100),
      template_name,
      category,
    });

    // Validate required fields
    if (!goal_description || !template_name || !category) {
      return c.json({
        status: 'error',
        error: 'goal_description, template_name, and category are required',
      }, 400);
    }

    // Get session data for multi-tenant support
    const sessionData = (c.get as any)('session') as SessionData | undefined;
    const orgId = sessionData?.org_id || null;
    const projectId = sessionData?.project_id || null;

    // Generate activity template
    const generated = await generateActivity({
      goalDescription: goal_description,
      templateName: template_name,
      category,
      variables,
      impulseRefs: impulse_refs,
      constraints: {
        maxTasks: constraints.max_tasks || 5,
        maxCost: constraints.max_cost || 5.0,
        preferComposition: constraints.prefer_composition !== false,
      },
    });

    // Insert template into database
    const templateRecord: Record<string, any> = {
      variant_id: generated.variant_id,
      activity_id: generated.activity_id,
      variant_name: generated.variant_name,
      description: generated.description,
      category: generated.category,
      task_steps: generated.task_steps,
      scope: generated.scope,
    };

    if (orgId) {
      templateRecord.org_id = orgId;
    }
    if (projectId) {
      templateRecord.project_id = projectId;
    }

    const fields = Object.keys(templateRecord).map(k => `${k}: $${k}`).join(',\n        ');
    const insertTemplateQuery = `
      INSERT INTO activity_template {
        ${fields},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    try {
      await surrealDB.query(insertTemplateQuery, templateRecord);
      logger.debug('Generated template inserted into activity_template', {
        variant_id: generated.variant_id,
      });
    } catch (insertError: any) {
      // Check if this is a duplicate key error
      if (insertError?.message?.includes('already contains') ||
          insertError?.message?.includes('idx_activity_template_variant_id')) {
        logger.info('Template already exists, returning existing template', {
          variant_id: generated.variant_id,
        });
        // Return success with existing template ID
        return c.json({
          status: 'success',
          template_id: generated.variant_id,
          existing: true,
        });
      }
      // Re-throw other errors
      throw insertError;
    }

    // Initialize Thompson Sampling metrics
    const insertMetricsQuery = `
      INSERT INTO variant_performance_metrics {
        variant_id: $variant_id,
        activity_id: $activity_id,
        total_executions: 0,
        successful_executions: 0,
        failed_executions: 0,
        success_rate: 0.0,
        avg_duration_ms: 0.0,
        avg_cost_usd: 0.0,
        thompson_alpha: 1.0,
        thompson_beta: 1.0,
        total_selections: 0,
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    await surrealDB.query(insertMetricsQuery, {
      variant_id: generated.variant_id,
      activity_id: generated.activity_id,
    });

    logger.info('Created improvised activity template', {
      variant_id: generated.variant_id,
      category: generated.category,
    });

    // Invalidate cache
    const redis = RedisClient.getInstance();
    await redis.del(CACHE_LIST_KEY);

    return c.json({
      status: 'success',
      template_id: generated.variant_id,
    });
  } catch (error) {
    logger.error('Failed to create goal-seeking activity', { error });
    return c.json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/activities/composition
 * 
 * Record activity composition edge (parent activity called child activity).
 * This endpoint implements the learning loop for activity composition graphs:
 * 1. Check if edge (parent → child) exists
 * 2. If exists: increment execution_count, update success_count, recalculate weight
 * 3. If new: create edge with execution_count=1, weight based on success
 * 4. Return updated edge data
 * 
 * Weight calculation: weight = success_count / execution_count
 * This represents P(success | parent calls child)
 */
app.post('/composition', async (c) => {
  try {
    const body = await c.req.json();
    const validated = CompositionRecordRequestSchema.parse(body);

    logger.info('POST /v2/activities/composition', {
      parent: validated.parent_activity_id,
      child: validated.child_activity_id,
      success: validated.success,
    });

    // Check if edge exists
    const checkQuery = `
      SELECT * FROM activity_composition_graph
      WHERE parent_activity_id = $parent_activity_id
        AND child_activity_id = $child_activity_id
      LIMIT 1
    `;

    const existing = await surrealDB.query<CompositionEdge[]>(checkQuery, {
      parent_activity_id: validated.parent_activity_id,
      child_activity_id: validated.child_activity_id,
    });

    let edge: CompositionEdge;

    if (existing && existing.length > 0 && existing[0]) {
      // Update existing edge
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing issue
      const newExecutionCount = (current.execution_count || 0) + 1;
      // @ts-ignore - SurrealDB query typing issue
      const newSuccessCount = (current.success_count || 0) + (validated.success ? 1 : 0);
      const newWeight = newSuccessCount / newExecutionCount;

      const updateQuery = `
        UPDATE activity_composition_graph
        SET 
          execution_count = $execution_count,
          success_count = $success_count,
          weight = $weight,
          updated_at = time::now()
        WHERE parent_activity_id = $parent_activity_id
          AND child_activity_id = $child_activity_id
        RETURN AFTER
      `;

      const updated = await surrealDB.query<CompositionEdge[]>(updateQuery, {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_count: newExecutionCount,
        success_count: newSuccessCount,
        weight: newWeight,
      });

      // @ts-ignore - SurrealDB query typing issue
      edge = updated && updated.length > 0 ? updated[0] : current;
      logger.info('Updated composition edge', {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        execution_count: newExecutionCount,
        weight: newWeight,
      });
    } else {
      // Create new edge
      const createQuery = `
        CREATE activity_composition_graph CONTENT {
          parent_activity_id: $parent_activity_id,
          child_activity_id: $child_activity_id,
          execution_id: $execution_id,
          goal_context: $goal_context,
          success: $success,
          execution_count: 1,
          success_count: $success_count,
          weight: $weight,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const created = await surrealDB.query<CompositionEdge[]>(createQuery, {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_id: validated.execution_id,
        goal_context: validated.goal_context || '',
        success: validated.success,
        success_count: validated.success ? 1 : 0,
        weight: validated.success ? 1.0 : 0.0,
      });

      // @ts-ignore - SurrealDB query typing issue
      edge = created && created.length > 0 ? created[0] : {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_id: validated.execution_id,
        goal_context: validated.goal_context || '',
        success: validated.success,
        execution_count: 1,
        success_count: validated.success ? 1 : 0,
        weight: validated.success ? 1.0 : 0.0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      logger.info('Created composition edge', {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        weight: edge.weight,
      });
    }

    return c.json({
      success: true,
      edge,
    });
  } catch (error: any) {
    logger.error('POST /v2/activities/composition failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record composition',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/graph
 * Query activity composition graph
 * 
 * Query parameters:
 * - activity_id: Filter edges where activity is parent OR child
 * - min_weight: Filter edges with weight >= min_weight
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 * 
 * Returns edges sorted by weight (strongest compositions first)
 */
app.get('/composition/graph', async (c) => {
  try {
    const query = c.req.query();
    const validated = CompositionGraphQuerySchema.parse({
      activity_id: query.activity_id,
      min_weight: query.min_weight ? parseFloat(query.min_weight) : undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });

    logger.info('GET /v2/activities/composition/graph', validated);

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };

    if (validated.activity_id) {
      whereClauses.push(`(parent_activity_id = $activity_id OR child_activity_id = $activity_id)`);
      params.activity_id = validated.activity_id;
    }

    if (validated.min_weight !== undefined) {
      whereClauses.push(`weight >= $min_weight`);
      params.min_weight = validated.min_weight;
    }

    let edgesQuery = `SELECT * FROM activity_composition_graph`;
    if (whereClauses.length > 0) {
      edgesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    edgesQuery += ` ORDER BY weight DESC LIMIT $limit START $offset`;

    let countQuery = `SELECT count() as total FROM activity_composition_graph`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [edgesResult, countResult] = await Promise.all([
      surrealDB.query<CompositionEdge[]>(edgesQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);

    // @ts-ignore - SurrealDB query typing issue
    const response: CompositionGraphResponse = {
      edges: (edgesResult && Array.isArray(edgesResult) ? edgesResult.flat() : []),
      // @ts-ignore - SurrealDB query typing issue
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };

    logger.info('Composition graph query result', {
      edges: response.edges.length,
      total: response.total,
    });

    return c.json(response);
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/graph failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to query composition graph',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/impulse-relevance
 * Record impulse usage and outcome for relevance learning
 * 
 * This endpoint implements Bayesian learning for impulse relevance:
 * - Track: was impulse loaded? did execution succeed?
 * - Learn: P(success | impulse present) vs P(success | impulse absent)
 * - Optimize: Skip loading irrelevant impulses (save tokens)
 * 
 * Bayesian calculation:
 * relevance_score = P(success | loaded) = times_execution_succeeded / times_loaded
 * irrelevance_score = P(success | not loaded) = times_not_loaded_succeeded / times_not_loaded
 * 
 * Decision rule:
 * - If relevance_score >> irrelevance_score → impulse is critical
 * - If relevance_score ≈ irrelevance_score → impulse is irrelevant
 * - If relevance_score << irrelevance_score → impulse is harmful
 */
app.post('/impulse-relevance', async (c) => {
  try {
    const body = await c.req.json();
    const validated = ImpulseRelevanceRecordRequestSchema.parse(body);

    logger.info('POST /v2/activities/impulse-relevance', {
      impulse_id: validated.impulse_id,
      activity: validated.activity_variant_id,
      was_loaded: validated.was_loaded,
      success: validated.execution_succeeded,
    });

    // Check if metric exists
    const checkQuery = `
      SELECT * FROM impulse_relevance_metrics
      WHERE impulse_id = $impulse_id
        AND activity_variant_id = $activity_variant_id
        AND (task_id = $task_id OR (task_id IS NULL AND $task_id IS NULL))
      LIMIT 1
    `;

    const existing = await surrealDB.query<ImpulseRelevanceMetric[]>(checkQuery, {
      impulse_id: validated.impulse_id,
      activity_variant_id: validated.activity_variant_id,
      task_id: validated.task_id ?? undefined,
    });

    let metric: ImpulseRelevanceMetric;

    if (existing && existing.length > 0 && existing[0]) {
      // Update existing metric
      const current = existing[0];
      
      // @ts-ignore - SurrealDB typing
      let newTimesLoaded = current.times_loaded || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesExecutionSucceeded = current.times_execution_succeeded || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesExecutionFailed = current.times_execution_failed || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesNotLoadedSucceeded = current.times_not_loaded_succeeded || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesNotLoadedFailed = current.times_not_loaded_failed || 0;

      if (validated.was_loaded) {
        newTimesLoaded++;
        if (validated.execution_succeeded) {
          newTimesExecutionSucceeded++;
        } else {
          newTimesExecutionFailed++;
        }
      } else {
        if (validated.execution_succeeded) {
          newTimesNotLoadedSucceeded++;
        } else {
          newTimesNotLoadedFailed++;
        }
      }

      // Calculate Bayesian scores
      const relevanceScore = newTimesLoaded > 0 
        ? newTimesExecutionSucceeded / newTimesLoaded 
        : 0;
      const irrelevanceScore = (newTimesNotLoadedSucceeded + newTimesNotLoadedFailed) > 0
        ? newTimesNotLoadedSucceeded / (newTimesNotLoadedSucceeded + newTimesNotLoadedFailed)
        : 0;

      // Update average content size
      // @ts-ignore - SurrealDB typing
      const totalSizeSamples = current.times_loaded || 0;
      // @ts-ignore - SurrealDB typing
      const currentAvgSize = current.avg_content_size_tokens || 0;
      const newAvgSize = validated.content_size_tokens !== undefined
        ? Math.floor((currentAvgSize * totalSizeSamples + validated.content_size_tokens) / (totalSizeSamples + 1))
        : currentAvgSize;

      const updateQuery = `
        UPDATE impulse_relevance_metrics
        SET 
          times_loaded = $times_loaded,
          times_execution_succeeded = $times_execution_succeeded,
          times_execution_failed = $times_execution_failed,
          times_not_loaded_succeeded = $times_not_loaded_succeeded,
          times_not_loaded_failed = $times_not_loaded_failed,
          relevance_score = $relevance_score,
          irrelevance_score = $irrelevance_score,
          avg_content_size_tokens = $avg_content_size_tokens,
          typical_pointer_type = $typical_pointer_type,
          updated_at = time::now()
        WHERE impulse_id = $impulse_id
          AND activity_variant_id = $activity_variant_id
          AND (task_id = $task_id OR (task_id IS NULL AND $task_id IS NULL))
        RETURN AFTER
      `;

      const updated = await surrealDB.query<ImpulseRelevanceMetric[]>(updateQuery, {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        times_loaded: newTimesLoaded,
        times_execution_succeeded: newTimesExecutionSucceeded,
        times_execution_failed: newTimesExecutionFailed,
        times_not_loaded_succeeded: newTimesNotLoadedSucceeded,
        times_not_loaded_failed: newTimesNotLoadedFailed,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        avg_content_size_tokens: newAvgSize,
        // @ts-ignore - SurrealDB typing
        typical_pointer_type: validated.pointer_type ?? current.typical_pointer_type,
      });

      // @ts-ignore - SurrealDB typing
      metric = updated && updated.length > 0 ? updated[0] : current;

      logger.info('Updated impulse relevance metric', {
        impulse_id: validated.impulse_id,
        activity: validated.activity_variant_id,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
      });
    } else {
      // Create new metric
      const createQuery = `
        CREATE impulse_relevance_metrics CONTENT {
          impulse_id: $impulse_id,
          activity_variant_id: $activity_variant_id,
          task_id: $task_id,
          times_loaded: $times_loaded,
          times_execution_succeeded: $times_execution_succeeded,
          times_execution_failed: $times_execution_failed,
          times_not_loaded_succeeded: $times_not_loaded_succeeded,
          times_not_loaded_failed: $times_not_loaded_failed,
          relevance_score: $relevance_score,
          irrelevance_score: $irrelevance_score,
          avg_content_size_tokens: $avg_content_size_tokens,
          typical_pointer_type: $typical_pointer_type,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const relevanceScore = validated.was_loaded && validated.execution_succeeded ? 1.0 : 0.0;
      const irrelevanceScore = !validated.was_loaded && validated.execution_succeeded ? 1.0 : 0.0;

      const created = await surrealDB.query<ImpulseRelevanceMetric[]>(createQuery, {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        times_loaded: validated.was_loaded ? 1 : 0,
        times_execution_succeeded: validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_execution_failed: validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        times_not_loaded_succeeded: !validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_not_loaded_failed: !validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        avg_content_size_tokens: validated.content_size_tokens || 0,
        typical_pointer_type: validated.pointer_type || '',
      });

      // @ts-ignore - SurrealDB typing
      metric = created && created.length > 0 ? created[0] : {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id,
        times_loaded: validated.was_loaded ? 1 : 0,
        times_execution_succeeded: validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_execution_failed: validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        times_not_loaded_succeeded: !validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_not_loaded_failed: !validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        avg_content_size_tokens: validated.content_size_tokens || 0,
        typical_pointer_type: validated.pointer_type || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      logger.info('Created impulse relevance metric', {
        impulse_id: validated.impulse_id,
        activity: validated.activity_variant_id,
      });
    }

    return c.json({
      success: true,
      metric,
    });
  } catch (error: any) {
    logger.error('POST /v2/activities/impulse-relevance failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record impulse relevance',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/impulse-relevance
 * Query impulse relevance metrics
 * 
 * Query parameters:
 * - impulse_id: Filter by specific impulse
 * - activity_variant_id: Filter by specific activity
 * - min_relevance_score: Filter metrics with relevance >= threshold
 * - max_irrelevance_score: Filter metrics with irrelevance <= threshold
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 * 
 * Use cases:
 * 1. Find irrelevant impulses: max_irrelevance_score=0.3 (high success without impulse)
 * 2. Find critical impulses: min_relevance_score=0.8 (high success only with impulse)
 * 3. Optimize activity: Get all metrics for activity_variant_id, skip low-relevance
 */
app.get('/impulse-relevance', async (c) => {
  try {
    const query = c.req.query();
    const validated = ImpulseRelevanceQuerySchema.parse({
      impulse_id: query.impulse_id,
      activity_variant_id: query.activity_variant_id,
      min_relevance_score: query.min_relevance_score ? parseFloat(query.min_relevance_score) : undefined,
      max_irrelevance_score: query.max_irrelevance_score ? parseFloat(query.max_irrelevance_score) : undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });

    logger.info('GET /v2/activities/impulse-relevance', validated);

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };

    if (validated.impulse_id) {
      whereClauses.push(`impulse_id = $impulse_id`);
      params.impulse_id = validated.impulse_id;
    }

    if (validated.activity_variant_id) {
      whereClauses.push(`activity_variant_id = $activity_variant_id`);
      params.activity_variant_id = validated.activity_variant_id;
    }

    if (validated.min_relevance_score !== undefined) {
      whereClauses.push(`relevance_score >= $min_relevance_score`);
      params.min_relevance_score = validated.min_relevance_score;
    }

    if (validated.max_irrelevance_score !== undefined) {
      whereClauses.push(`irrelevance_score <= $max_irrelevance_score`);
      params.max_irrelevance_score = validated.max_irrelevance_score;
    }

    let metricsQuery = `SELECT * FROM impulse_relevance_metrics`;
    if (whereClauses.length > 0) {
      metricsQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    metricsQuery += ` ORDER BY relevance_score DESC LIMIT $limit START $offset`;

    let countQuery = `SELECT count() as total FROM impulse_relevance_metrics`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [metricsResult, countResult] = await Promise.all([
      surrealDB.query<ImpulseRelevanceMetric[]>(metricsQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);

    // @ts-ignore - SurrealDB typing
    const response: ImpulseRelevanceResponse = {
      metrics: (metricsResult && Array.isArray(metricsResult) ? metricsResult.flat() : []),
      // @ts-ignore - SurrealDB typing
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };

    logger.info('Impulse relevance query result', {
      metrics: response.metrics.length,
      total: response.total,
    });

    return c.json(response);
  } catch (error: any) {
    logger.error('GET /v2/activities/impulse-relevance failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to query impulse relevance',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /tool-usage
 * 
 * Records tool usage during activity execution to learn:
 * - Which tools are required vs optional for each activity
 * - Success correlation between tool usage and activity outcomes
 * - Usage probability patterns
 * 
 * Learning metrics computed:
 * - usage_probability = times_used / total_executions
 * - is_required = (times_activity_succeeded_without_tool == 0)
 * - is_optional = (times_used < total_executions)
 * - success_correlation = correlation(tool_used, activity_succeeded)
 */
app.post('/tool-usage', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validate request body
    const validated = ToolUsageRecordRequestSchema.parse(body);
    logger.info('Recording tool usage', { 
      tool: validated.tool_name,
      activity: validated.activity_variant_id,
      execution: validated.execution_id,
    });
    
    // Check if pattern exists
    const checkQuery = `
      SELECT * FROM tool_usage_patterns
      WHERE activity_variant_id = $activity_variant_id
        AND tool_name = $tool_name
        ${validated.task_id ? 'AND task_id = $task_id' : 'AND task_id IS NONE'}
      LIMIT 1
    `;
    
    const existing = await surrealDB.query<ToolUsagePattern[]>(checkQuery, {
      activity_variant_id: validated.activity_variant_id,
      tool_name: validated.tool_name,
      task_id: validated.task_id ?? undefined,
    });
    
    let pattern: ToolUsagePattern;
    
    if (existing && existing.length > 0 && existing[0]) {
      // Update existing pattern
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing issue
      const newTimesUsed = (current.times_used || 0) + 1;
      // @ts-ignore - SurrealDB query typing issue
      const newTimesSucceeded = (current.times_succeeded || 0) + (validated.tool_succeeded ? 1 : 0);
      // @ts-ignore - SurrealDB query typing issue
      const newTimesFailed = (current.times_failed || 0) + (validated.tool_succeeded ? 0 : 1);
      // @ts-ignore - SurrealDB query typing issue
      const newTimesActivitySucceededWithTool = (current.times_activity_succeeded_with_tool || 0) + (validated.activity_succeeded ? 1 : 0);
      
      // Get total activity executions to compute usage probability
      // @ts-ignore - SurrealDB query typing issue
      const timesActivitySucceededWithoutTool = current.times_activity_succeeded_without_tool || 0;
      const totalExecutions = newTimesUsed + timesActivitySucceededWithoutTool;
      const usageProbability = totalExecutions > 0 ? newTimesUsed / totalExecutions : 0;
      
      // Tool is required if activity NEVER succeeded without it
      const isRequired = timesActivitySucceededWithoutTool === 0 && newTimesActivitySucceededWithTool > 0;
      
      // Tool is optional if not always used
      const isOptional = newTimesUsed < totalExecutions;
      
      // Simple success correlation: (successes_with_tool / uses) - (successes_without_tool / non_uses)
      const successRateWithTool = newTimesUsed > 0 ? newTimesActivitySucceededWithTool / newTimesUsed : 0;
      const successRateWithoutTool = timesActivitySucceededWithoutTool > 0 && totalExecutions > newTimesUsed
        ? timesActivitySucceededWithoutTool / (totalExecutions - newTimesUsed)
        : 0;
      const successCorrelation = successRateWithTool - successRateWithoutTool;
      
      // Update avg params complexity (rolling average)
      // @ts-ignore - SurrealDB query typing issue
      const currentAvg = current.avg_params_complexity || 0;
      // @ts-ignore - SurrealDB query typing issue
      const currentCount = current.times_used || 0;
      const avgParamsComplexity = validated.params_complexity !== undefined
        ? (currentAvg * currentCount + validated.params_complexity) / newTimesUsed
        : currentAvg;
      
      const typicalErrorRate = newTimesUsed > 0 ? newTimesFailed / newTimesUsed : 0;
      
      const updateQuery = `
        UPDATE tool_usage_patterns
        SET 
          times_used = $times_used,
          times_succeeded = $times_succeeded,
          times_failed = $times_failed,
          times_activity_succeeded_with_tool = $times_activity_succeeded_with_tool,
          usage_probability = $usage_probability,
          success_correlation = $success_correlation,
          is_required = $is_required,
          is_optional = $is_optional,
          avg_params_complexity = $avg_params_complexity,
          typical_error_rate = $typical_error_rate,
          updated_at = time::now()
        WHERE activity_variant_id = $activity_variant_id
          AND tool_name = $tool_name
          ${validated.task_id ? 'AND task_id = $task_id' : 'AND task_id IS NONE'}
        RETURN AFTER
      `;
      
      const updated = await surrealDB.query<ToolUsagePattern[]>(updateQuery, {
        activity_variant_id: validated.activity_variant_id,
        tool_name: validated.tool_name,
        task_id: validated.task_id ?? undefined,
        times_used: newTimesUsed,
        times_succeeded: newTimesSucceeded,
        times_failed: newTimesFailed,
        times_activity_succeeded_with_tool: newTimesActivitySucceededWithTool,
        usage_probability: usageProbability,
        success_correlation: Math.max(-1, Math.min(1, successCorrelation)), // Clamp to [-1, 1]
        is_required: isRequired,
        is_optional: isOptional,
        avg_params_complexity: avgParamsComplexity,
        typical_error_rate: typicalErrorRate,
      });
      
      // @ts-ignore - SurrealDB query typing issue
      pattern = updated && updated.length > 0 ? updated[0] : current;
      logger.info('Updated tool usage pattern', {
        tool: validated.tool_name,
        activity: validated.activity_variant_id,
        usageProbability,
        isRequired,
        successCorrelation,
      });
    } else {
      // Create new pattern
      const usageProbability = 1.0; // First execution, tool was used
      const isRequired = validated.activity_succeeded; // Required if first use succeeded
      const isOptional = false; // Not optional yet (only 1 execution)
      const successCorrelation = validated.tool_succeeded && validated.activity_succeeded ? 1.0 : 0.0;
      
      const createQuery = `
        CREATE tool_usage_patterns CONTENT {
          tool_name: $tool_name,
          activity_variant_id: $activity_variant_id,
          task_id: $task_id,
          times_used: 1,
          times_succeeded: $times_succeeded,
          times_failed: $times_failed,
          times_activity_succeeded_with_tool: $times_activity_succeeded_with_tool,
          times_activity_succeeded_without_tool: 0,
          usage_probability: $usage_probability,
          success_correlation: $success_correlation,
          is_required: $is_required,
          is_optional: $is_optional,
          avg_params_complexity: $avg_params_complexity,
          typical_error_rate: $typical_error_rate,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;
      
      const created = await surrealDB.query<ToolUsagePattern[]>(createQuery, {
        tool_name: validated.tool_name,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        times_succeeded: validated.tool_succeeded ? 1 : 0,
        times_failed: validated.tool_succeeded ? 0 : 1,
        times_activity_succeeded_with_tool: validated.activity_succeeded ? 1 : 0,
        usage_probability: usageProbability,
        success_correlation: successCorrelation,
        is_required: isRequired,
        is_optional: isOptional,
        avg_params_complexity: validated.params_complexity || 0,
        typical_error_rate: validated.tool_succeeded ? 0 : 1,
      });
      
      // @ts-ignore - SurrealDB query typing issue
      pattern = created && created.length > 0 ? created[0] : {
        tool_name: validated.tool_name,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id || '',
        times_used: 1,
        times_succeeded: validated.tool_succeeded ? 1 : 0,
        times_failed: validated.tool_succeeded ? 0 : 1,
        times_activity_succeeded_with_tool: validated.activity_succeeded ? 1 : 0,
        times_activity_succeeded_without_tool: 0,
        usage_probability: usageProbability,
        success_correlation: successCorrelation,
        is_required: isRequired,
        is_optional: isOptional,
        avg_params_complexity: validated.params_complexity || 0,
        typical_error_rate: validated.tool_succeeded ? 0 : 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      logger.info('Created new tool usage pattern', {
        tool: validated.tool_name,
        activity: validated.activity_variant_id,
      });
    }
    
    return c.json({ 
      success: true,
      message: 'Tool usage recorded successfully',
    });
    
  } catch (error: any) {
    logger.error('Failed to record tool usage', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to record tool usage',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /tool-usage
 * 
 * Query tool usage patterns with filtering:
 * - tool_name: Filter by specific tool
 * - activity_variant_id: Filter by activity
 * - is_required: Filter to only required tools
 * - min_usage_probability: Filter by usage frequency
 * 
 * Use cases:
 * - Pre-flight checks: "Does this vessel have required tools?"
 * - Optimization: "Can we skip loading this optional tool?"
 * - Discovery: "What tools does add-feature-complete typically need?"
 */
app.get('/tool-usage', async (c) => {
  try {
    const query = c.req.query();
    
    // Validate query params
    const validated = ToolUsageQuerySchema.parse({
      tool_name: query.tool_name,
      activity_variant_id: query.activity_variant_id,
      is_required: query.is_required === 'true' ? true : query.is_required === 'false' ? false : undefined,
      min_usage_probability: query.min_usage_probability ? parseFloat(query.min_usage_probability) : undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });
    
    logger.info('GET /v2/activities/tool-usage', validated);
    
    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };
    
    if (validated.tool_name) {
      whereClauses.push(`tool_name = $tool_name`);
      params.tool_name = validated.tool_name;
    }
    
    if (validated.activity_variant_id) {
      whereClauses.push(`activity_variant_id = $activity_variant_id`);
      params.activity_variant_id = validated.activity_variant_id;
    }
    
    if (validated.is_required !== undefined) {
      whereClauses.push(`is_required = $is_required`);
      params.is_required = validated.is_required;
    }
    
    if (validated.min_usage_probability !== undefined) {
      whereClauses.push(`usage_probability >= $min_usage_probability`);
      params.min_usage_probability = validated.min_usage_probability;
    }
    
    let patternsQuery = `SELECT * FROM tool_usage_patterns`;
    if (whereClauses.length > 0) {
      patternsQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    patternsQuery += ` ORDER BY usage_probability DESC LIMIT $limit START $offset`;
    
    let countQuery = `SELECT count() as total FROM tool_usage_patterns`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    
    const [patternsResult, countResult] = await Promise.all([
      surrealDB.query<ToolUsagePattern[]>(patternsQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);
    
    // @ts-ignore - SurrealDB typing
    const response: ToolUsageResponse = {
      patterns: (patternsResult && Array.isArray(patternsResult) ? patternsResult.flat() : []),
      // @ts-ignore - SurrealDB typing
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };
    
    logger.info('Tool usage query result', {
      patterns: response.patterns.length,
      total: response.total,
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to query tool usage patterns', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to query tool usage patterns',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /execution-sequences
 * 
 * Records execution sequences - which activities ran together in a session.
 * This enables learning:
 * - Typical sequences for achieving goals
 * - Success patterns (which sequences work well together)
 * - Failure patterns (which sequences fail)
 * - Sequence optimization (shorter successful paths)
 * 
 * Use cases:
 * - "For goal 'add authentication', what's the typical sequence?"
 * - "After activity A, what usually comes next?"
 * - "What's the success rate of sequence [A, B, C]?"
 */
app.post('/execution-sequences', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validate request body
    const validated = ExecutionSequenceRecordRequestSchema.parse(body);
    logger.info('Recording execution sequence', {
      session: validated.session_id,
      activities: validated.sequence.length,
      outcome: validated.outcome,
    });
    
    // Compute aggregates
    const totalDuration = validated.sequence.reduce((sum, item) => sum + item.duration_ms, 0);
    const totalCost = validated.sequence.reduce((sum, item) => sum + item.cost_usd, 0);
    const totalActivities = validated.sequence.length;
    
    // Create record
    const createQuery = `
      CREATE execution_sequences CONTENT {
        session_id: $session_id,
        goal_context: $goal_context,
        sequence: $sequence,
        outcome: $outcome,
        total_duration_ms: $total_duration_ms,
        total_cost_usd: $total_cost_usd,
        total_activities: $total_activities,
        created_at: time::now(),
        updated_at: time::now()
      }
    `;
    
    const created = await surrealDB.query<ExecutionSequence[]>(createQuery, {
      session_id: validated.session_id,
      goal_context: validated.goal_context || '',
      sequence: validated.sequence,
      outcome: validated.outcome,
      total_duration_ms: totalDuration,
      total_cost_usd: totalCost,
      total_activities: totalActivities,
    });
    
    // @ts-ignore - SurrealDB query typing issue
    const sequence: ExecutionSequence = created && created.length > 0 ? created[0] : {
      session_id: validated.session_id,
      goal_context: validated.goal_context || '',
      sequence: validated.sequence,
      outcome: validated.outcome,
      total_duration_ms: totalDuration,
      total_cost_usd: totalCost,
      total_activities: totalActivities,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    logger.info('Execution sequence recorded', {
      session: validated.session_id,
      activities: totalActivities,
      duration: totalDuration,
      outcome: validated.outcome,
    });
    
    return c.json({
      success: true,
      sequence,
    });
    
  } catch (error: any) {
    logger.error('Failed to record execution sequence', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to record execution sequence',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /execution-sequences
 * 
 * Query execution sequences with filtering:
 * - session_id: Get sequences from specific session
 * - goal_context: Fuzzy match on goal description
 * - outcome: Filter by success/partial/failure
 * - min_activities/max_activities: Filter by sequence length
 * 
 * Use cases:
 * - Session analysis: "What did I do in session X?"
 * - Goal patterns: "What sequences achieve goal Y?"
 * - Success analysis: "What successful sequences exist for similar goals?"
 * - Failure analysis: "What sequences failed and why?"
 */
app.get('/execution-sequences', async (c) => {
  try {
    const query = c.req.query();
    
    // Validate query params
    const validated = ExecutionSequenceQuerySchema.parse({
      session_id: query.session_id,
      goal_context: query.goal_context,
      min_activities: query.min_activities ? parseInt(query.min_activities) : undefined,
      max_activities: query.max_activities ? parseInt(query.max_activities) : undefined,
      outcome: query.outcome as 'success' | 'partial' | 'failure' | undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });
    
    logger.info('GET /v2/activities/execution-sequences', validated);
    
    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };
    
    if (validated.session_id) {
      whereClauses.push(`session_id = $session_id`);
      params.session_id = validated.session_id;
    }
    
    if (validated.goal_context) {
      // Fuzzy match on goal context
      whereClauses.push(`goal_context CONTAINS $goal_context`);
      params.goal_context = validated.goal_context;
    }
    
    if (validated.outcome) {
      whereClauses.push(`outcome = $outcome`);
      params.outcome = validated.outcome;
    }
    
    if (validated.min_activities !== undefined) {
      whereClauses.push(`total_activities >= $min_activities`);
      params.min_activities = validated.min_activities;
    }
    
    if (validated.max_activities !== undefined) {
      whereClauses.push(`total_activities <= $max_activities`);
      params.max_activities = validated.max_activities;
    }
    
    let sequencesQuery = `SELECT * FROM execution_sequences`;
    if (whereClauses.length > 0) {
      sequencesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    sequencesQuery += ` ORDER BY created_at DESC LIMIT $limit START $offset`;
    
    let countQuery = `SELECT count() as total FROM execution_sequences`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    
    const [sequencesResult, countResult] = await Promise.all([
      surrealDB.query<ExecutionSequence[]>(sequencesQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);
    
    // @ts-ignore - SurrealDB typing
    const response: ExecutionSequenceResponse = {
      sequences: (sequencesResult && Array.isArray(sequencesResult) ? sequencesResult.flat() : []),
      // @ts-ignore - SurrealDB typing
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };
    
    logger.info('Execution sequences query result', {
      sequences: response.sequences.length,
      total: response.total,
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to query execution sequences', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to query execution sequences',
      message: error.message,
    }, 500);
  }
});
