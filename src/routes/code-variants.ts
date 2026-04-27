/**
 * Code Variants Routes
 *
 * Provides endpoints for viewing code variants (git branches) with Thompson Sampling scores
 * Used by dashboard to display variant performance and promotion status
 */

import { Hono } from 'hono';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import type { SessionData } from '../models/schemas';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';

const app = new Hono();

interface CodeVariant {
  variant_id: string;
  activity_id: string;
  variant_name: string;
  branch_name?: string;
  commit_sha?: string;
  description: string;
  category: string;
  thompson_score: number;
  thompson_alpha: number;
  thompson_beta: number;
  total_executions: number;
  successful_executions: number;
  failed_executions: number;
  success_rate: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  ci_status?: 'pending' | 'passing' | 'failing' | 'error';
  ci_last_run?: string;
  staging_metrics?: {
    deployed_at?: string;
    deployment_status?: 'deploying' | 'deployed' | 'failed';
    health_check_status?: 'healthy' | 'unhealthy' | 'unknown';
    error_rate?: number;
    latency_p95?: number;
  };
  promotion_status?: 'candidate' | 'promoted' | 'rejected' | 'staging';
  promoted_at?: string;
  created_at: string;
  updated_at: string;
  last_executed_at?: string;
}

interface ListCodeVariantsResponse {
  variants: CodeVariant[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * GET /v2/activities/code-variants
 *
 * List code variants with Thompson Sampling scores and CI/staging metrics
 *
 * Query params:
 * - activity_id: Filter by activity ID
 * - category: Filter by category
 * - promotion_status: Filter by promotion status
 * - ci_status: Filter by CI status
 * - min_score: Minimum Thompson score (0-1)
 * - limit: Max records to return (default: 50, max: 200)
 * - offset: Pagination offset (default: 0)
 * - sort_by: Sort field (thompson_score, success_rate, total_executions, created_at)
 * - sort_order: Sort order (asc, desc) - default: desc
 */
app.get('/', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    const session = (c.get as any)('session') as SessionData | undefined;

    // Parse query params
    const activityId = c.req.query('activity_id');
    const category = c.req.query('category');
    const promotionStatus = c.req.query('promotion_status');
    const ciStatus = c.req.query('ci_status');
    const minScoreParam = c.req.query('min_score');
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);
    const sortBy = c.req.query('sort_by') || 'thompson_score';
    const sortOrder = c.req.query('sort_order') || 'desc';

    // Validate and cap limit
    const limit = Math.min(Math.max(limitParam, 1), 200);
    const offset = Math.max(offsetParam, 0);

    // Build query conditions
    let whereConditions: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    // Multi-tenant filtering (skip when using JWT - RBAC handles it via PERMISSIONS)
    if (!useJwtAuth) {
      if (session?.org_id) {
        whereConditions.push('(org_id = $org_id OR org_id = NULL)');
        params.org_id = session.org_id;
      }

      if (session?.project_id) {
        whereConditions.push('(project_id = $project_id OR project_id = NULL)');
        params.project_id = session.project_id;
      }
    }

    // Filter by activity_id
    if (activityId) {
      whereConditions.push('activity_id = $activity_id');
      params.activity_id = activityId;
    }

    // Filter by category
    if (category) {
      whereConditions.push('category = $category');
      params.category = category;
    }

    // Filter by promotion_status
    if (promotionStatus) {
      whereConditions.push('promotion_status = $promotion_status');
      params.promotion_status = promotionStatus;
    }

    // Filter by CI status
    if (ciStatus) {
      whereConditions.push('ci_status = $ci_status');
      params.ci_status = ciStatus;
    }

    // Filter by minimum Thompson score
    if (minScoreParam) {
      const minScore = parseFloat(minScoreParam);
      if (!isNaN(minScore)) {
        whereConditions.push('thompson_score >= $min_score');
        params.min_score = minScore;
      }
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Validate sort field
    const validSortFields = ['thompson_score', 'success_rate', 'total_executions', 'created_at', 'updated_at'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'thompson_score';
    const sortDirection = sortOrder.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Query code variants with metrics
    // Join variant_performance_metrics with activity_templates table
    const query = `
      SELECT
        t.variant_id,
        t.activity_id,
        t.variant_name,
        t.description,
        t.category,
        t.created_at,
        t.updated_at,
        m.total_executions,
        m.successful_executions,
        m.failed_executions,
        m.success_rate,
        m.avg_duration_ms,
        m.avg_cost_usd,
        m.thompson_alpha,
        m.thompson_beta,
        m.last_executed_at,
        (m.thompson_alpha / (m.thompson_alpha + m.thompson_beta)) AS thompson_score
      FROM activity_templates AS t
      LEFT JOIN variant_performance_metrics AS m ON t.variant_id = m.variant_id
      ${whereClause}
      ORDER BY ${sortField} ${sortDirection}
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching code variants', {
      whereClause,
      sortField,
      sortDirection,
      params,
      authMethod: useJwtAuth ? 'jwt' : 'session',
    });

    // Execute query with appropriate auth method
    let variants: CodeVariant[];
    let countResult: { total: number }[];

    const countQuery = `
      SELECT count() as total
      FROM activity_templates AS t
      LEFT JOIN variant_performance_metrics AS m ON t.variant_id = m.variant_id
      ${whereClause}
      GROUP ALL
    `;

    // F-36: skip JWT path for API-key auth (SurrealDB rejects api_key:N id
    // claim as unresolvable record reference). Falls back to root creds
    // with manual org_id filtering.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      // JWT AUTH PATH: Use RBAC-enforced query
      variants = await queryWithAuth<CodeVariant>(jwtAuth.jwtToken, query, params);
      countResult = await queryWithAuth<{ total: number }>(jwtAuth.jwtToken, countQuery, params);
    } else {
      // LEGACY PATH: Direct query with application-level filtering
      variants = await surrealDB.query<CodeVariant>(query, params);
      countResult = await surrealDB.query<{ total: number }>(countQuery, params);
    }

    // TODO: Enrich with CI/staging metrics from CI results table
    // For now, return variants with placeholder CI/staging data
    const enrichedVariants: CodeVariant[] = (variants || []).map((v) => ({
      ...v,
      thompson_score: v.thompson_score || 0.5,
      // Placeholder CI/staging data (will be populated from CI results table)
      ci_status: undefined,
      staging_metrics: undefined,
      promotion_status: v.success_rate >= 0.8 ? 'candidate' : 'staging',
    }));

    const total = countResult?.[0]?.total || 0;

    logger.info('Code variants fetched', {
      count: enrichedVariants.length,
      total,
      limit,
      offset,
    });

    const response: ListCodeVariantsResponse = {
      variants: enrichedVariants,
      total,
      limit,
      offset,
    };

    return c.json(response);

  } catch (error) {
    logger.error('Failed to list code variants', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to list code variants',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/code-variants/:variantId
 *
 * Get detailed information about a specific code variant
 */
app.get('/:variantId', async (c) => {
  try {
    const variantId = c.req.param('variantId');

    const query = `
      SELECT
        t.*,
        m.total_executions,
        m.successful_executions,
        m.failed_executions,
        m.success_rate,
        m.avg_duration_ms,
        m.avg_cost_usd,
        m.thompson_alpha,
        m.thompson_beta,
        m.last_executed_at,
        (m.thompson_alpha / (m.thompson_alpha + m.thompson_beta)) AS thompson_score
      FROM activity_templates AS t
      LEFT JOIN variant_performance_metrics AS m ON t.variant_id = m.variant_id
      WHERE t.variant_id = $variant_id
      LIMIT 1
    `;

    const result = await surrealDB.query<CodeVariant>(query, {
      variant_id: variantId,
    });

    if (!result || result.length === 0) {
      return c.json({
        error: 'Code variant not found',
        variant_id: variantId,
      }, 404);
    }

    return c.json(result[0]);

  } catch (error) {
    logger.error('Failed to get code variant', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to get code variant',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

export default app;
