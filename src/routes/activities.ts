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
import {
  extractContextTokensWithDecay,
  computeContextBucket,
  decayWeight,
  type SessionContext,
} from '../utils/session-context';
import { calculateImpulseRelevancyBoosts, discoverMissingImpulses } from '../utils/impulse-relevancy';
import { inferShapesFromTemplate, mergeShapes } from '../utils/shape-inference';
import { calculateOutputShapeCoverage } from '../utils/outcome-to-shape';
import { captureValidationTrace } from '../utils/validation-traces';
import { normalizeRecordId } from '../utils/surrealdb-types';
import { localEmbeddingService } from '../services/embedding-service';
import {
  insertActivity,
  insertExecution,
  getActivityScores,
  getShapeConditionedScores,
  queryActivitiesByShapes,
  queryActivitiesByFTS,
  queryActivitiesByDense,
  transformToLegacyTemplate,
  isDualWriteEnabled,
  getVariantFamily,
  getVariantScores,
  buildVariantTree,
  normalizeActivityId,
  type ParadigmActivity,
  type ParadigmExecution,
  type ActivityScore,
  type VariantInfo,
  type VariantScore,
  type VariantTreeNode,
} from '../db/paradigm';
import { mergeByRRF } from '../utils/rrf';
import {
  runDiscoverByShapes,
  validateDiscoverByShapesInput,
} from '../services/discover-by-shapes';

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
  ToolArgumentPatternRecordRequestSchema,
  ToolArgumentRecommendationsQuerySchema,
  ShapeScoreUpdateRequestSchema,
  ActivityFeedbackRequestSchema,
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
  type ToolArgumentPattern,
  type ToolArgumentRecommendationsResponse,
  type ShapeScoreUpdateResponse,
  type ActivityFeedbackRequest,
  type ActivityFeedbackResponse,
  type ImpulseShapeActivityScore,
} from '../models/schemas';
import { broadcaster } from '../websocket/broadcaster';
import { autoCreateVariantIfNeeded, checkAndRetireTemplate } from '../services/variant-creator';

const app = new Hono();

// Cache configuration
const TEMPLATE_CACHE_TTL = 3600; // 1 hour in seconds
const CACHE_KEY_PREFIX = 'activity:template:';
const CACHE_LIST_KEY = 'activity:templates:list';

// =============================================================================
// Phase B1: account_id dual-write helpers
// =============================================================================
// See OpenSpec change activity-api-account-id-migration-2026-04-28.
//
// Reads: prefer account_id when caller carries one; fall back to org_id for
// legacy rows (account_id IS NONE). Bind both as separate params.
//
// Writes: set account_id alongside org_id (null when caller has no accountId,
// schema is option<string>). Bump account_id_version = 1 to mark this row as
// Phase B dual-written. Phase D will flip the flag and treat <1 as legacy.
// =============================================================================

/**
 * Dual-tenant WHERE clause factory for the account_id migration.
 *
 * Returns a SurrealQL fragment that matches rows on `account_id` first and
 * falls back to `org_id` when the row predates Phase B (account_id IS NONE).
 *
 * Caller MUST bind both `$account_id` and `$org_id` as params; pass
 * `accountId ?? null` so option<string> stays satisfied when the JWT has no
 * `account_id` claim.
 *
 * Example:
 *   const where = accountIdScopedWhere();
 *   // -> "(account_id = $account_id OR (account_id IS NONE AND org_id = $org_id))"
 *   await surrealDB.query(`SELECT * FROM activity WHERE ${where}`, {
 *     account_id: jwtAuth?.accountId ?? null,
 *     org_id: jwtAuth?.orgId,
 *   });
 */
export function accountIdScopedWhere(): string {
  return '(account_id = $account_id OR (account_id IS NONE AND org_id = $org_id))';
}

/**
 * Account_id record-id form, matching the org_id record-ref convention used
 * elsewhere in this file (`organizations:${orgId}`). Returns null when
 * accountId is undefined so callers can pass it straight into
 * `option<string>` schema fields.
 */
export function accountIdRecordRef(accountId: string | undefined | null): string | null {
  if (!accountId) return null;
  return accountId.startsWith('accounts:') ? accountId : `accounts:${accountId}`;
}

/**
 * Phase E: deterministic record-id slug for variant_performance_metrics.
 *
 * Returns `<variant-slug>` when account_id is null (preserves the legacy
 * single-row-per-variant key from before Phase E), and `<variant-slug>__<acct-slug>`
 * when account_id is present so different accounts in the same org keep
 * separate α/β posteriors. The double-underscore separator avoids collisions
 * with conventional slug characters.
 *
 * Pre-Phase-E rows continue to live at the legacy key — they have account_id
 * IS NONE in the schema, and reads via accountIdScopedWhere() still match them
 * via the org_id branch when the caller has no accountId.
 *
 * Behavior change: the first execution from an account-bearing JWT against
 * a variant that previously had only legacy rows will create a NEW
 * `<variant>__<acct>` row rather than incrementing the legacy `<variant>`
 * row. Posteriors fork from that point forward; legacy rows are preserved.
 */
export function variantMetricsRecordId(
  variantId: string,
  accountId: string | undefined | null
): string {
  const variantSlug = variantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!accountId) return variantSlug;
  const acctSlug = accountId.replace(/^accounts:/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${variantSlug}__${acctSlug}`;
}

/**
 * Parse the `offset` query param for paginated template listing.
 * - Non-numeric, negative, or NaN values clamp to 0.
 * - Floats truncate to int.
 * - Positive integers pass through.
 *
 * Exported for unit tests in `routes/templates-pagination.test.ts`.
 */
export function parsePaginationOffset(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

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
 * Ensure output_shapes is populated for backward compatibility with existing templates.
 * For templates without output_shapes, infers them from template content/category.
 *
 * This function should be called when reading templates from the database to ensure
 * all templates have the required output_shapes field.
 */
function ensureOutputShapes(templates: ActivityTemplate[]): ActivityTemplate[] {
  return templates.map(template => {
    // If output_shapes already exists and has at least one element, no change needed
    if (template.output_shapes && template.output_shapes.length > 0) {
      return template;
    }

    // Need to infer output_shapes for this template
    // Try to infer from template content first
    try {
      const inferredShapes = inferShapesFromTemplate({
        tasks: template.tasks,
        description: template.description,
        category: template.category,
      });

      if (inferredShapes.output_shapes.length > 0) {
        logger.debug('Output shapes inferred on read for backward compatibility', {
          activityId: template.id,
          outputShapes: inferredShapes.output_shapes,
        });
        return {
          ...template,
          output_shapes: inferredShapes.output_shapes,
        };
      }
    } catch (e) {
      // Inference failed, use category-based fallback
    }

    // Fallback: derive from category
    const categoryLower = template.category?.toLowerCase() || '';
    let fallbackShape = 'unknown_output';
    switch (categoryLower) {
      case 'bugfix':
        fallbackShape = 'patch';
        break;
      case 'feature':
        fallbackShape = 'source_code';
        break;
      case 'refactor':
        fallbackShape = 'source_code';
        break;
      case 'test':
        fallbackShape = 'test_result';
        break;
      case 'tool':
        fallbackShape = 'tool_output';
        break;
      case 'infrastructure':
        fallbackShape = 'config_file';
        break;
      case 'meta':
        fallbackShape = 'activity_template';
        break;
      case 'docs':
        fallbackShape = 'documentation';
        break;
    }

    logger.debug('Output shapes set to category fallback on read', {
      activityId: template.id,
      category: template.category,
      outputShapes: [fallbackShape],
    });

    return {
      ...template,
      output_shapes: [fallbackShape],
    };
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
      sampleIds: activityIds.slice(0, 3),
      fullIds: activityIds
    });

    // Query metrics for all activities in one go
    // Use v_activity_score view (paradigm-aligned)
    // Fallback to legacy variant_performance_metrics if view doesn't exist
    let metricsResult: any[] = [];

    // Normalize activity IDs for v_activity_score view which stores plain IDs
    // Example: "activity:⟨fix.bug.thorough⟩" -> "fix.bug.thorough"
    // Note: IDs may be SurrealDB RecordId objects, so convert to string first
    const normalizedIds = activityIds.map(id => {
      const idStr = typeof id === 'string' ? id : String(id);
      return idStr.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');
    });

    // Also keep original string IDs for matching (covers both ID formats)
    const originalIds = activityIds.map(id => {
      const idStr = typeof id === 'string' ? id : String(id);
      return idStr;
    });

    // Combine both normalized and original IDs to cover all matching cases
    const allMatchIds = [...new Set([...normalizedIds, ...originalIds])];

    try {
      const metricsQuery = `
        SELECT * FROM v_activity_score
        WHERE activity_id IN $activity_ids
      `;
      metricsResult = await surrealDB.query<any>(metricsQuery, {
        activity_ids: allMatchIds
      });
    } catch (error: any) {
      // Fallback to variant_performance_metrics if view doesn't exist or fails
      logger.warn('Failed to query v_activity_score, falling back to variant_performance_metrics', {
        error: error.message
      });
      const fallbackQuery = `
        SELECT activity_id, variant_id,
               total_executions, successful_executions, failed_executions,
               thompson_alpha, thompson_beta, success_rate,
               avg_duration_ms, avg_cost_usd, total_selections
        FROM variant_performance_metrics
        WHERE activity_id IN $activity_ids
      `;
      metricsResult = await surrealDB.query<any>(fallbackQuery, {
        activity_ids: allMatchIds  // Use combined IDs to match all formats
      });
    }

    // For templates not found in v_activity_score (no executions yet),
    // try to get initial metrics from variant_performance_metrics
    if (metricsResult.length < allMatchIds.length) {
      const foundIds = new Set(metricsResult.map((m: any) => m.activity_id || m.variant_id));
      // Use combined IDs for comparison to match all formats
      const missingIds = allMatchIds.filter(id => !foundIds.has(id));

      if (missingIds.length > 0) {
        logger.debug('Fetching initial metrics for templates without executions', {
          missingCount: missingIds.length,
          sampleMissing: missingIds.slice(0, 3)
        });

        try {
          const initialMetricsQuery = `
            SELECT activity_id, variant_id,
                   total_executions, successful_executions, failed_executions,
                   thompson_alpha, thompson_beta, success_rate,
                   avg_duration_ms, avg_cost_usd, total_selections
            FROM variant_performance_metrics
            WHERE activity_id IN $missing_ids
          `;
          const initialMetrics = await surrealDB.query<any>(initialMetricsQuery, {
            missing_ids: missingIds
          });

          if (initialMetrics.length > 0) {
            logger.info('Found initial metrics for new templates', {
              count: initialMetrics.length
            });
            metricsResult = [...metricsResult, ...initialMetrics];
          }
        } catch (initialError: any) {
          logger.debug('Failed to fetch initial metrics from variant_performance_metrics', {
            error: initialError.message
          });
        }
      }
    }

    logger.info('Metrics query result', {
      metricsFound: metricsResult?.length || 0,
      sampleMetrics: metricsResult?.slice(0, 2).map((m: any) => ({
        id: m.activity_id || m.variant_id,
        alpha: m.thompson_alpha || m.alpha,
        beta: m.thompson_beta || m.beta,
        executions: m.total_executions
      })),
      allMetricIds: metricsResult?.map((m: any) => m.activity_id || m.variant_id)
    });

    // Helper function to normalize IDs for consistent comparison
    // Strips "activity:" prefix and angle brackets to create canonical lookup keys
    const normalizeIdForLookup = (id: string | unknown): string => {
      const idStr = typeof id === 'string' ? id : String(id);
      return idStr.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');
    };

    // Create a map of activity_id -> metrics (handle both canonical and legacy field names)
    const metricsMap = new Map();
    for (const metric of metricsResult) {
      const id = metric.activity_id || metric.variant_id;
      // Normalize the ID for consistent lookup (strip prefix and brackets)
      const normalizedKey = normalizeIdForLookup(id);
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
      metricsMap.set(normalizedKey, normalizedMetric);
    }

    // Attach metrics to each template using canonical 'id' field
    // Normalize template ID to match metricsMap keys (plain IDs)
    // Note: IDs may be SurrealDB RecordId objects, so convert to string first
    const enriched = templates.map(template => {
      const normalizedId = normalizeIdForLookup(template.id);
      const metrics = metricsMap.get(normalizedId);

      logger.debug('Template metrics lookup', {
        templateId: template.id,
        normalizedId,
        found: !!metrics,
        executions: metrics?.total_executions || 0
      });

      return {
        ...template,
        metrics: metrics || undefined
      };
    });

    // Ensure output_shapes is populated for backward compatibility
    return ensureOutputShapes(enriched);

  } catch (error) {
    logger.error('Failed to enrich templates with metrics', {
      error: error instanceof Error ? error.message : String(error)
    });
    // Return templates without metrics, but still ensure output_shapes
    return ensureOutputShapes(templates);
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
  executionType?: string | null, // Allow filtering by execution_type
  offset: number = 0, // Pagination offset (operator audit / shadow-template enumeration)
  accountId?: string | null // Prefer account_id, fall back to org_id
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
    params = { limit, offset, execution_type: effectiveExecutionType };

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
      AND (retired = false OR retired IS NONE)
      ${whereClause ? 'AND ' + whereClause.replace('WHERE ', '') : ''}
      ORDER BY created_at DESC
      LIMIT $limit START $offset
    `;

    logger.debug('Fetching activities with JWT auth (RBAC enforced)', { limit, offset, scopeFilter, executionType: effectiveExecutionType });
    const result = await queryWithAuth<ActivityTemplate>(jwtToken, query, params);

    logger.info('SurrealDB templates fetched (RBAC)', {
      count: result.length,
      authMethod: 'jwt',
      scopeFilter,
      offset,
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
    // Phase B1: scope by account_id when available; legacy rows (account_id IS NONE)
    // still match via org_id. Both bind params are always passed.
    const orgScope = `(scope = 'org' AND ${accountIdScopedWhere()})`;
    if (projectId) {
      // User has both org_id and project_id: return global + org + project activities
      query = `
        SELECT * FROM activity
        WHERE execution_type = $execution_type
        AND (retired = false OR retired IS NONE)
        AND (
          (scope = 'global' AND public = true)
          OR ${orgScope}
          OR (scope = 'project' AND project_id = $project_id)
        ) ${scopeClause}
        ORDER BY created_at DESC
        LIMIT $limit START $offset
      `;
      params = { limit, offset, org_id: orgId, account_id: accountId ?? null, project_id: projectId, execution_type: effectiveExecutionType };
    } else {
      // User has org_id but no project_id: return global + org activities
      query = `
        SELECT * FROM activity
        WHERE execution_type = $execution_type
        AND (retired = false OR retired IS NONE)
        AND (
          scope IS NULL
          OR scope = 'global'
          OR ${orgScope}
        ) ${scopeClause}
        ORDER BY created_at DESC
        LIMIT $limit START $offset
      `;
      params = { limit, offset, org_id: orgId, account_id: accountId ?? null, execution_type: effectiveExecutionType };
    }
  } else {
    // No org_id: return only global activities
    query = `
      SELECT * FROM activity
      WHERE execution_type = $execution_type
      AND (retired = false OR retired IS NONE)
      AND (
        scope IS NULL
        OR scope = 'global'
      ) ${scopeClause}
      ORDER BY created_at DESC
      LIMIT $limit START $offset
    `;
    params = { limit, offset, execution_type: effectiveExecutionType };
  }

  logger.debug('Fetching templates from SurrealDB', { query, params });
  const result = await surrealDB.query<ActivityTemplate>(query, params);

  logger.info('SurrealDB templates fetched', {
    count: result.length,
    orgId,
    projectId,
    offset,
  });

  // Enrich templates with metrics before returning
  const enrichedTemplates = await enrichTemplatesWithMetrics(result);
  logger.info('Templates enriched with metrics', { enrichedCount: enrichedTemplates.length });
  return enrichedTemplates;
}

/**
 * Count templates visible to caller, respecting the same RBAC + scope/exec-type
 * filter as listAllTemplatesFromDB. Used by GET /v2/activities/templates to return
 * a `total` field so paginating callers (operator audit) know when they've walked
 * the full set.
 *
 * Mirrors listAllTemplatesFromDB's RBAC branching:
 * - jwtToken provided → SurrealDB PERMISSIONS enforce $auth.org_id automatically
 * - no jwtToken → application-level WHERE org_id = $org_id (legacy / API-key path)
 */
async function countAllTemplatesFromDB(
  orgId?: string | null,
  projectId?: string | null,
  jwtToken?: string | null,
  scopeFilter?: string | null,
  executionType?: string | null,
  accountId?: string | null, // Phase B1: prefer account_id, fall back to org_id
): Promise<number> {
  const effectiveExecutionType = executionType || 'template';

  let query: string;
  let params: Record<string, any>;

  if (jwtToken) {
    // RBAC path — SurrealDB filters by $auth.org_id via PERMISSIONS
    let whereClause = '';
    params = { execution_type: effectiveExecutionType };

    if (scopeFilter) {
      if (scopeFilter === 'global') {
        whereClause = 'AND (scope IS NULL OR scope = "global")';
      } else if (scopeFilter === 'org') {
        whereClause = 'AND scope = "org"';
      } else if (scopeFilter === 'project') {
        whereClause = 'AND scope = "project"';
      }
    }

    query = `
      SELECT count() AS total FROM activity
      WHERE execution_type = $execution_type
      AND (retired = false OR retired IS NONE)
      ${whereClause}
      GROUP ALL
    `;

    const result = await queryWithAuth<{ total: number }>(jwtToken, query, params);
    return (result[0] as any)?.total ?? 0;
  }

  // Legacy path — application-level org/project filtering
  let scopeClause = '';
  if (scopeFilter === 'global') {
    scopeClause = 'AND (scope IS NULL OR scope = "global")';
  } else if (scopeFilter === 'org') {
    scopeClause = 'AND scope = "org"';
  } else if (scopeFilter === 'project') {
    scopeClause = 'AND scope = "project"';
  }

  if (orgId) {
    // Phase B1: dual-scope by account_id (preferred) or org_id (legacy fallback).
    const orgScope = `(scope = 'org' AND ${accountIdScopedWhere()})`;
    if (projectId) {
      query = `
        SELECT count() AS total FROM activity
        WHERE execution_type = $execution_type
        AND (retired = false OR retired IS NONE)
        AND (
          (scope = 'global' AND public = true)
          OR ${orgScope}
          OR (scope = 'project' AND project_id = $project_id)
        ) ${scopeClause}
        GROUP ALL
      `;
      params = { org_id: orgId, account_id: accountId ?? null, project_id: projectId, execution_type: effectiveExecutionType };
    } else {
      query = `
        SELECT count() AS total FROM activity
        WHERE execution_type = $execution_type
        AND (retired = false OR retired IS NONE)
        AND (
          scope IS NULL
          OR scope = 'global'
          OR ${orgScope}
        ) ${scopeClause}
        GROUP ALL
      `;
      params = { org_id: orgId, account_id: accountId ?? null, execution_type: effectiveExecutionType };
    }
  } else {
    query = `
      SELECT count() AS total FROM activity
      WHERE execution_type = $execution_type
      AND (retired = false OR retired IS NONE)
      AND (
        scope IS NULL
        OR scope = 'global'
      ) ${scopeClause}
      GROUP ALL
    `;
    params = { execution_type: effectiveExecutionType };
  }

  const result = await surrealDB.query<{ total: number }>(query, params);
  return (result[0] as any)?.total ?? 0;
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
  let accountId: string | null = null; // Phase B1

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
    // Phase B1: account_id only flows from JWT auth context — sessions don't carry one.
    accountId = jwtAuth?.accountId ?? null;

    // Parse and validate request body
    body = await c.req.json();
    const validated = CreateTemplateRequestSchema.parse(body);

    // Normalize to canonical field names (accept both legacy and canonical)
    //
    // Clients sometimes round-trip a previously-fetched
    // template id back into POST /templates without unwrapping the
    // SurrealDB record-id form (e.g. `"activity:hello-world-minimal"` or
    // `"activity:⟨hello-world-minimal⟩"`). The downstream
    // `UPSERT activity:\`${activityId}\`` then creates a *new* record with
    // a doubled prefix (`activity:⟨activity:⟨hello-world-minimal⟩⟩`)
    // instead of overwriting the original. Strip any leading `activity:`
    // and SurrealDB angle-bracket / backtick wrapping so the upsert always
    // targets the canonical bare-name record.
    const rawActivityId = validated.id || validated.variant_id;
    const activityId = typeof rawActivityId === 'string'
      ? rawActivityId.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '').trim()
      : rawActivityId;
    const activityName = validated.name || validated.variant_name;
    const activityTasks = validated.tasks || validated.task_steps;
    const activityVariantOf = validated.variant_of || validated.genealogy;

    // Validate required fields
    if (!activityId) {
      return c.json({ error: 'Missing required field: id or variant_id' }, 400);
    }
    if (!activityName) {
      return c.json({ error: 'Missing required field: name or variant_name' }, 400);
    }

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
      // Public templates are discoverable by all orgs (ribosome-generated templates)
      public: validated.public ?? false,
    };

    // Add org_id only if provided (optional field, let schema handle default)
    if (validated.org_id || orgId) {
      activityRecord.org_id = validated.org_id || orgId;
    }

    // Phase B1: dual-write account_id alongside org_id. Only set when non-null —
    // SurrealDB 3.x `option<string>` rejects JSON `null`; omitting the field
    // lets SurrealDB treat it as NONE (the correct absent-value sentinel).
    // account_id_version=1 marks this as Phase B regardless.
    if (accountId != null) {
      activityRecord.account_id = accountId;
    }
    activityRecord.account_id_version = 1;

    // Add tasks using canonical field name
    if (activityTasks && activityTasks.length > 0) {
      activityRecord.tasks = activityTasks;
    }

    // Add input/output shapes for paradigm alignment
    // Priority: 1. Explicit shapes, 2. Legacy schema conversion, 3. Inference from template
    let inputShapesProvided = false;
    let outputShapesProvided = false;

    if (validated.input_shapes?.length) {
      activityRecord.input_shapes = validated.input_shapes;
      inputShapesProvided = true;
    } else if (validated.input_schema?.required) {
      // Convert legacy input_schema to input_shapes
      activityRecord.input_shapes = validated.input_schema.required
        .map((s: any) => typeof s === 'string' ? s : s.shape)
        .filter(Boolean);
      inputShapesProvided = activityRecord.input_shapes.length > 0;
    }
    if (validated.output_shapes?.length) {
      activityRecord.output_shapes = validated.output_shapes;
      outputShapesProvided = true;
    } else if (validated.output_schema?.produces) {
      // Convert legacy output_schema to output_shapes
      activityRecord.output_shapes = validated.output_schema.produces
        .map((s: any) => typeof s === 'string' ? s : s.shape)
        .filter(Boolean);
      outputShapesProvided = activityRecord.output_shapes.length > 0;
    }

    // Infer shapes from template if not explicitly provided
    if (!inputShapesProvided || !outputShapesProvided) {
      try {
        const inferredShapes = inferShapesFromTemplate({
          tasks: activityTasks,
          task_steps: activityTasks, // backward compat
          description: validated.description,
          category: derivedCategory,
        });

        if (!inputShapesProvided && inferredShapes.input_shapes.length > 0) {
          // Merge with any existing shapes (in case partial shapes were set)
          activityRecord.input_shapes = mergeShapes(
            activityRecord.input_shapes,
            inferredShapes.input_shapes
          );
          logger.info('Input shapes inferred from template', {
            activityId,
            inferredInputShapes: inferredShapes.input_shapes,
            mergedInputShapes: activityRecord.input_shapes,
          });
        }

        if (!outputShapesProvided) {
          // inferShapesFromTemplate always returns at least one output shape
          // (category-based fallback ensures this)
          activityRecord.output_shapes = mergeShapes(
            activityRecord.output_shapes,
            inferredShapes.output_shapes
          );
          logger.info('Output shapes inferred from template', {
            activityId,
            inferredOutputShapes: inferredShapes.output_shapes,
            mergedOutputShapes: activityRecord.output_shapes,
          });
        }
      } catch (inferenceError) {
        // Shape inference failed - but output_shapes is required
        // Use a fallback based on category
        logger.warn('Shape inference failed, using category-based fallback for output_shapes', {
          activityId,
          error: inferenceError instanceof Error ? inferenceError.message : String(inferenceError),
        });

        if (!outputShapesProvided) {
          // Fallback: derive output shape from category
          const categoryLower = derivedCategory?.toLowerCase() || '';
          let fallbackShape = 'unknown_output';
          switch (categoryLower) {
            case 'bugfix':
              fallbackShape = 'patch';
              break;
            case 'feature':
              fallbackShape = 'source_code';
              break;
            case 'refactor':
              fallbackShape = 'source_code';
              break;
            case 'test':
              fallbackShape = 'test_result';
              break;
            case 'tool':
              fallbackShape = 'tool_output';
              break;
            case 'infrastructure':
              fallbackShape = 'config_file';
              break;
            case 'meta':
              fallbackShape = 'activity_template';
              break;
            case 'docs':
              fallbackShape = 'documentation';
              break;
          }
          activityRecord.output_shapes = [fallbackShape];
          logger.info('Output shapes set to category fallback', {
            activityId,
            category: derivedCategory,
            outputShapes: activityRecord.output_shapes,
          });
        }
      }
    }

    // Final validation: ensure output_shapes is populated (required field)
    if (!activityRecord.output_shapes || activityRecord.output_shapes.length === 0) {
      activityRecord.output_shapes = ['unknown_output'];
      logger.warn('output_shapes was empty after all inference attempts, using default fallback', {
        activityId,
      });
    }

    // Add optional fields only if provided
    if (validated.project_id || projectId) {
      activityRecord.project_id = validated.project_id || projectId;
    }
    if (activityVariantOf && Object.keys(activityVariantOf).length > 0) {
      activityRecord.variant_of = activityVariantOf;
    }

    // Store structured schemas if provided (goal-execution-foundation-alignment)
    // These are stored in addition to input_shapes/output_shapes for detailed schema info
    if (validated.input_schema) {
      activityRecord.input_schema = validated.input_schema;
    }
    if (validated.output_schema) {
      activityRecord.output_schema = validated.output_schema;
    }
    if (validated.schema_confidence !== undefined) {
      activityRecord.schema_confidence = validated.schema_confidence;
      // Log warning for low confidence schemas
      if (validated.schema_confidence < 0.5) {
        logger.warn('Low schema confidence template registered', {
          activityId,
          schemaConfidence: validated.schema_confidence,
        });
      }
    }

    // Build dynamic query with only provided fields
    // Use UPSERT to handle orphaned index entries and allow re-registration
    const fields = Object.keys(activityRecord).map(k => `${k}: $${k}`).join(',\n        ');
    const upsertActivityQuery = `
      UPSERT activity:\`${activityId}\` CONTENT {
        ${fields},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    await surrealDB.query(upsertActivityQuery, activityRecord);

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
    // UPSERT metrics to handle re-registration of existing templates
    // Uses deterministic record ID format to ensure idempotent upserts.
    //
    // Phase E: record-id includes the account slug when accountId is present
    // so different accounts in the same org get distinct α/β rows on register.
    // Caller-without-accountId still lands at the legacy `<variant>` key.
    const metricsRecordIdSlug = variantMetricsRecordId(activityId, accountId);
    const insertMetricsQuery = metricsProjectId
      ? `
      UPSERT variant_performance_metrics:\`${metricsRecordIdSlug}\` CONTENT {
        variant_id: $activity_id,
        activity_id: $activity_id,
        org_id: $org_id,
        account_id: $account_id,
        account_id_version: 1,
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
      UPSERT variant_performance_metrics:\`${metricsRecordIdSlug}\` CONTENT {
        variant_id: $activity_id,
        activity_id: $activity_id,
        org_id: $org_id,
        account_id: $account_id,
        account_id_version: 1,
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

    // Phase B1: only bind account_id when non-null — SurrealDB 3.x option<string>
    // rejects JSON null; omitting the param lets the field default to NONE.
    const metricsAccountId = accountIdRecordRef(accountId);
    await surrealDB.query(insertMetricsQuery, {
      activity_id: activityId,
      org_id: metricsOrgId,
      ...(metricsAccountId != null ? { account_id: metricsAccountId } : {}),
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

    // Fire-and-forget: generate dense embeddings for the new activity
    Promise.resolve().then(async () => {
      if (!localEmbeddingService.isReady()) return;
      try {
        const nameVec = await localEmbeddingService.embed(activityName || activityId);
        const nameArr = Array.from(nameVec);
        const updates: Record<string, any> = { name_embedding: nameArr };
        if (validated.description) {
          const descVec = await localEmbeddingService.embed(validated.description);
          updates.description_embedding = Array.from(descVec);
        }
        const setClause = Object.keys(updates).map(k => `${k} = $${k}`).join(', ');
        await surrealDB.query(
          `UPDATE type::record("activity", $id) SET ${setClause}`,
          { id: activityId, ...updates }
        );
        logger.debug('[embedding] Wrote embeddings for new activity', { id: activityId });
      } catch (err) {
        logger.warn('[embedding] Failed to write embeddings for new activity', {
          id: activityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }).catch(() => { /* swallow — never throw into request path */ });

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
          callerId: jwtAuth?.keyId || jwtAuth?.userId,
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

    // Check if it's an index conflict (template/variant already exists with different record ID)
    // This happens when legacy records have random IDs but new UPSERTs use deterministic IDs
    // The unique index on variant_id blocks the duplicate
    if (error.message?.includes('Database index') && error.message?.includes('already contains')) {
      // Extract template ID from error message
      // Error format: "already contains 'template-id', with record..."
      const idMatch = error.message.match(/already contains '([^']+)'/);
      const templateId = idMatch?.[1] || 'unknown';

      logger.info('Template already exists (index conflict)', {
        id: templateId,
        message: error.message,
      });
      return c.json({
        success: true,
        id: templateId,
        variant_id: templateId,
        message: 'Template already exists',
      }, 409);
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

    // API-key-minted JWTs use the `jwt_external` ACCESS method which SurrealDB
    // rejects for `db.authenticate()` ("The access method cannot be used in the
    // requested operation"). Sibling endpoints like `GET /templates/:variantId`
    // and `GET /public` avoid this by querying through the root client and
    // relying on application-level WHERE clauses for multi-tenant filtering.
    // Route API-key auth through that same legacy path here — real Bearer JWTs
    // (dashboard users) and MiniBob tokens keep the RBAC-enforced path below.
    const useRbacJwtQuery = useJwtAuth && jwtAuth?.authType !== 'apikey';

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

    // Pagination offset for operator audit / shadow-template enumeration.
    // Limit is still capped at 100/request — operators iterate via offset.
    const offsetStr = c.req.query('offset') || '0';
    const offset = parsePaginationOffset(offsetStr);
    // When paginating (offset > 0) we bypass Redis cache since the cache
    // holds the top-N list under one shared key; mid-page slices must hit DB.
    const paginating = offset > 0;

    // Natural-language full-text search — bypasses Redis cache and returns
    // BM25-ranked results from the FTS index. Same engine used by the
    // recommendation system (Tier 3 fallback).
    const q = c.req.query('q')?.trim() ?? null;
    if (q && q.length > 0) {
      logger.info('GET /v2/activities/templates — FTS path', { q: q.slice(0, 80), orgId, limit });
      const ftsResult = await queryActivitiesByFTS(
        q,
        orgId,
        executionType as 'template' | 'tool' | 'composition' | 'vessel_function' | null,
        limit,
        useRbacJwtQuery && jwtAuth?.jwtToken ? jwtAuth.jwtToken : null
      );
      const ftsTemplates = (ftsResult.data ?? []) as unknown as ActivityTemplate[];
      return c.json({ templates: ftsTemplates, total: ftsTemplates.length, limit, offset: 0, fts: true });
    }

    logger.info('GET /v2/activities/templates', {
      category,
      scopeFilter,
      executionType,
      limit,
      offset,
      orgId,
      projectId,
      authMethod: useRbacJwtQuery ? 'jwt' : (useJwtAuth ? 'apikey' : 'session'),
    });

    // CACHE-ASIDE PATTERN
    // Step 1: Check Redis cache for template list
    // Paginated requests (offset > 0) bypass the cache because the cache
    // holds only the top window populated on a previous limit*2 prefetch — it
    // can't satisfy mid-page slices and would silently truncate operator audits.
    const redis = RedisClient.getInstance();
    const templateIdsSet = paginating ? [] : await redis.smembers(CACHE_LIST_KEY);

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
          // Load templates from database.
          // Pass JWT token for RBAC enforcement ONLY when we can safely authenticate
          // it against SurrealDB (real Bearer JWTs / MiniBob tokens). API-key-minted
          // JWTs are intentionally NOT passed here — they'd trip the
          // "access method cannot be used" error. Multi-tenant filtering for those
          // callers is enforced application-side via orgId/projectId below.
          // When paginating, request exactly `limit` rows starting at
          // `offset`. For un-paginated requests we keep the existing limit*2
          // prefetch (used by the cache-population path).
          const dbTemplates = await listAllTemplatesFromDB(
            paginating ? limit : limit * 2,
            orgId,
            projectId,
            useRbacJwtQuery ? (jwtAuth?.jwtToken || null) : null,
            scopeFilter,
            executionType, // T8: Pass execution_type filter
            offset,
            jwtAuth?.accountId ?? null // Phase B1: account_id-aware scoping
          );

          // Populate Redis cache only when application-level filtering produced
          // the result set (legacy path) AND we're not paginating (paginated
          // slices are mid-page and would corrupt the cache's top-N invariant).
          // RBAC-filtered results are per-$auth and would leak isolation under
          // the shared list key.
          if (dbTemplates.length > 0 && !useRbacJwtQuery && !paginating) {
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

    // Skip client-side org/project filtering when the DB query ran with RBAC
    // auth (SurrealDB PERMISSIONS clauses already enforced isolation via
    // $auth.org_id). For API-key / session paths, do the filter in-app.
    if (!useRbacJwtQuery) {
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
      rbacEnforced: useRbacJwtQuery,
    });

    // Enrich templates with execution metrics
    templates = await enrichTemplatesWithMetrics(templates);
    logger.debug('Template enrichment point reached', { count: templates.length });
    logger.info('Templates enriched with metrics', { templatesWithMetrics: templates.filter(t => t.metrics).length });

    // Query a real total count (respects same RBAC + scope/exec-type filter
    // as the list query) so paginating callers know when they've walked the full
    // visible set. category is filtered application-side; reflect that in total.
    let total: number;
    try {
      total = await countAllTemplatesFromDB(
        orgId,
        projectId,
        useRbacJwtQuery ? (jwtAuth?.jwtToken || null) : null,
        scopeFilter,
        executionType,
        jwtAuth?.accountId ?? null, // Phase B1
      );
    } catch (countErr: any) {
      // Defensive: total is informational; never fail the list response on count failure.
      logger.warn('Template count query failed; falling back to page-size total', {
        error: countErr?.message,
      });
      total = templates.length + offset;
    }

    return c.json({
      templates,
      total,
      limit,
      offset,
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
      let template = JSON.parse(cachedData) as ActivityTemplate;
      // Ensure output_shapes for backward compatibility (cached templates may not have it)
      if (!template.output_shapes || template.output_shapes.length === 0) {
        const [ensured] = ensureOutputShapes([template]);
        template = ensured;
      }
      return c.json(template);
    }

    // Cache miss - fetch from SurrealDB
    logger.debug('Template cache miss, fetching from SurrealDB', { variantId });

    let result: ActivityTemplate[] = [];

    // Query from activity table (the canonical table for templates)
    // Try multiple ID formats to handle SurrealDB's auto-wrapping of string IDs in angle brackets
    // 1. Simple name (e.g., "report-metrics")
    // 2. Angle-bracket wrapped (e.g., "⟨report-metrics⟩") - SurrealDB auto-format
    // 3. Full record ID (e.g., "activity:report-metrics")
    const normalizedId = variantId.includes('⟨') || variantId.includes('⟩')
      ? variantId
      : `⟨${variantId}⟩`;

    const variantQuery = `
      SELECT * FROM activity
      WHERE (meta::id(id) = $variant_id OR meta::id(id) = $normalized_id)
        AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
      LIMIT 1
    `;
    result = await surrealDB.query<ActivityTemplate>(variantQuery, {
      variant_id: variantId,
      normalized_id: normalizedId,
    });

    // If not found, try treating variant_id as a full record ID (for activity:xyz format)
    if (result.length === 0 && variantId.includes(':')) {
      try {
        const recordQuery = `
          SELECT * FROM activity
          WHERE id = type::record($variant_id)
            AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
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
    // Phase B1: account_id flows from JWT auth only.
    const accountId: string | null = jwtAuth?.accountId ?? null;

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

    // Auto-create missing base template if it doesn't exist (v1.4.5)
    // This handles cases where MiniBob executes embedded templates without registering them first
    if (!templateLookup[0]) {
      logger.info('[template] Auto-creating missing base template from execution', {
        activity_id: activityIdFromRequest,
        org_id: orgId
      });

      try {
        // Create minimal template with auto-created tag
        // Phase B1: dual-write account_id alongside org_id.
        await surrealDB.query(`
          INSERT INTO activity {
            id: $id,
            name: $name,
            description: "Auto-created from execution trace",
            tags: ["infrastructure.auto-created"],
            tag_prefixes: ["infrastructure"],
            execution_type: "template",
            scope: "org",
            org_id: $org_id,
            account_id: $account_id,
            account_id_version: 1,
            created_at: time::now(),
            updated_at: time::now()
          }
        `, {
          id: activityIdFromRequest,
          name: activityIdFromRequest.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''),
          org_id: orgId,
          // Phase B1: omit when null — SurrealDB 3.x option<string> rejects JSON null.
          ...(accountId != null ? { account_id: accountId } : {}),
        });

        logger.info('[template] Successfully auto-created base template', {
          activity_id: activityIdFromRequest
        });
      } catch (templateError) {
        logger.warn('[template] Failed to auto-create template (non-blocking)', {
          activity_id: activityIdFromRequest,
          error: templateError instanceof Error ? templateError.message : String(templateError)
        });
      }
    }

    // Emit execution_started event via WebSocket
    // Phase G1 (2026-04-28): tenancy fields surfaced for downstream filtering.
    const executionStartedData: any = {
      execution_id: executionId,
      activity_id: activityIdFromRequest,
      // Legacy field for backward compatibility
      variant_id: activityIdFromRequest,
      org_id: orgId ?? null,
      account_id: accountId ?? null,
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
    // Phase B1: dual-write account_id (option<string>; null is acceptable).
    executionRecord.account_id = accountId;
    executionRecord.account_id_version = 1;
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
        // Phase B1: dual-write account_id alongside org_id.
        account_id: accountId ?? undefined,
        account_id_version: 1,
        project_id: projectId || undefined,
        // Edge learning fields
        ...(validated.improvisation && { improvisation: validated.improvisation }),
        ...(validated.input_impulse_shapes && { input_impulse_shapes: validated.input_impulse_shapes }),
        ...(validated.output_impulse_shapes && { output_impulse_shapes: validated.output_impulse_shapes }),
        ...(validated.metadata && { metadata: validated.metadata }),
      } as any;

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

    // Step 1b: Update shape-based Thompson Sampling scores
    // If input_impulse_shapes are provided, update impulse_shape_activity_score table
    // This enables shape-conditioned activity selection
    // Phase B-followup: thread accountId so dual-write fires.
    if (validated.input_impulse_shapes && validated.input_impulse_shapes.length > 0 && orgId) {
      // Non-blocking: don't await, just fire and forget
      updateShapeScoresFromExecution(
        activityIdFromRequest,
        validated.input_impulse_shapes,
        validated.success,
        orgId,
        jwtAuth?.jwtToken,
        jwtAuth?.accountId ?? null
      ).catch((error) => {
        logger.warn('Shape score update failed (non-blocking)', {
          activity_id: activityIdFromRequest,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Step 2: Update Thompson Sampling metrics in variant_performance_metrics
    // Thompson Sampling uses Beta distribution: Beta(alpha, beta)
    // - alpha: number of successes + 1
    // - beta: number of failures + 1
    //
    // ATOMIC UPDATE: Uses SurrealDB += operator for race-condition-free concurrent updates
    // Previous implementation had read-modify-write race condition

    const success_delta = validated.success ? 1 : 0;
    const failure_delta = validated.success ? 0 : 1;
    
    // UPSERT PATTERN: Phase E — keyed on (variant_id, account_id) via a
    // deterministic record-id slug (`<variant>__<acct>` when account_id is
    // present; legacy `<variant>` slug when null). This lets two callers in
    // the same org but different accounts maintain separate α/β posteriors.
    //
    // Pre-Phase-E rows live at the legacy `<variant>` key — they remain
    // readable via the org_id branch of `accountIdScopedWhere()`, but new
    // account-bearing executions land in their own row from this point on.
    //
    // Mechanism: INSERT INTO names the record `id` explicitly so the duplicate
    // detection that drives ON DUPLICATE KEY UPDATE happens on the id (which
    // is now account-keyed). The pre-existing UNIQUE(variant_id) index is
    // intentionally not modified in this phase; the legacy `<variant>` slug
    // continues to satisfy it for the no-accountId path, and the new
    // `<variant>__<acct>` slug carries a different variant_id-equal value
    // for the index check (it does not — the variant_id stays as the plain
    // normalized id). The UNIQUE(variant_id) index would, in principle,
    // reject the second account's row; in practice the migration to drop
    // that index is staged for a follow-up phase. For now, on environments
    // where the unique index is enforced the second-account write may still
    // collapse onto the legacy row. This is the documented canary drift.
    //
    // Normalize variant_id to plain form (strip `activity:` prefix and `⟨...⟩`
    // brackets) BEFORE the upsert. Mirrors `resolveTemplateIdsForUpdate` in
    // execution-traces.ts so wrapped/plain forms collapse to the same row.
    const normalizedVariantId = normalizeActivityId(activityIdFromRequest);
    const metricsRecordIdSlug = variantMetricsRecordId(normalizedVariantId, accountId);
    const upsertMetricsQuery = `
      INSERT INTO variant_performance_metrics {
        id: type::thing('variant_performance_metrics', $record_id_slug),
        variant_id: $variant_id,
        activity_id: $variant_id,
        org_id: $org_id,
        account_id: $account_id,
        account_id_version: 1,
        total_executions: 1,
        successful_executions: $success_delta,
        failed_executions: $failure_delta,
        success_rate: $success_delta,
        avg_duration_ms: $duration_ms,
        avg_cost_usd: $cost,
        thompson_alpha: $success_delta + 1,
        thompson_beta: $failure_delta + 1,
        total_selections: 0,
        last_executed_at: time::now(),
        created_at: time::now(),
        updated_at: time::now()
      }
      ON DUPLICATE KEY UPDATE
        total_executions += 1,
        successful_executions += $input.successful_executions,
        failed_executions += $input.failed_executions,
        success_rate = successful_executions / total_executions,
        avg_duration_ms = ((avg_duration_ms * (total_executions - 1)) + $input.avg_duration_ms) / total_executions,
        avg_cost_usd = ((avg_cost_usd * (total_executions - 1)) + $input.avg_cost_usd) / total_executions,
        thompson_alpha = successful_executions + 1,
        thompson_beta = failed_executions + 1,
        last_executed_at = time::now(),
        updated_at = time::now()
      RETURN AFTER;
    `;

    const metricsResult = await surrealDB.query(upsertMetricsQuery, {
      record_id_slug: metricsRecordIdSlug,
      variant_id: normalizedVariantId,
      org_id: orgId,
      account_id: accountIdRecordRef(accountId),
      success_delta,
      failure_delta,
      duration_ms: validated.duration_ms,
      cost: validated.cost,
    });

    if (metricsResult.length === 0) {
      logger.error('Thompson Sampling UPSERT failed - no record returned', {
        activity_id: activityIdFromRequest,
        org_id: orgId,
        variant_id: activityIdFromRequest,
      });
    } else {
      const updatedRecord = metricsResult[0];
      const isNewRecord = updatedRecord.total_executions === 1;
      logger.info('Thompson Sampling metrics upserted', {
        activity_id: activityIdFromRequest,
        operation: isNewRecord ? 'INSERT (new record)' : 'UPDATE (existing record)',
        total_executions: updatedRecord.total_executions,
        thompson_alpha: updatedRecord.thompson_alpha,
        thompson_beta: updatedRecord.thompson_beta,
        thompson_score: updatedRecord.thompson_alpha / (updatedRecord.thompson_alpha + updatedRecord.thompson_beta),
      });
    }

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
    // Phase G1 (2026-04-28): tenancy fields surfaced for downstream filtering.
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
        org_id: orgId ?? null,
        account_id: accountId ?? null,
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
          org_id: orgId ?? null,
          account_id: accountId ?? null,
        },
      });
    }

    // Step 4: Auto-create variant if needed (after consecutive failures)
    // Non-blocking: don't await, fire and forget.
    // Phase B4a: thread accountId through (already in scope at this site).
    if (orgId) {
      autoCreateVariantIfNeeded(activityIdFromRequest, orgId, validated.success, accountId)
        .then((variantResult) => {
          if (variantResult) {
            logger.info('Auto-created variant from consecutive failures', {
              parentTemplateId: activityIdFromRequest,
              variantId: variantResult.variantId,
              variantGeneration: variantResult.variantGeneration,
              modifications: variantResult.modifications.length,
            });

            // Emit variant_created event via WebSocket
            // Phase G1 (2026-04-28): tenancy fields surfaced for filtering.
            broadcaster.emit({
              type: 'variant_created',
              timestamp: new Date().toISOString(),
              data: {
                parent_activity_id: activityIdFromRequest,
                variant_id: variantResult.variantId,
                variant_generation: variantResult.variantGeneration,
                reason: variantResult.reason,
                modifications: variantResult.modifications,
                org_id: orgId ?? null,
                account_id: accountId ?? null,
              },
            });
          }
        })
        .catch((error) => {
          logger.warn('Auto-variant creation failed (non-blocking)', {
            activity_id: activityIdFromRequest,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      // Step 5: Check and retire template if needed (after enough executions)
      // Non-blocking: don't await, fire and forget.
      // Phase B4a: thread accountId for dual-tenant scoping on the read.
      checkAndRetireTemplate(activityIdFromRequest, orgId, accountId)
        .then((wasRetired) => {
          if (wasRetired) {
            logger.info('Template retired due to poor performance', {
              activity_id: activityIdFromRequest,
            });

            // Emit template_retired event via WebSocket
            // Phase G1 (2026-04-28): tenancy fields surfaced for filtering.
            broadcaster.emit({
              type: 'template_retired',
              timestamp: new Date().toISOString(),
              data: {
                activity_id: activityIdFromRequest,
                reason: 'poor_performance',
                org_id: orgId ?? null,
                account_id: accountId ?? null,
              },
            });

            // Invalidate cache for retired template
            redis.del(`${CACHE_KEY_PREFIX}${activityIdFromRequest}`);
            redis.srem(CACHE_LIST_KEY, activityIdFromRequest);
          }
        })
        .catch((error) => {
          logger.warn('Template retirement check failed (non-blocking)', {
            activity_id: activityIdFromRequest,
            error: error instanceof Error ? error.message : String(error),
          });
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
    // Phase B1: account_id from JWT auth context if present.
    const jwtAuth = getJwtAuthFromContext(c);
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;
    const projectId = jwtAuth?.projectId || session?.project_id || null;

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
    // TEMPORARY: Query execution table directly (view not yet applied)
    let query = `
      SELECT
        id AS execution_id,
        activity_id,
        activity_id AS variant_id,
        activity_id AS template_id,
        success,
        IF success = true { 'success' } ELSE { 'failure' } AS status,
        duration_ms,
        cost_usd,
        tokens_in AS tokens_input,
        tokens_out AS tokens_output,
        tokens_in + tokens_out AS tokens_total,
        error.message AS error_message,
        error.type AS error_type,
        error.task_id AS failed_task_id,
        input_impulses AS impulses_used,
        output_impulses AS impulses_created,
        trace AS execution_trace,
        trace.state_transition.after AS component_changes,
        parent_execution_id,
        composition_chain,
        org_id,
        project_id,
        vessel_id,
        executed_at,
        created_at,
        created_at AS stored_at,
        created_at AS updated_at
      FROM execution WHERE 1=1
    `.trim();
    const params: Record<string, any> = {};
    
    // Multi-tenant filtering (same as templates)
    // Phase B1: prefer account_id; legacy rows match via org_id fallback.
    if (orgId) {
      query += ` AND (org_id = NONE OR ${accountIdScopedWhere()})`;
      params.org_id = orgId;
      params.account_id = accountId;
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
 * Architecture (Unified Impulse-Driven):
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
      FROM activity_execution_traces
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
      FROM activity_execution_traces
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
 * GET /v2/activities/metrics
 *
 * Returns detailed metrics for a specific activity.
 * Used by MiniBob's model selector for progressive determinism.
 *
 * Query params:
 * - activity_id: string (required) - Activity template ID to get metrics for
 *
 * Returns:
 * {
 *   activity_id: string,
 *   total_executions: number,
 *   successful_executions: number,
 *   success_rate: number,
 *   avg_duration_ms: number,
 *   avg_cost_usd: number,
 *   model_usage_distribution: Record<string, number>,
 *   deterministic_task_ratio: number,
 * }
 */
app.get('/metrics', async (c) => {
  try {
    const activityId = c.req.query('activity_id');

    if (!activityId) {
      return c.json({ error: 'Missing required parameter: activity_id' }, 400);
    }

    logger.info('GET /v2/activities/metrics', { activity_id: activityId });

    // Query execution metrics for this specific activity
    const metricsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS successful_executions,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
        math::mean(duration_ms) AS avg_duration_ms,
        math::mean(cost_usd) AS avg_cost_usd
      FROM activity_execution_traces
      WHERE activity_id = $activity_id
      GROUP ALL
    `, { activity_id: activityId });

    const stats = (metricsResult[0] as any) || {};

    // Query model usage distribution
    const modelDistResult = await surrealDB.query(`
      SELECT model, count() AS count
      FROM activity_execution_traces
      WHERE activity_id = $activity_id
      GROUP BY model
    `, { activity_id: activityId });

    const modelUsageDistribution: Record<string, number> = {};
    for (const row of (modelDistResult as any[]) || []) {
      if (row.model) {
        modelUsageDistribution[row.model] = row.count || 0;
      }
    }

    // Query deterministic task ratio (tasks that don't require LLM)
    // Note: Deterministic task tracking is not yet implemented
    // Task-level data exists in activity_execution_traces.tasks (flexible array)
    // but separate activity_execution_task_result table does not exist
    const deterministicTaskRatio = 0; // Placeholder until proper task-level metrics implemented

    const metrics = {
      activity_id: activityId,
      total_executions: stats.total_executions || 0,
      successful_executions: stats.successful_executions || 0,
      success_rate: stats.success_rate || 0,
      avg_duration_ms: Math.round(stats.avg_duration_ms || 0),
      avg_cost_usd: stats.avg_cost_usd || 0,
      model_usage_distribution: modelUsageDistribution,
      deterministic_task_ratio: deterministicTaskRatio,
    };

    logger.debug('Activity metrics retrieved', { activity_id: activityId, metrics });

    return c.json(metrics);

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity metrics',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /templates/:templateId/metrics
 *
 * Returns comprehensive metrics for a specific template including Thompson Sampling parameters.
 *
 * Path params:
 * - templateId: string (required) - Activity template ID
 *
 * Returns:
 * {
 *   template_id: string,
 *   total_executions: number,
 *   successful_executions: number,
 *   failed_executions: number,
 *   success_rate: number,
 *   avg_duration_ms: number,
 *   avg_cost_usd: number,
 *   total_cost_usd: number,
 *   thompson_alpha: number,
 *   thompson_beta: number,
 *   thompson_belief: number,
 *   last_executed_at: string | null,
 *   executions_by_day: Array<{date: string, count: number, success_count: number}>
 * }
 */
app.get('/templates/:templateId/metrics', async (c) => {
  try {
    const templateId = c.req.param('templateId');

    if (!templateId) {
      return c.json({ error: 'Missing template ID' }, 400);
    }

    logger.info('GET /v2/activities/templates/:templateId/metrics', { template_id: templateId });

    // Query execution metrics for this specific template
    const metricsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS successful_executions,
        count(IF success = false THEN 1 ELSE NONE END) AS failed_executions,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
        math::mean(duration_ms) AS avg_duration_ms,
        math::mean(cost_usd) AS avg_cost_usd,
        math::sum(cost_usd) AS total_cost_usd,
        time::max(executed_at) AS last_executed_at
      FROM activity_execution_traces
      WHERE activity_id = $template_id
      GROUP ALL
    `, { template_id: templateId });

    const stats = (metricsResult[0] as any) || {};

    const totalExecutions = stats.total_executions || 0;
    const successfulExecutions = stats.successful_executions || 0;
    const failedExecutions = stats.failed_executions || 0;

    // Thompson Sampling parameters
    const thompsonAlpha = successfulExecutions + 1;
    const thompsonBeta = failedExecutions + 1;
    const thompsonBelief = thompsonAlpha / (thompsonAlpha + thompsonBeta);

    // Query executions grouped by day
    const executionsByDayResult = await surrealDB.query(`
      SELECT
        time::format(executed_at, '%Y-%m-%d') AS date,
        count() AS count,
        count(IF success = true THEN 1 ELSE NONE END) AS success_count
      FROM activity_execution_traces
      WHERE activity_id = $template_id
      GROUP BY time::format(executed_at, '%Y-%m-%d')
      ORDER BY date DESC
      LIMIT 30
    `, { template_id: templateId });

    const executionsByDay = (executionsByDayResult as any[]) || [];

    const metrics = {
      template_id: templateId,
      total_executions: totalExecutions,
      successful_executions: successfulExecutions,
      failed_executions: failedExecutions,
      success_rate: stats.success_rate || 0,
      avg_duration_ms: Math.round(stats.avg_duration_ms || 0),
      avg_cost_usd: stats.avg_cost_usd || 0,
      total_cost_usd: stats.total_cost_usd || 0,
      thompson_alpha: thompsonAlpha,
      thompson_beta: thompsonBeta,
      thompson_belief: thompsonBelief,
      last_executed_at: stats.last_executed_at || null,
      executions_by_day: executionsByDay.map((row: any) => ({
        date: row.date,
        count: row.count || 0,
        success_count: row.success_count || 0,
      })),
    };

    logger.debug('Template metrics retrieved', { template_id: templateId, metrics });

    return c.json(metrics);

  } catch (error: any) {
    logger.error('GET /v2/activities/templates/:templateId/metrics failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch template metrics',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /metrics/aggregate
 *
 * Returns system-wide aggregate metrics including top templates.
 *
 * Returns:
 * {
 *   total_templates: number,
 *   templates_executed: number,
 *   templates_never_executed: number,
 *   total_executions: number,
 *   successful_executions: number,
 *   failed_executions: number,
 *   overall_success_rate: number,
 *   total_cost_usd: number,
 *   avg_cost_per_execution: number,
 *   top_templates_by_executions: Array<{template_id, execution_count, success_rate}>,
 *   top_templates_by_success_rate: Array<{template_id, success_rate, execution_count}>
 * }
 */
app.get('/metrics/aggregate', async (c) => {
  try {
    logger.info('GET /v2/activities/metrics/aggregate');

    // Query overall execution statistics
    const overallStatsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS successful_executions,
        count(IF success = false THEN 1 ELSE NONE END) AS failed_executions,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS overall_success_rate,
        math::sum(cost_usd) AS total_cost_usd
      FROM activity_execution_traces
      GROUP ALL
    `);

    const overallStats = (overallStatsResult[0] as any) || {};
    const totalExecutions = overallStats.total_executions || 0;
    const avgCostPerExecution = totalExecutions > 0
      ? (overallStats.total_cost_usd || 0) / totalExecutions
      : 0;

    // Count total templates
    const totalTemplatesResult = await surrealDB.query(`
      SELECT count() AS total
      FROM activity_template
      GROUP ALL
    `);
    const totalTemplates = ((totalTemplatesResult[0] as any)?.total) || 0;

    // Count templates that have been executed
    const executedTemplatesResult = await surrealDB.query(`
      SELECT array::len(array::distinct(activity_id)) AS executed_count
      FROM activity_execution_traces
      GROUP ALL
    `);
    const templatesExecuted = ((executedTemplatesResult[0] as any)?.executed_count) || 0;
    const templatesNeverExecuted = totalTemplates - templatesExecuted;

    // Query top templates by execution count
    const topByExecutionsResult = await surrealDB.query(`
      SELECT
        activity_id AS template_id,
        count() AS execution_count,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate
      FROM activity_execution_traces
      GROUP BY activity_id
      ORDER BY execution_count DESC
      LIMIT 10
    `);

    // Query top templates by success rate (min 3 executions)
    // Note: SurrealDB 2.x does not support HAVING clause, using subquery pattern instead
    const topBySuccessRateResult = await surrealDB.query(`
      SELECT * FROM (
        SELECT
          activity_id AS template_id,
          math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
          count() AS execution_count
        FROM activity_execution_traces
        GROUP BY activity_id
      ) WHERE execution_count >= 3
      ORDER BY success_rate DESC, execution_count DESC
      LIMIT 10
    `);

    const metrics = {
      total_templates: totalTemplates,
      templates_executed: templatesExecuted,
      templates_never_executed: templatesNeverExecuted,
      total_executions: totalExecutions,
      successful_executions: overallStats.successful_executions || 0,
      failed_executions: overallStats.failed_executions || 0,
      overall_success_rate: overallStats.overall_success_rate || 0,
      total_cost_usd: overallStats.total_cost_usd || 0,
      avg_cost_per_execution: avgCostPerExecution,
      top_templates_by_executions: (topByExecutionsResult as any[]).map((row: any) => ({
        template_id: row.template_id,
        execution_count: row.execution_count || 0,
        success_rate: row.success_rate || 0,
      })),
      top_templates_by_success_rate: (topBySuccessRateResult as any[]).map((row: any) => ({
        template_id: row.template_id,
        success_rate: row.success_rate || 0,
        execution_count: row.execution_count || 0,
      })),
    };

    logger.debug('Aggregate metrics retrieved', metrics);

    return c.json(metrics);

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics/aggregate failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch aggregate metrics',
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

    // Use existing getActivityScores function from paradigm.ts.
    // Phase E: pass accountId so posteriors stay separate per account.
    const result = await getActivityScores(orgId, undefined, jwtAuth?.jwtToken, jwtAuth?.accountId ?? null);

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

// =============================================================================
// Variant Resolver Endpoints (variant-resolver-endpoints)
// =============================================================================

/**
 * GET /v2/activities/:id/variants
 * Get all variants of an activity (recursive family tree).
 *
 * Returns all activities where variant_of matches the base ID,
 * including recursive children up to 3 levels deep.
 *
 * Query params:
 * - None
 *
 * Returns: { variants: VariantInfo[], total: number }
 */
app.get('/:id/variants', async (c) => {
  try {
    const activityId = c.req.param('id');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    logger.info('GET /v2/activities/:id/variants', {
      activityId,
      orgId,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    // Phase E: pass accountId so cross-account variants stay isolated.
    const result = await getVariantFamily(activityId, orgId, jwtAuth?.jwtToken, jwtAuth?.accountId ?? null);

    return c.json({
      variants: result.data,
      total: result.data.length,
      path: result.path,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/:id/variants failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity variants',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/:id/variants
 * Manually trigger variant creation for a template.
 *
 * This endpoint allows users to explicitly request variant creation
 * without waiting for automatic creation from consecutive failures.
 *
 * Request body:
 * - reason: Optional reason for creating the variant (default: 'manual_improvement')
 *
 * Returns:
 * - variant_id: ID of the created variant
 * - variant_generation: Generation number
 * - modifications: Array of modifications made
 * - reason: Reason for variant creation
 */
app.post('/:id/variants', async (c) => {
  try {
    const activityId = c.req.param('id');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B4a: account_id only flows from JWT auth context (sessions
    // don't carry one). Null is valid; reads/writes fall back to org_id.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    // Parse optional request body
    let reason = 'manual_improvement';
    try {
      const body = await c.req.json();
      if (body.reason) {
        reason = body.reason;
      }
    } catch {
      // No body or invalid JSON, use default
    }

    logger.info('POST /v2/activities/:id/variants', {
      activityId,
      orgId,
      reason,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    // Import the createVariant function from variant-creator
    const { createVariant, shouldCreateVariant } = await import('../services/variant-creator');

    // Check current failure pattern to provide context
    // Phase B4a: dual-tenant scoping; pass accountId.
    const failurePattern = await shouldCreateVariant(activityId, orgId, accountId);

    // Create variant even if no failure pattern (manual improvement)
    const defaultFailurePattern = failurePattern || {
      templateId: activityId,
      consecutiveFailures: 0,
      totalExecutions: 0,
      successRate: 1.0,
      commonErrors: [],
      failedTasks: [],
    };

    const variantResult = await createVariant(
      activityId,
      defaultFailurePattern,
      orgId,
      reason,
      accountId
    );

    if (!variantResult) {
      return c.json({
        error: 'Failed to create variant',
        message: 'Variant creation returned null. Template may not exist or maximum variants reached.',
      }, 500);
    }

    // Emit variant_created event via WebSocket
    // Phase G1 (2026-04-28): tenancy fields surfaced for filtering.
    broadcaster.emit({
      type: 'variant_created',
      timestamp: new Date().toISOString(),
      data: {
        parent_activity_id: activityId,
        variant_id: variantResult.variantId,
        variant_generation: variantResult.variantGeneration,
        reason: variantResult.reason,
        modifications: variantResult.modifications,
        org_id: orgId ?? null,
        account_id: accountId ?? null,
      },
    });

    return c.json({
      success: true,
      variant_id: variantResult.variantId,
      variant_generation: variantResult.variantGeneration,
      modifications: variantResult.modifications,
      reason: variantResult.reason,
    }, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/:id/variants failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to create variant',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/:id/variant-scores
 * Get per-variant Thompson Sampling scores.
 *
 * First fetches all variants in the family, then retrieves
 * alpha/beta parameters and metrics for each.
 *
 * Query params:
 * - None
 *
 * Returns: { scores: VariantScore[], total: number }
 */
app.get('/:id/variant-scores', async (c) => {
  try {
    const activityId = c.req.param('id');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    logger.info('GET /v2/activities/:id/variant-scores', {
      activityId,
      orgId,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    // First get all variants in the family.
    // Phase E: pass accountId so cross-account variants stay isolated.
    const accountIdForScopes = jwtAuth?.accountId ?? null;
    const familyResult = await getVariantFamily(activityId, orgId, jwtAuth?.jwtToken, accountIdForScopes);
    const variantIds = familyResult.data.map(v => v.id);

    if (variantIds.length === 0) {
      return c.json({
        scores: [],
        total: 0,
        path: 'new',
      });
    }

    // Then get scores for all variants (account-scoped).
    const scoresResult = await getVariantScores(variantIds, orgId, jwtAuth?.jwtToken, accountIdForScopes);

    return c.json({
      scores: scoresResult.data,
      total: scoresResult.data.length,
      path: scoresResult.path,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/:id/variant-scores failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch variant scores',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/family/:baseId
 * Get genealogy tree for an activity family.
 *
 * Returns a tree structure showing parent-child relationships
 * based on the variant_of field.
 *
 * Query params:
 * - max_depth: number (default: 5, max: 10) - Maximum tree depth
 *
 * Returns: { tree: VariantTreeNode | null, total_nodes: number }
 */
app.get('/family/:baseId', async (c) => {
  try {
    const baseId = c.req.param('baseId');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    // Parse max_depth parameter
    const maxDepthStr = c.req.query('max_depth') || '5';
    let maxDepth = parseInt(maxDepthStr, 10);
    if (isNaN(maxDepth) || maxDepth < 1) maxDepth = 5;
    maxDepth = Math.min(maxDepth, 10); // Cap at 10 levels

    logger.info('GET /v2/activities/family/:baseId', {
      baseId,
      orgId,
      maxDepth,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    const tree = await buildVariantTree(baseId, orgId, maxDepth, jwtAuth?.jwtToken);

    // Count total nodes in tree
    function countNodes(node: VariantTreeNode | null): number {
      if (!node) return 0;
      return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
    }

    const totalNodes = countNodes(tree);

    return c.json({
      tree,
      total_nodes: totalNodes,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/family/:baseId failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity family tree',
      message: error.message,
    }, 500);
  }
});

// =============================================================================
// POST /feedback - Manual feedback on activity performance
// =============================================================================
/**
 * Record human feedback on activity performance (/teach and /warn commands)
 *
 * Positive feedback (teach):
 * - Multiplies alpha (success parameter) in Thompson Sampling
 * - Optionally boosts adjacent activities with reduced multiplier
 *
 * Negative feedback (warn):
 * - Multiplies beta (failure parameter) in Thompson Sampling
 * - Does NOT penalize adjacent activities (warnings are specific)
 *
 * Updates impulse_shape_activity_score table for all shapes the activity handles.
 */
app.post('/feedback', async (c) => {
  try {
    // Check for JWT auth
    const jwtAuth = getJwtAuthFromContext(c);

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B-followup: account_id only flows from JWT auth.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing organization context',
      }, 401);
    }

    // Parse and validate request body
    const body = await c.req.json();
    const validated = ActivityFeedbackRequestSchema.parse(body);

    logger.info('POST /v2/activities/feedback', {
      activity_id: validated.activity_id,
      direction: validated.direction,
      intensity: validated.intensity,
      include_adjacent: validated.include_adjacent,
      reason: validated.reason,
      orgId,
      accountId,
    });

    // Map intensity to multiplier (0=1.5x, 1=2x, 2=2.5x, 3=3x)
    const multiplier = 1.5 + (validated.intensity * 0.5);

    // Verify activity exists - normalize ID format
    // SurrealDB uses three ID formats:
    // 1. Simple ID (e.g., "acquire-codebase-context")
    // 2. Angle-bracket wrapped (e.g., "⟨report-metrics⟩")
    // 3. Full record ID (e.g., "activity:report-metrics")
    const normalizedActivityId = validated.activity_id.includes('⟨') || validated.activity_id.includes('⟩')
      ? validated.activity_id
      : `⟨${validated.activity_id}⟩`;

    let activityLookup = await surrealDB.query<{ id: string; input_shapes?: string[] }>(
      `SELECT id, input_shapes FROM activity
       WHERE (meta::id(id) = $activity_id OR meta::id(id) = $normalized_id)
         AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
       LIMIT 1`,
      {
        activity_id: validated.activity_id,
        normalized_id: normalizedActivityId,
      }
    );

    // If not found, try treating activity_id as a full record ID (for activity:xyz format)
    if (activityLookup.length === 0 && validated.activity_id.includes(':')) {
      try {
        activityLookup = await surrealDB.query<{ id: string; input_shapes?: string[] }>(
          `SELECT id, input_shapes FROM activity
           WHERE id = type::record($activity_id)
             AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
           LIMIT 1`,
          { activity_id: validated.activity_id }
        );
      } catch (recordError) {
        logger.debug('Record ID query failed for activity lookup', {
          activity_id: validated.activity_id,
          error: recordError
        });
      }
    }

    if (!activityLookup || activityLookup.length === 0 || !activityLookup[0]) {
      return c.json({
        error: 'Activity not found',
        message: `Activity ${validated.activity_id} does not exist`,
      }, 404);
    }

    const activity = activityLookup[0];
    const inputShapes = activity.input_shapes || [];

    // Find all shape scores for this activity
    // Phase B-followup: dual-tenant scoping; legacy rows match via the
    // org_id branch of accountIdScopedWhere().
    const shapesQuery = await surrealDB.query<ImpulseShapeActivityScore>(
      `SELECT * FROM impulse_shape_activity_score
       WHERE ${accountIdScopedWhere()} AND activity_id = $activity_id`,
      { org_id: orgId, account_id: accountId, activity_id: validated.activity_id }
    );

    const existingScores = shapesQuery || [];

    logger.debug('Found existing shape scores', {
      activity_id: validated.activity_id,
      count: existingScores.length,
      shapes: existingScores.map(s => s.shape),
    });

    // If no scores exist yet, initialize for all input shapes
    if (existingScores.length === 0 && inputShapes.length > 0) {
      logger.info('Initializing shape scores for new activity', {
        activity_id: validated.activity_id,
        shapes: inputShapes,
      });

      for (const shape of inputShapes) {
        // Phase B-followup: dual-write account_id + version on CREATE.
        await surrealDB.query(
          `CREATE impulse_shape_activity_score CONTENT {
            shape: $shape,
            activity_id: $activity_id,
            org_id: $org_id,
            account_id: $account_id,
            account_id_version: $account_id_version,
            success_count: 0,
            failure_count: 0,
            alpha: 1,
            beta: 1,
            updated_at: time::now()
          }`,
          {
            shape,
            activity_id: validated.activity_id,
            org_id: orgId,
            account_id: accountId,
            account_id_version: 1,
          }
        );
      }

      // Re-fetch scores
      const refreshedScores = await surrealDB.query<ImpulseShapeActivityScore>(
        `SELECT * FROM impulse_shape_activity_score
         WHERE ${accountIdScopedWhere()} AND activity_id = $activity_id`,
        { org_id: orgId, account_id: accountId, activity_id: validated.activity_id }
      );
      existingScores.push(...(refreshedScores || []));
    }

    // Apply feedback multiplier to all shape scores
    const affectedActivities: string[] = [validated.activity_id];

    if (validated.direction === 'positive') {
      // Positive feedback: multiply alpha
      for (const score of existingScores) {
        const currentAlpha = score.alpha || 1;
        const newAlpha = Math.ceil(currentAlpha * multiplier);

        // Phase B-followup: dual-tenant WHERE on UPDATE.
        await surrealDB.query(
          `UPDATE impulse_shape_activity_score
           SET alpha = $new_alpha, updated_at = time::now()
           WHERE ${accountIdScopedWhere()}
             AND shape = $shape
             AND activity_id = $activity_id`,
          {
            new_alpha: newAlpha,
            org_id: orgId,
            account_id: accountId,
            shape: score.shape,
            activity_id: validated.activity_id,
          }
        );

        logger.info('Updated alpha for positive feedback', {
          activity_id: validated.activity_id,
          shape: score.shape,
          old_alpha: currentAlpha,
          new_alpha: newAlpha,
          multiplier,
        });
      }

      // TODO: Handle include_adjacent for positive feedback
      // This would query the composition graph to find adjacent activities
      // and apply a reduced multiplier to their scores
      if (validated.include_adjacent && validated.session_id) {
        logger.debug('Adjacent activity boosting not yet implemented', {
          session_id: validated.session_id,
        });
      }

    } else {
      // Negative feedback: multiply beta
      for (const score of existingScores) {
        const currentBeta = score.beta || 1;
        const newBeta = Math.ceil(currentBeta * multiplier);

        // Phase B-followup: dual-tenant WHERE on UPDATE.
        await surrealDB.query(
          `UPDATE impulse_shape_activity_score
           SET beta = $new_beta, updated_at = time::now()
           WHERE ${accountIdScopedWhere()}
             AND shape = $shape
             AND activity_id = $activity_id`,
          {
            new_beta: newBeta,
            org_id: orgId,
            account_id: accountId,
            shape: score.shape,
            activity_id: validated.activity_id,
          }
        );

        logger.info('Updated beta for negative feedback', {
          activity_id: validated.activity_id,
          shape: score.shape,
          old_beta: currentBeta,
          new_beta: newBeta,
          multiplier,
        });
      }

      // Negative feedback is specific - don't penalize adjacent activities
    }

    // Invalidate Redis cache for template recommendations
    try {
      const redisWrapper = RedisClient.getInstance();
      const redis = redisWrapper.getClient();
      if (redis) {
        // Invalidate all cached recommendations since scores changed
        const keys = await redis.keys(`${CACHE_KEY_PREFIX}*`);
        if (keys.length > 0) {
          await redis.del(...keys);
          logger.debug('Invalidated Redis cache after feedback', {
            keys_deleted: keys.length,
          });
        }
      }
    } catch (redisError) {
      logger.warn('Failed to invalidate Redis cache', {
        error: redisError instanceof Error ? redisError.message : String(redisError),
      });
      // Non-critical, continue
    }

    // Emit WebSocket event for dashboard updates
    // Phase G1 (2026-04-28): account_id surfaced alongside org_id for filtering.
    try {
      broadcaster.emit({
        type: 'feedback_recorded',
        timestamp: new Date().toISOString(),
        data: {
          activity_id: validated.activity_id,
          direction: validated.direction,
          intensity: validated.intensity,
          multiplier,
          affected_activities: affectedActivities,
          org_id: orgId,
          account_id: accountId ?? null,
        },
      });
    } catch (wsError) {
      logger.warn('Failed to emit WebSocket event', {
        error: wsError instanceof Error ? wsError.message : String(wsError),
      });
      // Non-critical, continue
    }

    // Log feedback for learning (optional audit trail)
    if (validated.reason) {
      logger.info('Feedback reason', {
        activity_id: validated.activity_id,
        direction: validated.direction,
        reason: validated.reason,
      });
    }

    const response: ActivityFeedbackResponse = {
      success: true,
      affected_activities: affectedActivities,
      multiplier,
      direction: validated.direction,
      message: `${validated.direction === 'positive' ? 'Positive' : 'Negative'} feedback applied with ${multiplier}x multiplier`,
    };

    return c.json(response, 200);

  } catch (error: any) {
    logger.error('POST /v2/activities/feedback failed', {
      error: error.message,
      stack: error.stack,
    });

    // Handle Zod validation errors
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation error',
        message: error.errors[0]?.message || 'Invalid request body',
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record feedback',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/discover-by-shapes
 * Discover activities by their input/output shapes
 *
 * Supports two modes:
 * - forward (default): Find activities that produce required_shapes (backward chaining - find producers)
 * - backward: Find activities that consume required_shapes (forward chaining - find consumers)
 *
 * Use case:
 * - Forward mode: "I need shape X, who can produce it?" (prerequisite discovery)
 * - Backward mode: "I have shape Y, what can consume it?" (next step discovery)
 */
app.post('/discover-by-shapes', async (c) => {
  try {
    const body = await c.req.json();
    // output_shapes: optional additive filter on backward mode — see OpenSpec change 2026-04-26-validators-and-failure-modes.
    const input = {
      required_shapes: body.required_shapes,
      mode: body.mode ?? 'forward',
      limit: body.limit ?? 10,
      current_shapes: body.current_shapes ?? [],
      output_shapes: body.output_shapes ?? [],
      predecessor_activity_id: body.predecessor_activity_id,
    };

    const validationError = validateDiscoverByShapesInput(input);
    if (validationError) {
      return c.json({
        error: validationError.error,
        message: validationError.message,
      }, 400);
    }

    const result = await runDiscoverByShapes(input);

    return c.json({
      activities: result.activities,
      total: result.total,
    });

  } catch (error: any) {
    logger.error('POST /v2/activities/discover-by-shapes failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to discover activities by shapes',
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
  tier: 'exact' | 'compatible' | 'fts' | 'fts_hybrid';
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

  // Tier 3: Hybrid FTS + dense fallback — search by goal description
  if (goalDescription && goalDescription.trim()) {
    const [tier3Result, denseResults] = await Promise.all([
      queryActivitiesByFTS(goalDescription, orgId, executionType, limit * 3, jwtToken),
      queryActivitiesByDense(goalDescription, orgId, executionType, limit * 3, jwtToken),
    ]);

    const ftsData = tier3Result.data ?? [];

    if (denseResults.length > 0) {
      const merged = mergeByRRF(ftsData as ParadigmActivity[], denseResults as ParadigmActivity[]);
      logger.info('[tiered-fallback] Tier 3 (FTS+dense hybrid) succeeded', {
        ftsCount: ftsData.length,
        denseCount: denseResults.length,
        mergedCount: merged.length,
        searchQuery: goalDescription.substring(0, 50),
      });
      return {
        activities: merged,
        tier: 'fts_hybrid',
      };
    }

    if (ftsData.length > 0) {
      logger.info('[tiered-fallback] Tier 3 (FTS) succeeded', {
        resultCount: ftsData.length,
        searchQuery: goalDescription.substring(0, 50),
        topScore: ftsData[0]?.fts_score,
        latency_ms: tier3Result.latency_ms,
      });
      return {
        activities: ftsData,
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
      expected_output_shapes = [],  // Array of expected output shapes from goal enrichment
      limit = 3,
      exclude_activities = [],  // T4: Blacklist of activity IDs to exclude
      session_context,          // Spec 2/3/4: loaded impulse state with timestamps
      exploration_config: rawExplorationConfig,
    } = body;

    const exploration_config = {
      exploration_ratio: 0.2,
      min_observations_threshold: 5,
      ...(rawExplorationConfig ?? {}),
    };
    const exploration_ratio = Math.max(0, Math.min(1, exploration_config.exploration_ratio ?? 0.2));
    const min_observations_threshold = Math.max(0, Math.floor(exploration_config.min_observations_threshold ?? 5));

    if (session_context) {
      const sc = session_context as SessionContext;
      const len = sc.loaded_shapes?.length ?? 0;
      if (
        (sc.loaded_pointer_paths?.length ?? 0) !== len ||
        (sc.load_timestamps_ms?.length ?? 0) !== len
      ) {
        return c.json({ error: 'session_context arrays must be the same length' }, 400);
      }
    }

    logger.info('POST /recommend', {
      task_description: task_description?.substring(0, 100),
      category,
      tags,
      tag_prefix,
      execution_type,
      loaded_impulses,
      impulse_shapes,
      expected_output_shapes,
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

    // Build FTS query: augment task_description with session_context tokens when present.
    // Tier 1/2 (shape-based) are not affected — only the FTS (Tier 3) query is enriched.
    let ftsQuery = task_description;
    let contextDecayWeightsByShape: Map<string, number> = new Map();
    if (session_context) {
      const sc = session_context as SessionContext;
      const nowMs = Date.now();
      const { tokens: augmentTokens, decayWeightsByShape } = extractContextTokensWithDecay(sc, 3, nowMs);
      contextDecayWeightsByShape = decayWeightsByShape;
      if (augmentTokens.length > 0) {
        ftsQuery = `${task_description} ${augmentTokens.join(' ')}`;
        logger.debug('FTS query augmented with session_context tokens', {
          fts_query_augmented: ftsQuery.substring(0, 120),
          augment_tokens: augmentTokens,
          hot_count: 3,
        });
      }
    }

    // Compute context_bucket for per-context Thompson Sampling (Spec 3)
    const contextBucket = orgId
      ? computeContextBucket(task_description, effectiveShapes, orgId)
      : null;
    if (contextBucket) {
      logger.debug('context_bucket computed', { context_bucket: contextBucket });
    }

    // Query activities using tiered fallback strategy
    // Tier 1: Exact shape match, Tier 2: Compatible (no shapes), Tier 3: FTS on goal description
    const fallbackResult = await getActivitiesWithTieredFallback(
      effectiveShapes,
      category || null,
      ftsQuery,
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
    // Note: Use normalizeRecordId to convert SurrealDB RecordId objects to strings
    const activityIds = templates.map((t: any) =>
      normalizeRecordId(t.id || t.variant_id)
    );
    let scoresMap = new Map<string, ActivityScore>();
    let scoreMethod: 'shape_conditioned' | 'global' | 'legacy' = 'legacy';

    if (activityIds.length > 0 && orgId) {
      // Use shape-conditioned scores when shapes are provided (includes semantically implied shapes)
      // Phase E: pass accountId so posteriors stay separated per account.
      const recommendAccountId = jwtAuth?.accountId ?? null;
      if (effectiveShapes && effectiveShapes.length > 0) {
        const shapeScoresResult = await getShapeConditionedScores(
          orgId,
          activityIds,
          effectiveShapes,
          jwtAuth?.jwtToken,
          recommendAccountId
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
        const scoresResult = await getActivityScores(orgId, activityIds, jwtAuth?.jwtToken, recommendAccountId);
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

    // Lookup per-bucket Thompson scores (Spec 3)
    // Phase B1: dual-scope by account_id; legacy rows match via org_id.
    let contextScoresMap = new Map<string, { alpha: number; beta: number; n_observations: number }>();
    if (contextBucket && activityIds.length > 0) {
      try {
        const ctxResult = await surrealDB.query<any>(`
          SELECT template_id, alpha, beta, n_observations
          FROM context_thompson_scores
          WHERE ${accountIdScopedWhere()} AND context_bucket = $bucket AND template_id IN $ids
        `, {
          org_id: orgId,
          account_id: jwtAuth?.accountId ?? null,
          bucket: contextBucket,
          ids: activityIds,
        });

        for (const row of (ctxResult || [])) {
          contextScoresMap.set(row.template_id, {
            alpha: row.alpha ?? 1,
            beta: row.beta ?? 1,
            n_observations: row.n_observations ?? 0,
          });
        }
      } catch (ctxErr: any) {
        logger.warn('context_thompson_scores lookup failed (non-blocking)', {
          error: ctxErr.message,
        });
      }
    }

    // Calculate impulse relevancy boosts (with optional decay weights from session_context)
    const decayWeightsForRelevancy = contextDecayWeightsByShape.size > 0 ? contextDecayWeightsByShape : undefined;
    const impulseBoostsMap = await calculateImpulseRelevancyBoosts(activityIds, loaded_impulses, decayWeightsForRelevancy);

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

    // Filter out templates without a valid ID or that are retired before processing
    // Note: Use normalizeRecordId to handle SurrealDB RecordId objects
    const validTemplates = templates.filter((template: any) => {
      const templateId = normalizeRecordId(template.id || template.variant_id);
      if (!templateId || templateId.trim() === '') {
        logger.warn('Filtering out template without valid ID', {
          template_name: template.name || template.variant_name,
          template_id: normalizeRecordId(template.id),
          variant_id: template.variant_id,
        });
        return false;
      }

      // Filter out retired templates
      if (template.retired === true) {
        logger.debug('Filtering out retired template', {
          template_id: templateId,
          template_name: template.name || template.variant_name,
          retired_reason: template.retired_reason,
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

    // UCB: total org executions derived from already-fetched scoresMap — no extra DB query
    const total_org_executions = Math.max(1, [...scoresMap.values()].reduce((sum, s) => sum + (s.total_executions ?? 0), 0));

    function ucbScore(totalExecs: number, successes: number): number {
      const n = totalExecs;
      const mean = n === 0 ? 0 : successes / n;
      return mean + Math.sqrt(2 * Math.log(total_org_executions) / Math.max(n, 1));
    }

    // Apply Thompson Sampling with heuristic prior boosting
    const recommendations = validTemplates
      .map((template: any) => {
        // Try to get alpha/beta from v_activity_score first
        // Note: Use normalizeRecordId for consistent Map lookups and API output
        const activityId = normalizeRecordId(template.id || template.variant_id);
        const scores = scoresMap.get(activityId);
        let alpha = scores?.alpha || template.metrics?.thompson_alpha || 1.0;
        const betaVal = scores?.beta || template.metrics?.thompson_beta || 1.0;

        // HEURISTIC BOOSTS: Encode domain knowledge as informative priors
        const templateTags = template.tags || [];
        const templateShapes = template.input_shapes || [];
        let totalBoost = 0;

        // 1. Tag match quality boost (+0 to +10 based on match quality)
        // Higher weight ensures semantic relevance outweighs execution history
        const tagMatchQuality = semantics.getMatchQuality(templateTags);
        const tagBoost = Math.floor(tagMatchQuality * 10);
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

        // 4. Execution history boost (proven templates get +1 to +3)
        // Reduced weight prevents well-tested but irrelevant templates from dominating
        const executionCount = (scores?.successes || 0) + (scores?.failures || 0);
        const historyBoost = Math.min(3, Math.floor(executionCount / 20));
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

        // 8. Output shape coverage boost (based on expected outcomes from goal enrichment)
        // Activities whose output_shapes cover expected outcomes get boosted
        const templateOutputShapes = template.output_shapes || [];
        const outputCoverage = calculateOutputShapeCoverage(expected_output_shapes, templateOutputShapes);
        // +0 to +4 based on coverage (0% = +0, 50% = +2, 100% = +4)
        const outputShapeBoost = Math.floor(outputCoverage * 4);
        totalBoost += outputShapeBoost;

        // 9. Shape mismatch penalty (penalize templates missing required shapes)
        // If we have expected shapes (from context/impulses), penalize activities that don't support them
        let shapeMismatchPenalty = 0;
        if (effectiveShapes && effectiveShapes.length > 0) {
          const missingShapes = effectiveShapes.filter(
            (shape: string) => !templateShapes.includes(shape)
          );
          shapeMismatchPenalty = missingShapes.length * -2;
          totalBoost += shapeMismatchPenalty;

          if (missingShapes.length > 0) {
            logger.debug('Shape mismatch penalty', {
              template_id: template.id,
              template_name: template.name,
              expected_shapes: effectiveShapes,
              template_shapes: templateShapes,
              missing_shapes: missingShapes,
              missing_count: missingShapes.length,
              penalty: shapeMismatchPenalty,
            });
          }
        }

        // Log boost calculation for debugging
        logger.debug('Thompson boost calculation', {
          template_id: activityId,
          template_name: template.name || template.variant_name,
          execution_boost: historyBoost,
          tag_boost: tagBoost,
          total_boost: totalBoost,
          boost_breakdown: {
            tag_match: tagBoost,
            shape_compatible: shapeBoost,
            recency: recencyBoost,
            execution_history: historyBoost,
            scope_preference: scopeBoost,
            impulse_relevancy: impulseAlphaBoost,
            category_match: categoryBoost,
            output_shape_coverage: outputShapeBoost,
            shape_mismatch_penalty: shapeMismatchPenalty,
          },
        });

        // Apply boosts and penalties
        alpha += totalBoost;
        const adjustedBeta = betaVal + impulseBetaPenalty;

        // Context-bucketed Thompson blend (Spec 3)
        const ctxRow = contextScoresMap.get(activityId);
        const nContext = ctxRow ? (ctxRow.alpha + ctxRow.beta - 2) : 0;
        const blendWeight = nContext >= 5 ? 0.7 : nContext >= 2 ? 0.3 : 0.0;
        const alphaBlended = blendWeight * (ctxRow?.alpha ?? 1) + (1 - blendWeight) * alpha;
        const betaBlended  = blendWeight * (ctxRow?.beta  ?? 1) + (1 - blendWeight) * adjustedBeta;

        // Sample from Beta(alpha, beta) distribution for Thompson Sampling
        // This enables exploration (high variance for uncertain templates) and
        // exploitation (high mean for proven templates) tradeoff
        const sample = betaSample(alphaBlended, betaBlended);

        const rawTotalExecs = scores?.total_executions ?? 0;
        const rawSuccesses = scores?.successes ?? 0;
        const computed_ucb_score = ucbScore(rawTotalExecs, rawSuccesses);

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
          _ucb_score: computed_ucb_score,
          _total_executions: rawTotalExecs,
          selection_metadata: {
            method: 'thompson_sampling',
            score_source: blendWeight > 0 ? 'context_bucketed' : scoreMethod,
            alpha: alphaBlended,
            beta: betaBlended,
            original_beta: betaVal,
            sample,
            score: sample,
            ucb_score: computed_ucb_score,
            exploration_slot: false, // patched after pool partitioning
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
              output_shape_coverage: outputShapeBoost,
              shape_mismatch_penalty: shapeMismatchPenalty,
            },
            // Context-bucketed Thompson metadata (Spec 3)
            ...(contextBucket ? {
              context_bucket: contextBucket,
              context_blend_weight: blendWeight,
              context_n_observations: nContext,
            } : {}),
            // Output shape analysis
            output_shape_analysis: expected_output_shapes.length > 0 ? {
              expected_shapes: expected_output_shapes,
              activity_output_shapes: templateOutputShapes,
              coverage: outputCoverage,
              boost: outputShapeBoost,
            } : null,
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

    // UCB pool partitioning: split into exploration/exploitation, assemble final list
    const reserved = exploration_ratio > 0 ? Math.max(1, Math.floor(limit * exploration_ratio)) : 0;
    const explorationPool = recommendations.filter((c: any) => c._total_executions < min_observations_threshold);
    const exploitationPool = recommendations.filter((c: any) => c._total_executions >= min_observations_threshold);
    explorationPool.sort((a: any, b: any) => b._ucb_score - a._ucb_score);
    exploitationPool.sort((a: any, b: any) => b._ucb_score - a._ucb_score);
    const headSlots = limit - reserved;
    const head = exploitationPool.slice(0, headSlots);
    const tail = explorationPool.slice(0, reserved);
    const tailFill = exploitationPool.slice(headSlots, headSlots + (reserved - tail.length));
    const finalRecommendations = [...head, ...tail, ...tailFill].slice(0, limit);

    // Patch exploration_slot and clean up internal fields
    const explorationSet = new Set(explorationPool);
    for (const rec of finalRecommendations) {
      rec.selection_metadata.exploration_slot = explorationSet.has(rec);
      delete (rec as any)._ucb_score;
      delete (rec as any)._total_executions;
    }

    // Generate correlation IDs for selection-to-execution linkage
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    finalRecommendations.forEach((rec: any, index: number) => {
      rec.correlation_id = `sel_${timestamp}_${randomSuffix}_${index}`;
    });

    logger.info('Recommendations generated', {
      count: finalRecommendations.length,
      top: finalRecommendations[0]?.template_id,
      correlationIds: finalRecommendations.map((r: any) => r.correlation_id),
      scoreMethod,
      fallbackTier,
      explorationRatio: exploration_ratio,
      // Log selection details for top recommendation
      topRecommendation: finalRecommendations[0] ? {
        template_id: finalRecommendations[0].template_id,
        thompson_sample: finalRecommendations[0].selection_metadata.sample,
        alpha: finalRecommendations[0].selection_metadata.alpha,
        beta: finalRecommendations[0].selection_metadata.beta,
        ucb_score: finalRecommendations[0].selection_metadata.ucb_score,
        exploration_slot: finalRecommendations[0].selection_metadata.exploration_slot,
        output_shapes: finalRecommendations[0].output_shapes,
      } : null,
    });

    // Log Thompson Sampling selections for explainability (non-blocking)
    // Only log if we have an org context and recommendations
    if (orgId && finalRecommendations.length > 0) {
      // Log each selection to thompson_selection_log for explainability
      const selectionLogs = finalRecommendations.map((rec: any, index: number) => ({
        correlation_id: rec.correlation_id, // Link to execution via correlation_id
        execution_id: `recommend-${timestamp}-${index}`, // Placeholder until actual execution
        activity_id: rec.template_id,
        thompson_sample: rec.selection_metadata.sample,
        alpha: rec.selection_metadata.alpha,
        beta: rec.selection_metadata.beta,
        selection_method: 'thompson_sampling',
        candidates_count: templates.length,
        exploration_slot: rec.selection_metadata.exploration_slot,
      }));

      // Insert selection logs (fire-and-forget for performance)
      // Use FOR loop to handle array inserts properly
      // NOTE: org_id is STRING type in schema, not a record
      // Phase B1: dual-write account_id + account_id_version on each log row.
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
            exploration_slot: $log.exploration_slot,
            org_id: $org_name,
            account_id: $account_id,
            account_id_version: 1,
            project_id: IF $project_name IS NOT NONE AND $project_name IS NOT NULL THEN type::record('projects', $project_name) ELSE NONE END
          }
        }
      `, {
        logs: selectionLogs,
        org_name: orgId, // Plain string org_id
        account_id: jwtAuth?.accountId ?? null,
        project_name: projectId, // project_id can be record or string
      }).catch((err: any) => {
        logger.warn('Failed to log Thompson selections', { error: err.message });
      });

      // Increment total_selections for recommended activities
      // Phase B1: dual-scope WHERE — match account_id-tagged rows first, fall
      // back to legacy org_id-only rows.
      const activityIds = finalRecommendations.map((r: any) => r.template_id);
      surrealDB.query(`
        UPDATE variant_performance_metrics
        SET total_selections = total_selections + 1,
            updated_at = time::now()
        WHERE variant_id IN $activity_ids
          AND ${accountIdScopedWhere()}
      `, {
        activity_ids: activityIds,
        org_id: orgId,
        account_id: accountIdRecordRef(jwtAuth?.accountId ?? null),
      }).catch((err: any) => {
        logger.warn('Failed to update total_selections', { error: err.message });
      });

      logger.debug('Selection metrics queued for persistence', {
        selectionCount: selectionLogs.length,
        activityIds,
      });
    }

    return c.json({
      recommendations: finalRecommendations,
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
    // Phase B1: account_id flows from JWT auth context.
    const goalSeekingJwtAuth = getJwtAuthFromContext(c);
    const orgId = goalSeekingJwtAuth?.orgId || sessionData?.org_id || null;
    const accountId: string | null = goalSeekingJwtAuth?.accountId ?? null;
    const projectId = goalSeekingJwtAuth?.projectId || sessionData?.project_id || null;

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
    // Phase B1: dual-write account_id + version=1 marker on the new template.
    // Only set when non-null — SurrealDB 3.x option<string> rejects JSON null.
    if (accountId != null) {
      templateRecord.account_id = accountId;
    }
    templateRecord.account_id_version = 1;

    const fields = Object.keys(templateRecord).map(k => `${k}: $${k}`).join(',\n        ');
    // Use UPSERT to handle re-registration and orphaned index entries
    const upsertTemplateQuery = `
      UPSERT activity:\`${generated.id}\` CONTENT {
        ${fields},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    try {
      await surrealDB.query(upsertTemplateQuery, templateRecord);
      logger.debug('Generated template upserted into activity table', {
        id: generated.id,
      });
    } catch (upsertError: any) {
      // Re-throw errors
      throw upsertError;
    }

    // Initialize Thompson Sampling metrics (UPSERT to handle re-registration)
    // Use deterministic record ID format for idempotent upserts.
    // Phase E: record-id is account-keyed when accountId is present so
    // different accounts in the same org keep separate posteriors.
    const metricsRecordId = variantMetricsRecordId(generated.id, accountId);
    const insertMetricsQuery = `
      UPSERT variant_performance_metrics:\`${metricsRecordId}\` CONTENT {
        variant_id: $activity_id,
        activity_id: $activity_id,
        account_id: $account_id,
        account_id_version: 1,
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

    const generatedMetricsAccountId = accountIdRecordRef(accountId);
    await surrealDB.query(insertMetricsQuery, {
      activity_id: generated.id,
      ...(generatedMetricsAccountId != null ? { account_id: generatedMetricsAccountId } : {}),
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

    // Phase B1: pull account_id from JWT auth context for dual-write.
    const compositionJwtAuth = getJwtAuthFromContext(c);
    const compositionAccountId: string | null = compositionJwtAuth?.accountId ?? null;

    logger.info('POST /v2/activities/composition', {
      parent: validated.parent_activity_id,
      child: validated.child_activity_id,
      success: validated.success,
      inputShapes: validated.input_impulse_shapes?.length || 0,
      outputShapes: validated.output_impulse_shapes?.length || 0,
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
    // Generate edge_id for composition_impulse_flow records
    const edgeId = `${validated.parent_activity_id}:${validated.child_activity_id}`;

    if (existing && existing.length > 0 && existing[0]) {
      // Update existing edge
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing issue
      const newExecutionCount = (current.execution_count || 0) + 1;
      // @ts-ignore - SurrealDB query typing issue
      const newSuccessCount = (current.success_count || 0) + (validated.success ? 1 : 0);
      const newWeight = newSuccessCount / newExecutionCount;

      // Build SET clauses dynamically to avoid SCHEMAFULL field errors
      // Phase B1: refresh account_id_version on every update so legacy rows
      // get tagged on first write, and re-stamp account_id when caller carries one.
      const setClauses: string[] = [
        'execution_count = $execution_count',
        'success_count = $success_count',
        'weight = $weight',
        'updated_at = time::now()',
        'input_impulse_shapes = $input_impulse_shapes',
        'output_impulse_shapes = $output_impulse_shapes',
        'account_id = $account_id',
        'account_id_version = 1',
      ];

      const updateParams: Record<string, any> = {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_count: newExecutionCount,
        success_count: newSuccessCount,
        weight: newWeight,
        input_impulse_shapes: validated.input_impulse_shapes || [],
        output_impulse_shapes: validated.output_impulse_shapes || [],
        account_id: compositionAccountId,
      };

      // Add optional fields only if they have values
      if (validated.duration_ms !== undefined && validated.duration_ms !== null) {
        setClauses.push('duration_ms = $duration_ms');
        updateParams.duration_ms = validated.duration_ms;
      }
      if (validated.cost_usd !== undefined && validated.cost_usd !== null) {
        setClauses.push('cost_usd = $cost_usd');
        updateParams.cost_usd = validated.cost_usd;
      }
      if (validated.tokens_input !== undefined && validated.tokens_input !== null) {
        setClauses.push('tokens_input = $tokens_input');
        updateParams.tokens_input = validated.tokens_input;
      }
      if (validated.tokens_output !== undefined && validated.tokens_output !== null) {
        setClauses.push('tokens_output = $tokens_output');
        updateParams.tokens_output = validated.tokens_output;
      }
      if (validated.depth !== undefined && validated.depth !== null) {
        setClauses.push('depth = $depth');
        updateParams.depth = validated.depth;
      }
      if (validated.composition_chain && validated.composition_chain.length > 0) {
        setClauses.push('composition_chain = $composition_chain');
        updateParams.composition_chain = validated.composition_chain;
      }

      const updateQuery = `
        UPDATE activity_composition_graph
        SET ${setClauses.join(',\n          ')}
        WHERE parent_activity_id = $parent_activity_id
          AND child_activity_id = $child_activity_id
        RETURN AFTER
      `;

      const updated = await surrealDB.query<CompositionEdge[]>(updateQuery, updateParams);

      // @ts-ignore - SurrealDB query typing issue
      edge = updated && updated.length > 0 ? updated[0] : current;
      logger.info('Updated composition edge', {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        execution_count: newExecutionCount,
        weight: newWeight,
      });
    } else {
      // Create new edge with impulse flow fields
      // Build params object dynamically to avoid SCHEMAFULL field errors
      // Phase B1: dual-write account_id + version=1 marker on the new edge.
      const params: Record<string, any> = {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_id: validated.execution_id,
        goal_context: validated.goal_context || '',
        success: validated.success,
        success_count: validated.success ? 1 : 0,
        weight: validated.success ? 1.0 : 0.0,
        input_impulse_shapes: validated.input_impulse_shapes || [],
        output_impulse_shapes: validated.output_impulse_shapes || [],
        account_id: compositionAccountId,
        account_id_version: 1,
      };

      // Add optional fields only if they have values
      // This prevents SCHEMAFULL errors when fields aren't in the schema yet
      if (validated.duration_ms !== undefined && validated.duration_ms !== null) {
        params.duration_ms = validated.duration_ms;
      }
      if (validated.cost_usd !== undefined && validated.cost_usd !== null) {
        params.cost_usd = validated.cost_usd;
      }
      if (validated.tokens_input !== undefined && validated.tokens_input !== null) {
        params.tokens_input = validated.tokens_input;
      }
      if (validated.tokens_output !== undefined && validated.tokens_output !== null) {
        params.tokens_output = validated.tokens_output;
      }
      if (validated.depth !== undefined && validated.depth !== null) {
        params.depth = validated.depth;
      }
      if (validated.composition_chain && validated.composition_chain.length > 0) {
        params.composition_chain = validated.composition_chain;
      }

      // Build field list dynamically from params
      const fieldEntries = Object.keys(params).map(k => `${k}: $${k}`);
      const fieldsStr = fieldEntries.join(',\n          ');

      const createQuery = `
        CREATE activity_composition_graph CONTENT {
          ${fieldsStr},
          execution_count: 1,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const created = await surrealDB.query<CompositionEdge[]>(createQuery, params);

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
        input_impulse_shapes: validated.input_impulse_shapes || [],
        output_impulse_shapes: validated.output_impulse_shapes || [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      logger.info('Created composition edge', {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        weight: edge.weight,
      });
    }

    // Record detailed impulse flow if impulse IDs are provided
    if (validated.input_impulse_ids?.length || validated.output_impulse_ids?.length) {
      const flowRecords: any[] = [];

      // Create input flow records
      if (validated.input_impulse_ids && validated.input_impulse_shapes) {
        for (let i = 0; i < validated.input_impulse_ids.length; i++) {
          flowRecords.push({
            edge_id: edgeId,
            execution_id: validated.execution_id,
            impulse_id: validated.input_impulse_ids[i],
            direction: 'input',
            shape: validated.input_impulse_shapes[i] || 'unknown',
            execution_succeeded: validated.success,
          });
        }
      }

      // Create output flow records
      if (validated.output_impulse_ids && validated.output_impulse_shapes) {
        for (let i = 0; i < validated.output_impulse_ids.length; i++) {
          flowRecords.push({
            edge_id: edgeId,
            execution_id: validated.execution_id,
            impulse_id: validated.output_impulse_ids[i],
            direction: 'output',
            shape: validated.output_impulse_shapes[i] || 'unknown',
            execution_succeeded: validated.success,
          });
        }
      }

      // Insert flow records
      if (flowRecords.length > 0) {
        const flowInsertQuery = `
          INSERT INTO composition_impulse_flow $records
        `;
        await surrealDB.query(flowInsertQuery, { records: flowRecords });
        logger.info('Recorded composition impulse flows', {
          edge_id: edgeId,
          flow_count: flowRecords.length,
        });
      }
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
 * GET /v2/activities/composition/state-transitions
 * Query state transitions in the composition graph
 *
 * Analyzes how shapes flow through activity compositions, showing:
 * - Which shapes are produced by each activity
 * - Which shapes are consumed by downstream activities
 * - Success rates for specific shape transformations
 *
 * Query parameters:
 * - from_shapes: Array of input shapes to analyze
 * - to_shapes: Array of desired output shapes
 * - activity_id: Filter by specific activity
 * - limit: Max results (default: 50)
 */
app.get('/composition/state-transitions', async (c) => {
  try {
    const query = c.req.query();
    const fromShapes = query.from_shapes ? JSON.parse(query.from_shapes) : undefined;
    const toShapes = query.to_shapes ? JSON.parse(query.to_shapes) : undefined;
    const activityId = query.activity_id;
    const limit = query.limit ? parseInt(query.limit) : 50;

    logger.info('GET /v2/activities/composition/state-transitions', {
      from_shapes: fromShapes,
      to_shapes: toShapes,
      activity_id: activityId,
      limit,
    });

    const whereClauses: string[] = [];
    const params: Record<string, any> = { limit };

    if (activityId) {
      whereClauses.push(`(parent_activity_id = $activity_id OR child_activity_id = $activity_id)`);
      params.activity_id = activityId;
    }

    if (fromShapes && Array.isArray(fromShapes) && fromShapes.length > 0) {
      whereClauses.push(`array::len(array::intersect(input_impulse_shapes, $from_shapes)) > 0`);
      params.from_shapes = fromShapes;
    }

    if (toShapes && Array.isArray(toShapes) && toShapes.length > 0) {
      whereClauses.push(`array::len(array::intersect(output_impulse_shapes, $to_shapes)) > 0`);
      params.to_shapes = toShapes;
    }

    let transitionsQuery = `
      SELECT
        parent_activity_id,
        child_activity_id,
        input_impulse_shapes,
        output_impulse_shapes,
        weight,
        execution_count,
        success_count,
        math::mean(duration_ms) AS avg_duration_ms,
        math::mean(cost_usd) AS avg_cost_usd
      FROM activity_composition_graph
    `;

    if (whereClauses.length > 0) {
      transitionsQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    transitionsQuery += `
      ORDER BY weight DESC, execution_count DESC
      LIMIT $limit
    `;

    const transitions = await surrealDB.query(transitionsQuery, params);

    // Aggregate shape transformation statistics
    const shapeTransformations = new Map<string, {
      from_shapes: Set<string>;
      to_shapes: Set<string>;
      activities: Set<string>;
      total_executions: number;
      successful_executions: number;
      avg_duration_ms: number;
      avg_cost_usd: number;
    }>();

    if (transitions && Array.isArray(transitions)) {
      for (const edge of transitions.flat()) {
        const key = `${edge.parent_activity_id}->${edge.child_activity_id}`;
        const existing = shapeTransformations.get(key);

        if (existing) {
          edge.input_impulse_shapes?.forEach((s: string) => existing.from_shapes.add(s));
          edge.output_impulse_shapes?.forEach((s: string) => existing.to_shapes.add(s));
          existing.total_executions += edge.execution_count || 0;
          existing.successful_executions += edge.success_count || 0;
        } else {
          shapeTransformations.set(key, {
            from_shapes: new Set(edge.input_impulse_shapes || []),
            to_shapes: new Set(edge.output_impulse_shapes || []),
            activities: new Set([edge.parent_activity_id, edge.child_activity_id]),
            total_executions: edge.execution_count || 0,
            successful_executions: edge.success_count || 0,
            avg_duration_ms: edge.avg_duration_ms || 0,
            avg_cost_usd: edge.avg_cost_usd || 0,
          });
        }
      }
    }

    // Convert to array for response
    const stateTransitions = Array.from(shapeTransformations.entries()).map(([key, stats]) => ({
      transition: key,
      from_shapes: Array.from(stats.from_shapes),
      to_shapes: Array.from(stats.to_shapes),
      activities: Array.from(stats.activities),
      success_rate: stats.total_executions > 0
        ? stats.successful_executions / stats.total_executions
        : 0,
      total_executions: stats.total_executions,
      avg_duration_ms: stats.avg_duration_ms,
      avg_cost_usd: stats.avg_cost_usd,
    }));

    logger.info('State transitions query result', {
      transitions: stateTransitions.length,
    });

    return c.json({
      state_transitions: stateTransitions,
      total: stateTransitions.length,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/state-transitions failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query state transitions',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/successors
 * Query composition successors for an activity
 *
 * Returns activities that have historically followed the given activity
 * with their success rates, costs, and durations. Used for post-execution
 * recommendations.
 *
 * Query parameters:
 * - activity_id: Activity to get successors for (required)
 * - min_weight: Minimum edge weight (default: 0.5 = 50% success rate)
 * - limit: Max results (default: 10)
 *
 * Returns array of successor activities sorted by weight (success rate)
 */
app.get('/composition/successors', async (c) => {
  try {
    const query = c.req.query();
    const activityId = query.activity_id;
    const minWeight = query.min_weight ? parseFloat(query.min_weight) : 0.5;
    const limit = query.limit ? parseInt(query.limit) : 10;

    if (!activityId) {
      return c.json({
        error: 'Validation failed',
        message: 'activity_id is required',
      }, 400);
    }

    logger.info('GET /v2/activities/composition/successors', {
      activityId,
      minWeight,
      limit,
    });

    // Query composition graph for edges where this activity is parent
    const successorsQuery = `
      SELECT
        child_activity_id,
        weight,
        avg_duration_ms,
        avg_cost_usd,
        success_count,
        total_count
      FROM activity_composition_graph
      WHERE parent_activity_id = $activity_id
        AND weight >= $min_weight
      ORDER BY weight DESC
      LIMIT $limit
    `;

    const result = await surrealDB.query(successorsQuery, {
      activity_id: activityId,
      min_weight: minWeight,
      limit,
    });

    const successors = (result && Array.isArray(result) ? result.flat() : []);

    logger.info('Composition successors query result', {
      activityId,
      successorCount: successors.length,
    });

    return c.json({
      successors,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/successors failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query composition successors',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/impulse-success
 * Query impulse-conditioned success rates from composition data
 *
 * This endpoint enables queries like:
 * - "Success rate when parent X calls child Y with shape Z loaded"
 * - "Which input shapes correlate with composition success?"
 * - "Which output shapes indicate successful completion?"
 *
 * Query parameters:
 * - edge_id: Filter by specific composition edge (parent:child)
 * - shape: Filter by specific impulse shape
 * - direction: Filter by 'input' or 'output'
 * - min_count: Minimum count for statistical significance (default: 3)
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 *
 * Returns success rates grouped by edge, shape, and direction
 */
app.get('/composition/impulse-success', async (c) => {
  try {
    const query = c.req.query();

    const edgeId = query.edge_id;
    const shape = query.shape;
    const direction = query.direction as 'input' | 'output' | undefined;
    const minCount = query.min_count ? parseInt(query.min_count) : 3;
    const limit = query.limit ? parseInt(query.limit) : 100;
    const offset = query.offset ? parseInt(query.offset) : 0;

    logger.info('GET /v2/activities/composition/impulse-success', {
      edge_id: edgeId,
      shape,
      direction,
      min_count: minCount,
      limit,
      offset,
    });

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
      min_count: minCount,
    };

    if (edgeId) {
      whereClauses.push(`edge_id = $edge_id`);
      params.edge_id = edgeId;
    }

    if (shape) {
      whereClauses.push(`shape = $shape`);
      params.shape = shape;
    }

    if (direction) {
      whereClauses.push(`direction = $direction`);
      params.direction = direction;
    }

    // Query from the view (v_composition_impulse_success) or aggregate directly
    // Note: SurrealDB 2.x does not support HAVING clause, using subquery with WHERE instead
    let ratesQuery = `
      SELECT * FROM (
        SELECT
          edge_id,
          shape,
          direction,
          count() as total_count,
          count(IF execution_succeeded = true THEN 1 ELSE NONE END) as success_count,
          (count(IF execution_succeeded = true THEN 1 ELSE NONE END) * 1.0 / count()) as success_rate
        FROM composition_impulse_flow
    `;

    if (whereClauses.length > 0) {
      ratesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    ratesQuery += `
        GROUP BY edge_id, shape, direction
      ) WHERE total_count >= $min_count
      ORDER BY success_rate DESC
      LIMIT $limit START $offset
    `;

    // Count query for total
    // Note: SurrealDB 2.x does not support HAVING clause, using nested subquery with WHERE instead
    let countQuery = `
      SELECT count() as total FROM (
        SELECT * FROM (
          SELECT edge_id, shape, direction, count() as cnt
          FROM composition_impulse_flow
          ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
          GROUP BY edge_id, shape, direction
        ) WHERE cnt >= $min_count
      )
    `;

    const [ratesResult, countResult] = await Promise.all([
      surrealDB.query<any[]>(ratesQuery, params),
      surrealDB.query<any[]>(countQuery, params),
    ]);

    const rates = ratesResult && Array.isArray(ratesResult) ? ratesResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : rates.length;

    logger.info('Composition impulse success query result', {
      rates_count: rates.length,
      total,
    });

    return c.json({
      rates,
      total,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/impulse-success failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query impulse success rates',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/composition/edges
 * Record shape-based composition edge for Thompson Sampling learning.
 *
 * This endpoint records edges between activities based on the shapes they produce/consume.
 * When Activity A produces shape X that Activity B consumes, record an edge for learning.
 *
 * Uses fn::update_composition_edge from schema 046-composition-graph.surql to:
 * - Create edge if it doesn't exist (alpha=2/beta=1 or alpha=1/beta=2 based on success)
 * - Update Thompson Sampling parameters (alpha+1 for success, beta+1 for failure)
 * - Track success/failure counts per edge
 *
 * Request body:
 * - parent_activity_id: Activity that produced the shape
 * - child_activity_id: Activity that consumed the shape
 * - shape_produced: The shape that connects them (optional - will compute overlap if not provided)
 * - state_before: State when parent completed (shapes, git, env)
 * - state_after: State after child completed (shapes, git, env)
 * - success: Whether the child activity succeeded
 * - duration_ms: Execution duration (optional)
 */
app.post('/composition/edges', async (c) => {
  try {
    // Check JWT authentication
    const jwtAuth = getJwtAuthFromContext(c);
    if (!jwtAuth?.orgId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const body = await c.req.json();
    // Inline schema for composition edge request (shape-based composition tracking)
    const validated = {
      parent_activity_id: body.parent_activity_id,
      child_activity_id: body.child_activity_id,
      shape_produced: body.shape_produced,
      state_before: body.state_before,
      state_after: body.state_after,
      success: body.success,
    };

    logger.info('POST /v2/activities/composition/edges', {
      parent: validated.parent_activity_id,
      child: validated.child_activity_id,
      shape: validated.shape_produced,
      success: validated.success,
      orgId: jwtAuth.orgId,
    });

    // If shape_produced is not provided, compute overlapping shapes
    let shapesToRecord: string[] = [];

    if (validated.shape_produced) {
      // Single shape provided
      shapesToRecord = [validated.shape_produced];
    } else if (validated.state_before?.shapes && validated.state_after?.shapes) {
      // Compute overlap: shapes that parent produced that child consumed
      // state_before.shapes = shapes available when child started (includes parent's output)
      // state_after.shapes = shapes available after child completed
      const beforeSet = new Set(validated.state_before.shapes);
      const afterSet = new Set(validated.state_after.shapes);

      // Shapes that were in before (parent produced) and still in after (used by child)
      shapesToRecord = [...beforeSet].filter(s => afterSet.has(s)) as string[];

      // If no overlap, record edge without shape
      if (shapesToRecord.length === 0) {
        shapesToRecord = ['_direct']; // Placeholder for direct composition without shape flow
      }
    } else {
      // No state info, record with placeholder
      shapesToRecord = ['_unknown'];
    }

    // Record edge for each overlapping shape using fn::update_composition_edge
    const recordedEdges: any[] = [];

    for (const shape of shapesToRecord) {
      try {
        // Use the fn::update_composition_edge function from schema 046
        const updateQuery = `
          RETURN fn::update_composition_edge(
            $from_activity,
            $to_activity,
            $shape,
            $success
          );
        `;

        await surrealDB.query(updateQuery, {
          from_activity: validated.parent_activity_id,
          to_activity: validated.child_activity_id,
          shape: shape,
          success: validated.success,
        });

        recordedEdges.push({
          from_activity: validated.parent_activity_id,
          to_activity: validated.child_activity_id,
          shape_produced: shape,
          success: validated.success,
        });

        logger.debug('Recorded composition edge', {
          parent: validated.parent_activity_id,
          child: validated.child_activity_id,
          shape: shape,
          success: validated.success,
        });
      } catch (edgeError: any) {
        // Log but continue - fn::update_composition_edge may not exist in older schemas
        logger.warn('Failed to record edge via fn::update_composition_edge, falling back', {
          error: edgeError.message,
          shape: shape,
        });

        // Fallback: Direct insert into composition_edge table
        // Phase B1: dual-scope match on existing row (account_id preferred,
        // fall back to org_id), and dual-write account_id + version=1 on
        // both UPDATE and CREATE branches.
        const fallbackQuery = `
          LET $existing = (
            SELECT * FROM composition_edge
            WHERE from_activity = $from_activity
              AND to_activity = $to_activity
              AND shape_produced = $shape
              AND ${accountIdScopedWhere()}
            LIMIT 1
          );

          IF array::len($existing) > 0 THEN (
            UPDATE composition_edge SET
              success_count = IF($success, success_count + 1, success_count),
              failure_count = IF($success, failure_count, failure_count + 1),
              total_count = total_count + 1,
              alpha = IF($success, alpha + 1, alpha),
              beta = IF($success, beta, beta + 1),
              account_id = $account_id,
              account_id_version = 1,
              updated_at = time::now()
            WHERE from_activity = $from_activity
              AND to_activity = $to_activity
              AND shape_produced = $shape
              AND ${accountIdScopedWhere()}
            RETURN AFTER
          ) ELSE (
            CREATE composition_edge SET
              from_activity = $from_activity,
              to_activity = $to_activity,
              shape_produced = $shape,
              alpha = IF($success, 2.0, 1.0),
              beta = IF($success, 1.0, 2.0),
              weight = 0.5,
              success_count = IF($success, 1, 0),
              failure_count = IF($success, 0, 1),
              total_count = 1,
              org_id = $org_id,
              account_id = $account_id,
              account_id_version = 1,
              public = false
            RETURN AFTER
          ) END;
        `;

        try {
          await surrealDB.query(fallbackQuery, {
            from_activity: validated.parent_activity_id,
            to_activity: validated.child_activity_id,
            shape: shape,
            success: validated.success,
            org_id: jwtAuth.orgId,
            account_id: jwtAuth.accountId ?? null,
          });

          recordedEdges.push({
            from_activity: validated.parent_activity_id,
            to_activity: validated.child_activity_id,
            shape_produced: shape,
            success: validated.success,
          });
        } catch (fallbackError: any) {
          logger.error('Fallback edge recording also failed', {
            error: fallbackError.message,
          });
        }
      }
    }

    // Also record to activity_composition_graph for backward compatibility
    // (existing queries may use that table)
    // Phase B1: dual-write account_id + version=1 on both UPDATE/CREATE branches.
    try {
      const compatQuery = `
        LET $existing = (
          SELECT * FROM activity_composition_graph
          WHERE parent_activity_id = $parent AND child_activity_id = $child
          LIMIT 1
        );

        IF array::len($existing) > 0 THEN (
          UPDATE activity_composition_graph SET
            execution_count = execution_count + 1,
            success_count = IF($success, success_count + 1, success_count),
            weight = (IF($success, success_count + 1, success_count)) / (execution_count + 1),
            account_id = $account_id,
            account_id_version = 1,
            updated_at = time::now()
          WHERE parent_activity_id = $parent AND child_activity_id = $child
        ) ELSE (
          CREATE activity_composition_graph SET
            parent_activity_id = $parent,
            child_activity_id = $child,
            execution_count = 1,
            success_count = IF($success, 1, 0),
            weight = IF($success, 1.0, 0.0),
            account_id = $account_id,
            account_id_version = 1,
            created_at = time::now(),
            updated_at = time::now()
        ) END;
      `;

      await surrealDB.query(compatQuery, {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        success: validated.success,
        account_id: jwtAuth.accountId ?? null,
      });
    } catch (compatError: any) {
      // Non-critical - log and continue
      logger.debug('Compat write to activity_composition_graph failed', {
        error: compatError.message,
      });
    }

    // Generate edge_id from first recorded edge for backward compatibility
    const edgeId = recordedEdges.length > 0
      ? `${recordedEdges[0].from_activity}:${recordedEdges[0].to_activity}:${recordedEdges[0].shape_produced}`
      : undefined;

    return c.json({
      success: true,
      edge_id: edgeId,
      edges_recorded: recordedEdges.length,
      edges: recordedEdges,
    });

  } catch (error: any) {
    if (error.name === 'ZodError') {
      logger.warn('POST /v2/activities/composition/edges validation failed', {
        errors: error.errors,
      });
      return c.json({
        error: 'Validation failed',
        details: error.errors,
      }, 400);
    }

    logger.error('POST /v2/activities/composition/edges failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to record composition edge',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/edges/successors/:activityId
 * Query successor activities for a given activity based on composition edges.
 *
 * Returns activities that typically follow the given activity, ranked by Thompson Sampling.
 */
app.get('/composition/edges/successors/:activityId', async (c) => {
  try {
    // Check JWT authentication
    const jwtAuth = getJwtAuthFromContext(c);
    if (!jwtAuth?.orgId) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const activityId = c.req.param('activityId');
    const stateSignature = c.req.query('stateSignature');
    const minOccurrences = parseInt(c.req.query('minOccurrences') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '10', 10);

    logger.info('GET /v2/activities/composition/edges/successors', {
      activityId,
      stateSignature,
      minOccurrences,
      limit,
      orgId: jwtAuth.orgId,
    });

    // Query composition_edge for successors
    // Note: SurrealDB 2.x does not support HAVING clause, using subquery with WHERE instead
    // Phase B1: dual-scope by account_id (preferred) or org_id (legacy fallback);
    // public edges remain visible across tenants.
    let query = `
      SELECT * FROM (
        SELECT
          to_activity as child_activity_id,
          shape_produced,
          math::sum(success_count) as successful_occurrences,
          math::sum(total_count) as total_occurrences,
          (math::sum(success_count) / math::sum(total_count)) as success_rate,
          math::mean(alpha) as avg_alpha,
          math::mean(beta) as avg_beta
        FROM composition_edge
        WHERE from_activity = $activity_id
          AND (${accountIdScopedWhere()} OR public = true)
    `;

    const params: Record<string, any> = {
      activity_id: activityId,
      org_id: jwtAuth.orgId,
      account_id: jwtAuth.accountId ?? null,
    };

    // Add state signature filter if provided
    if (stateSignature) {
      // For now, state signature filtering would need additional schema support
      // This is a placeholder for future state-aware queries
      logger.debug('State signature filtering not yet implemented', { stateSignature });
    }

    query += `
        GROUP BY to_activity, shape_produced
      ) WHERE total_occurrences >= $min_occurrences
      ORDER BY success_rate DESC
      LIMIT $limit
    `;

    params.min_occurrences = minOccurrences;
    params.limit = limit;

    const results = await surrealDB.query<any[]>(query, params);
    const successors = results && Array.isArray(results) ? results.flat() : [];

    logger.info('Composition edge successors query result', {
      activityId,
      successors_count: successors.length,
    });

    return c.json({
      successors: successors,
      total: successors.length,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/composition/edges/successors failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query composition successors',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/validate-composition
 *
 * Validate a composition graph for cycles and impulse shape compatibility.
 * Used by the composition builder UI to provide real-time validation feedback.
 *
 * Request body:
 * - nodes: Array of { activity_id: string, output_shapes?: string[] }
 * - edges: Array of { from: string, to: string }
 *
 * Returns:
 * - valid: boolean
 * - errors: Array of validation errors
 *   - { type: 'cycle', path: string[] } for cycles
 *   - { type: 'shape_mismatch', from: string, to: string, details: string } for incompatible shapes
 */
app.post('/validate-composition', async (c) => {
  try {
    const body = await c.req.json();

    if (!body.nodes || !Array.isArray(body.nodes) || !body.edges || !Array.isArray(body.edges)) {
      return c.json({
        error: 'Invalid request body',
        required: { nodes: 'array', edges: 'array' },
      }, 400);
    }

    const { nodes, edges } = body;
    const errors: Array<{ type: string; [key: string]: any }> = [];

    // Build adjacency list for cycle detection
    const adjacencyList = new Map<string, string[]>();
    for (const node of nodes) {
      if (!adjacencyList.has(node.activity_id)) {
        adjacencyList.set(node.activity_id, []);
      }
    }
    for (const edge of edges) {
      const neighbors = adjacencyList.get(edge.from) || [];
      neighbors.push(edge.to);
      adjacencyList.set(edge.from, neighbors);
    }

    // Cycle detection using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycleDetected: string[][] = [];

    function detectCycle(nodeId: string, path: string[]): boolean {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (detectCycle(neighbor, [...path])) {
            return true;
          }
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart >= 0) {
            cycleDetected.push([...path.slice(cycleStart), neighbor]);
          }
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    }

    for (const node of nodes) {
      if (!visited.has(node.activity_id)) {
        detectCycle(node.activity_id, []);
      }
    }

    if (cycleDetected.length > 0) {
      for (const cycle of cycleDetected) {
        errors.push({
          type: 'cycle',
          path: cycle,
          message: `Cycle detected: ${cycle.join(' → ')}`,
        });
      }
    }

    // Shape compatibility validation
    // Fetch activity templates to get input/output shapes
    const activityIds = nodes.map((n: any) => n.activity_id);
    if (activityIds.length > 0) {
      try {
        const templatesQuery = `
          SELECT id, input_shapes, output_shapes FROM activity
          WHERE id IN $activity_ids
        `;
        const templatesResult = await surrealDB.query<Array<{
          id: string;
          input_shapes?: string[];
          output_shapes?: string[];
        }>>(templatesQuery, { activity_ids: activityIds });

        // surrealDB.query returns an array of result sets, take the first one
        const templates = templatesResult[0] || [];

        const shapeMap = new Map<string, { input: string[]; output: string[] }>();
        for (const template of templates) {
          shapeMap.set(template.id, {
            input: template.input_shapes || [],
            output: template.output_shapes || [],
          });
        }

        // Check each edge for shape compatibility
        for (const edge of edges) {
          const fromShapes = shapeMap.get(edge.from);
          const toShapes = shapeMap.get(edge.to);

          if (!fromShapes || !toShapes) {
            continue; // Skip if template not found
          }

          // Check if any output shape from 'from' activity matches input shapes of 'to' activity
          if (toShapes.input.length > 0 && fromShapes.output.length > 0) {
            const hasCompatibleShape = fromShapes.output.some((outputShape: string) =>
              toShapes.input.includes(outputShape)
            );

            if (!hasCompatibleShape) {
              errors.push({
                type: 'shape_mismatch',
                from: edge.from,
                to: edge.to,
                fromOutputShapes: fromShapes.output,
                toInputShapes: toShapes.input,
                message: `No compatible shapes between ${edge.from} (outputs: ${fromShapes.output.join(', ')}) and ${edge.to} (inputs: ${toShapes.input.join(', ')})`,
              });
            }
          }
        }
      } catch (dbError) {
        logger.error('Failed to fetch activity templates for shape validation', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
        errors.push({
          type: 'validation_error',
          message: 'Failed to validate shapes - database error',
        });
      }
    }

    const valid = errors.length === 0;

    logger.info('POST /v2/activities/validate-composition', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      valid,
      errorCount: errors.length,
    });

    return c.json({
      valid,
      errors,
      summary: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        cyclesDetected: cycleDetected.length,
        shapeMismatches: errors.filter(e => e.type === 'shape_mismatch').length,
      },
    });

  } catch (error) {
    logger.error('POST /v2/activities/validate-composition failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to validate composition',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/activities/similar-state
 * Query executions with similar available shapes (Task #29)
 *
 * Finds past executions that had similar impulse state (available shapes)
 * to the current state. Uses Jaccard similarity on shape sets.
 *
 * Request body:
 * - state_signature: State signature hash
 * - available_shapes: Array of shapes currently available
 * - min_similarity: Minimum similarity threshold (0.0-1.0, default: 0.5)
 * - limit: Maximum results (default: 10)
 *
 * Returns executions sorted by similarity score descending.
 */
app.post('/similar-state', async (c) => {
  try {
    const body = await c.req.json();
    const {
      state_signature,
      available_shapes,
      min_similarity = 0.5,
      limit = 10,
    } = body;

    logger.info('POST /v2/activities/similar-state', {
      state_signature,
      shapes_count: available_shapes?.length || 0,
      min_similarity,
      limit,
    });

    if (!available_shapes || !Array.isArray(available_shapes)) {
      return c.json({
        error: 'available_shapes is required and must be an array',
      }, 400);
    }

    // Fast path: Check for exact state_signature match using indexed field
    // This enables instant retrieval of executions with identical state
    if (state_signature) {
      logger.debug('Attempting fast path: exact state_signature match', { state_signature });

      const exactQuery = `
        SELECT
          id,
          activity_id,
          success,
          duration_ms,
          cost_usd,
          input_impulses,
          output_impulses
        FROM execution
        WHERE state_signature = $state_signature
        ORDER BY created_at DESC
        LIMIT $limit
      `;

      const exactResults = await surrealDB.query<any[]>(exactQuery, {
        state_signature,
        limit,
      });

      const exactMatches = exactResults && Array.isArray(exactResults) ? exactResults.flat() : [];

      if (exactMatches.length > 0) {
        logger.info('Fast path hit: exact state_signature matches found', {
          count: exactMatches.length,
          state_signature,
        });

        // Return exact matches with similarity score of 1.0
        const formatted = exactMatches.map((exec: any) => ({
          execution_id: exec.id,
          activity_id: exec.activity_id,
          similarity: 1.0,
          success: exec.success || false,
          duration_ms: exec.duration_ms || 0,
          cost_usd: exec.cost_usd || 0,
          input_shapes: exec.input_impulses || [],
          output_shapes: exec.output_impulses || [],
        }));

        return c.json({
          executions: formatted,
          total: formatted.length,
          fast_path: true,
        });
      }

      logger.debug('Fast path miss: no exact state_signature matches, falling back to similarity', {
        state_signature,
      });
    }

    // Fallback path: Jaccard similarity on shapes
    // Query executions that have input shapes overlapping with available shapes
    // Use CONTAINSANY to find executions with at least one matching shape
    const similarityQuery = `
      SELECT
        id,
        activity_id,
        success,
        duration_ms,
        cost_usd,
        input_impulses,
        output_impulses
      FROM execution
      WHERE input_impulses CONTAINSANY $available_shapes
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const results = await surrealDB.query<any[]>(similarityQuery, {
      available_shapes,
    });

    const executions = results && Array.isArray(results) ? results.flat() : [];

    // Calculate Jaccard similarity for each execution
    const availableSet = new Set(available_shapes);
    const withSimilarity = executions.map((exec: any) => {
      const execShapes = exec.input_impulses || [];
      const execSet = new Set(execShapes);

      // Calculate intersection
      const intersection = new Set(
        [...execSet].filter(shape => availableSet.has(shape))
      );

      // Calculate union
      const union = new Set([...execSet, ...availableSet]);

      // Jaccard similarity
      const similarity = union.size > 0 ? intersection.size / union.size : 0;

      return {
        execution_id: exec.id,
        activity_id: exec.activity_id,
        similarity,
        success: exec.success || false,
        duration_ms: exec.duration_ms || 0,
        cost_usd: exec.cost_usd || 0,
        input_shapes: execShapes,
        output_shapes: exec.output_impulses || [],
      };
    });

    // Filter by minimum similarity and sort by similarity descending
    const filtered = withSimilarity
      .filter(exec => exec.similarity >= min_similarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    logger.info('Similarity fallback query result', {
      total_executions: executions.length,
      filtered_count: filtered.length,
      top_similarity: filtered[0]?.similarity,
    });

    return c.json({
      executions: filtered,
      total: filtered.length,
      fast_path: false,
    });
  } catch (error: any) {
    logger.error('POST /v2/activities/similar-state failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query similar executions',
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
    // Legacy-field coercion: legacy callers (e.g. minibob mcp.ts) send
    // `activity_id`, but the schema requires `activity_variant_id`. Map the
    // legacy field to the canonical one when the canonical one is absent.
    // Explicit `activity_variant_id` always wins. Remove once all callers are
    // updated.
    if (body && body.activity_id && !body.activity_variant_id) {
      logger.warn(
        "[impulse-relevance] caller using deprecated 'activity_id' field; use 'activity_variant_id'. Coercion applied.",
        { activity_id: body.activity_id },
      );
      body.activity_variant_id = body.activity_id;
    }
    const validated = ImpulseRelevanceRecordRequestSchema.parse(body);

    // Phase E: pull tenant context from JWT auth so the (impulse, variant,
    // task) aggregation key becomes (impulse, variant, task, account|org).
    // Pre-Phase-E rows have no org/account scoping at all — they aggregated
    // across the whole platform. From this point on, two callers in different
    // accounts maintain separate Bayesian posteriors for the same
    // (impulse, variant, task) triple.
    const relevanceJwtAuth = getJwtAuthFromContext(c);
    const sessionForRelevance = (c.get as any)('session') as SessionData | undefined;
    const relevanceOrgId =
      relevanceJwtAuth?.orgId ?? sessionForRelevance?.org_id ?? null;
    const relevanceAccountId: string | null =
      relevanceJwtAuth?.accountId ?? null;

    logger.info('POST /v2/activities/impulse-relevance', {
      impulse_id: validated.impulse_id,
      activity: validated.activity_variant_id,
      was_loaded: validated.was_loaded,
      success: validated.execution_succeeded,
      org_id: relevanceOrgId,
      account_id: relevanceAccountId,
    });

    // Check if metric exists for this (impulse, variant, task, tenant) tuple.
    // Phase E: tenant is part of the de-facto unique key. accountIdScopedWhere
    // returns rows that match account_id when present, falling back to
    // org_id when account_id IS NONE — so legacy rows still increment.
    const checkQuery = `
      SELECT * FROM impulse_relevance_metrics
      WHERE impulse_id = $impulse_id
        AND activity_variant_id = $activity_variant_id
        AND (task_id = $task_id OR (task_id IS NULL AND $task_id IS NULL))
        AND ${accountIdScopedWhere()}
      LIMIT 1
    `;

    const existing = await surrealDB.query<ImpulseRelevanceMetric[]>(checkQuery, {
      impulse_id: validated.impulse_id,
      activity_variant_id: validated.activity_variant_id,
      task_id: validated.task_id ?? undefined,
      org_id: relevanceOrgId,
      account_id: relevanceAccountId,
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
      const netValueScore = Math.max(-1, Math.min(1, relevanceScore - irrelevanceScore * 0.5));

      // Update average content size
      // @ts-ignore - SurrealDB typing
      const totalSizeSamples = current.times_loaded || 0;
      // @ts-ignore - SurrealDB typing
      const currentAvgSize = current.avg_content_size_tokens || 0;
      const newAvgSize = validated.content_size_tokens !== undefined
        ? Math.floor((currentAvgSize * totalSizeSamples + validated.content_size_tokens) / (totalSizeSamples + 1))
        : currentAvgSize;

      // Update resolver tracking metrics (resolver-tier-tracking)
      // @ts-ignore - SurrealDB typing
      const currentResolverSuccessCount = current.resolver_success_count || 0;
      // @ts-ignore - SurrealDB typing
      const currentResolverFailureCount = current.resolver_failure_count || 0;
      // @ts-ignore - SurrealDB typing
      const currentAvgLatency = current.avg_resolution_latency_ms || 0;
      const totalResolutions = currentResolverSuccessCount + currentResolverFailureCount;

      const newResolverSuccessCount = validated.was_loaded && validated.execution_succeeded
        ? currentResolverSuccessCount + 1
        : currentResolverSuccessCount;
      const newResolverFailureCount = validated.was_loaded && !validated.execution_succeeded
        ? currentResolverFailureCount + 1
        : currentResolverFailureCount;

      // Update average latency if resolution latency provided
      const newAvgLatency = validated.resolution_latency_ms !== undefined && totalResolutions > 0
        ? Math.floor((currentAvgLatency * totalResolutions + validated.resolution_latency_ms) / (totalResolutions + 1))
        : currentAvgLatency;

      // Phase E: dual-tenant WHERE so the UPDATE only touches the row
      // belonging to this account (or the legacy row when accountId is null).
      // Without this, two accounts in the same org would race over the same
      // row's scores.
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
          net_value_score = $net_value_score,
          avg_content_size_tokens = $avg_content_size_tokens,
          typical_pointer_type = $typical_pointer_type,
          resolver_tier = $resolver_tier,
          resolver_name = $resolver_name,
          avg_resolution_latency_ms = $avg_resolution_latency_ms,
          resolver_success_count = $resolver_success_count,
          resolver_failure_count = $resolver_failure_count,
          updated_at = time::now()
        WHERE impulse_id = $impulse_id
          AND activity_variant_id = $activity_variant_id
          AND (task_id = $task_id OR (task_id IS NULL AND $task_id IS NULL))
          AND ${accountIdScopedWhere()}
        RETURN AFTER
      `;

      const updated = await surrealDB.query<ImpulseRelevanceMetric[]>(updateQuery, {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        org_id: relevanceOrgId,
        account_id: relevanceAccountId,
        times_loaded: newTimesLoaded,
        times_execution_succeeded: newTimesExecutionSucceeded,
        times_execution_failed: newTimesExecutionFailed,
        times_not_loaded_succeeded: newTimesNotLoadedSucceeded,
        times_not_loaded_failed: newTimesNotLoadedFailed,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        net_value_score: netValueScore,
        avg_content_size_tokens: newAvgSize,
        // @ts-ignore - SurrealDB typing
        typical_pointer_type: validated.pointer_type ?? current.typical_pointer_type,
        // Resolver tracking fields (use most recent values)
        // @ts-ignore - SurrealDB typing
        resolver_tier: validated.resolver_tier ?? current.resolver_tier,
        // @ts-ignore - SurrealDB typing
        resolver_name: validated.resolver_name ?? current.resolver_name,
        avg_resolution_latency_ms: newAvgLatency,
        resolver_success_count: newResolverSuccessCount,
        resolver_failure_count: newResolverFailureCount,
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
      // Create new metric.
      // Phase E: dual-write account_id + org_id + version=1 marker so future
      // reads via accountIdScopedWhere() find this row, and a Phase F
      // backfill pass can identify rows already tagged.
      const createQuery = `
        CREATE impulse_relevance_metrics CONTENT {
          impulse_id: $impulse_id,
          activity_variant_id: $activity_variant_id,
          task_id: $task_id,
          org_id: $org_id,
          account_id: $account_id,
          account_id_version: 1,
          times_loaded: $times_loaded,
          times_execution_succeeded: $times_execution_succeeded,
          times_execution_failed: $times_execution_failed,
          times_not_loaded_succeeded: $times_not_loaded_succeeded,
          times_not_loaded_failed: $times_not_loaded_failed,
          relevance_score: $relevance_score,
          irrelevance_score: $irrelevance_score,
          net_value_score: $net_value_score,
          avg_content_size_tokens: $avg_content_size_tokens,
          typical_pointer_type: $typical_pointer_type,
          resolver_tier: $resolver_tier,
          resolver_name: $resolver_name,
          avg_resolution_latency_ms: $avg_resolution_latency_ms,
          resolver_success_count: $resolver_success_count,
          resolver_failure_count: $resolver_failure_count,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const relevanceScore = validated.was_loaded && validated.execution_succeeded ? 1.0 : 0.0;
      const irrelevanceScore = !validated.was_loaded && validated.execution_succeeded ? 1.0 : 0.0;
      const netValueScore = Math.max(-1, Math.min(1, relevanceScore - irrelevanceScore * 0.5));

      const created = await surrealDB.query<ImpulseRelevanceMetric[]>(createQuery, {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        org_id: relevanceOrgId,
        account_id: relevanceAccountId,
        times_loaded: validated.was_loaded ? 1 : 0,
        times_execution_succeeded: validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_execution_failed: validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        times_not_loaded_succeeded: !validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_not_loaded_failed: !validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        net_value_score: netValueScore,
        avg_content_size_tokens: validated.content_size_tokens || 0,
        // Resolver tracking fields (resolver-tier-tracking)
        resolver_tier: validated.resolver_tier ?? undefined,
        resolver_name: validated.resolver_name ?? undefined,
        avg_resolution_latency_ms: validated.resolution_latency_ms || 0,
        resolver_success_count: validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        resolver_failure_count: validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
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
        net_value_score: netValueScore,
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

    // Phase E: scope reads by tenant. Pre-Phase-E rows had no scoping at all
    // (account_id IS NONE AND org_id IS NONE), so the dual-tenant WHERE will
    // miss them — but those rows are platform-wide aggregates that are
    // semantically wrong to return to a specific tenant anyway. Going forward
    // every new row carries org_id + account_id.
    const relevanceJwtAuth = getJwtAuthFromContext(c);
    const sessionForRelevance = (c.get as any)('session') as SessionData | undefined;
    const relevanceOrgId =
      relevanceJwtAuth?.orgId ?? sessionForRelevance?.org_id ?? null;
    const relevanceAccountId: string | null =
      relevanceJwtAuth?.accountId ?? null;

    logger.info('GET /v2/activities/impulse-relevance', {
      ...validated,
      org_id: relevanceOrgId,
      account_id: relevanceAccountId,
    });

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

    // Phase E: tenant scoping. Always present so unauthenticated callers
    // get an empty result set (their org_id is null, account_id is null,
    // and the dual-tenant WHERE matches no rows by design).
    if (relevanceOrgId !== null || relevanceAccountId !== null) {
      whereClauses.push(accountIdScopedWhere());
      params.org_id = relevanceOrgId;
      params.account_id = relevanceAccountId;
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

    // Phase B-followup: pull tenant context from JWT/session. tool_usage_patterns
    // historically had NO org_id field; migration 097 added option<string>
    // org_id + account_id so this route can dual-write going forward.
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Validate request body
    const validated = ToolUsageRecordRequestSchema.parse(body);
    logger.info('Recording tool usage', {
      tool: validated.tool_name,
      activity: validated.activity_variant_id,
      execution: validated.execution_id,
      orgId,
      accountId,
    });

    // Check if pattern exists.
    // Phase B-followup: dual-tenant scoping; legacy rows (no org_id) match
    // when both bound params are NONE/null via accountIdScopedWhere().
    const checkQuery = `
      SELECT * FROM tool_usage_patterns
      WHERE activity_variant_id = $activity_variant_id
        AND tool_name = $tool_name
        ${validated.task_id ? 'AND task_id = $task_id' : 'AND task_id IS NONE'}
        AND ${accountIdScopedWhere()}
      LIMIT 1
    `;

    const existing = await surrealDB.query<ToolUsagePattern[]>(checkQuery, {
      activity_variant_id: validated.activity_variant_id,
      tool_name: validated.tool_name,
      task_id: validated.task_id ?? undefined,
      org_id: orgId,
      account_id: accountId,
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
      
      // Phase B-followup: dual-tenant WHERE; sticky-write account_id + org_id
      // so legacy rows (NONE/NONE) get backfilled on first touch.
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
          org_id = $org_id,
          account_id = $account_id,
          account_id_version = $account_id_version,
          updated_at = time::now()
        WHERE activity_variant_id = $activity_variant_id
          AND tool_name = $tool_name
          ${validated.task_id ? 'AND task_id = $task_id' : 'AND task_id IS NONE'}
          AND ${accountIdScopedWhere()}
        RETURN AFTER
      `;

      const updated = await surrealDB.query<ToolUsagePattern[]>(updateQuery, {
        activity_variant_id: validated.activity_variant_id,
        tool_name: validated.tool_name,
        task_id: validated.task_id ?? undefined,
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
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
      
      // Phase B-followup: dual-write account_id + version (and org_id, the
      // first multi-tenant key for this table) on CREATE.
      // tool_usage_patterns.account_id is option<string> per the deployed
      // schema; SurrealDB 3.x rejects JSON `null` against `TYPE none | string`.
      // Use IF..THEN..ELSE..END to coerce null → NONE on the SQL side so we
      // don't have to branch the CREATE template here.
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
          org_id: $org_id,
          account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
          account_id_version: $account_id_version,
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
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
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

    // Phase B-followup: pull tenant context so we can dual-bind the
    // tool_usage_patterns read alongside org_id (added by migration 097).
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

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

    // Phase B-followup: always dual-bind tenant context.
    const whereClauses: string[] = [accountIdScopedWhere()];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
      org_id: orgId,
      account_id: accountId,
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

// =============================================================================
// Tool Argument Pattern Endpoints
// =============================================================================

/**
 * POST /tool-argument-patterns
 *
 * Records tool argument patterns observed during activity execution.
 * Implements upsert logic: if a pattern with the same argument_hash exists,
 * increments times_used and conditionally times_succeeded, updates rolling
 * average for execution_ms.
 *
 * Learning metrics:
 * - times_used: Total times this exact argument pattern was used
 * - times_succeeded: How many of those executions succeeded
 * - avg_execution_ms: Rolling average execution time
 * - success_rate: Computed as times_succeeded / times_used
 *
 * Use cases:
 * - Pattern deduplication: Identify repeated argument patterns
 * - Learning: Which argument patterns lead to success
 * - Recommendations: Suggest proven arguments for new executions
 */
app.post('/tool-argument-patterns', async (c) => {
  try {
    const body = await c.req.json();

    // Phase B-followup: pull tenant context from JWT/session so we can
    // dual-bind account_id alongside the existing org_id-derived scope.
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Validate request body
    const validated = ToolArgumentPatternRecordRequestSchema.parse(body);
    logger.info('Recording tool argument pattern', {
      activity: validated.activity_id,
      tool: validated.tool_name,
      shape: validated.argument_shape,
      hash: validated.argument_hash.substring(0, 16) + '...',
      succeeded: validated.execution_succeeded,
      failureType: validated.failure_type,
      orgId,
      accountId,
    });

    // Check if pattern exists.
    // Phase B-followup: dual-tenant scoping; legacy rows match via the
    // org_id branch of accountIdScopedWhere().
    const checkQuery = `
      SELECT * FROM tool_argument_pattern
      WHERE argument_hash = $hash AND ${accountIdScopedWhere()}
      LIMIT 1
    `;

    const existing = await surrealDB.query<any[]>(checkQuery, {
      hash: validated.argument_hash,
      org_id: orgId,
      account_id: accountId,
    });

    let pattern: any;

    if (existing && existing.length > 0 && existing[0]) {
      // Update existing pattern with rolling average for execution_ms
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing issue
      const currentTimesUsed = current.times_used || 0;
      const successIncrement = validated.execution_succeeded ? 1 : 0;
      const failureIncrement = validated.execution_succeeded ? 0 : 1;

      // Update failure counts breakdown if failure type is provided
      // @ts-ignore - SurrealDB query typing issue
      const currentFailureCounts = current.failure_counts || {};
      if (!validated.execution_succeeded && validated.failure_type) {
        currentFailureCounts[validated.failure_type] = (currentFailureCounts[validated.failure_type] || 0) + 1;
      }

      // Phase B-followup: dual-tenant WHERE; account_id stays sticky on the
      // row but is also explicitly written to bring legacy rows forward.
      const updateQuery = `
        UPDATE tool_argument_pattern
        SET
          times_used = times_used + 1,
          times_succeeded = times_succeeded + $success_increment,
          times_failed = (times_failed OR 0) + $failure_increment,
          avg_execution_ms = (avg_execution_ms * $current_times_used + $execution_ms) / ($current_times_used + 1),
          last_used_at = time::now(),
          updated_at = time::now(),
          failure_type = $failure_type,
          failure_reason = $failure_reason,
          tool_succeeded = $tool_succeeded,
          validation_error = $validation_error,
          failure_counts = $failure_counts,
          account_id = $account_id,
          account_id_version = $account_id_version
        WHERE argument_hash = $hash AND ${accountIdScopedWhere()}
        RETURN AFTER
      `;

      const updateResult = await surrealDB.query<any[]>(updateQuery, {
        hash: validated.argument_hash,
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
        success_increment: successIncrement,
        failure_increment: failureIncrement,
        current_times_used: currentTimesUsed,
        execution_ms: validated.execution_ms,
        failure_type: validated.failure_type || undefined,
        failure_reason: validated.failure_reason || undefined,
        tool_succeeded: validated.tool_succeeded ?? undefined,
        validation_error: validated.validation_error || undefined,
        failure_counts: currentFailureCounts,
      });

      pattern = updateResult && updateResult.length > 0 ? updateResult[0] : current;

      logger.info('Updated existing tool argument pattern', {
        hash: validated.argument_hash.substring(0, 16) + '...',
        times_used: pattern.times_used,
        times_succeeded: pattern.times_succeeded,
        times_failed: pattern.times_failed,
        failureType: validated.failure_type,
      });
    } else {
      // Create new pattern with failure tracking fields
      const initialFailureCounts: Record<string, number> = {};
      if (!validated.execution_succeeded && validated.failure_type) {
        initialFailureCounts[validated.failure_type] = 1;
      }

      // Phase B-followup: dual-write account_id + version on CREATE; org_id
      // is also written explicitly so the row is no longer dependent on
      // SurrealDB-level $auth defaulting.
      const createQuery = `
        CREATE tool_argument_pattern SET
          activity_id = $activity_id,
          tool_name = $tool_name,
          argument_shape = $argument_shape,
          argument_hash = $argument_hash,
          arguments = $arguments,
          times_used = 1,
          times_succeeded = $success_increment,
          times_failed = $failure_increment,
          avg_execution_ms = $execution_ms,
          last_used_at = time::now(),
          failure_type = $failure_type,
          failure_reason = $failure_reason,
          tool_succeeded = $tool_succeeded,
          validation_error = $validation_error,
          failure_counts = $failure_counts,
          org_id = $org_id,
          account_id = $account_id,
          account_id_version = $account_id_version
      `;

      const createResult = await surrealDB.query<any[]>(createQuery, {
        activity_id: validated.activity_id,
        tool_name: validated.tool_name,
        argument_shape: validated.argument_shape,
        argument_hash: validated.argument_hash,
        arguments: validated.arguments,
        success_increment: validated.execution_succeeded ? 1 : 0,
        failure_increment: validated.execution_succeeded ? 0 : 1,
        execution_ms: validated.execution_ms,
        failure_type: validated.failure_type || undefined,
        failure_reason: validated.failure_reason || undefined,
        tool_succeeded: validated.tool_succeeded ?? undefined,
        validation_error: validated.validation_error || undefined,
        failure_counts: initialFailureCounts,
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
      });

      pattern = createResult && createResult.length > 0 ? createResult[0] : {
        activity_id: validated.activity_id,
        tool_name: validated.tool_name,
        argument_shape: validated.argument_shape,
        argument_hash: validated.argument_hash,
        times_used: 1,
        times_succeeded: validated.execution_succeeded ? 1 : 0,
        times_failed: validated.execution_succeeded ? 0 : 1,
        avg_execution_ms: validated.execution_ms,
        failure_type: validated.failure_type,
        failure_reason: validated.failure_reason,
        failure_counts: initialFailureCounts,
      };

      logger.info('Created new tool argument pattern', {
        hash: validated.argument_hash.substring(0, 16) + '...',
        tool: validated.tool_name,
        shape: validated.argument_shape,
        failureType: validated.failure_type,
      });
    }

    return c.json({
      success: true,
      pattern,
    });

  } catch (error: any) {
    logger.error('Failed to record tool argument pattern', { error: error.message });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record tool argument pattern',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /tool-argument-recommendations
 *
 * Returns recommended argument patterns for a given activity from
 * the v_argument_recommendations view. This view filters for patterns
 * with sufficient usage (>=3) and high success rate (>=80%).
 *
 * Query params:
 *   activity_id: string (required) - The activity to get recommendations for
 *
 * Returns:
 * {
 *   patterns: [{
 *     argument_shape: string,
 *     argument_hash: string,
 *     arguments: object,
 *     success_rate: number,
 *     times_used: number,
 *     avg_execution_ms: number,
 *     tool_name: string
 *   }]
 * }
 *
 * Use cases:
 * - Pre-populate tool arguments with proven patterns
 * - Suggest successful argument combinations
 * - Reduce exploration when reliable patterns exist
 */
app.get('/tool-argument-recommendations', async (c) => {
  try {
    const query = c.req.query();

    // Validate query params
    const validated = ToolArgumentRecommendationsQuerySchema.parse({
      activity_id: query.activity_id,
    });

    logger.info('GET /v2/activities/tool-argument-recommendations', { activity_id: validated.activity_id });

    // Query the v_argument_recommendations view
    const patternsQuery = `
      SELECT * FROM v_argument_recommendations
      WHERE activity_id = $activity_id
        AND org_id = <string>$auth.org_id
      ORDER BY success_rate DESC, times_used DESC
      LIMIT 20
    `;

    const patternsResult = await surrealDB.query<ToolArgumentPattern[]>(patternsQuery, {
      activity_id: validated.activity_id,
    });

    const patterns = patternsResult && Array.isArray(patternsResult) ? patternsResult.flat() : [];

    const response: ToolArgumentRecommendationsResponse = {
      patterns,
    };

    logger.info('Tool argument recommendations query result', {
      activity_id: validated.activity_id,
      patterns_found: patterns.length,
    });

    return c.json(response);

  } catch (error: any) {
    logger.error('Failed to get tool argument recommendations', { error: error.message });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to get tool argument recommendations',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /failure-patterns
 *
 * Returns failure patterns for analysis and debugging.
 * Surfaces patterns that frequently fail to help identify:
 * - Problematic argument combinations
 * - Common validation failures
 * - Execution issues
 *
 * Query params:
 *   activity_id?: string - Filter by activity
 *   tool_name?: string - Filter by tool
 *   failure_type?: 'validation' | 'execution' | 'tool_failure' | 'timeout' - Filter by failure type
 *   min_failures?: number - Minimum failure count (default: 1)
 *   limit?: number - Max results (default: 100)
 *   offset?: number - Pagination offset (default: 0)
 *
 * Returns:
 * {
 *   patterns: [{
 *     activity_id: string,
 *     tool_name: string,
 *     argument_shape: string,
 *     argument_hash: string,
 *     arguments: object,
 *     success_rate: number,
 *     failure_rate: number,
 *     times_used: number,
 *     times_succeeded: number,
 *     times_failed: number,
 *     failure_type?: string,
 *     failure_reason?: string,
 *     validation_error?: string,
 *     failure_counts?: object
 *   }],
 *   total: number
 * }
 *
 * Use cases:
 * - Identify argument patterns that fail validation
 * - Debug execution failures
 * - Learn what to avoid in recommendations
 */
app.get('/failure-patterns', async (c) => {
  try {
    const query = c.req.query();

    // Phase B-followup: pull tenant context so we can dual-bind the
    // tool_argument_pattern read alongside org_id.
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    const activityId = query.activity_id;
    const toolName = query.tool_name;
    const failureType = query.failure_type as 'validation' | 'execution' | 'tool_failure' | 'timeout' | undefined;
    const minFailures = query.min_failures ? parseInt(query.min_failures) : 1;
    const limit = query.limit ? parseInt(query.limit) : 100;
    const offset = query.offset ? parseInt(query.offset) : 0;

    logger.info('GET /v2/activities/failure-patterns', {
      activity_id: activityId,
      tool_name: toolName,
      failure_type: failureType,
      min_failures: minFailures,
      limit,
      offset,
      orgId,
      accountId,
    });

    const whereClauses: string[] = ['times_failed >= $min_failures'];
    const params: Record<string, any> = {
      min_failures: minFailures,
      limit,
      offset,
      org_id: orgId,
      account_id: accountId,
    };

    if (activityId) {
      whereClauses.push(`activity_id = $activity_id`);
      params.activity_id = activityId;
    }

    if (toolName) {
      whereClauses.push(`tool_name = $tool_name`);
      params.tool_name = toolName;
    }

    if (failureType) {
      whereClauses.push(`failure_type = $failure_type`);
      params.failure_type = failureType;
    }

    // Query failure patterns from v_failure_patterns view or tool_argument_pattern table
    const patternsQuery = `
      SELECT
        activity_id,
        tool_name,
        argument_shape,
        argument_hash,
        arguments,
        (times_succeeded * 1.0 / times_used) as success_rate,
        (times_failed * 1.0 / times_used) as failure_rate,
        times_used,
        times_succeeded,
        times_failed,
        avg_execution_ms,
        failure_type,
        failure_reason,
        validation_error,
        failure_counts,
        org_id
      FROM tool_argument_pattern
      WHERE ${whereClauses.join(' AND ')}
        AND ${accountIdScopedWhere()}
      ORDER BY times_failed DESC, failure_rate DESC
      LIMIT $limit START $offset
    `;

    // Count query
    const countQuery = `
      SELECT count() as total FROM tool_argument_pattern
      WHERE ${whereClauses.join(' AND ')}
        AND ${accountIdScopedWhere()}
    `;

    const [patternsResult, countResult] = await Promise.all([
      surrealDB.query<any[]>(patternsQuery, params),
      surrealDB.query<any[]>(countQuery, params),
    ]);

    const patterns = patternsResult && Array.isArray(patternsResult) ? patternsResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : patterns.length;

    logger.info('Failure patterns query result', {
      patterns_found: patterns.length,
      total,
    });

    return c.json({
      patterns,
      total,
    });

  } catch (error: any) {
    logger.error('Failed to get failure patterns', { error: error.message });

    return c.json({
      error: 'Failed to get failure patterns',
      message: error.message,
    }, 500);
  }
});

// =============================================================================
// Emergent Shape Network Endpoints
// =============================================================================
// These endpoints expose the emergent shape statistics from v_shape_* views.
// Shapes are discovered through usage, not predefined - these views reveal
// the network topology that emerges from activity definitions and executions.
// =============================================================================

/**
 * Shape network edge representing a transformation from input to output shape
 */
interface ShapeNetworkEdge {
  input_shape: string;
  output_shape: string;
  edge_weight: number;
  activities: string[];
}

/**
 * Shape usage statistics by role (input or output)
 */
interface ShapeUsage {
  shape: string;
  role: 'input' | 'output';
  activity_count: number;
  activities: string[];
}

/**
 * Shape suggestion for autocomplete
 */
interface ShapeAutocomplete {
  shape: string;
  total_uses: number;
  roles: string[];
}

/**
 * GET /shapes/network
 *
 * Returns the emergent shape transformation graph showing how shapes
 * transform from inputs to outputs across activities.
 *
 * Query params:
 *   input_shape?: string - Filter to edges from this input shape
 *   output_shape?: string - Filter to edges producing this output shape
 *   min_weight?: number - Filter to edges with weight >= this value
 *   limit?: number - Maximum edges to return (default: 100)
 *   offset?: number - Pagination offset (default: 0)
 *
 * Returns:
 * {
 *   edges: ShapeNetworkEdge[],
 *   total: number
 * }
 */
app.get('/shapes/network', async (c) => {
  try {
    const inputShape = c.req.query('input_shape');
    const outputShape = c.req.query('output_shape');
    const minWeight = c.req.query('min_weight') ? parseInt(c.req.query('min_weight')!, 10) : undefined;
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    logger.info('GET /shapes/network', { inputShape, outputShape, minWeight, limit, offset });

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    if (inputShape) {
      whereClauses.push('input_shape = $input_shape');
      params.input_shape = inputShape;
    }

    if (outputShape) {
      whereClauses.push('output_shape = $output_shape');
      params.output_shape = outputShape;
    }

    if (minWeight !== undefined) {
      whereClauses.push('edge_weight >= $min_weight');
      params.min_weight = minWeight;
    }

    let edgesQuery = 'SELECT * FROM v_shape_network';
    if (whereClauses.length > 0) {
      edgesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    edgesQuery += ' ORDER BY edge_weight DESC LIMIT $limit START $offset';

    let countQuery = 'SELECT count() as total FROM v_shape_network';
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [edgesResult, countResult] = await Promise.all([
      surrealDB.query<ShapeNetworkEdge[]>(edgesQuery, params),
      surrealDB.query<{ total: number }[]>(countQuery, params),
    ]);

    const edges = edgesResult && Array.isArray(edgesResult) ? edgesResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = countResult && countResult.length > 0 && countResult[0] ? (countResult[0].total || 0) : 0;

    logger.info('Shape network query result', { edges: edges.length, total });

    return c.json({
      edges,
      total,
    });

  } catch (error: any) {
    logger.error('GET /shapes/network failed', { error: error.message, stack: error.stack });
    return c.json({
      error: 'Failed to query shape network',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /shapes/usage
 *
 * Returns shape frequency statistics showing how often each shape
 * appears as an input or output across activities.
 *
 * Query params:
 *   shape?: string - Filter to a specific shape
 *   role?: 'input' | 'output' - Filter to a specific role
 *   limit?: number - Maximum results to return (default: 100)
 *   offset?: number - Pagination offset (default: 0)
 *
 * Returns:
 * {
 *   usage: ShapeUsage[],
 *   total: number
 * }
 */
app.get('/shapes/usage', async (c) => {
  try {
    const shape = c.req.query('shape');
    const role = c.req.query('role');
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    logger.info('GET /shapes/usage', { shape, role, limit, offset });

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    if (shape) {
      whereClauses.push('shape = $shape');
      params.shape = shape;
    }

    if (role && (role === 'input' || role === 'output')) {
      whereClauses.push('role = $role');
      params.role = role;
    }

    let usageQuery = 'SELECT * FROM v_shape_usage';
    if (whereClauses.length > 0) {
      usageQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    usageQuery += ' ORDER BY activity_count DESC LIMIT $limit START $offset';

    let countQuery = 'SELECT count() as total FROM v_shape_usage';
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [usageResult, countResult] = await Promise.all([
      surrealDB.query<ShapeUsage[]>(usageQuery, params),
      surrealDB.query<{ total: number }[]>(countQuery, params),
    ]);

    const usage = usageResult && Array.isArray(usageResult) ? usageResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = countResult && countResult.length > 0 && countResult[0] ? (countResult[0].total || 0) : 0;

    logger.info('Shape usage query result', { usage: usage.length, total });

    return c.json({
      usage,
      total,
    });

  } catch (error: any) {
    logger.error('GET /shapes/usage failed', { error: error.message, stack: error.stack });
    return c.json({
      error: 'Failed to query shape usage',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /shape-scores
 *
 * Update impulse_shape_activity_score table with execution outcomes.
 * Used for shape-based Thompson Sampling activity selection.
 *
 * For each shape in the request:
 * - UPSERT into impulse_shape_activity_score
 * - Increment success_count or failure_count based on outcome
 * - Compute alpha = success_count + 1, beta = failure_count + 1
 *
 * Uses atomic UPSERT operations to prevent race conditions.
 *
 * Request body:
 * {
 *   activity_id: string,
 *   shapes: string[],
 *   success: boolean,
 *   org_id?: string  // Optional, inferred from auth context
 * }
 *
 * Returns:
 * {
 *   success: boolean,
 *   updated_count: number,
 *   message?: string
 * }
 */
app.post('/shape-scores', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B-followup: account_id only flows from JWT auth.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Parse and validate request body
    const body = await c.req.json();
    const validated = ShapeScoreUpdateRequestSchema.parse(body);

    // Use provided org_id or fall back to auth context
    const effectiveOrgId = validated.org_id || orgId;

    if (!effectiveOrgId) {
      return c.json({
        success: false,
        updated_count: 0,
        message: 'Organization ID required (provide org_id or authenticate)',
      }, 401);
    }

    logger.info('POST /v2/activities/shape-scores', {
      activity_id: validated.activity_id,
      shapes: validated.shapes,
      success: validated.success,
      org_id: effectiveOrgId,
      account_id: accountId,
    });

    // Update shape scores atomically using UPSERT
    // For each shape, either create a new record or update existing counts
    let updatedCount = 0;

    for (const shape of validated.shapes) {
      try {
        // Determine which counter to increment
        const successIncrement = validated.success ? 1 : 0;
        const failureIncrement = validated.success ? 0 : 1;

        // UPSERT: Create if not exists, otherwise update atomically
        // SurrealDB UPSERT with ON DUPLICATE KEY semantics using MERGE
        //
        // Phase B-followup: dual-write account_id + version on the MERGE.
        // Record id stays keyed on (org_id, shape, activity_id) so legacy
        // and dual-tenant rows continue to map to the same composite slot.
        const upsertQuery = `
          UPSERT impulse_shape_activity_score:[$org_id, $shape, $activity_id]
          MERGE {
            shape: $shape,
            activity_id: $activity_id,
            org_id: $org_id,
            account_id: $account_id,
            account_id_version: $account_id_version,
            success_count: (
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $success_increment,
            failure_count: (
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $failure_increment,
            alpha: (
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $success_increment + 1,
            beta: (
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $failure_increment + 1,
            updated_at: time::now()
          };
        `;

        await surrealDB.query(upsertQuery, {
          shape,
          activity_id: validated.activity_id,
          org_id: effectiveOrgId,
          account_id: accountId,
          account_id_version: 1,
          success_increment: successIncrement,
          failure_increment: failureIncrement,
        });

        updatedCount++;

        logger.debug('Shape score updated', {
          shape,
          activity_id: validated.activity_id,
          org_id: effectiveOrgId,
          success: validated.success,
        });
      } catch (shapeError: any) {
        // Log error but continue with other shapes
        logger.warn('Failed to update shape score', {
          shape,
          activity_id: validated.activity_id,
          error: shapeError.message,
        });
      }
    }

    logger.info('Shape scores updated', {
      activity_id: validated.activity_id,
      requested_shapes: validated.shapes.length,
      updated_count: updatedCount,
      success: validated.success,
    });

    const response: ShapeScoreUpdateResponse = {
      success: updatedCount > 0,
      updated_count: updatedCount,
      message: `Updated ${updatedCount} of ${validated.shapes.length} shape scores`,
    };

    return c.json(response, updatedCount > 0 ? 200 : 500);

  } catch (error: any) {
    logger.error('POST /v2/activities/shape-scores failed', {
      error: error.message,
      stack: error.stack,
    });

    // Check if it's a validation error
    if (error.name === 'ZodError') {
      return c.json({
        success: false,
        updated_count: 0,
        message: `Validation failed: ${error.message}`,
      }, 400);
    }

    return c.json({
      success: false,
      updated_count: 0,
      message: error.message,
    }, 500);
  }
});

/**
 * updateShapeScoresFromExecution - Helper function to update shape scores
 *
 * Called from the execution recording flow to update shape-based Thompson
 * Sampling scores based on execution outcomes.
 *
 * @param activityId - Activity that was executed
 * @param shapes - Input impulse shapes observed during execution
 * @param success - Whether the execution succeeded
 * @param orgId - Organization ID
 */
async function updateShapeScoresFromExecution(
  activityId: string,
  shapes: string[],
  success: boolean,
  orgId: string,
  jwtToken?: string | null,
  accountId: string | null = null
): Promise<void> {
  if (!shapes || shapes.length === 0) {
    return; // No shapes to update
  }

  try {
    const successIncrement = success ? 1 : 0;
    const failureIncrement = success ? 0 : 1;

    for (const shape of shapes) {
      try {
        // Phase B-followup: dual-write account_id + version on the MERGE.
        const upsertQuery = `
          UPSERT impulse_shape_activity_score:[$org_id, $shape, $activity_id]
          MERGE {
            shape: $shape,
            activity_id: $activity_id,
            org_id: $org_id,
            account_id: $account_id,
            account_id_version: $account_id_version,
            success_count: (
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $success_increment,
            failure_count: (
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $failure_increment,
            alpha: (
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $success_increment + 1,
            beta: (
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $failure_increment + 1,
            updated_at: time::now()
          };
        `;

        const params = {
          shape,
          activity_id: activityId,
          org_id: orgId,
          account_id: accountId,
          account_id_version: 1,
          success_increment: successIncrement,
          failure_increment: failureIncrement,
        };

        // Use authenticated connection if JWT token provided, otherwise use root connection
        if (jwtToken) {
          await queryWithAuth(jwtToken, upsertQuery, params);
        } else {
          await surrealDB.query(upsertQuery, params);
        }
      } catch (shapeError: any) {
        logger.warn('Failed to update shape score in execution flow', {
          shape,
          activity_id: activityId,
          error: shapeError.message,
        });
      }
    }

    logger.debug('Shape scores updated from execution', {
      activity_id: activityId,
      shapes_count: shapes.length,
      success,
    });
  } catch (error: any) {
    // Non-blocking: don't fail the execution recording if shape score update fails
    logger.warn('Shape score update from execution failed (non-blocking)', {
      activity_id: activityId,
      error: error.message,
    });
  }
}

/**
 * GET /shapes/autocomplete
 *
 * Returns shape suggestions for UI autocomplete, sorted by frequency.
 * Shapes emerge from observed usage - this is not a predefined list.
 *
 * Query params:
 *   prefix?: string - Filter shapes starting with this prefix
 *   limit?: number - Maximum suggestions to return (default: 50)
 *
 * Returns:
 * {
 *   suggestions: ShapeAutocomplete[],
 *   total: number
 * }
 */
app.get('/shapes/autocomplete', async (c) => {
  try {
    const prefix = c.req.query('prefix') || '';
    const limit = parseInt(c.req.query('limit') || '50', 10);

    logger.info('GET /shapes/autocomplete', { prefix, limit });

    // Query the autocomplete view
    // Note: SurrealDB views don't support LIKE, so we filter in code for prefix matching
    const query = `
      SELECT * FROM v_shapes_for_autocomplete
      ORDER BY total_uses DESC
      LIMIT 1000
    `;

    const result = await surrealDB.query<ShapeAutocomplete[]>(query);
    const allShapes = result && Array.isArray(result) ? result.flat() : [];

    // Filter by prefix if provided
    const filtered = prefix
      ? allShapes.filter(s => s.shape && s.shape.toLowerCase().startsWith(prefix.toLowerCase()))
      : allShapes;

    // Apply limit
    const suggestions = filtered.slice(0, limit);

    logger.info('Shape autocomplete query result', {
      prefix: prefix || null,
      suggestions: suggestions.length,
      total: filtered.length,
    });

    return c.json({
      suggestions,
      total: filtered.length,
    });

  } catch (error: any) {
    logger.error('GET /shapes/autocomplete failed', { error: error.message, stack: error.stack });
    return c.json({
      error: 'Failed to get shape suggestions',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /scores
 * Get Thompson Sampling scores for all templates
 * Returns alpha, beta, confidence intervals, and selection probabilities
 */
app.get('/scores', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = session?.org_id || null;
    const limitStr = c.req.query('limit') || '50';
    const limit = Math.min(Math.max(parseInt(limitStr, 10), 1), 100);

    logger.info('GET /v2/activities/scores', { limit, orgId });

    // Query activity_metrics table for Thompson Sampling scores
    let query = `
      SELECT
        activity_id,
        thompson_alpha AS alpha,
        thompson_beta AS beta,
        total_executions,
        successful_executions,
        failed_executions,
        success_rate,
        avg_duration_ms,
        avg_cost_usd,
        total_selections,
        last_executed_at,
        updated_at
      FROM activity_metrics
      WHERE 1=1
    `;
    const params: Record<string, any> = {};

    // Multi-tenant filtering
    if (orgId) {
      query += ' AND (org_id = $org_id OR org_id = NONE)';
      params.org_id = orgId;
    }

    // Order by total executions (show most used templates first)
    query += ' ORDER BY total_executions DESC';
    query += ' LIMIT $limit';
    params.limit = limit;

    const result = await surrealDB.query(query, params);
    const scores = Array.isArray(result) ? result : [];

    // Enrich with confidence intervals and selection probability
    const enrichedScores = scores.map((score: any) => {
      const alpha = score.alpha || 1;
      const beta = score.beta || 1;
      const mean = alpha / (alpha + beta);

      // 95% confidence interval (approximate)
      const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
      const stdDev = Math.sqrt(variance);
      const confidenceInterval = {
        lower: Math.max(0, mean - 1.96 * stdDev),
        upper: Math.min(1, mean + 1.96 * stdDev),
      };

      // Confidence level (higher is better)
      const confidence = alpha + beta; // Total observations

      return {
        ...score,
        mean_score: mean,
        confidence_interval: confidenceInterval,
        confidence_level: confidence,
        exploring: confidence < 10, // Low confidence = still exploring
      };
    });

    logger.info('Thompson Sampling scores retrieved', { count: enrichedScores.length });

    return c.json({
      scores: enrichedScores,
      total: enrichedScores.length,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/scores failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch Thompson Sampling scores',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /relevance-feedback
 *
 * Explicit relevance signal for a template recommendation.
 * was_selected=true increments alpha; false increments beta in both
 * variant_performance_metrics and (if context_bucket provided) context_thompson_scores.
 * Returns 204 No Content immediately — all DB writes are fire-and-forget.
 */
app.post('/relevance-feedback', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B1: account_id flows from JWT auth.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({ error: 'Unauthorized', message: 'Missing organization context' }, 401);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { template_id, was_selected, context_bucket, reason, correlation_id } = body;

    if (!template_id || typeof template_id !== 'string' || typeof was_selected !== 'boolean') {
      return c.json({ error: 'template_id (string) and was_selected (boolean) are required' }, 400);
    }

    const alpha_delta = was_selected ? 1 : 0;
    const beta_delta = was_selected ? 0 : 1;

    // Normalize template_id to plain form before write — wrapped vs plain
    // forms must collapse to the same row (UNIQUE index on variant_id is
    // plain string equality). See variant_performance_metrics UPSERT comment
    // in /executions handler.
    const normalizedTemplateId = normalizeActivityId(template_id);

    // Upsert variant_performance_metrics Thompson params.
    // Phase E: account-keyed record-id slug so different accounts in the
    // same org keep separate posteriors when relevance feedback fires.
    const relevanceMetricsRecordSlug = variantMetricsRecordId(normalizedTemplateId, accountId);
    surrealDB.query(`
      INSERT INTO variant_performance_metrics {
        id: type::thing('variant_performance_metrics', $record_id_slug),
        variant_id: $variant_id,
        activity_id: $variant_id,
        org_id: $org_id,
        account_id: $account_id,
        account_id_version: 1,
        total_executions: 0,
        successful_executions: 0,
        failed_executions: 0,
        success_rate: 0,
        avg_duration_ms: 0,
        avg_cost_usd: 0,
        thompson_alpha: $alpha_delta + 1,
        thompson_beta: $beta_delta + 1,
        total_selections: 0,
        last_executed_at: time::now(),
        created_at: time::now(),
        updated_at: time::now()
      }
      ON DUPLICATE KEY UPDATE
        thompson_alpha += $alpha_delta,
        thompson_beta += $beta_delta,
        updated_at = time::now()
    `, {
      record_id_slug: relevanceMetricsRecordSlug,
      variant_id: normalizedTemplateId,
      org_id: orgId,
      account_id: accountIdRecordRef(accountId),
      alpha_delta,
      beta_delta,
    }).catch((err: any) => {
      logger.warn('relevance-feedback: variant_performance_metrics upsert failed', { error: err.message });
    });

    // Upsert context_thompson_scores when context_bucket is provided
    // Phase B1: dual-write account_id alongside org_id.
    if (context_bucket && typeof context_bucket === 'string') {
      surrealDB.query(`
        INSERT INTO context_thompson_scores {
          template_id: $template_id,
          org_id: $org_id,
          account_id: $account_id,
          account_id_version: 1,
          context_bucket: $bucket,
          alpha: $alpha_delta + 1,
          beta: $beta_delta + 1,
          n_observations: 1,
          last_updated_at: time::now(),
          created_at: time::now()
        }
        ON DUPLICATE KEY UPDATE
          alpha += $alpha_delta,
          beta += $beta_delta,
          n_observations += 1,
          last_updated_at = time::now()
      `, {
        template_id,
        org_id: orgId,
        account_id: accountId,
        bucket: context_bucket,
        alpha_delta,
        beta_delta,
      }).catch((err: any) => {
        logger.warn('relevance-feedback: context_thompson_scores upsert failed', { error: err.message });
      });
    }

    // Persist the feedback record for audit / future learning
    // SurrealDB 3.x distinguishes NONE (undefined) from NULL; `none | string` fields
    // reject JavaScript null. Pass undefined so the driver sends NONE.
    // Phase B1: dual-write account_id (undefined when absent so driver sends NONE).
    surrealDB.query(`
      CREATE relevance_feedback CONTENT {
        template_id: $template_id,
        org_id: $org_id,
        account_id: $account_id,
        account_id_version: 1,
        was_selected: $was_selected,
        context_bucket: $context_bucket,
        reason: $reason,
        correlation_id: $correlation_id,
        created_at: time::now()
      }
    `, {
      template_id,
      org_id: orgId,
      account_id: accountId ?? undefined,
      was_selected,
      context_bucket: context_bucket ?? undefined,
      reason: reason ?? undefined,
      correlation_id: correlation_id ?? undefined,
    }).catch((err: any) => {
      logger.warn('relevance-feedback: feedback record insert failed', { error: err.message });
    });

    logger.info('POST /v2/activities/relevance-feedback', {
      template_id,
      was_selected,
      context_bucket: context_bucket ?? null,
      correlation_id: correlation_id ?? null,
      orgId,
    });

    return c.body(null, 204);
  } catch (error: any) {
    logger.error('POST /v2/activities/relevance-feedback failed', {
      error: error.message,
      stack: error.stack,
    });
    return c.json({
      error: 'Failed to record relevance feedback',
      message: error.message,
    }, 500);
  }
});
