/**
 * Goal Execution Paths Routes (Phase 1.7)
 * 
 * Implements goal-based path tracking and Thompson Sampling recommendations:
 * - POST /goal-paths - Record path execution
 * - GET /goal-paths - Query paths for a goal
 * - POST /goal-paths/recommend - Thompson Sampling recommendation
 * - GET /goal-paths/stats - Global statistics
 */

import { Hono } from 'hono';
import crypto from 'crypto';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import {
  PathRecordRequestSchema,
  PathQuerySchema,
  PathRecommendationRequestSchema,
  PathStatsResponseSchema,
  PathsResponseSchema,
  PathRecommendationResponseSchema,
  type GoalExecutionPath,
  type PathRecordRequest,
  type PathQuery,
  type PathRecommendationRequest,
  type RecommendedPath,
} from '../models/schemas';

const app = new Hono();

/**
 * Normalize goal text for consistent hashing
 */
function normalizeGoal(goal: string): string {
  return goal
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '') // Remove punctuation
    .replace(/\s+/g, '_');   // Replace spaces with underscores
}

/**
 * Hash goal text to create goal_hash
 */
function hashGoal(goal: string): string {
  const normalized = normalizeGoal(goal);
  return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 16);
}

/**
 * Hash path activities to create path_signature
 */
function hashPath(activities: string[]): string {
  const signature = activities.join('->');
  return crypto.createHash('md5').update(signature).digest('hex').substring(0, 16);
}

/**
 * Sample from Beta distribution (Thompson Sampling)
 * Uses Wilson score interval approximation for speed
 */
function sampleBeta(alpha: number, beta: number): number {
  // For small sample sizes, use Wilson score
  if (alpha + beta < 10) {
    const n = alpha + beta - 2;
    const p = (alpha - 1) / n;
    const z = 1.96; // 95% confidence
    
    if (n === 0) return 0.5; // No data
    
    const wilson = (p + z*z/(2*n) - z * Math.sqrt((p*(1-p) + z*z/(4*n))/n)) / (1 + z*z/n);
    return Math.max(0, Math.min(1, wilson));
  }
  
  // For larger samples, use simple mean with small noise
  const mean = (alpha - 1) / (alpha + beta - 2);
  const noise = (Math.random() - 0.5) * 0.1; // +/- 5%
  return Math.max(0, Math.min(1, mean + noise));
}

/**
 * POST /goal-paths
 * Record execution of a goal-based path
 */
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const validated = PathRecordRequestSchema.parse(body);
    
    const goalHash = hashGoal(validated.goal_text);
    const pathSignature = hashPath(validated.path_activities);
    
    logger.info('Recording goal path', {
      goal: validated.goal_text,
      goal_hash: goalHash,
      path: validated.path_activities,
      success: validated.success,
    });
    
    // Check if this goal+path combination exists
    const checkQuery = `
      SELECT * FROM goal_execution_paths
      WHERE goal_hash = $goal_hash
        AND path_signature = $path_signature
      LIMIT 1
    `;
    
    const existing = await surrealDB.query<GoalExecutionPath[]>(checkQuery, {
      goal_hash: goalHash,
      path_signature: pathSignature,
    });
    
    let path: GoalExecutionPath;
    
    if (existing && existing.length > 0 && existing[0]) {
      // Update existing path
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing
      const newTotal = (current.total_executions || 0) + 1;
      // @ts-ignore - SurrealDB query typing
      const newSuccessful = (current.successful_executions || 0) + (validated.success ? 1 : 0);
      // @ts-ignore - SurrealDB query typing
      const newFailed = (current.failed_executions || 0) + (validated.success ? 0 : 1);
      
      // Thompson Sampling parameters (Beta distribution)
      const thompsonAlpha = newSuccessful + 1; // Prior: α = 1
      const thompsonBeta = newFailed + 1;      // Prior: β = 1
      const successRate = newSuccessful / newTotal;
      
      // Update rolling averages
      // @ts-ignore - SurrealDB query typing
      const currentAvgDuration = current.avg_duration_ms || 0;
      // @ts-ignore - SurrealDB query typing
      const currentAvgCost = current.avg_cost_usd || 0;
      // @ts-ignore - SurrealDB query typing
      const currentAvgTokens = current.avg_token_usage || 0;
      // @ts-ignore - SurrealDB query typing
      const currentTotal = current.total_executions || 0;
      
      const newAvgDuration = (currentAvgDuration * currentTotal + validated.duration_ms) / newTotal;
      const newAvgCost = (currentAvgCost * currentTotal + validated.cost_usd) / newTotal;
      const newAvgTokens = validated.token_usage !== undefined
        ? Math.floor((currentAvgTokens * currentTotal + validated.token_usage) / newTotal)
        : currentAvgTokens;
      
      const updateQuery = `
        UPDATE goal_execution_paths
        SET
          total_executions = $total_executions,
          successful_executions = $successful_executions,
          failed_executions = $failed_executions,
          thompson_alpha = $thompson_alpha,
          thompson_beta = $thompson_beta,
          success_rate = $success_rate,
          avg_duration_ms = $avg_duration_ms,
          avg_cost_usd = $avg_cost_usd,
          avg_token_usage = $avg_token_usage,
          last_executed_at = time::now(),
          updated_at = time::now()
        WHERE goal_hash = $goal_hash
          AND path_signature = $path_signature
        RETURN AFTER
      `;
      
      const updated = await surrealDB.query<GoalExecutionPath[]>(updateQuery, {
        goal_hash: goalHash,
        path_signature: pathSignature,
        total_executions: newTotal,
        successful_executions: newSuccessful,
        failed_executions: newFailed,
        thompson_alpha: thompsonAlpha,
        thompson_beta: thompsonBeta,
        success_rate: successRate,
        avg_duration_ms: newAvgDuration,
        avg_cost_usd: newAvgCost,
        avg_token_usage: newAvgTokens,
      });
      
      // @ts-ignore - SurrealDB query typing
      path = updated && updated.length > 0 ? updated[0] : current;
      
      logger.info('Updated goal path', {
        goal_hash: goalHash,
        total: newTotal,
        success_rate: successRate,
        thompson_alpha: thompsonAlpha,
        thompson_beta: thompsonBeta,
      });
    } else {
      // Create new path
      const thompsonAlpha = validated.success ? 2.0 : 1.0;
      const thompsonBeta = validated.success ? 1.0 : 2.0;
      const successRate = validated.success ? 1.0 : 0.0;
      
      const createQuery = `
        CREATE goal_execution_paths CONTENT {
          goal_hash: $goal_hash,
          goal_text: $goal_text,
          goal_category: $goal_category,
          path_activities: $path_activities,
          path_signature: $path_signature,
          total_executions: 1,
          successful_executions: $successful_executions,
          failed_executions: $failed_executions,
          thompson_alpha: $thompson_alpha,
          thompson_beta: $thompson_beta,
          success_rate: $success_rate,
          avg_duration_ms: $avg_duration_ms,
          avg_cost_usd: $avg_cost_usd,
          avg_token_usage: $avg_token_usage,
          typical_files_modified: $typical_files_modified,
          typical_tools_used: $typical_tools_used,
          last_executed_at: time::now(),
          created_at: time::now(),
          updated_at: time::now()
        }
      `;
      
      const created = await surrealDB.query<GoalExecutionPath[]>(createQuery, {
        goal_hash: goalHash,
        goal_text: validated.goal_text,
        goal_category: validated.goal_category,
        path_activities: validated.path_activities,
        path_signature: pathSignature,
        successful_executions: validated.success ? 1 : 0,
        failed_executions: validated.success ? 0 : 1,
        thompson_alpha: thompsonAlpha,
        thompson_beta: thompsonBeta,
        success_rate: successRate,
        avg_duration_ms: validated.duration_ms,
        avg_cost_usd: validated.cost_usd,
        avg_token_usage: validated.token_usage || 0,
        typical_files_modified: validated.files_modified ?? undefined,
        typical_tools_used: validated.tools_used ?? undefined,
      });
      
      // @ts-ignore - SurrealDB query typing
      path = created && created.length > 0 ? created[0] : {
        goal_hash: goalHash,
        goal_text: validated.goal_text,
        goal_category: validated.goal_category,
        path_activities: validated.path_activities,
        path_signature: pathSignature,
        total_executions: 1,
        successful_executions: validated.success ? 1 : 0,
        failed_executions: validated.success ? 0 : 1,
        thompson_alpha: thompsonAlpha,
        thompson_beta: thompsonBeta,
        success_rate: successRate,
        avg_duration_ms: validated.duration_ms,
        avg_cost_usd: validated.cost_usd,
        avg_token_usage: validated.token_usage || 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      logger.info('Created new goal path', {
        goal_hash: goalHash,
        success_rate: successRate,
      });
    }
    
    return c.json({
      success: true,
      path,
    });
    
  } catch (error: any) {
    logger.error('Failed to record goal path', {
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
      error: 'Failed to record goal path',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /goal-paths
 * Query paths for a specific goal
 */
app.get('/', async (c) => {
  try {
    const query = c.req.query();
    const validated = PathQuerySchema.parse({
      goal_text: query.goal_text,
      goal_hash: query.goal_hash,
      goal_category: query.goal_category,
      min_executions: query.min_executions ? parseInt(query.min_executions) : undefined,
      limit: query.limit ? parseInt(query.limit) : undefined,
      offset: query.offset ? parseInt(query.offset) : undefined,
    });
    
    let whereClause = '';
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };
    
    if (validated.goal_hash) {
      whereClause = 'WHERE goal_hash = $goal_hash';
      params.goal_hash = validated.goal_hash;
    } else if (validated.goal_text) {
      const goalHash = hashGoal(validated.goal_text);
      whereClause = 'WHERE goal_hash = $goal_hash';
      params.goal_hash = goalHash;
    } else if (validated.goal_category) {
      whereClause = 'WHERE goal_category = $goal_category';
      params.goal_category = validated.goal_category;
    }
    
    if (validated.min_executions > 1) {
      whereClause += whereClause ? ' AND ' : 'WHERE ';
      whereClause += 'total_executions >= $min_executions';
      params.min_executions = validated.min_executions;
    }
    
    const selectQuery = `
      SELECT * FROM goal_execution_paths
      ${whereClause}
      ORDER BY success_rate DESC, total_executions DESC
      LIMIT $limit
      START $offset
    `;
    
    const paths = await surrealDB.query<GoalExecutionPath[]>(selectQuery, params);
    
    const countQuery = `
      SELECT count() AS total FROM goal_execution_paths
      ${whereClause}
      GROUP ALL
    `;
    
    const countResult = await surrealDB.query<{ total: number }[]>(countQuery, params);
    const total = countResult && countResult.length > 0 ? countResult[0].total : 0;
    
    const response = PathsResponseSchema.parse({
      paths: paths || [],
      total,
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to query goal paths', {
      error: error.message,
    });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to query goal paths',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /goal-paths/recommend
 * Thompson Sampling recommendation for a goal
 */
app.post('/recommend', async (c) => {
  try {
    const body = await c.req.json();
    const validated = PathRecommendationRequestSchema.parse(body);
    
    const goalHash = hashGoal(validated.goal_text);
    
    logger.info('Recommending path for goal', {
      goal: validated.goal_text,
      goal_hash: goalHash,
      exploration_rate: validated.exploration_rate,
    });
    
    // Get all paths for this goal
    let whereClause = 'WHERE goal_hash = $goal_hash';
    const params: Record<string, any> = { goal_hash: goalHash };
    
    if (validated.goal_category) {
      whereClause += ' AND goal_category = $goal_category';
      params.goal_category = validated.goal_category;
    }
    
    const selectQuery = `
      SELECT * FROM goal_execution_paths
      ${whereClause}
      ORDER BY total_executions DESC
    `;
    
    const paths = await surrealDB.query<GoalExecutionPath[]>(selectQuery, params);
    
    if (!paths || paths.length === 0) {
      return c.json(PathRecommendationResponseSchema.parse({
        goal_hash: goalHash,
        recommended_paths: [],
      }));
    }
    
    // Decide: exploration vs exploitation
    const shouldExplore = Math.random() < validated.exploration_rate;
    
    let recommendedPaths: RecommendedPath[];
    
    if (shouldExplore) {
      // Exploration: prefer paths with fewer executions (UCB-style)
      logger.info('Thompson Sampling: EXPLORE mode');
      
      const sorted = paths
        .sort((a, b) => {
          // @ts-ignore
          const aExec = a.total_executions || 0;
          // @ts-ignore
          const bExec = b.total_executions || 0;
          return aExec - bExec; // Ascending (fewer executions first)
        })
        .slice(0, validated.top_k);
      
      recommendedPaths = sorted.map(p => ({
        // @ts-ignore
        path_activities: p.path_activities,
        confidence: 0.5, // Neutral confidence for exploration
        // @ts-ignore
        success_rate: p.success_rate || 0,
        // @ts-ignore
        avg_duration_ms: p.avg_duration_ms || 0,
        // @ts-ignore
        avg_cost_usd: p.avg_cost_usd || 0,
        // @ts-ignore
        total_executions: p.total_executions || 0,
        // @ts-ignore
        exploration_bonus: 1.0 / ((p.total_executions || 0) + 1),
      }));
    } else {
      // Exploitation: sample from Beta distributions
      logger.info('Thompson Sampling: EXPLOIT mode');
      
      const samples = paths.map(p => ({
        path: p,
        // @ts-ignore
        sample: sampleBeta(p.thompson_alpha || 1, p.thompson_beta || 1),
      }));
      
      samples.sort((a, b) => b.sample - a.sample); // Descending
      
      recommendedPaths = samples.slice(0, validated.top_k).map(s => ({
        // @ts-ignore
        path_activities: s.path.path_activities,
        confidence: s.sample,
        // @ts-ignore
        success_rate: s.path.success_rate || 0,
        // @ts-ignore
        avg_duration_ms: s.path.avg_duration_ms || 0,
        // @ts-ignore
        avg_cost_usd: s.path.avg_cost_usd || 0,
        // @ts-ignore
        total_executions: s.path.total_executions || 0,
      }));
    }
    
    const response = PathRecommendationResponseSchema.parse({
      goal_hash: goalHash,
      recommended_paths: recommendedPaths,
    });
    
    logger.info('Recommended paths', {
      goal_hash: goalHash,
      count: recommendedPaths.length,
      mode: shouldExplore ? 'explore' : 'exploit',
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to recommend path', {
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
      error: 'Failed to recommend path',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /goal-paths/stats
 * Global statistics on goal paths
 */
app.get('/stats', async (c) => {
  try {
    // Total unique goals (SurrealDB doesn't support count(DISTINCT), use subquery)
    const goalsQuery = `
      SELECT count() AS total FROM (
        SELECT goal_hash FROM goal_execution_paths GROUP BY goal_hash
      ) GROUP ALL
    `;
    const goalsResult = await surrealDB.query<{ total: number }[]>(goalsQuery);
    const totalGoals = goalsResult && goalsResult.length > 0 ? goalsResult[0].total : 0;
    
    // Total paths
    const pathsQuery = `
      SELECT count() AS total FROM goal_execution_paths
      GROUP ALL
    `;
    const pathsResult = await surrealDB.query<{ total: number }[]>(pathsQuery);
    const totalPaths = pathsResult && pathsResult.length > 0 ? pathsResult[0].total : 0;
    
    // Avg paths per goal
    const avgPathsPerGoal = totalGoals > 0 ? totalPaths / totalGoals : 0;
    
    // Most common goals (by path count)
    const commonGoalsQuery = `
      SELECT 
        goal_hash,
        goal_text,
        count() AS path_count
      FROM goal_execution_paths
      GROUP BY goal_hash, goal_text
      ORDER BY path_count DESC
      LIMIT 10
    `;
    const mostCommonGoals = await surrealDB.query<{
      goal_hash: string;
      goal_text: string;
      path_count: number;
    }[]>(commonGoalsQuery);
    
    // Best performing paths
    const bestPathsQuery = `
      SELECT 
        goal_text,
        path_activities,
        success_rate,
        total_executions
      FROM goal_execution_paths
      WHERE total_executions >= 3
      ORDER BY success_rate DESC, total_executions DESC
      LIMIT 10
    `;
    const bestPerformingPaths = await surrealDB.query<{
      goal_text: string;
      path_activities: string[];
      success_rate: number;
      total_executions: number;
    }[]>(bestPathsQuery);
    
    const response = PathStatsResponseSchema.parse({
      total_goals: totalGoals,
      total_paths: totalPaths,
      avg_paths_per_goal: avgPathsPerGoal,
      most_common_goals: mostCommonGoals || [],
      best_performing_paths: bestPerformingPaths || [],
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to get path stats', {
      error: error.message,
    });
    
    return c.json({
      error: 'Failed to get path stats',
      message: error.message,
    }, 500);
  }
});

export default app;
