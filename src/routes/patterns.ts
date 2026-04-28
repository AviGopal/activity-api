/**
 * Execution Pattern Routes
 *
 * Provides endpoints for querying execution patterns learned from execution traces.
 * Patterns track common input→output shape transformations with aggregate metrics.
 */

import { Hono } from 'hono';
import { logger } from '../utils/logger';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';
import { queryPatterns } from '../services/pattern-extraction';

const app = new Hono();

/**
 * POST /v2/activities/patterns/query
 *
 * Query execution patterns by input shapes, output shapes, or both.
 *
 * Request body:
 * - inputShapes: Optional array of input shapes to filter by
 * - outputShapes: Optional array of output shapes to filter by
 * - minExecutions: Minimum execution count (default: 1)
 * - sortBy: Sort field (success_rate | execution_count | avg_cost_usd | avg_duration_ms)
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 *
 * Response:
 * {
 *   patterns: [
 *     {
 *       input_shapes: string[],
 *       output_shapes: string[],
 *       activity_templates: string[],
 *       success_rate: number,
 *       execution_count: number,
 *       avg_cost_usd: number,
 *       avg_duration_ms: number
 *     }
 *   ],
 *   total: number
 * }
 */
app.post('/query', async (c) => {
  try {
    // Get JWT auth context for org_id
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    if (!jwtAuth?.orgId) {
      return c.json({
        error: 'Authentication required',
        message: 'org_id is required to query patterns',
      }, 401);
    }

    const body = await c.req.json();

    // Validate and extract query parameters
    const inputShapes = Array.isArray(body.inputShapes) ? body.inputShapes : undefined;
    const outputShapes = Array.isArray(body.outputShapes) ? body.outputShapes : undefined;
    const minExecutions = typeof body.minExecutions === 'number' ? body.minExecutions : 1;
    const sortBy = ['success_rate', 'execution_count', 'avg_cost_usd', 'avg_duration_ms'].includes(body.sortBy)
      ? body.sortBy
      : 'execution_count';
    const limit = Math.min(Math.max(body.limit || 100, 1), 500);
    const offset = Math.max(body.offset || 0, 0);

    logger.info('[patterns] Query patterns', {
      orgId: jwtAuth.orgId,
      inputShapes,
      outputShapes,
      minExecutions,
      sortBy,
      limit,
      offset,
    });

    // Query patterns (Phase B4b: dual-tenant binding)
    const result = await queryPatterns({
      orgId: jwtAuth.orgId!,
      accountId: jwtAuth.accountId ?? null,
      inputShapes,
      outputShapes,
      minExecutions,
      sortBy: sortBy as any,
      limit,
      offset,
    });

    logger.info('[patterns] Query results', {
      count: result.patterns.length,
      total: result.total,
    });

    return c.json(result);
  } catch (error: any) {
    logger.error('[patterns] Query failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query patterns',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/patterns
 *
 * List execution patterns (convenience endpoint for GET requests)
 *
 * Query params:
 * - input_shapes: Comma-separated list of input shapes
 * - output_shapes: Comma-separated list of output shapes
 * - min_executions: Minimum execution count (default: 1)
 * - sort_by: Sort field (success_rate | execution_count | avg_cost_usd | avg_duration_ms)
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 */
app.get('/', async (c) => {
  try {
    // Get JWT auth context for org_id
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    if (!jwtAuth?.orgId) {
      return c.json({
        error: 'Authentication required',
        message: 'org_id is required to query patterns',
      }, 401);
    }

    // Parse query parameters
    const inputShapesParam = c.req.query('input_shapes');
    const outputShapesParam = c.req.query('output_shapes');
    const minExecutions = parseInt(c.req.query('min_executions') || '1', 10);
    const sortBy = c.req.query('sort_by') || 'execution_count';
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10), 1), 500);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);

    const inputShapes = inputShapesParam ? inputShapesParam.split(',').map(s => s.trim()) : undefined;
    const outputShapes = outputShapesParam ? outputShapesParam.split(',').map(s => s.trim()) : undefined;

    logger.info('[patterns] List patterns', {
      orgId: jwtAuth.orgId,
      inputShapes,
      outputShapes,
      minExecutions,
      sortBy,
      limit,
      offset,
    });

    // Query patterns (Phase B4b: dual-tenant binding)
    const result = await queryPatterns({
      orgId: jwtAuth.orgId!,
      accountId: jwtAuth.accountId ?? null,
      inputShapes,
      outputShapes,
      minExecutions,
      sortBy: sortBy as any,
      limit,
      offset,
    });

    logger.info('[patterns] List results', {
      count: result.patterns.length,
      total: result.total,
    });

    return c.json(result);
  } catch (error: any) {
    logger.error('[patterns] List failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to list patterns',
      message: error.message,
    }, 500);
  }
});

export default app;
