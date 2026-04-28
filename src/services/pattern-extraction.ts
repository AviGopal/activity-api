/**
 * Pattern Extraction Service
 *
 * Learns common input→output shape transformations from execution traces.
 * Extracts patterns after storing execution traces and maintains aggregate metrics.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { inferShapesFromTemplate } from '../utils/shape-inference';
import { accountIdScopedWhere } from '../routes/activities';

/**
 * Extract pattern from an execution trace and upsert pattern record.
 *
 * @param executionId - Execution ID to extract pattern from
 * @param activityId - Activity ID that was executed
 * @param inputImpulses - Input impulse IDs used in execution
 * @param outputImpulses - Output impulse IDs produced by execution
 * @param success - Whether execution succeeded
 * @param durationMs - Execution duration in milliseconds
 * @param costUsd - Execution cost in USD
 * @param tokensIn - Input tokens consumed
 * @param tokensOut - Output tokens generated
 * @param orgId - Organization ID
 * @param projectId - Optional project ID
 */
export async function extractAndUpsertPattern(params: {
  executionId: string;
  activityId: string;
  inputImpulses: string[];
  outputImpulses: string[];
  success: boolean;
  durationMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  orgId: string;
  /** Phase B4b: optional account_id; null when caller has no JWT claim. */
  accountId?: string | null;
  projectId?: string | null;
}): Promise<void> {
  const {
    executionId,
    activityId,
    inputImpulses,
    outputImpulses,
    success,
    durationMs,
    costUsd,
    tokensIn,
    tokensOut,
    orgId,
    accountId,
    projectId,
  } = params;

  try {
    // Extract input shapes from impulses
    const inputShapes = await extractShapesFromImpulses(inputImpulses);

    // Extract output shapes from impulses
    const outputShapes = await extractShapesFromImpulses(outputImpulses);

    if (inputShapes.length === 0 && outputShapes.length === 0) {
      logger.debug('[PatternExtraction] No shapes found for execution', {
        executionId,
        inputImpulses: inputImpulses.length,
        outputImpulses: outputImpulses.length,
      });
      return;
    }

    // Sort shapes for consistent pattern matching
    const sortedInputShapes = inputShapes.sort();
    const sortedOutputShapes = outputShapes.sort();

    // Find existing pattern or create new one
    await upsertPattern({
      inputShapes: sortedInputShapes,
      outputShapes: sortedOutputShapes,
      activityId,
      success,
      durationMs,
      costUsd,
      tokensIn,
      tokensOut,
      orgId,
      accountId: accountId ?? null,
      projectId: projectId || null,
      executedAt: new Date().toISOString(),
    });

    logger.info('[PatternExtraction] Pattern extracted and upserted', {
      executionId,
      activityId,
      inputShapes: sortedInputShapes,
      outputShapes: sortedOutputShapes,
      success,
    });
  } catch (error: any) {
    logger.error('[PatternExtraction] Failed to extract pattern', {
      executionId,
      error: error.message,
      stack: error.stack,
    });
    // Don't throw - pattern extraction is non-critical
  }
}

/**
 * Extract shapes from impulse IDs by looking them up in the database
 */
async function extractShapesFromImpulses(impulseIds: string[]): Promise<string[]> {
  if (impulseIds.length === 0) {
    return [];
  }

  try {
    // Query impulse table for shapes
    const query = `
      SELECT shape FROM impulse
      WHERE id IN $impulseIds
    `;

    const result = await surrealDB.query<Array<{ shape: string }>>(query, {
      impulseIds,
    });

    if (!result || result.length === 0) {
      return [];
    }

    const shapes = result
      .map((r: any) => r.shape)
      .filter((shape: any) => shape !== null && shape !== undefined) as string[];

    return [...new Set(shapes)]; // Deduplicate
  } catch (error: any) {
    logger.error('[PatternExtraction] Failed to extract shapes from impulses', {
      impulseIds,
      error: error.message,
    });
    return [];
  }
}

/**
 * Upsert pattern record with rolling average updates
 */
async function upsertPattern(params: {
  inputShapes: string[];
  outputShapes: string[];
  activityId: string;
  success: boolean;
  durationMs: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  orgId: string;
  /** Phase B4b: optional account_id; null when caller has no claim. */
  accountId: string | null;
  projectId: string | null;
  executedAt: string;
}): Promise<void> {
  const {
    inputShapes,
    outputShapes,
    activityId,
    success,
    durationMs,
    costUsd,
    tokensIn,
    tokensOut,
    orgId,
    accountId,
    projectId,
    executedAt,
  } = params;

  // Find existing pattern (dual-tenant scoped)
  const findQuery = `
    SELECT * FROM execution_pattern
    WHERE ${accountIdScopedWhere()}
      AND input_shapes = $inputShapes
      AND output_shapes = $outputShapes
    LIMIT 1
  `;

  const existing = await surrealDB.query<Array<{
    execution_count: number;
    success_count: number;
    failure_count: number;
    avg_cost_usd: number;
    avg_duration_ms: number;
    avg_tokens_in: number;
    avg_tokens_out: number;
    activity_templates: string[];
  }>>(findQuery, {
    org_id: orgId,
    account_id: accountId,
    inputShapes,
    outputShapes,
  });

  if (existing && existing.length > 0) {
    // Update existing pattern with rolling averages
    const pattern = existing[0] as any;
    const newExecutionCount = pattern.execution_count + 1;
    const newSuccessCount = pattern.success_count + (success ? 1 : 0);
    const newFailureCount = pattern.failure_count + (success ? 0 : 1);
    const newSuccessRate = newSuccessCount / newExecutionCount;

    // Rolling average formula: new_avg = (old_avg * old_count + new_value) / new_count
    const newAvgCost = (pattern.avg_cost_usd * pattern.execution_count + costUsd) / newExecutionCount;
    const newAvgDuration = (pattern.avg_duration_ms * pattern.execution_count + durationMs) / newExecutionCount;
    const newAvgTokensIn = (pattern.avg_tokens_in * pattern.execution_count + tokensIn) / newExecutionCount;
    const newAvgTokensOut = (pattern.avg_tokens_out * pattern.execution_count + tokensOut) / newExecutionCount;

    // Add activity to templates array if not already present
    const activityTemplates = pattern.activity_templates.includes(activityId)
      ? pattern.activity_templates
      : [...pattern.activity_templates, activityId];

    const updateQuery = `
      UPDATE execution_pattern
      SET
        execution_count = $executionCount,
        success_count = $successCount,
        failure_count = $failureCount,
        success_rate = $successRate,
        avg_cost_usd = $avgCost,
        avg_duration_ms = $avgDuration,
        avg_tokens_in = $avgTokensIn,
        avg_tokens_out = $avgTokensOut,
        activity_templates = $activityTemplates,
        last_executed_at = $executedAt,
        account_id = $account_id,
        account_id_version = 1,
        updated_at = time::now()
      WHERE ${accountIdScopedWhere()}
        AND input_shapes = $inputShapes
        AND output_shapes = $outputShapes
    `;

    await surrealDB.query(updateQuery, {
      executionCount: newExecutionCount,
      successCount: newSuccessCount,
      failureCount: newFailureCount,
      successRate: newSuccessRate,
      avgCost: newAvgCost,
      avgDuration: newAvgDuration,
      avgTokensIn: newAvgTokensIn,
      avgTokensOut: newAvgTokensOut,
      activityTemplates,
      executedAt,
      org_id: orgId,
      account_id: accountId,
      inputShapes,
      outputShapes,
    });

    logger.debug('[PatternExtraction] Updated existing pattern', {
      inputShapes,
      outputShapes,
      executionCount: newExecutionCount,
      successRate: newSuccessRate,
    });
  } else {
    // Create new pattern (Phase B4b: dual-write account_id alongside org_id)
    const insertQuery = `
      CREATE execution_pattern CONTENT {
        input_shapes: $inputShapes,
        output_shapes: $outputShapes,
        activity_templates: [$activityId],
        success_rate: $successRate,
        execution_count: 1,
        success_count: $successCount,
        failure_count: $failureCount,
        avg_cost_usd: $costUsd,
        avg_duration_ms: $durationMs,
        avg_tokens_in: $tokensIn,
        avg_tokens_out: $tokensOut,
        org_id: $org_id,
        account_id: $account_id,
        account_id_version: 1,
        project_id: $projectId,
        last_executed_at: $executedAt,
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    await surrealDB.query(insertQuery, {
      inputShapes,
      outputShapes,
      activityId,
      successRate: success ? 1.0 : 0.0,
      successCount: success ? 1 : 0,
      failureCount: success ? 0 : 1,
      costUsd,
      durationMs,
      tokensIn,
      tokensOut,
      org_id: orgId,
      account_id: accountId,
      projectId,
      executedAt,
    });

    logger.debug('[PatternExtraction] Created new pattern', {
      inputShapes,
      outputShapes,
    });
  }
}

/**
 * Query patterns by input shapes, output shapes, or both.
 *
 * @param orgId - Organization ID (required for RBAC)
 * @param inputShapes - Optional input shapes to filter by
 * @param outputShapes - Optional output shapes to filter by
 * @param minExecutions - Minimum execution count to include
 * @param sortBy - Field to sort by (success_rate, execution_count, avg_cost_usd, avg_duration_ms)
 * @param limit - Maximum number of results
 * @param offset - Offset for pagination
 */
export async function queryPatterns(params: {
  orgId: string;
  /** Phase B4b: optional account_id; null when caller has no claim. */
  accountId?: string | null;
  inputShapes?: string[];
  outputShapes?: string[];
  minExecutions?: number;
  sortBy?: 'success_rate' | 'execution_count' | 'avg_cost_usd' | 'avg_duration_ms';
  limit?: number;
  offset?: number;
}): Promise<{
  patterns: Array<{
    input_shapes: string[];
    output_shapes: string[];
    activity_templates: string[];
    success_rate: number;
    execution_count: number;
    avg_cost_usd: number;
    avg_duration_ms: number;
  }>;
  total: number;
}> {
  const {
    orgId,
    accountId,
    inputShapes,
    outputShapes,
    minExecutions = 1,
    sortBy = 'execution_count',
    limit = 100,
    offset = 0,
  } = params;

  let whereClause = `WHERE ${accountIdScopedWhere()}`;
  const queryParams: Record<string, any> = {
    org_id: orgId,
    account_id: accountId ?? null,
    minExecutions,
    limit,
    offset,
  };

  if (inputShapes && inputShapes.length > 0) {
    whereClause += ' AND input_shapes ALLINSIDE $inputShapes';
    queryParams.inputShapes = inputShapes;
  }

  if (outputShapes && outputShapes.length > 0) {
    whereClause += ' AND output_shapes ALLINSIDE $outputShapes';
    queryParams.outputShapes = outputShapes;
  }

  whereClause += ' AND execution_count >= $minExecutions';

  const orderByClause = `ORDER BY ${sortBy} DESC`;

  const query = `
    SELECT
      input_shapes,
      output_shapes,
      activity_templates,
      success_rate,
      execution_count,
      avg_cost_usd,
      avg_duration_ms
    FROM execution_pattern
    ${whereClause}
    ${orderByClause}
    LIMIT $limit
    START $offset
  `;

  const countQuery = `
    SELECT count() AS total FROM execution_pattern
    ${whereClause}
  `;

  const [patterns, countResult] = await Promise.all([
    surrealDB.query<Array<{
      input_shapes: string[];
      output_shapes: string[];
      activity_templates: string[];
      success_rate: number;
      execution_count: number;
      avg_cost_usd: number;
      avg_duration_ms: number;
    }>>(query, queryParams),
    surrealDB.query<Array<{ total: number }>>(countQuery, queryParams),
  ]);

  const total = (countResult?.[0] as any)?.total || 0;

  return {
    patterns: patterns?.[0] || [],
    total,
  };
}
