/**
 * Task Generator Service
 *
 * Automatically detects self-development opportunities from execution metrics
 * and generates boredom tasks to drive continuous improvement.
 *
 * Opportunity Detection:
 * 1. Failing templates (success_rate < threshold) → debug tasks
 * 2. Slow templates (duration > baseline) → optimize tasks
 * 3. Recent failures → immediate debug tasks
 * 4. Periodic self-improvement → background dev tasks
 *
 * Integration:
 * - Scheduled job (every 5 min): detectOpportunities()
 * - Post-execution hook: analyzeExecution()
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface BoredomTask {
  id: string;
  goal?: string;          // Goal-based execution (preferred)
  templateId?: string;    // Template-based execution (legacy fallback)
  priority: 'critical' | 'high' | 'medium' | 'low';
  variables: Record<string, unknown>;
  reason?: string;
  createdAt: number;
}

interface TemplateMetrics {
  variant_id: string;
  activity_id: string;
  variant_name: string;
  total_executions: number;
  successful_executions: number;
  failed_executions: number;
  success_rate: number;
  avg_duration_ms: number;
  avg_cost_usd: number;
  thompson_alpha: number;
  thompson_beta: number;
  last_executed_at: string;
}

interface ExecutionTrace {
  execution_id: string;
  template_id: string;
  status: 'success' | 'failure' | 'partial';
  duration_ms: number;
  cost_usd: number;
  execution_trace: {
    tasks: Array<{
      taskId: string;
      status: string;
      error?: string;
      output?: string;
    }>;
    filesModified?: string[];
    goalContext?: {
      goal: string;
      intent: string;
    };
  };
  created_at: string;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = {
  // Thresholds for opportunity detection
  failureThreshold: 0.5,        // Templates with <50% success rate need debugging
  minExecutionsForAnalysis: 3,  // Need at least 3 executions to analyze
  slowTemplateMultiplier: 1.5,  // Template is slow if >150% of average
  recentWindowHours: 24,        // Look at executions from last 24 hours

  // Task generation limits
  maxTasksPerCycle: 10,         // Max tasks to generate per detection cycle
  selfImproveProbability: 0.2,  // 20% chance of generating self-improvement task

  // Target repositories for self-development
  targetRepos: [
    'repos/minibob',
    'repos/metabob-activity-api',
    'repos/activity-dashboard',
  ],
};

// =============================================================================
// TASK GENERATOR CLASS
// =============================================================================

export class TaskGenerator {
  /**
   * Detect all improvement opportunities from current system state
   * Called by scheduled job every 5 minutes
   */
  async detectOpportunities(): Promise<BoredomTask[]> {
    const tasks: BoredomTask[] = [];

    try {
      // 1. Find failing templates
      const failingTasks = await this.detectFailingTemplates();
      tasks.push(...failingTasks);

      // 2. Find slow templates
      const slowTasks = await this.detectSlowTemplates();
      tasks.push(...slowTasks);

      // 3. Periodic self-improvement (probabilistic)
      const improveTasks = await this.generateSelfImprovementTasks();
      tasks.push(...improveTasks);

      // 4. System inspection tasks (probabilistic)
      const inspectionTasks = await this.generateInspectionTasks();
      tasks.push(...inspectionTasks);

      // Limit total tasks per cycle
      const limitedTasks = tasks.slice(0, CONFIG.maxTasksPerCycle);

      logger.info('[TaskGenerator] Detected opportunities', {
        total: tasks.length,
        enqueued: limitedTasks.length,
        failing: failingTasks.length,
        slow: slowTasks.length,
        selfImprove: improveTasks.length,
        inspection: inspectionTasks.length,
      });

      return limitedTasks;
    } catch (error) {
      logger.error('[TaskGenerator] Error detecting opportunities', { error });
      return [];
    }
  }

  /**
   * Analyze a specific execution trace and generate immediate tasks
   * Called as post-execution hook
   */
  async analyzeExecution(trace: ExecutionTrace): Promise<BoredomTask[]> {
    const tasks: BoredomTask[] = [];

    try {
      if (trace.status === 'failure') {
        // Immediate debug task for failed execution
        const failedTask = trace.execution_trace.tasks.find(t => t.status === 'failed');

        tasks.push({
          id: `task_${Date.now()}_debug_${trace.execution_id.slice(-6)}`,
          templateId: 'debug-failed-execution',
          priority: 'high',
          variables: {
            executionId: trace.execution_id,
            templateId: trace.template_id,
            error: failedTask?.error ?? 'Unknown error',
            failedTaskId: failedTask?.taskId,
            goalContext: trace.execution_trace.goalContext?.goal,
          },
          reason: `Debug failed execution of ${trace.template_id}`,
          createdAt: Date.now(),
        });

        logger.info('[TaskGenerator] Generated debug task for failed execution', {
          executionId: trace.execution_id,
          templateId: trace.template_id,
        });
      }

      return tasks;
    } catch (error) {
      logger.error('[TaskGenerator] Error analyzing execution', { error });
      return [];
    }
  }

  /**
   * Find templates with low success rates
   */
  private async detectFailingTemplates(): Promise<BoredomTask[]> {
    const tasks: BoredomTask[] = [];

    const query = `
      SELECT
        variant_id,
        activity_id,
        total_executions,
        successful_executions,
        failed_executions,
        success_rate,
        thompson_alpha,
        thompson_beta,
        last_executed_at
      FROM variant_performance_metrics
      WHERE total_executions >= $minExecutions
        AND success_rate < $threshold
      ORDER BY failed_executions DESC
      LIMIT 5
    `;

    const failingTemplates = await surrealDB.query<TemplateMetrics>(query, {
      minExecutions: CONFIG.minExecutionsForAnalysis,
      threshold: CONFIG.failureThreshold,
    });

    for (const template of failingTemplates) {
      // Get recent failure details
      const failuresQuery = `
        SELECT
          execution_id,
          status,
          duration_ms,
          execution_trace,
          created_at
        FROM execution_traces
        WHERE template_id = $templateId
          AND status = 'failure'
        ORDER BY created_at DESC
        LIMIT 3
      `;

      let recentFailures: ExecutionTrace[] = [];
      try {
        recentFailures = await surrealDB.query<ExecutionTrace>(failuresQuery, {
          templateId: template.variant_id,
        });
      } catch (e) {
        // Table might not exist or be empty
      }

      // Generate a goal instead of using a template
      const errorSummary = recentFailures
        .map(f => f.execution_trace?.tasks?.find(t => t.status === 'failed')?.error)
        .filter(Boolean)
        .slice(0, 2)
        .join('; ') || 'Unknown errors';

      tasks.push({
        id: `task_${Date.now()}_debug_${template.variant_id.slice(-8)}`,
        // Goal-based execution: describe what needs to be done
        goal: `Investigate why activity "${template.variant_id}" has ${Math.round(template.success_rate * 100)}% success rate after ${template.total_executions} executions. Recent errors: ${errorSummary}. Analyze the failure patterns, identify root causes, and suggest specific fixes.`,
        priority: template.success_rate < 0.3 ? 'critical' : 'high',
        variables: {
          failingTemplateId: template.variant_id,
          activityId: template.activity_id,
          successRate: template.success_rate,
          totalExecutions: template.total_executions,
          failedExecutions: template.failed_executions,
        },
        reason: `Template ${template.variant_id} has ${Math.round(template.success_rate * 100)}% success rate (${template.failed_executions} failures)`,
        createdAt: Date.now(),
      });
    }

    return tasks;
  }

  /**
   * Find templates that are running slower than expected
   */
  private async detectSlowTemplates(): Promise<BoredomTask[]> {
    const tasks: BoredomTask[] = [];

    // Get average duration across all templates
    const avgQuery = `
      SELECT math::mean(avg_duration_ms) AS global_avg
      FROM variant_performance_metrics
      WHERE total_executions >= $minExecutions
      GROUP ALL
    `;

    let globalAvg = 30000; // Default 30 seconds
    try {
      const avgResult = await surrealDB.query<{ global_avg: number }>(avgQuery, {
        minExecutions: CONFIG.minExecutionsForAnalysis,
      });
      if (avgResult.length > 0 && avgResult[0].global_avg) {
        globalAvg = avgResult[0].global_avg;
      }
    } catch (e) {
      // Use default
    }

    const slowThreshold = globalAvg * CONFIG.slowTemplateMultiplier;

    const query = `
      SELECT
        variant_id,
        activity_id,
        avg_duration_ms,
        total_executions,
        success_rate
      FROM variant_performance_metrics
      WHERE total_executions >= $minExecutions
        AND avg_duration_ms > $threshold
        AND success_rate > 0.5
      ORDER BY avg_duration_ms DESC
      LIMIT 3
    `;

    const slowTemplates = await surrealDB.query<TemplateMetrics>(query, {
      minExecutions: CONFIG.minExecutionsForAnalysis,
      threshold: slowThreshold,
    });

    for (const template of slowTemplates) {
      tasks.push({
        id: `task_${Date.now()}_optimize_${template.variant_id.slice(-8)}`,
        // Goal-based: describe optimization needed
        goal: `Optimize activity "${template.variant_id}" which takes ${Math.round(template.avg_duration_ms / 1000)}s on average (${(template.avg_duration_ms / globalAvg).toFixed(1)}x slower than system average of ${Math.round(globalAvg / 1000)}s). Analyze the activity steps, identify bottlenecks, and suggest optimizations to reduce execution time.`,
        priority: 'medium',
        variables: {
          templateId: template.variant_id,
          activityId: template.activity_id,
          currentDurationMs: template.avg_duration_ms,
          globalAvgMs: globalAvg,
        },
        reason: `Template ${template.variant_id} is ${(template.avg_duration_ms / globalAvg).toFixed(1)}x slower than average`,
        createdAt: Date.now(),
      });
    }

    return tasks;
  }

  /**
   * Generate periodic self-improvement tasks
   */
  private async generateSelfImprovementTasks(): Promise<BoredomTask[]> {
    const tasks: BoredomTask[] = [];

    // Probabilistic generation
    if (Math.random() > CONFIG.selfImproveProbability) {
      return tasks;
    }

    // Rotate through target repositories
    const repoIndex = Math.floor(Date.now() / 1000) % CONFIG.targetRepos.length;
    const targetRepo = CONFIG.targetRepos[repoIndex];

    // Select improvement focus area
    const focusAreas = [
      'error-handling',
      'type-safety',
      'performance',
      'code-clarity',
      'test-coverage',
    ];
    const focusIndex = Math.floor(Math.random() * focusAreas.length);
    const focusArea = focusAreas[focusIndex];

    tasks.push({
      id: `task_${Date.now()}_improve_${targetRepo.split('/')[1]}`,
      // Goal-based self-improvement
      goal: `Review ${targetRepo} and identify opportunities to improve ${focusArea}. Look for specific issues, propose concrete fixes, and implement up to 3 small improvements. Focus on code quality and maintainability.`,
      priority: 'low',
      variables: {
        targetRepo,
        focusArea,
        maxChanges: 3,
      },
      reason: `Periodic self-improvement: ${focusArea} in ${targetRepo}`,
      createdAt: Date.now(),
    });

    return tasks;
  }

  /**
   * Generate system inspection tasks
   * These review the activity system itself
   */
  async generateInspectionTasks(): Promise<BoredomTask[]> {
    const tasks: BoredomTask[] = [];

    // Probabilistic - 10% chance per cycle
    if (Math.random() > 0.1) {
      return tasks;
    }

    // Rotate through inspection types
    const inspectionTypes = [
      {
        id: 'validation-audit',
        goal: 'Audit the activity system validation: Fetch templates from the backend API, analyze which activities have validation criteria in their task_steps, identify activities with weak or missing validation, and write a report to /workspace/validation-audit.md with recommendations.',
        priority: 'medium' as const,
        reason: 'Periodic validation audit',
      },
      {
        id: 'metrics-review',
        goal: 'Review activity system metrics: Fetch performance data from the backend, identify top-performing activities (high success rate, low duration), identify struggling activities, and write a system health report to /workspace/system-health.md.',
        priority: 'low' as const,
        reason: 'Periodic metrics review',
      },
      {
        id: 'capability-gaps',
        goal: 'Analyze capability gaps in the activity system: Review existing activities by category, identify missing capabilities or categories with few activities, suggest new activities that would improve system coverage, and write recommendations to /workspace/capability-gaps.md.',
        priority: 'low' as const,
        reason: 'Capability gap analysis',
      },
      {
        id: 'thompson-sampling-health',
        goal: 'Review Thompson Sampling health: Fetch activity metrics, identify activities with extreme alpha/beta ratios that may indicate stale or biased data, suggest metric resets or adjustments, and write findings to /workspace/thompson-health.md.',
        priority: 'low' as const,
        reason: 'Thompson Sampling health check',
      },
    ];

    const typeIndex = Math.floor(Date.now() / (1000 * 60 * 60)) % inspectionTypes.length; // Rotate hourly
    const inspection = inspectionTypes[typeIndex];

    if (inspection) {
      tasks.push({
        id: `task_${Date.now()}_inspect_${inspection.id}`,
        goal: inspection.goal,
        priority: inspection.priority,
        variables: {
          inspectionType: inspection.id,
          timestamp: new Date().toISOString(),
        },
        reason: inspection.reason,
        createdAt: Date.now(),
      });
    }

    return tasks;
  }

  /**
   * Get current queue statistics
   */
  async getQueueStats(): Promise<{
    pendingByPriority: Record<string, number>;
    recentlyGenerated: number;
    templatesNeedingAttention: number;
  }> {
    // Count templates needing attention
    const attentionQuery = `
      SELECT count() AS count
      FROM variant_performance_metrics
      WHERE total_executions >= $minExecutions
        AND success_rate < $threshold
      GROUP ALL
    `;

    let templatesNeedingAttention = 0;
    try {
      const result = await surrealDB.query<{ count: number }>(attentionQuery, {
        minExecutions: CONFIG.minExecutionsForAnalysis,
        threshold: CONFIG.failureThreshold,
      });
      if (result.length > 0) {
        templatesNeedingAttention = result[0].count;
      }
    } catch (e) {
      // Ignore
    }

    return {
      pendingByPriority: {}, // Would need Redis access
      recentlyGenerated: 0,  // Would need tracking
      templatesNeedingAttention,
    };
  }
}

// Singleton instance
export const taskGenerator = new TaskGenerator();
