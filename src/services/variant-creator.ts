/**
 * Variant Creator Service
 *
 * Automatically creates activity template variants from failed executions.
 * Implements trailblazing: when a template fails repeatedly, create a variant
 * with modified approach.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

export interface VariantCreationResult {
  variantId: string;
  variantGeneration: number;
  reason: string;
  modifications: string[];
}

export interface FailurePattern {
  templateId: string;
  consecutiveFailures: number;
  totalExecutions: number;
  successRate: number;
  commonErrors: string[];
  failedTasks: string[];
}

/**
 * Check if a template should have a variant created
 * Returns failure pattern if variant creation is warranted
 */
export async function shouldCreateVariant(
  templateId: string,
  orgId: string
): Promise<FailurePattern | null> {
  try {
    // Get recent execution history (last 10 executions)
    const recentExecutions = await surrealDB.query<any[]>(`
      SELECT success, error, created_at
      FROM execution
      WHERE activity_id = $template_id
        AND org_id = $org_id
      ORDER BY created_at DESC
      LIMIT 10
    `, {
      template_id: templateId,
      org_id: orgId,
    });

    if (!recentExecutions || recentExecutions.length === 0) {
      return null;
    }

    const executions = recentExecutions[0] || [];

    // Count consecutive failures from most recent
    let consecutiveFailures = 0;
    for (const exec of executions) {
      if (exec.success === false) {
        consecutiveFailures++;
      } else {
        break;
      }
    }

    // Need at least 3 consecutive failures to create variant
    if (consecutiveFailures < 3) {
      return null;
    }

    // Get overall statistics
    const stats = await surrealDB.query<any[]>(`
      SELECT
        count() AS total_executions,
        math::sum(success = true) AS successes,
        math::sum(success = false) AS failures,
        array::group(error.message) AS error_messages,
        array::group(error.task_id) AS failed_task_ids
      FROM execution
      WHERE activity_id = $template_id
        AND org_id = $org_id
    `, {
      template_id: templateId,
      org_id: orgId,
    });

    const statData = stats[0]?.[0];
    if (!statData) {
      return null;
    }

    const totalExecutions = statData.total_executions || 0;
    const successes = statData.successes || 0;
    const failures = statData.failures || 0;
    const successRate = totalExecutions > 0 ? successes / totalExecutions : 0;

    // Extract unique error messages and failed task IDs
    const errorMessages = Array.from(new Set(
      (statData.error_messages || []).filter(Boolean) as string[]
    )).slice(0, 5);

    const failedTaskIds = Array.from(new Set(
      (statData.failed_task_ids || []).filter(Boolean) as string[]
    )).slice(0, 5);

    return {
      templateId,
      consecutiveFailures,
      totalExecutions,
      successRate,
      commonErrors: errorMessages,
      failedTasks: failedTaskIds,
    };
  } catch (error) {
    logger.error('Error checking if variant should be created', {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Generate variant modifications based on failure patterns
 */
function generateVariantModifications(
  originalTemplate: any,
  failurePattern: FailurePattern
): { modifiedTemplate: any; modifications: string[] } {
  const modifications: string[] = [];
  const modifiedTemplate = JSON.parse(JSON.stringify(originalTemplate));

  // 1. Add validation steps for frequently failing tasks
  if (failurePattern.failedTasks.length > 0 && modifiedTemplate.tasks) {
    for (const taskId of failurePattern.failedTasks) {
      const taskIndex = modifiedTemplate.tasks.findIndex((t: any) => t.id === taskId);
      if (taskIndex >= 0) {
        const task = modifiedTemplate.tasks[taskIndex];

        // Add more rigorous validation
        if (!task.validation) {
          task.validation = {};
        }

        // Increase retry attempts for failing tasks
        if (!task.retry) {
          task.retry = { maxAttempts: 3, strategy: 'exponential_backoff' };
        } else {
          task.retry.maxAttempts = Math.min((task.retry.maxAttempts || 2) + 1, 5);
        }

        modifications.push(`Increased retry attempts for task '${task.id}' to ${task.retry.maxAttempts}`);
      }
    }
  }

  // 2. Modify prompts to include failure context
  if (failurePattern.commonErrors.length > 0 && modifiedTemplate.tasks) {
    for (const task of modifiedTemplate.tasks) {
      if (task.prompt?.template) {
        const errorContext = failurePattern.commonErrors
          .map(e => `- ${e}`)
          .join('\n');

        // Prepend error awareness to prompt
        const errorAwareness = `
IMPORTANT: Previous attempts failed with these errors:
${errorContext}

Please be especially careful to avoid these issues.

`;
        task.prompt.template = errorAwareness + task.prompt.template;
        modifications.push(`Added error awareness to task '${task.id}' prompt`);
      }
    }
  }

  // 3. Reorder tasks if there's a dependency issue pattern
  // If early tasks are failing, try adding a preparation task
  if (modifiedTemplate.tasks && modifiedTemplate.tasks.length > 1) {
    const firstTaskId = modifiedTemplate.tasks[0].id;
    if (failurePattern.failedTasks.includes(firstTaskId)) {
      // Add a validation/preparation task at the beginning
      const prepTask = {
        id: 'prep_validation',
        description: 'Validate environment and prerequisites before main execution',
        resolver: 'bash',
        config: {
          command: 'echo "Validating environment..." && pwd && ls -la',
        },
        validation: {
          exitCode: 0,
        },
        retry: {
          maxAttempts: 2,
          strategy: 'immediate',
        },
      };

      modifiedTemplate.tasks.unshift(prepTask);
      modifications.push('Added preparation/validation task at start of execution');
    }
  }

  // 4. Add success criteria clarification
  if (modifiedTemplate.description) {
    modifiedTemplate.description = modifiedTemplate.description +
      `\n\nVariant created to address failure patterns. Success rate of parent: ${(failurePattern.successRate * 100).toFixed(1)}%.`;
  }

  return { modifiedTemplate, modifications };
}

/**
 * Create a variant of an activity template
 */
export async function createVariant(
  parentTemplateId: string,
  failurePattern: FailurePattern,
  orgId: string,
  reason: string = 'consecutive_failures'
): Promise<VariantCreationResult | null> {
  try {
    // Get parent template
    const parentResult = await surrealDB.query<any[]>(`
      SELECT * FROM activity
      WHERE id = $template_id
        AND org_id = $org_id
      LIMIT 1
    `, {
      template_id: parentTemplateId,
      org_id: orgId,
    });

    const parentTemplate = parentResult[0]?.[0];
    if (!parentTemplate) {
      logger.error('Parent template not found for variant creation', {
        parentTemplateId,
        orgId,
      });
      return null;
    }

    // Check if parent already has too many variants
    const existingVariants = await surrealDB.query<any[]>(`
      SELECT count() AS count
      FROM activity
      WHERE variant_of = $parent_id
        AND org_id = $org_id
    `, {
      parent_id: parentTemplateId,
      org_id: orgId,
    });

    const variantCount = existingVariants[0]?.[0]?.count || 0;
    if (variantCount >= 5) {
      logger.warn('Parent template already has maximum variants', {
        parentTemplateId,
        variantCount,
      });
      return null;
    }

    // Generate variant modifications
    const { modifiedTemplate, modifications } = generateVariantModifications(
      parentTemplate,
      failurePattern
    );

    // Calculate variant generation
    const parentGeneration = parentTemplate.variant_generation || 0;
    const variantGeneration = parentGeneration + 1;

    // Create unique variant ID
    const variantId = `${parentTemplateId}.v${variantGeneration}.${Date.now()}`;

    // Create variant in database
    const variantName = `${parentTemplate.name} (Variant ${variantGeneration})`;

    await surrealDB.query(`
      CREATE activity:⟨$variant_id⟩ SET
        name = $name,
        description = $description,
        tags = $tags,
        category = $category,
        tasks = $tasks,
        scope = $scope,
        org_id = $org_id,
        project_id = $project_id,
        input_shapes = $input_shapes,
        output_shapes = $output_shapes,
        execution_type = $execution_type,
        variant_of = $variant_of,
        variant_generation = $variant_generation,
        variant_reason = $variant_reason,
        retired = false
    `, {
      variant_id: variantId,
      name: variantName,
      description: modifiedTemplate.description,
      tags: modifiedTemplate.tags || [],
      category: modifiedTemplate.category,
      tasks: modifiedTemplate.tasks || [],
      scope: parentTemplate.scope,
      org_id: orgId,
      project_id: parentTemplate.project_id,
      input_shapes: modifiedTemplate.input_shapes || [],
      output_shapes: modifiedTemplate.output_shapes || [],
      execution_type: parentTemplate.execution_type || 'template',
      variant_of: parentTemplateId,
      variant_generation: variantGeneration,
      variant_reason: reason,
    });

    logger.info('Created activity variant', {
      parentTemplateId,
      variantId,
      variantGeneration,
      modifications: modifications.length,
      reason,
    });

    return {
      variantId,
      variantGeneration,
      reason,
      modifications,
    };
  } catch (error) {
    logger.error('Error creating variant', {
      parentTemplateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check and retire poorly performing templates
 * Retirement criteria: Success rate < 30% over last 20 executions
 */
export async function checkAndRetireTemplate(
  templateId: string,
  orgId: string
): Promise<boolean> {
  try {
    // Get last 20 executions
    const recentExecutions = await surrealDB.query<any[]>(`
      SELECT success
      FROM execution
      WHERE activity_id = $template_id
        AND org_id = $org_id
      ORDER BY created_at DESC
      LIMIT 20
    `, {
      template_id: templateId,
      org_id: orgId,
    });

    const executions = recentExecutions[0] || [];

    // Need at least 20 executions to retire
    if (executions.length < 20) {
      return false;
    }

    // Calculate success rate
    const successes = executions.filter((e: any) => e.success === true).length;
    const successRate = successes / executions.length;

    // Retire if success rate < 30%
    if (successRate < 0.3) {
      await surrealDB.query(`
        UPDATE activity:⟨$template_id⟩ SET
          retired = true,
          retired_at = time::now(),
          retired_reason = "poor_performance"
      `, {
        template_id: templateId,
      });

      logger.info('Retired template due to poor performance', {
        templateId,
        successRate,
        executionCount: executions.length,
      });

      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking template retirement', {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Auto-create variant after recording execution if needed
 */
export async function autoCreateVariantIfNeeded(
  templateId: string,
  orgId: string,
  executionSuccess: boolean
): Promise<VariantCreationResult | null> {
  // Only check after failures
  if (executionSuccess) {
    return null;
  }

  // Check if variant should be created
  const failurePattern = await shouldCreateVariant(templateId, orgId);
  if (!failurePattern) {
    return null;
  }

  // Check if we already created a variant recently (within last hour)
  const recentVariants = await surrealDB.query<any[]>(`
    SELECT created_at
    FROM activity
    WHERE variant_of = $parent_id
      AND org_id = $org_id
      AND created_at > time::now() - 1h
    LIMIT 1
  `, {
    parent_id: templateId,
    org_id: orgId,
  });

  if (recentVariants[0] && recentVariants[0].length > 0) {
    logger.debug('Variant already created recently, skipping', {
      templateId,
    });
    return null;
  }

  // Create the variant
  return await createVariant(
    templateId,
    failurePattern,
    orgId,
    'consecutive_failures'
  );
}
