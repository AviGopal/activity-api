/**
 * CI/CD Integration Routes
 *
 * Implements webhook endpoint for CI/CD systems to report build and deployment results.
 * Updates execution traces with CI status and feeds data to Thompson Sampling for learning.
 *
 * Workflow:
 * 1. Activity execution completes -> execution trace stored
 * 2. Code changes committed to branch
 * 3. CI/CD runs (build, typecheck, test)
 * 4. CI webhook calls this endpoint with results
 * 5. Backend updates execution trace with CI status
 * 6. Thompson Sampling metrics updated based on CI success/failure
 * 7. On success, deployment task enqueued to boredom queue
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { surrealDB } from '../db/surreal';
import { normalizeActivityId } from '../db/paradigm';
import { RedisClient } from '../db/redis';
import { logger } from '../utils/logger';
import { broadcaster } from '../websocket/broadcaster';

const router = new Hono();

// CI Result schemas
export const CIArtifactSchema = z.object({
  name: z.string(),
  type: z.enum(['docker_image', 'npm_package', 'binary', 'coverage_report', 'test_report', 'other']),
  url: z.string().optional(),
  size_bytes: z.number().optional(),
  metadata: z.record(z.any()).optional(),
});

export const CIResultRequestSchema = z.object({
  execution_id: z.string(),
  template_id: z.string().optional(),
  branch: z.string(),
  commit: z.string(),
  success: z.boolean(),
  duration_ms: z.number(),
  ci_provider: z.enum(['github_actions', 'gitlab_ci', 'jenkins', 'circleci', 'other']).default('github_actions'),
  workflow_name: z.string().optional(),
  run_id: z.string().optional(),
  run_url: z.string().optional(),

  // Build stages
  stages: z.object({
    build: z.object({
      success: z.boolean(),
      duration_ms: z.number().optional(),
      error: z.string().optional(),
    }).optional(),
    typecheck: z.object({
      success: z.boolean(),
      duration_ms: z.number().optional(),
      error: z.string().optional(),
    }).optional(),
    test: z.object({
      success: z.boolean(),
      duration_ms: z.number().optional(),
      tests_passed: z.number().optional(),
      tests_failed: z.number().optional(),
      coverage_percent: z.number().optional(),
      error: z.string().optional(),
    }).optional(),
    lint: z.object({
      success: z.boolean(),
      duration_ms: z.number().optional(),
      errors: z.number().optional(),
      warnings: z.number().optional(),
      error: z.string().optional(),
    }).optional(),
  }).optional(),

  // Artifacts produced
  artifacts: z.array(CIArtifactSchema).optional(),

  // Metadata
  metadata: z.record(z.any()).optional(),
});

export const CIResultResponseSchema = z.object({
  success: z.boolean(),
  execution_id: z.string(),
  ci_status_updated: z.boolean(),
  metrics_updated: z.boolean(),
  deployment_enqueued: z.boolean().optional(),
  message: z.string().optional(),
});

export type CIArtifact = z.infer<typeof CIArtifactSchema>;
export type CIResultRequest = z.infer<typeof CIResultRequestSchema>;
export type CIResultResponse = z.infer<typeof CIResultResponseSchema>;

/**
 * POST /v2/activities/ci-result
 *
 * Receive CI/CD results and update system state
 *
 * Flow:
 * 1. Validate request body
 * 2. Load execution trace from database
 * 3. Update execution trace with CI status
 * 4. Update Thompson Sampling metrics (success contributes positively, failure negatively)
 * 5. Broadcast CI result via WebSocket for live dashboard updates
 * 6. If CI succeeded, enqueue staging deployment to boredom queue
 * 7. Return confirmation response
 */
router.post('/ci-result', async (c) => {
  try {
    const body = await c.req.json();
    const request = CIResultRequestSchema.parse(body);

    logger.info('POST /v2/activities/ci-result', {
      execution_id: request.execution_id,
      branch: request.branch,
      commit: request.commit.substring(0, 8),
      success: request.success,
      ci_provider: request.ci_provider,
    });

    // Check if execution trace exists
    const traceQuery = `
      SELECT * FROM execution_traces
      WHERE execution_id = $execution_id
      LIMIT 1
    `;

    const traces = await surrealDB.query<any>(traceQuery, {
      execution_id: request.execution_id,
    });

    if (traces.length === 0) {
      logger.warn('Execution trace not found for CI result', {
        execution_id: request.execution_id,
      });
      return c.json({
        success: false,
        execution_id: request.execution_id,
        ci_status_updated: false,
        metrics_updated: false,
        message: `Execution trace not found: ${request.execution_id}`,
      } as CIResultResponse, 404);
    }

    const trace = traces[0];
    const template_id = request.template_id || trace.template_id;
    // Normalize once at the top so all downstream sites (metrics WHERE/UPDATE,
    // Redis cache invalidation, deployment task payload) collapse wrapped
    // (`activity:⟨name⟩`) and plain (`name`) forms to the same key. See
    // `execution-traces.ts:resolveTemplateIdsForUpdate` for the canonical
    // convention this aligns with.
    const normalizedTemplateId = template_id ? normalizeActivityId(template_id) : undefined;

    // Update execution trace with CI results
    const now = new Date().toISOString();
    const updateTraceQuery = `
      UPDATE execution_traces
      SET
        ci_status = {
          success: $ci_success,
          duration_ms: $duration_ms,
          provider: $ci_provider,
          workflow_name: $workflow_name,
          run_id: $run_id,
          run_url: $run_url,
          branch: $branch,
          commit: $commit,
          stages: $stages,
          artifacts: $artifacts,
          completed_at: $completed_at,
          metadata: $metadata
        },
        updated_at = $updated_at
      WHERE execution_id = $execution_id
    `;

    await surrealDB.query(updateTraceQuery, {
      execution_id: request.execution_id,
      ci_success: request.success,
      duration_ms: request.duration_ms,
      ci_provider: request.ci_provider,
      workflow_name: request.workflow_name,
      run_id: request.run_id,
      run_url: request.run_url,
      branch: request.branch,
      commit: request.commit,
      stages: request.stages || {},
      artifacts: request.artifacts || [],
      completed_at: now,
      metadata: request.metadata || {},
      updated_at: now,
    });

    logger.info('Updated execution trace with CI status', {
      execution_id: request.execution_id,
      ci_success: request.success,
    });

    // Update Thompson Sampling metrics
    // CI success/failure affects template selection probability
    let metricsUpdated = false;

    if (template_id && normalizedTemplateId) {
      try {
        // `normalizedTemplateId` is computed once at the top of the handler.
        // The variant_performance_metrics row stores `variant_id` as a plain
        // string (UNIQUE index is plain-string equality), so wrapped forms
        // would split α/β across two records and stall Thompson Sampling.
        // Mirrors the 10.4 fix in `routes/activities.ts` and
        // `routes/execution-traces.ts:resolveTemplateIdsForUpdate`.

        // Load current metrics
        const metricsQuery = `
          SELECT * FROM variant_performance_metrics
          WHERE variant_id = $variant_id
          LIMIT 1
        `;

        const metricsResult = await surrealDB.query<any>(metricsQuery, {
          variant_id: normalizedTemplateId,
        });

        if (metricsResult.length > 0) {
          const metrics = metricsResult[0];

          // Update Thompson Sampling parameters based on CI result
          // CI success adds a small boost to alpha (success parameter)
          // CI failure adds a small penalty to beta (failure parameter)
          const alphaBoost = request.success ? 0.5 : 0;
          const betaPenalty = request.success ? 0 : 0.5;

          const newAlpha = metrics.thompson_alpha + alphaBoost;
          const newBeta = metrics.thompson_beta + betaPenalty;

          // Also track CI-specific metrics
          const updateMetricsQuery = `
            UPDATE variant_performance_metrics
            SET
              thompson_alpha = $thompson_alpha,
              thompson_beta = $thompson_beta,
              ci_pass_count = $ci_pass_count,
              ci_fail_count = $ci_fail_count,
              ci_success_rate = $ci_success_rate,
              updated_at = $updated_at
            WHERE variant_id = $variant_id
          `;

          const ciPassCount = (metrics.ci_pass_count || 0) + (request.success ? 1 : 0);
          const ciFailCount = (metrics.ci_fail_count || 0) + (request.success ? 0 : 1);
          const ciSuccessRate = ciPassCount / (ciPassCount + ciFailCount);

          await surrealDB.query(updateMetricsQuery, {
            variant_id: normalizedTemplateId,
            thompson_alpha: newAlpha,
            thompson_beta: newBeta,
            ci_pass_count: ciPassCount,
            ci_fail_count: ciFailCount,
            ci_success_rate: ciSuccessRate,
            updated_at: now,
          });

          logger.info('Updated Thompson Sampling metrics with CI result', {
            template_id,
            thompson_alpha: newAlpha,
            thompson_beta: newBeta,
            ci_success_rate: ciSuccessRate,
          });

          metricsUpdated = true;

          // Invalidate Redis cache for this template — must use normalized id
          // to match `execution-traces.ts:1551` (cache invalidation after score
          // updates uses `candidateId` from `resolveTemplateIdsForUpdate`,
          // which normalizes all ids). Wrapped vs plain forms would otherwise
          // miss the entry written by the trace path.
          const redis = RedisClient.getInstance();
          await redis.getClient().del(`activity:template:${normalizedTemplateId}`);
          await redis.getClient().del('activity:templates:list');

        } else {
          logger.warn('Template metrics not found, cannot update Thompson Sampling', {
            template_id,
          });
        }
      } catch (error: any) {
        logger.error('Failed to update Thompson Sampling metrics', {
          template_id,
          error: error.message,
        });
        // Don't fail the entire request if metrics update fails
      }
    }

    // Broadcast CI result via WebSocket for live updates
    broadcaster.emit({
      type: 'ci_result',
      data: {
        execution_id: request.execution_id,
        template_id,
        success: request.success,
        branch: request.branch,
        commit: request.commit,
        duration_ms: request.duration_ms,
        ci_provider: request.ci_provider,
        workflow_name: request.workflow_name,
        run_url: request.run_url,
        timestamp: now,
      },
    });

    // Enqueue staging deployment on CI success
    let deploymentEnqueued = false;

    if (request.success) {
      try {
        // Import boredom task enqueuer
        const { enqueueTask } = await import('./boredom');

        const deploymentTask = {
          id: `deploy-${request.commit.substring(0, 8)}-${Date.now()}`,
          priority: 'medium' as const,
          goal: `Deploy ${request.branch} (${request.commit.substring(0, 8)}) to staging environment`,
          variables: {
            execution_id: request.execution_id,
            // Pass normalized form downstream so the deployment consumer keys
            // off the same id as Thompson Sampling / cache layers.
            template_id: normalizedTemplateId,
            branch: request.branch,
            commit: request.commit,
            ci_run_url: request.run_url,
            artifacts: request.artifacts,
          },
          reason: `CI success on ${request.branch}: deploy to staging`,
          createdAt: Date.now(),
        };

        await enqueueTask(deploymentTask);
        deploymentEnqueued = true;

        logger.info('Enqueued staging deployment task', {
          task_id: deploymentTask.id,
          branch: request.branch,
          commit: request.commit,
        });
      } catch (error: any) {
        logger.error('Failed to enqueue deployment task', {
          error: error.message,
        });
        // Don't fail the entire request if deployment enqueue fails
      }
    }

    return c.json({
      success: true,
      execution_id: request.execution_id,
      ci_status_updated: true,
      metrics_updated: metricsUpdated,
      deployment_enqueued: deploymentEnqueued,
      message: request.success
        ? 'CI passed, execution trace updated, deployment enqueued'
        : 'CI failed, execution trace updated with failure details',
    } as CIResultResponse, 200);

  } catch (error: any) {
    logger.error('POST /v2/activities/ci-result failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        success: false,
        execution_id: '',
        ci_status_updated: false,
        metrics_updated: false,
        message: 'Invalid request body: ' + JSON.stringify(error.errors),
      } as CIResultResponse, 400);
    }

    return c.json({
      success: false,
      execution_id: '',
      ci_status_updated: false,
      metrics_updated: false,
      message: 'Internal server error: ' + error.message,
    } as CIResultResponse, 500);
  }
});

/**
 * GET /v2/activities/ci-results
 *
 * List CI results for executions with optional filtering
 *
 * Query params:
 * - template_id: Filter by template
 * - branch: Filter by branch name
 * - success: Filter by success/failure (true/false)
 * - limit: Max results (default 50)
 * - offset: Pagination offset (default 0)
 */
router.get('/ci-results', async (c) => {
  try {
    const template_id = c.req.query('template_id');
    const branch = c.req.query('branch');
    const successStr = c.req.query('success');
    const limitStr = c.req.query('limit') || '50';
    const offsetStr = c.req.query('offset') || '0';

    let limit = parseInt(limitStr, 10);
    let offset = parseInt(offsetStr, 10);

    if (isNaN(limit) || limit < 1) {
      limit = 50;
    }
    if (limit > 1000) {
      limit = 1000;
    }
    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }

    // Build WHERE clause
    const conditions: string[] = ['ci_status IS NOT NONE'];
    const params: Record<string, any> = { limit, offset };

    if (template_id) {
      conditions.push('template_id = $template_id');
      params.template_id = template_id;
    }

    if (branch) {
      conditions.push('ci_status.branch = $branch');
      params.branch = branch;
    }

    if (successStr !== undefined) {
      const success = successStr.toLowerCase() === 'true';
      conditions.push('ci_status.success = $success');
      params.success = success;
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const query = `
      SELECT
        execution_id,
        template_id,
        status,
        duration_ms,
        cost_usd,
        ci_status,
        created_at
      FROM execution_traces
      ${whereClause}
      ORDER BY ci_status.completed_at DESC
      LIMIT $limit
      START $offset
    `;

    const results = await surrealDB.query<any>(query, params);

    logger.info('GET /v2/activities/ci-results', {
      count: results.length,
      template_id,
      branch,
      success: successStr,
    });

    return c.json({
      ci_results: results,
      total: results.length,
      limit,
      offset,
    }, 200);

  } catch (error: any) {
    logger.error('GET /v2/activities/ci-results failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to list CI results',
      message: error.message,
    }, 500);
  }
});

export default router;
