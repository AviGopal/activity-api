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
import beta from '@stdlib/random-base-beta';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { logger } from '../utils/logger';
import { ensureTags, computeTagPrefixes, deriveCategory } from '../utils/tags';
import { analyzeTaskSemantics } from '../utils/semantic-tags';
import { calculateImpulseRelevancyBoosts, discoverMissingImpulses } from '../utils/impulse-relevancy';
import { captureValidationTrace } from '../utils/validation-traces';
import {
  insertActivity,
  insertExecution,
  getActivityScores,
  getShapeConditionedScores,
  queryActivitiesByShapes,
  queryActivitiesByFTS,
  transformToLegacyTemplate,
  isDualWriteEnabled,
  type ParadigmActivity,
  type ParadigmExecution,
  type ActivityScore,
} from '../db/paradigm';

/**
 * Thompson Sampling Beta distribution sampler.
 *
 * Uses @stdlib/random-base-beta to sample from Beta(alpha, beta) distribution.
 * When THOMPSON_SAMPLING_SEED env var is set, uses seeded RNG for reproducible tests.
 *
 * @param alpha - Success count + 1 (prior)
 * @param betaParam - Failure count + 1 (prior)
 * @returns Sample from Beta(alpha, beta) distribution, value between 0 and 1
 */
const betaSample: (alpha: number, betaParam: number) => number = (() => {
  const seed = process.env.THOMPSON_SAMPLING_SEED;
  if (seed) {
    const seedNum = parseInt(seed, 10);
    if (!isNaN(seedNum)) {
      logger.info('Thompson Sampling initialized with seed', { seed: seedNum });
      return beta.factory({ seed: seedNum });
    }
  }
  return beta;
})();
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

// =============================================================================
// ActivityTemplate Interface (Canonical Field Names)
// =============================================================================
// Aligned with 020-paradigm-core-tables.surql 'activity' table schema.
// Uses canonical field names: id, name, tasks (not variant_id, variant_name, task_steps)
// =============================================================================
interface ActivityTemplate {
  // Canonical fields
  id: string;
  name: string;
  description: string;
  // Hierarchical tags (primary classification)
  tags: string[];
  tag_prefixes?: string[];
  // Legacy category (deprecated)
  category?: string;
  // Canonical: 'tasks' (was task_steps)
  tasks?: any[];
  scope: string | null;
  org_id: string | null;
  project_id: string | null;
  // Input/output shapes for paradigm alignment
  input_shapes?: string[];
  output_shapes?: string[];
  execution_type?: string;
  // Canonical: 'variant_of' (was genealogy)
  variant_of?: Record<string, any>;
  created_at: string;
  updated_at: string;
  metrics?: {
    id: string;
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
 * Filter templates by input shapes compatibility
 * Uses canonical 'input_shapes' field (paradigm-aligned)
 * Falls back to legacy 'input_schema' for backward compatibility
 *
 * A template matches if ALL required shapes in its input_shapes are present in providedShapes
 * Templates without input_shapes match anything (backwards compatible)
 */
function filterByInputSchema(
  templates: any[],
  providedShapes: string[]
): any[] {
  if (!providedShapes || providedShapes.length === 0) {
    return templates;
  }

  const providedSet = new Set(providedShapes);

  return templates.filter(template => {
    // Prefer canonical 'input_shapes' field, fall back to legacy 'input_schema'
    const inputShapes = template.input_shapes;
    const inputSchema = template.input_schema;

    // Templates without input requirements match anything (backwards compatible)
    if (!inputShapes?.length && (!inputSchema || !inputSchema.required || !Array.isArray(inputSchema.required))) {
      return true;
    }

    // Use canonical input_shapes if available
    if (inputShapes?.length) {
      const allRequiredPresent = inputShapes.every((shape: string) =>
        providedSet.has(shape)
      );

      // Log for composition learning
      if (allRequiredPresent && template.output_shapes) {
        logger.debug('[Composition Learning] Activity produces output shapes', {
          activity_id: template.id,
          input_shapes: inputShapes,
          output_shapes: template.output_shapes,
        });
      }

      return allRequiredPresent;
    }

    // Fall back to legacy input_schema
    const requiredShapes = inputSchema.required.map((s: any) =>
      typeof s === 'string' ? s : s.shape
    ).filter(Boolean);

    const allRequiredPresent = requiredShapes.every((shape: string) =>
      providedSet.has(shape)
    );

    // Log for composition learning
    if (allRequiredPresent && template.output_shapes) {
      logger.debug('[Composition Learning] Activity produces output shapes', {
        activity_id: template.id,
        input_shapes: requiredShapes,
        output_shapes: template.output_shapes,
      });
    }

    return allRequiredPresent;
  });
}

/**
 * Enrich templates with execution metrics from v_activity_score view
 * Uses canonical field names (id instead of variant_id)
 */
async function enrichTemplatesWithMetrics(
  templates: ActivityTemplate[]
): Promise<ActivityTemplate[]> {
  if (templates.length === 0) {
    return templates;
  }

  try {
    // Extract activity IDs using canonical 'id' field
    const activityIds = templates.map(t => t.id);

    logger.info('Enriching templates with metrics', {
      templateCount: templates.length,
      sampleIds: activityIds.slice(0, 3)
    });

    // Query metrics for all activities in one go
    // Use v_activity_score view (paradigm-aligned)
    // Fallback to legacy variant_performance_metrics if view doesn't exist
    let metricsResult: any[] = [];

    try {
      const metricsQuery = `
        SELECT * FROM v_activity_score
        WHERE activity_id IN $activity_ids
      `;
      metricsResult = await surrealDB.query<any>(metricsQuery, {
        activity_ids: activityIds
      });
    } catch (error: any) {
      // Fallback to activity table if view doesn't exist yet
      logger.warn('Failed to query v_activity_score, falling back to activity table', {
        error: error.message
      });
      const fallbackQuery = `
        SELECT id as activity_id, name, total_executions,
               thompson_alpha, thompson_beta, success_rate,
               avg_duration_ms, avg_cost_usd
        FROM activity
        WHERE id IN $activity_ids
      `;
      metricsResult = await surrealDB.query<any>(fallbackQuery, {
        activity_ids: activityIds
      });
    }

    logger.info('Metrics query result', {
      metricsFound: metricsResult?.length || 0,
      sampleMetrics: metricsResult?.slice(0, 2).map((m: any) => ({
        id: m.activity_id || m.variant_id,
        alpha: m.thompson_alpha || m.alpha,
        beta: m.thompson_beta || m.beta
      }))
    });

    // Create a map of activity_id -> metrics (handle both canonical and legacy field names)
    const metricsMap = new Map();
    for (const metric of metricsResult) {
      const id = metric.activity_id || metric.variant_id;
      // Normalize metrics to canonical field names
      const normalizedMetric = {
        id,
        total_executions: metric.total_executions,
        successful_executions: metric.successful_executions || metric.successes,
        failed_executions: metric.failed_executions || metric.failures,
        success_rate: metric.success_rate,
        avg_duration_ms: metric.avg_duration_ms,
        avg_cost_usd: metric.avg_cost_usd,
        thompson_alpha: metric.thompson_alpha || metric.alpha,
        thompson_beta: metric.thompson_beta || metric.beta,
        total_selections: metric.total_selections,
        last_executed_at: metric.last_executed_at,
        created_at: metric.created_at,
        updated_at: metric.updated_at,
      };
      metricsMap.set(id, normalizedMetric);
    }

    // Attach metrics to each template using canonical 'id' field
    return templates.map(template => ({
      ...template,
      metrics: metricsMap.get(template.id) || undefined
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
  scopeFilter?: string | null,
  executionType?: string | null // T8: Allow filtering by execution_type
): Promise<ActivityTemplate[]> {
  let query: string;
  let params: Record<string, any>;

  // T8: Default to 'template' for backward compatibility
  const effectiveExecutionType = executionType || 'template';

  if (jwtToken) {
    // JWT AUTH PATH: Use RBAC-enforced query
    // The PERMISSIONS clause on activity_template uses $auth.org_id to filter
    // We just need to query all templates - SurrealDB will filter automatically
    let whereClause = '';
    params = { limit, execution_type: effectiveExecutionType };

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
      SELECT * FROM activity
      WHERE execution_type = $execution_type
      ${whereClause ? 'AND ' + whereClause.replace('WHERE ', '') : ''}
      ORDER BY created_at DESC
      LIMIT $limit
    `;

    logger.debug('Fetching activities with JWT auth (RBAC enforced)', { limit, scopeFilter, executionType: effectiveExecutionType });
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
      // User has both org_id and project_id: return global + org + project activities
      query = `
        SELECT * FROM activity
        WHERE execution_type = $execution_type
        AND (
          (scope = 'global' AND public = true)
          OR (scope = 'org' AND org_id = $org_id)
          OR (scope = 'project' AND project_id = $project_id)
        ) ${scopeClause}
        ORDER BY created_at DESC
        LIMIT $limit
      `;
      params = { limit, org_id: orgId, project_id: projectId, execution_type: effectiveExecutionType };
    } else {
      // User has org_id but no project_id: return global + org activities
      query = `
        SELECT * FROM activity
        WHERE execution_type = $execution_type AND (
          scope IS NULL
          OR scope = 'global'
          OR (scope = 'org' AND org_id = $org_id)
        ) ${scopeClause}
        ORDER BY created_at DESC
        LIMIT $limit
      `;
      params = { limit, org_id: orgId, execution_type: effectiveExecutionType };
    }
  } else {
    // No org_id: return only global activities
    query = `
      SELECT * FROM activity
      WHERE execution_type = $execution_type AND (
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
 * List public templates from SurrealDB.
 *
 * Public templates are globally scoped templates with public=true.
 * No authentication required - these are visible to all users.
 */
async function listPublicTemplatesFromDB(
  limit: number
): Promise<ActivityTemplate[]> {
  const query = `
    SELECT * FROM activity
    WHERE execution_type = 'template'
      AND scope = 'global'
      AND public = true
    ORDER BY created_at DESC
    LIMIT $limit
  `;
  const params = { limit };

  logger.debug('Fetching public templates from SurrealDB', { limit });
  const result = await surrealDB.query<ActivityTemplate>(query, params);

  logger.info('SurrealDB public templates fetched', {
    count: result.length
  });

  // Enrich templates with metrics before returning
  const enrichedTemplates = await enrichTemplatesWithMetrics(result);
  logger.info('Public templates enriched with metrics', { enrichedCount: enrichedTemplates.length });
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
  // Parse body early for validation trace capture
  let body: any;
  let jwtAuth: any;
  let orgId: string | null = null;
  let projectId: string | null = null;

  try {
    // Check for JWT auth first (MiniBob instances)
    jwtAuth = getJwtAuthFromContext(c);

    logger.info('POST /templates - JWT auth context', {
      hasJwtAuth: !!jwtAuth,
      jwtAuthOrgId: jwtAuth?.orgId,
      hasJwtToken: !!jwtAuth?.jwtToken,
    });

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    orgId = jwtAuth?.orgId || session?.org_id || null;
    projectId = jwtAuth?.projectId || session?.project_id || null;

    // Parse and validate request body
    body = await c.req.json();
    const validated = CreateTemplateRequestSchema.parse(body);

    // Normalize to canonical field names (accept both legacy and canonical)
    const activityId = validated.id || validated.variant_id;
    const activityName = validated.name || validated.variant_name;
    const activityTasks = validated.tasks || validated.task_steps;
    const activityVariantOf = validated.variant_of || validated.genealogy;

    // Convert category to tags if needed (backward compatibility)
    const tags = ensureTags({ tags: validated.tags, category: validated.category });
    const tagPrefixes = computeTagPrefixes(tags);
    // Derive category for backward compat (first tag's root segment if known)
    const derivedCategory = deriveCategory(tags) || validated.category || tags[0]?.split('.')[0] || 'uncategorized';

    logger.info('POST /v2/activities/templates', {
      id: activityId,
      name: activityName,
      tags,
      tagPrefixes,
      category: derivedCategory,
      scope: validated.scope,
    });

    // Check if activity already exists
    const existingQuery = `
      SELECT * FROM activity
      WHERE id = $id
      LIMIT 1
    `;

    const existing = await surrealDB.query<ActivityTemplate>(existingQuery, {
      id: activityId,
    });

    if (existing.length > 0) {
      logger.warn('Template already exists', { id: activityId });
      return c.json({
        success: false,
        id: activityId,
        variant_id: activityId, // Legacy alias for backward compatibility
        message: 'Template variant already exists',
      } as CreateTemplateResponse, 409);
    }

    // Build activity record using canonical field names
    const activityRecord: Record<string, any> = {
      id: activityId,
      name: activityName,
      description: validated.description,
      execution_type: 'template',
      // Hierarchical tags (primary classification)
      tags,
      tag_prefixes: tagPrefixes,
      // Legacy category for backward compatibility
      category: derivedCategory,
      scope: validated.scope || 'org',
    };

    // Add org_id only if provided (optional field, let schema handle default)
    if (validated.org_id || orgId) {
      activityRecord.org_id = validated.org_id || orgId;
    }

    // Add tasks using canonical field name
    if (activityTasks && activityTasks.length > 0) {
      activityRecord.tasks = activityTasks;
    }

    // Add input/output shapes for paradigm alignment
    if (validated.input_shapes?.length) {
      activityRecord.input_shapes = validated.input_shapes;
    } else if (validated.input_schema?.required) {
      // Convert legacy input_schema to input_shapes
      activityRecord.input_shapes = validated.input_schema.required
        .map((s: any) => typeof s === 'string' ? s : s.shape)
        .filter(Boolean);
    }
    if (validated.output_shapes?.length) {
      activityRecord.output_shapes = validated.output_shapes;
    } else if (validated.output_schema?.produces) {
      // Convert legacy output_schema to output_shapes
      activityRecord.output_shapes = validated.output_schema.produces
        .map((s: any) => typeof s === 'string' ? s : s.shape)
        .filter(Boolean);
    }

    // Add optional fields only if provided
    if (validated.project_id || projectId) {
      activityRecord.project_id = validated.project_id || projectId;
    }
    if (activityVariantOf && Object.keys(activityVariantOf).length > 0) {
      activityRecord.variant_of = activityVariantOf;
    }

    // Build dynamic query with only provided fields
    const fields = Object.keys(activityRecord).map(k => `${k}: $${k}`).join(',\n        ');
    const insertActivityQuery = `
      INSERT INTO activity {
        ${fields},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    await surrealDB.query(insertActivityQuery, activityRecord);

    logger.info('Activity template inserted into activity table', {
      id: activityId,
      name: activityName,
      scope: activityRecord.scope,
      public: activityRecord.public,
    });

    // Create initial performance metrics
    // org_id is optional - use session org or request value if provided
    // Use record format for consistency with JWT $auth.org_id
    const metricsOrgId = validated.org_id || orgId || 'organizations:metabob_internal';
    const metricsProjectId = validated.project_id || projectId;

    // Build metrics query with conditional project_id
    // Note: variant_performance_metrics is a legacy table but still used for Thompson Sampling
    // The v_activity_score view reads from this table
    const insertMetricsQuery = metricsProjectId
      ? `
      INSERT INTO variant_performance_metrics {
        variant_id: $activity_id,
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
        variant_id: $activity_id,
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
      activity_id: activityId,
      org_id: metricsOrgId,
      ...(metricsProjectId ? { project_id: metricsProjectId } : {}),
    });

    logger.info('Template registered successfully', {
      id: activityId,
    });

    // Invalidate Redis cache so the new template appears in list queries
    const redis = RedisClient.getInstance();
    await redis.del(CACHE_LIST_KEY);
    logger.debug('Redis template list cache invalidated after template registration', {
      id: activityId,
    });

    return c.json({
      success: true,
      id: activityId,
      variant_id: activityId, // Legacy alias for backward compatibility
      message: 'Template registered successfully',
    } as CreateTemplateResponse, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/templates failed', {
      error: error.message,
      stack: error.stack,
    });

    // Check if it's a validation error
    if (error.name === 'ZodError') {
      // Capture validation error as trace for pattern detection
      // This enables auto-detection of schema mismatches like snake_case vs camelCase
      captureValidationTrace(
        '/v2/activities/templates',
        'POST',
        error.errors,
        body,
        {
          callerId: jwtAuth?.instanceId,
          orgId: orgId || undefined,
          projectId: projectId || undefined,
        }
      );

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
 * GET /v2/activities/validation-patterns
 * Detect recurring validation errors for self-healing
 *
 * Returns patterns of validation failures that occur frequently,
 * enabling auto-detection of schema drift and field naming mismatches.
 */
app.get('/validation-patterns', async (c) => {
  try {
    const { detectValidationPatterns } = await import('../utils/validation-traces');
    const timeWindowHours = parseInt(c.req.query('hours') || '24', 10);
    const minFrequency = parseInt(c.req.query('min_frequency') || '3', 10);

    const patterns = await detectValidationPatterns(timeWindowHours, minFrequency);

    return c.json({
      patterns,
      query: {
        time_window_hours: timeWindowHours,
        min_frequency: minFrequency,
      },
      total: patterns.length,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/validation-patterns failed', {
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
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
    const executionType = c.req.query('execution_type') || null; // T8: Filter by execution_type
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
      executionType,
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

      // Load each template from cache (using canonical 'id' field)
      const templatePromises = templateIdsSet.map(async (activityId) => {
        const cachedData = await redis.get(`${CACHE_KEY_PREFIX}${activityId}`);
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
            scopeFilter,
            executionType // T8: Pass execution_type filter
          );

          // Populate Redis cache (only for non-JWT queries to avoid polluting global cache)
          // JWT queries are already RBAC-filtered, so caching would leak isolation
          if (dbTemplates.length > 0 && !useJwtAuth) {
            const cachePromises: Promise<any>[] = [];

            for (const template of dbTemplates) {
              // Use canonical 'id' field
              const activityId = template.id;

              // Store template data with TTL
              cachePromises.push(
                redis.set(
                  `${CACHE_KEY_PREFIX}${activityId}`,
                  JSON.stringify(template),
                  TEMPLATE_CACHE_TTL
                )
              );

              // Add to template list set
              cachePromises.push(
                redis.sadd(CACHE_LIST_KEY, activityId)
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
    logger.debug('Template enrichment point reached', { count: templates.length });
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
 * GET /v2/activities/public
 * List public templates visible to all users (no auth required)
 *
 * Public templates are globally scoped templates with public=true.
 * This endpoint is unauthenticated - anyone can browse public templates.
 *
 * Query parameters:
 * - limit: Maximum number of templates to return (default: 50, max: 100)
 */
app.get('/public', async (c) => {
  try {
    const limitStr = c.req.query('limit') || '50';
    let limit = parseInt(limitStr, 10);

    // Validate limit
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    }
    limit = Math.min(limit, 100);

    logger.info('GET /v2/activities/public', { limit });

    // Load public templates from SurrealDB (no auth required)
    const templates = await listPublicTemplatesFromDB(limit);

    logger.info('Public templates fetched', {
      count: templates.length,
      limit,
    });

    return c.json({
      templates,
      total: templates.length,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/public failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch public templates',
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

    // Query from activity table (the canonical table for templates)
    // Use meta::id() to extract just the ID part (without table prefix) and compare
    const variantQuery = `
      SELECT * FROM activity
      WHERE meta::id(id) = $variant_id
        AND execution_type = 'template'
      LIMIT 1
    `;
    result = await surrealDB.query<ActivityTemplate>(variantQuery, { variant_id: variantId });

    // If not found, try treating variant_id as a full record ID (for activity:xyz format)
    if (result.length === 0 && variantId.includes(':')) {
      try {
        const recordQuery = `
          SELECT * FROM activity
          WHERE id = type::record($variant_id)
            AND execution_type = 'template'
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

    // Enrich with metrics before caching
    const enrichedTemplates = await enrichTemplatesWithMetrics([template]);
    const enrichedTemplate = enrichedTemplates[0] || template;

    // Cache the enriched result
    await redis.set(
      `${CACHE_KEY_PREFIX}${variantId}`,
      JSON.stringify(enrichedTemplate),
      TEMPLATE_CACHE_TTL
    );

    logger.info('Template fetched from SurrealDB', { variantId, hasMetrics: !!enrichedTemplate.metrics });

    return c.json(enrichedTemplate);

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
 * 1. Recording execution result in activity_execution_traces table
 * 2. Updating variant_performance_metrics with Thompson Sampling parameters
 * 3. Invalidating Redis cache for updated template
 */
app.post('/executions', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    // org_id is a string field (not a record), project_id is record<projects>
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const rawProjectId = jwtAuth?.projectId || session?.project_id || null;

    // Only project_id needs record format (record<projects>)
    const projectId = rawProjectId
      ? (rawProjectId.startsWith('projects:') ? rawProjectId : `projects:${rawProjectId}`)
      : null;

    // Parse and validate request body
    const body = await c.req.json();
    const validated = ExecutionRecordSchema.parse(body);

    // Normalize to canonical field name: activity_id (accept legacy variant_id)
    const activityIdFromRequest = validated.activity_id || validated.variant_id!;

    logger.info('POST /v2/activities/executions', {
      activity_id: activityIdFromRequest,
      success: validated.success,
      duration_ms: validated.duration_ms,
      cost: validated.cost,
      orgId,
      projectId,
    });

    // Generate execution ID
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

    // Look up template to verify it exists (using canonical 'activity' table)
    // The activityIdFromRequest is already the canonical ID
    const templateLookup = await surrealDB.query<{ id: string }>(
      'SELECT id FROM activity WHERE id = $activity_id LIMIT 1',
      { activity_id: activityIdFromRequest }
    );
    const activityId = templateLookup[0]?.id || activityIdFromRequest;

    // Emit execution_started event via WebSocket
    const executionStartedData: any = {
      execution_id: executionId,
      activity_id: activityIdFromRequest,
      // Legacy field for backward compatibility
      variant_id: activityIdFromRequest,
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
      activity_id: activityId,
      // Legacy field for backward compatibility with activity_execution_traces table
      variant_id: activityIdFromRequest,
      success: validated.success,
      status: validated.success ? 'success' : 'failure',
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

    // Edge learning fields (from improvisation traces)
    if (validated.improvisation) {
      executionRecord.improvisation = validated.improvisation;
    }
    if (validated.input_impulse_shapes && validated.input_impulse_shapes.length > 0) {
      executionRecord.input_impulse_shapes = validated.input_impulse_shapes;
    }
    if (validated.output_impulse_shapes && validated.output_impulse_shapes.length > 0) {
      executionRecord.output_impulse_shapes = validated.output_impulse_shapes;
    }
    if (validated.output_impulses && validated.output_impulses.length > 0) {
      executionRecord.output_impulses = validated.output_impulses;
    }
    if (validated.metadata) {
      executionRecord.metadata = validated.metadata;
    }

    // Build dynamic query with only provided fields
    // org_id is string, project_id needs type::record() casting for SurrealDB
    const execFields = Object.keys(executionRecord).map(k => {
      if (k === 'project_id') {
        return `${k}: type::record($${k})`;
      }
      return `${k}: $${k}`;
    }).join(',\n        ');
    const insertExecutionQuery = `
      INSERT INTO activity_execution_traces {
        ${execFields},
        executed_at: time::now(),
        created_at: time::now()
      }
    `;

    await surrealDB.query(insertExecutionQuery, executionRecord);

    logger.debug('Execution recorded in activity_execution_traces', { executionId });

    // DUAL-WRITE: Also insert into new paradigm execution table (schema-paradigm-alignment)
    // v_activity_score view computes Thompson Sampling from execution table automatically
    // P4.1: Feature flag controlled
    if (isDualWriteEnabled()) {
      try {
        const paradigmExecution: Partial<ParadigmExecution> = {
        id: executionId,
        activity_id: activityIdFromRequest,
        input_impulses: validated.impulses_used || [],
        // Use output_impulses from improvisation traces if available
        output_impulses: validated.output_impulses?.map((imp: any) => imp.shape) || [],
        success: validated.success,
        error: validated.error_message ? {
          message: validated.error_message,
          type: validated.error_type,
          task_id: validated.failed_task_id,
        } : undefined,
        duration_ms: validated.duration_ms,
        cost_usd: validated.cost,
        tokens_in: validated.tokens.input,
        tokens_out: validated.tokens.output,
        org_id: orgId || undefined,
        project_id: projectId || undefined,
        // Edge learning fields
        ...(validated.improvisation && { improvisation: validated.improvisation }),
        ...(validated.input_impulse_shapes && { input_impulse_shapes: validated.input_impulse_shapes }),
        ...(validated.output_impulse_shapes && { output_impulse_shapes: validated.output_impulse_shapes }),
        ...(validated.metadata && { metadata: validated.metadata }),
      };

      const paradigmResult = await insertExecution(paradigmExecution, jwtAuth?.jwtToken);
      if (paradigmResult) {
        logger.info('[paradigm] Execution also written to execution table', {
          id: executionId,
          activity_id: activityIdFromRequest,
          path: 'dual-write',
        });
      }
      } catch (paradigmError) {
        // Don't fail the request if paradigm write fails - legacy write succeeded
        logger.warn('[paradigm] Dual-write to execution table failed (non-blocking)', {
          execution_id: executionId,
          error: paradigmError instanceof Error ? paradigmError.message : String(paradigmError),
        });
      }
    } // end isDualWriteEnabled()

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
      variant_id: activityIdFromRequest,
      success_delta,
      failure_delta,
      duration_ms: validated.duration_ms,
      cost: validated.cost,
    });

    logger.info('Thompson Sampling metrics updated', {
      activity_id: activityIdFromRequest,
      metricsUpdated: metricsResult.length > 0,
    });

    // Step 3: Invalidate Redis cache for this template
    const redis = RedisClient.getInstance();
    await redis.del(`${CACHE_KEY_PREFIX}${activityIdFromRequest}`);
    await redis.srem(CACHE_LIST_KEY, activityIdFromRequest);

    logger.debug('Redis cache invalidated for template', {
      activity_id: activityIdFromRequest,
    });

    // Extract updated metrics from result
    const updatedMetrics = metricsResult.length > 0 ? metricsResult[0] : undefined;

    // Emit execution_completed event via WebSocket
    broadcaster.emit({
      type: 'execution_completed',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: executionId,
        activity_id: activityIdFromRequest,
        // Legacy field for backward compatibility
        variant_id: activityIdFromRequest,
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
          activity_id: activityIdFromRequest,
          // Legacy field for backward compatibility
          variant_id: activityIdFromRequest,
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
    let query = 'SELECT * FROM v_paradigm_execution_traces WHERE 1=1';
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
    const templateCountResult = await surrealDB.query('SELECT count() AS count FROM activity GROUP ALL');
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
      average_success_rate: ((stats.success_rate || 0) * 100).toFixed(1),
      average_duration_ms: Math.round(stats.avg_duration || 0),
      total_cost_usd: (stats.total_cost || 0).toFixed(2),
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

/**
 * GET /scores
 *
 * Get Thompson Sampling scores for all activities in the learned corpus.
 * Used by the Learned Corpus Dashboard to visualize activity beliefs.
 *
 * Query params:
 * - limit: number (default 100, max 500)
 * - min_executions: number (optional, filter activities with minimum executions)
 *
 * Returns: ActivityScoresResponse
 */
app.get('/scores', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    const limitStr = c.req.query('limit') || '100';
    let limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 1) limit = 100;
    limit = Math.min(limit, 500);

    const minExecutionsStr = c.req.query('min_executions');
    const minExecutions = minExecutionsStr ? parseInt(minExecutionsStr, 10) : undefined;

    logger.info('GET /v2/activities/scores', {
      orgId,
      limit,
      minExecutions,
    });

    // Use existing getActivityScores function from paradigm.ts
    const result = await getActivityScores(orgId, undefined, jwtAuth?.jwtToken);

    // Filter by min_executions if specified
    let scores = result.data;
    if (minExecutions && !isNaN(minExecutions)) {
      scores = scores.filter(s => s.total_executions >= minExecutions);
    }

    // Apply limit
    scores = scores.slice(0, limit);

    return c.json({
      scores,
      total: result.data.length,
      path: result.path === 'new' ? 'paradigm' : 'legacy',
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/scores failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity scores',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /corpus-summary
 *
 * Get aggregate metrics for the learned corpus.
 * Used by the Learned Corpus Dashboard to show corpus statistics.
 *
 * Returns: CorpusSummaryResponse
 */
app.get('/corpus-summary', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    logger.info('GET /v2/activities/corpus-summary', { orgId });

    // org_id in v_activity_score is stored as record ID (e.g., "organizations:metabob_internal")
    const fullOrgId = orgId.startsWith('organizations:') ? orgId : `organizations:${orgId}`;

    // Query aggregate metrics from v_activity_score
    // Note: org_id in the view is a record reference, so we use type::record() to convert
    const summaryResult = await surrealDB.query(`
      SELECT
        count() AS total_activities,
        math::sum(total_executions) AS total_executions,
        math::sum(successes) AS total_successes,
        math::sum(failures) AS total_failures,
        math::sum(total_cost_usd) AS total_cost_usd,
        math::mean(<float> alpha / (<float> alpha + <float> beta)) AS avg_belief,
        count(IF total_executions < 5 THEN 1 ELSE NONE END) AS exploration_count,
        count(IF total_executions >= 10 THEN 1 ELSE NONE END) AS exploitation_count
      FROM v_activity_score
      WHERE org_id = type::record($org_id)
      GROUP ALL
    `, { org_id: fullOrgId });

    const stats = summaryResult[0] as any || {};

    const totalExecutions = stats.total_executions || 0;
    const totalSuccesses = stats.total_successes || 0;

    return c.json({
      total_activities: stats.total_activities || 0,
      total_executions: totalExecutions,
      total_successes: totalSuccesses,
      total_failures: stats.total_failures || 0,
      overall_success_rate: totalExecutions > 0 ? totalSuccesses / totalExecutions : 0,
      total_cost_usd: stats.total_cost_usd || 0,
      avg_belief: stats.avg_belief || 0.5,
      exploration_count: stats.exploration_count || 0,
      exploitation_count: stats.exploitation_count || 0,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/corpus-summary failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch corpus summary',
      message: error.message,
    }, 500);
  }
});

export default app;

/**
 * Tiered fallback result type
 */
type TieredFallbackResult = {
  activities: ParadigmActivity[];
  tier: 'exact' | 'compatible' | 'fts';
};

/**
 * Tiered fallback for activity recommendations
 * Each tier progressively relaxes constraints to ensure results
 *
 * Tier 1: Exact match - shapes + category + tags
 * Tier 2: Compatible - shapes optional, category soft match
 * Tier 3: FTS fallback - search by goal description
 *
 * @param shapes - Available impulse shapes for filtering
 * @param category - Optional category filter
 * @param goalDescription - Goal description for FTS search fallback
 * @param orgId - Organization ID for multi-tenant filtering
 * @param executionType - Optional execution_type filter
 * @param limit - Maximum number of results to return
 * @param jwtToken - Optional JWT token for RBAC
 * @returns Activities with tier indicator
 */
async function getActivitiesWithTieredFallback(
  shapes: string[],
  category: string | null,
  goalDescription: string | null,
  orgId: string | null,
  executionType: 'template' | 'tool' | 'composition' | 'vessel_function' | null,
  limit: number,
  jwtToken: string | null
): Promise<TieredFallbackResult> {
  const minResults = Math.ceil(limit / 2);

  // Tier 1: Exact match - use shapes for strict filtering
  if (shapes && shapes.length > 0) {
    logger.debug('[tiered-fallback] Trying Tier 1: exact shape match', {
      shapes,
      category,
      executionType,
      limit,
      minResults,
    });

    const tier1Result = await queryActivitiesByShapes(
      shapes,
      orgId,
      category,
      executionType,
      limit * 3, // Fetch more to allow for filtering
      jwtToken
    );

    if (tier1Result.data && tier1Result.data.length >= minResults) {
      logger.info('[tiered-fallback] Tier 1 (exact) succeeded', {
        resultCount: tier1Result.data.length,
        path: tier1Result.path,
        latency_ms: tier1Result.latency_ms,
      });

      return {
        activities: tier1Result.data,
        tier: 'exact',
      };
    }

    logger.debug('[tiered-fallback] Tier 1 insufficient results, trying Tier 2', {
      tier1Count: tier1Result.data?.length || 0,
      minResults,
    });
  }

  // Tier 2: Compatible - query without shape filter (relax constraints)
  logger.debug('[tiered-fallback] Trying Tier 2: compatible (no shape filter)', {
    category,
    executionType,
    limit,
    minResults,
  });

  const tier2Result = await queryActivitiesByShapes(
    [], // No shape filter - accept all activities
    orgId,
    category,
    executionType,
    limit * 3,
    jwtToken
  );

  if (tier2Result.data && tier2Result.data.length >= minResults) {
    logger.info('[tiered-fallback] Tier 2 (compatible) succeeded', {
      resultCount: tier2Result.data.length,
      path: tier2Result.path,
      latency_ms: tier2Result.latency_ms,
    });

    return {
      activities: tier2Result.data,
      tier: 'compatible',
    };
  }

  logger.debug('[tiered-fallback] Tier 2 insufficient results, trying Tier 3 FTS', {
    tier2Count: tier2Result.data?.length || 0,
    minResults,
    goalDescription: goalDescription?.substring(0, 50),
  });

  // Tier 3: FTS fallback - search by goal description
  if (goalDescription && goalDescription.trim()) {
    const tier3Result = await queryActivitiesByFTS(
      goalDescription,
      orgId,
      executionType,
      limit * 3,
      jwtToken
    );

    if (tier3Result.data && tier3Result.data.length > 0) {
      logger.info('[tiered-fallback] Tier 3 (FTS) succeeded', {
        resultCount: tier3Result.data.length,
        searchQuery: goalDescription.substring(0, 50),
        topScore: tier3Result.data[0]?.fts_score,
        latency_ms: tier3Result.latency_ms,
      });

      return {
        activities: tier3Result.data,
        tier: 'fts',
      };
    }
  }

  // If FTS returned nothing or no goalDescription, return whatever we got from Tier 2
  // This ensures we always return something if Tier 2 found any results
  if (tier2Result.data && tier2Result.data.length > 0) {
    logger.info('[tiered-fallback] Returning Tier 2 results after FTS miss', {
      resultCount: tier2Result.data.length,
    });

    return {
      activities: tier2Result.data,
      tier: 'compatible',
    };
  }

  // Last resort: return empty array with FTS tier indicator
  logger.warn('[tiered-fallback] All tiers exhausted, returning empty', {
    shapes,
    category,
    goalDescription: goalDescription?.substring(0, 50),
  });

  return {
    activities: [],
    tier: 'fts',
  };
}

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
    const {
      task_description,
      category,
      tags,           // NEW: Filter by exact tags
      tag_prefix,     // NEW: Filter by tag prefix (e.g., "feature" matches "feature.vessel")
      execution_type, // T8: Filter by execution type (template, tool, composition, vessel_function)
      loaded_impulses = [],
      impulse_shapes = [],  // Array of impulse shapes for schema filtering
      limit = 3,
      exclude_activities = []  // T4: Blacklist of activity IDs to exclude
    } = body;

    logger.info('POST /recommend', {
      task_description: task_description?.substring(0, 100),
      category,
      tags,
      tag_prefix,
      execution_type,
      loaded_impulses,
      impulse_shapes,
      limit
    });

    // Validate required fields
    if (!task_description) {
      return c.json({
        error: 'task_description is required',
      }, 400);
    }

    // SEMANTIC ANALYSIS: Extract tag prefixes and implied shapes from task description
    const semantics = analyzeTaskSemantics(task_description);

    // Use extracted tag prefixes if not explicitly provided
    const effectiveTagPrefix = tag_prefix || semantics.tagPrefixes[0] || null;
    const effectiveTags = tags || (semantics.tagPrefixes.length > 0 ? semantics.tagPrefixes.slice(0, 3) : null);

    // Augment impulse_shapes with semantically implied shapes
    const effectiveShapes = [...new Set([...impulse_shapes, ...semantics.impliedShapes])];

    logger.info('Semantic analysis', {
      extractedTags: semantics.tagPrefixes,
      impliedShapes: semantics.impliedShapes,
      primaryIntent: semantics.primaryIntent,
      effectiveTagPrefix,
      effectiveTags,
      effectiveShapes,
    });

    // Get session data for multi-tenant filtering
    const sessionData = (c.get as any)('session') as SessionData | undefined;
    const jwtAuth = getJwtAuthFromContext(c);
    const orgId = jwtAuth?.orgId || sessionData?.org_id || null;
    const projectId = jwtAuth?.projectId || sessionData?.project_id || null;

    // Query activities using tiered fallback strategy
    // Tier 1: Exact shape match, Tier 2: Compatible (no shapes), Tier 3: FTS on goal description
    const fallbackResult = await getActivitiesWithTieredFallback(
      effectiveShapes,
      category || null,
      task_description,
      orgId,
      execution_type || null,
      limit,
      jwtAuth?.jwtToken || null
    );

    let templates: any[] = fallbackResult.activities;
    const fallbackTier = fallbackResult.tier;

    logger.info('Templates fetched for recommendation', {
      count: templates.length,
      fallback_tier: fallbackTier,
    });

    // T4: Filter out excluded activities (within-goal blacklisting)
    if (exclude_activities && exclude_activities.length > 0) {
      const beforeCount = templates.length;
      const excludeSet = new Set(exclude_activities);
      templates = templates.filter((t: any) => !excludeSet.has(t.id));
      logger.info('Blacklist filtering applied', {
        before: beforeCount,
        after: templates.length,
        excluded: exclude_activities
      });
    }

    // Get Thompson Sampling scores
    // Use shape-conditioned scores when impulse_shapes are provided (goal-aware recommendations)
    // This allows learning different success rates for different input contexts
    const activityIds = templates.map((t: any) => t.id || t.variant_id);
    let scoresMap = new Map<string, ActivityScore>();
    let scoreMethod: 'shape_conditioned' | 'global' | 'legacy' = 'legacy';

    if (activityIds.length > 0 && orgId) {
      // Use shape-conditioned scores when shapes are provided (includes semantically implied shapes)
      if (effectiveShapes && effectiveShapes.length > 0) {
        const shapeScoresResult = await getShapeConditionedScores(
          orgId,
          activityIds,
          effectiveShapes,
          jwtAuth?.jwtToken
        );
        for (const score of shapeScoresResult.data) {
          scoresMap.set(score.activity_id, score);
        }
        // Check if we got shape-conditioned data or fell back to global
        const hasShapeData = shapeScoresResult.data.some(
          (s: any) => s.shape_signature && s.shape_signature.length > 0
        );
        scoreMethod = hasShapeData ? 'shape_conditioned' : 'global';
        logger.info('[paradigm] Shape-conditioned scores fetched', {
          count: shapeScoresResult.data.length,
          path: shapeScoresResult.path,
          scoreMethod,
          original_shapes: impulse_shapes,
          effective_shapes: effectiveShapes,
          semantic_additions: semantics.impliedShapes,
        });
      } else {
        // Fall back to global activity scores
        const scoresResult = await getActivityScores(orgId, activityIds, jwtAuth?.jwtToken);
        for (const score of scoresResult.data) {
          scoresMap.set(score.activity_id, score);
        }
        scoreMethod = 'global';
        logger.debug('[paradigm] Activity scores fetched (global)', {
          count: scoresResult.data.length,
          path: scoresResult.path,
        });
      }
    } else {
      // Fallback: Use enrichTemplatesWithMetrics for legacy path
      templates = await enrichTemplatesWithMetrics(templates);
    }

    // Calculate impulse relevancy boosts
    const impulseBoostsMap = await calculateImpulseRelevancyBoosts(activityIds, loaded_impulses);

    // Discover missing impulses that would unlock better activities
    const missingImpulseSuggestions = await discoverMissingImpulses(activityIds, loaded_impulses, 5);

    if (missingImpulseSuggestions.length > 0) {
      logger.info('Missing impulse suggestions', {
        count: missingImpulseSuggestions.length,
        top_suggestion: missingImpulseSuggestions[0]?.impulse_id,
        suggestions: missingImpulseSuggestions.map(s => ({
          impulse: s.impulse_id,
          unlocks: s.unlocks_activities.length,
        })),
      });
    }

    // Filter out templates without a valid ID before processing
    const validTemplates = templates.filter((template: any) => {
      const templateId = template.id || template.variant_id;
      if (!templateId || typeof templateId !== 'string' || templateId.trim() === '') {
        logger.warn('Filtering out template without valid ID', {
          template_name: template.name || template.variant_name,
          template_id: template.id,
          variant_id: template.variant_id,
        });
        return false;
      }
      return true;
    });

    if (validTemplates.length < templates.length) {
      logger.info('Templates filtered for missing IDs', {
        before: templates.length,
        after: validTemplates.length,
        filtered: templates.length - validTemplates.length,
      });
    }

    // Apply Thompson Sampling with heuristic prior boosting
    const recommendations = validTemplates
      .map((template: any) => {
        // Try to get alpha/beta from v_activity_score first
        const activityId = template.id || template.variant_id;
        const scores = scoresMap.get(activityId);
        let alpha = scores?.alpha || template.metrics?.thompson_alpha || 1.0;
        const betaVal = scores?.beta || template.metrics?.thompson_beta || 1.0;

        // HEURISTIC BOOSTS: Encode domain knowledge as informative priors
        const templateTags = template.tags || [];
        const templateShapes = template.input_shapes || [];
        let totalBoost = 0;

        // 1. Tag match quality boost (+0 to +6 based on match quality)
        const tagMatchQuality = semantics.getMatchQuality(templateTags);
        const tagBoost = Math.floor(tagMatchQuality * 6);
        totalBoost += tagBoost;

        // 2. Shape compatibility boost (+3 if input_shapes ⊆ available shapes)
        const shapeCompatible = templateShapes.length === 0 ||
          templateShapes.every((shape: string) => effectiveShapes.includes(shape));
        const shapeBoost = shapeCompatible ? 3 : 0;
        totalBoost += shapeBoost;

        // 3. Recency boost (+1 for templates created in last 30 days)
        const createdAt = template.created_at ? new Date(template.created_at) : null;
        const daysSinceCreation = createdAt ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24) : Infinity;
        const recencyBoost = daysSinceCreation < 30 ? 1 : 0;
        totalBoost += recencyBoost;

        // 4. Execution history boost (proven templates get +1 to +5)
        const executionCount = (scores?.successes || 0) + (scores?.failures || 0);
        const historyBoost = Math.min(5, Math.floor(executionCount / 10));
        totalBoost += historyBoost;

        // 5. Scope preference boost (+1 for org-specific templates)
        const scopeBoost = template.scope === 'org' || template.scope === 'project' ? 1 : 0;
        totalBoost += scopeBoost;

        // 6. Impulse relevancy boost (based on loaded impulses)
        const impulseBoost = impulseBoostsMap.get(activityId);
        const impulseAlphaBoost = impulseBoost?.alphaBoost || 0;
        const impulseBetaPenalty = impulseBoost?.betaPenalty || 0;
        totalBoost += impulseAlphaBoost;

        // 7. Category preference boost (soft, not hard filter)
        const templateCategory = template.category;
        let categoryBoost = 0;
        if (category && templateCategory === category) {
          categoryBoost = 3;  // Exact category match
        }
        totalBoost += categoryBoost;

        // Apply boosts and penalties
        alpha += totalBoost;
        const adjustedBeta = betaVal + impulseBetaPenalty;

        // Sample from Beta(alpha, beta) distribution for Thompson Sampling
        // This enables exploration (high variance for uncertain templates) and
        // exploitation (high mean for proven templates) tradeoff
        const sample = betaSample(alpha, adjustedBeta);

        return {
          template_id: activityId,
          template_name: template.name || template.variant_name,
          category: template.category,
          tags: template.tags || [],
          tag_prefixes: template.tag_prefixes || [],
          input_shapes: template.input_shapes || [],
          output_shapes: template.output_shapes || [],
          input_schema: template.input_schema || null,
          output_schema: template.output_schema || null,
          selection_metadata: {
            method: 'thompson_sampling',
            score_source: scoreMethod, // shape_conditioned | global | legacy
            alpha,
            beta: adjustedBeta,
            original_beta: betaVal,
            sample,
            score: sample, // Use sample as score for ranking
            // Semantic matching quality
            tag_match_quality: tagMatchQuality,
            heuristic_boost: totalBoost,
            boost_breakdown: {
              tag_match: tagBoost,
              shape_compatible: shapeBoost,
              recency: recencyBoost,
              execution_history: historyBoost,
              scope_preference: scopeBoost,
              impulse_relevancy: impulseAlphaBoost,
              category_match: categoryBoost,
            },
            // Impulse relevancy details
            impulse_analysis: impulseBoost ? {
              alpha_boost: impulseBoost.alphaBoost,
              beta_penalty: impulseBoost.betaPenalty,
              relevant_impulses: impulseBoost.relevantImpulses,
              missing_critical_impulses: impulseBoost.missingCriticalImpulses,
              details: impulseBoost.details,
            } : null,
            // Include shape signature if shape-conditioned
            ...(scoreMethod === 'shape_conditioned' && scores && 'shape_signature' in scores
              ? { shape_signature: (scores as any).shape_signature }
              : {}),
          },
        };
      })
      // Sort by Thompson sample (highest first)
      .sort((a: any, b: any) => b.selection_metadata.sample - a.selection_metadata.sample)
      // Take top N
      .slice(0, limit)
      // Final defensive filter: ensure all recommendations have valid template_id
      .filter((rec: any) => {
        if (!rec.template_id || typeof rec.template_id !== 'string' || rec.template_id.trim() === '') {
          logger.error('Filtering out recommendation with invalid template_id (should not happen)', {
            template_name: rec.template_name,
            template_id: rec.template_id,
          });
          return false;
        }
        return true;
      });

    // Generate correlation IDs for selection-to-execution linkage
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    recommendations.forEach((rec: any, index: number) => {
      rec.correlation_id = `sel_${timestamp}_${randomSuffix}_${index}`;
    });

    logger.info('Recommendations generated', {
      count: recommendations.length,
      top: recommendations[0]?.template_id,
      correlationIds: recommendations.map((r: any) => r.correlation_id),
    });

    // Log Thompson Sampling selections for explainability (non-blocking)
    // Only log if we have an org context and recommendations
    if (orgId && recommendations.length > 0) {
      // Log each selection to thompson_selection_log for explainability
      const selectionLogs = recommendations.map((rec: any, index: number) => ({
        correlation_id: rec.correlation_id, // Link to execution via correlation_id
        execution_id: `recommend-${timestamp}-${index}`, // Placeholder until actual execution
        activity_id: rec.template_id,
        thompson_sample: rec.selection_metadata.sample,
        alpha: rec.selection_metadata.alpha,
        beta: rec.selection_metadata.beta,
        selection_method: 'thompson_sampling',
        candidates_count: templates.length,
      }));

      // Insert selection logs (fire-and-forget for performance)
      // Use FOR loop to handle array inserts properly
      // NOTE: org_id is STRING type in schema, not a record
      surrealDB.query(`
        FOR $log IN $logs {
          CREATE thompson_selection_log CONTENT {
            correlation_id: $log.correlation_id,
            execution_id: $log.execution_id,
            activity_id: $log.activity_id,
            thompson_sample: $log.thompson_sample,
            alpha: $log.alpha,
            beta: $log.beta,
            selection_method: $log.selection_method,
            candidates_count: $log.candidates_count,
            org_id: $org_name,
            project_id: IF $project_name IS NOT NONE AND $project_name IS NOT NULL THEN type::record('projects', $project_name) ELSE NONE END
          }
        }
      `, {
        logs: selectionLogs,
        org_name: orgId, // Plain string org_id
        project_name: projectId, // project_id can be record or string
      }).catch((err: any) => {
        logger.warn('Failed to log Thompson selections', { error: err.message });
      });

      // Increment total_selections for recommended activities
      const activityIds = recommendations.map((r: any) => r.template_id);
      surrealDB.query(`
        UPDATE variant_performance_metrics
        SET total_selections = total_selections + 1,
            updated_at = time::now()
        WHERE variant_id IN $activity_ids
          AND org_id = $org_id
      `, { activity_ids: activityIds, org_id: orgId }).catch((err: any) => {
        logger.warn('Failed to update total_selections', { error: err.message });
      });

      logger.debug('Selection metrics queued for persistence', {
        selectionCount: selectionLogs.length,
        activityIds,
      });
    }

    return c.json({
      recommendations,
      // Include fallback tier to indicate which matching strategy was used
      fallback_tier: fallbackTier,
      // Include missing impulse suggestions if any were found
      ...(missingImpulseSuggestions.length > 0 ? {
        missing_impulses: missingImpulseSuggestions.map(s => ({
          impulse_id: s.impulse_id,
          reason: s.reason,
          unlocks_activities: s.unlocks_activities.length,
          avg_relevance_boost: s.avg_relevance_boost,
        })),
      } : {}),
    });
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

    // Insert template into database (activity is the canonical table)
    // Use canonical field names from GeneratedActivity interface
    const templateRecord: Record<string, any> = {
      id: generated.id,
      name: generated.name,
      description: generated.description,
      execution_type: generated.execution_type,
      category: generated.category,
      tasks: generated.tasks,
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
      INSERT INTO activity {
        ${fields},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    try {
      await surrealDB.query(insertTemplateQuery, templateRecord);
      logger.debug('Generated template inserted into activity table', {
        id: generated.id,
      });
    } catch (insertError: any) {
      // Check if this is a duplicate key error
      if (insertError?.message?.includes('already contains') ||
          insertError?.message?.includes('idx_activity_id')) {
        logger.info('Template already exists, returning existing template', {
          id: generated.id,
        });
        // Return success with existing template ID
        return c.json({
          status: 'success',
          template_id: generated.id,
          existing: true,
        });
      }
      // Re-throw other errors
      throw insertError;
    }

    // Initialize Thompson Sampling metrics
    const insertMetricsQuery = `
      INSERT INTO variant_performance_metrics {
        variant_id: $activity_id,
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
      activity_id: generated.id,
    });

    logger.info('Created improvised activity template', {
      id: generated.id,
      category: generated.category,
    });

    // Invalidate cache
    const redis = RedisClient.getInstance();
    await redis.del(CACHE_LIST_KEY);

    return c.json({
      status: 'success',
      template_id: generated.id,
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

// =============================================================================
// Tag Endpoints
// =============================================================================

/**
 * GET /tags/suggest
 *
 * Get tag suggestions based on a prefix
 *
 * Query params:
 *   prefix?: string - The prefix to match (e.g., "feat" matches "feature", "feature.vessel")
 *   limit?: number - Maximum suggestions to return (default: 20)
 *
 * Returns:
 * {
 *   suggestions: string[],
 *   total: number
 * }
 */
app.get('/tags/suggest', async (c) => {
  try {
    const prefix = c.req.query('prefix') || '';
    const limit = parseInt(c.req.query('limit') || '20', 10);

    logger.info('GET /tags/suggest', { prefix, limit });

    // Query tag prefixes (deduplication happens in code)
    const query = `
      SELECT tag_prefixes FROM activity
      WHERE array::len(tag_prefixes) > 0
      LIMIT 1000
    `;

    const result = await surrealDB.query(query);

    // Flatten and dedupe all tag_prefixes, filtering by prefix
    const allPrefixes = new Set<string>();
    for (const row of (result || [])) {
      if (row.tag_prefixes && Array.isArray(row.tag_prefixes)) {
        for (const p of row.tag_prefixes) {
          if (!prefix || p.startsWith(prefix)) {
            allPrefixes.add(p);
          }
        }
      }
    }

    // Sort and limit
    const suggestions = Array.from(allPrefixes)
      .sort()
      .slice(0, limit);

    return c.json({
      suggestions,
      total: allPrefixes.size,
      prefix: prefix || null,
    });

  } catch (error: any) {
    logger.error('Failed to get tag suggestions', { error: error.message });
    return c.json({
      error: 'Failed to get tag suggestions',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /tags/stats
 *
 * Get tag usage statistics
 *
 * Query params:
 *   prefix?: string - Filter to tags with this prefix
 *
 * Returns:
 * {
 *   stats: { tag: string, count: number }[],
 *   total_templates: number
 * }
 */
app.get('/tags/stats', async (c) => {
  try {
    const prefix = c.req.query('prefix') || '';

    logger.info('GET /tags/stats', { prefix });

    // Query templates and count tag occurrences
    const query = `
      SELECT tags FROM activity
      WHERE array::len(tags) > 0
    `;

    const result = await surrealDB.query(query);

    // Count tag occurrences
    const tagCounts = new Map<string, number>();
    let totalTemplates = 0;

    for (const row of (result || [])) {
      if (row.tags && Array.isArray(row.tags)) {
        totalTemplates++;
        for (const tag of row.tags) {
          if (!prefix || tag.startsWith(prefix)) {
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          }
        }
      }
    }

    // Convert to sorted array
    const stats = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    return c.json({
      stats,
      total_templates: totalTemplates,
      prefix: prefix || null,
    });

  } catch (error: any) {
    logger.error('Failed to get tag stats', { error: error.message });
    return c.json({
      error: 'Failed to get tag stats',
      message: error.message,
    }, 500);
  }
});
