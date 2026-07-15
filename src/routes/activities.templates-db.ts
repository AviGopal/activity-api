// Extracted from activities.ts by parity-gated seam extraction (behavior-neutral move).
import { validRepairSignature, repairBoostFromRows } from '../lib/repair-signature-consume';
import { Hono } from 'hono';
import beta from '@stdlib/random-base-beta';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { invalidateTemplateCache, invalidateTemplateCacheMany } from '../utils/template-cache';
import { logger } from '../utils/logger';
import { ensureTags, computeTagPrefixes, deriveCategory } from '../utils/tags';
import { analyzeTaskSemantics } from '../utils/semantic-tags';
import {
  extractContextTokensWithDecay,
  computeContextBucket,
  computeStateSpaceSignature,
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
import type { SessionData } from '../models/schemas';
import { getJwtAuthFromContext, hasJwtAuth, getExecutionScopeFromContext, type JwtAuthContext } from '../middleware/jwtAuth';
import {
  applyCompatibilityFilter,
  generatePointerRecommendations,
  identifyBlockingShapes,
  buildPointerStateSpace,
  type ImpulseStateEntry,
} from '../services/recommendation';
import { generateActivity } from '../services/activity-generator';
import { applyReputationFactor } from '../services/thompson-sampling';
import {
  successorFeaturesEnabled,
  fetchSuccessorFeatureCells,
  successorFeatureCellKey,
  rewardFromCompletionShapes,
  successorValue,
} from '../lib/successor-features';
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
import { applyOutcomeToPosteriors } from '../lib/posterior-update';
import { incrementTraceStoreCounter } from '../lib/trace-store-counters';
import { classifyTemplateTiers } from '../services/tier-classifier';
import { lookupAssignment, readClusterPosterior } from '../lib/cluster-posterior';
import { getTuningParam } from '../lib/tuning-params';
import { betaSample, normalizeSuccessorValue, successorBlendEnabled, successorBlendWeight, updateShapeScoresFromExecution, variantMetricsRecordId } from "./activities.scoring";
import { classifyCompositionEdge } from "./activities.composition";

export function accountIdScopedWhere(): string {
  return '(account_id = $account_id OR (account_id IS NONE AND org_id = $org_id))';
}

export interface ActivityTemplate {
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

export function ensureOutputShapes(templates: ActivityTemplate[]): ActivityTemplate[] {
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

export async function enrichTemplatesWithMetrics(
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

export const TEMPLATE_LIST_FIELDS =
  'id, name, description, tags, tag_prefixes, category, tasks, scope, org_id, project_id, input_shapes, output_shapes, execution_type, variant_of, created_at, updated_at';

export async function fetchTemplatesRowTolerant(
  makeQuery: (fields: string) => string,
  params: Record<string, any>,
  run: (sql: string, params: Record<string, any>) => Promise<any[]>
): Promise<ActivityTemplate[]> {
  const query = makeQuery(TEMPLATE_LIST_FIELDS);
  try {
    return (await run(query, params)) as ActivityTemplate[];
  } catch (batchErr: any) {
    logger.warn('Template batch listing failed; retrying row-by-row (poison-row tolerance)', {
      error: batchErr?.message,
      errorName: batchErr?.constructor?.name,
    });
    const limit = Number(params.limit) || 0;
    const baseOffset = Number(params.offset) || 0;
    const rows: ActivityTemplate[] = [];
    for (let i = 0; i < limit; i++) {
      const rowParams = { ...params, limit: 1, offset: baseOffset + i };
      try {
        const row = await run(query, rowParams);
        if (row.length === 0) break; // walked past the end of the visible set
        rows.push(row[0] as ActivityTemplate);
      } catch (rowErr: any) {
        // Row fails even with the explicit projection — skip it, but fetch
        // its id alone (ids always deserialize) so the poison row is named.
        let poisonId: string | undefined;
        try {
          const idRow = await run(makeQuery('meta::id(id) AS id'), rowParams);
          poisonId = idRow[0] ? String((idRow[0] as any).id) : undefined;
        } catch {
          /* id fetch failed too; the absolute offset is the only handle */
        }
        logger.error('Skipping undeserializable activity row in template listing', {
          offset: baseOffset + i,
          id: poisonId,
          error: rowErr?.message,
          errorName: rowErr?.constructor?.name,
        });
      }
    }
    return rows;
  }
}

export async function listAllTemplatesFromDB(
  limit: number,
  orgId?: string | null,
  projectId?: string | null,
  jwtToken?: string | null,
  scopeFilter?: string | null,
  executionType?: string | null, // Allow filtering by execution_type
  offset: number = 0, // Pagination offset (operator audit / shadow-template enumeration)
  accountId?: string | null // Prefer account_id, fall back to org_id
): Promise<ActivityTemplate[]> {
  let makeQuery: (fields: string) => string;
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

    makeQuery = (fields) => `
      SELECT ${fields} FROM activity
      WHERE execution_type = $execution_type
      AND (retired = false OR retired IS NONE)
      ${whereClause ? 'AND ' + whereClause.replace('WHERE ', '') : ''}
      ORDER BY created_at DESC
      LIMIT $limit START $offset
    `;

    logger.debug('Fetching activities with JWT auth (RBAC enforced)', { limit, offset, scopeFilter, executionType: effectiveExecutionType });
    const result = await fetchTemplatesRowTolerant(makeQuery, params, (sql, p) =>
      queryWithAuth<ActivityTemplate>(jwtToken, sql, p)
    );

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
      makeQuery = (fields) => `
        SELECT ${fields} FROM activity
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
      makeQuery = (fields) => `
        SELECT ${fields} FROM activity
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
    makeQuery = (fields) => `
      SELECT ${fields} FROM activity
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

  logger.debug('Fetching templates from SurrealDB', { params });
  const result = await fetchTemplatesRowTolerant(makeQuery, params, (sql, p) =>
    surrealDB.query<ActivityTemplate>(sql, p)
  );

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

export async function countAllTemplatesFromDB(
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

export async function listPublicTemplatesFromDB(
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
