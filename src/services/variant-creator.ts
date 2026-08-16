/**
 * Variant Creator Service
 *
 * Automatically creates activity template variants from failed executions.
 * Implements trailblazing: when a template fails repeatedly, create a variant
 * with modified approach.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { accountIdScopedWhere } from '../routes/activities';
import { getTuningParam } from '../lib/tuning-params';

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
 *
 * Phase B4a: dual-tenant scoping. Prefer account_id; legacy execution rows
 * (account_id IS NONE) match via the org_id branch. accountId optional —
 * legacy callers passing only orgId still resolve through the org_id branch.
 */
export async function shouldCreateVariant(
  templateId: string,
  orgId: string,
  accountId?: string | null
): Promise<FailurePattern | null> {
  try {
    // Get recent execution history (last 10 executions)
    const recentExecutions = await surrealDB.query<any[]>(`
      SELECT success, error, created_at
      FROM execution
      WHERE activity_id = $template_id
        AND ${accountIdScopedWhere()}
      ORDER BY created_at DESC
      LIMIT 10
    `, {
      template_id: templateId,
      org_id: orgId,
      account_id: accountId ?? null,
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
        AND ${accountIdScopedWhere()}
    `, {
      template_id: templateId,
      org_id: orgId,
      account_id: accountId ?? null,
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
 *
 * Phase B4a: dual-tenant scoping on reads + dual-write account_id on the new
 * variant row. accountId optional for legacy callers.
 */
export async function createVariant(
  parentTemplateId: string,
  failurePattern: FailurePattern,
  orgId: string,
  reason: string = 'consecutive_failures',
  accountId?: string | null
): Promise<VariantCreationResult | null> {
  try {
    // Get parent template
    const parentResult = await surrealDB.query<any[]>(`
      SELECT * FROM activity
      WHERE id = $template_id
        AND ${accountIdScopedWhere()}
      LIMIT 1
    `, {
      template_id: parentTemplateId,
      org_id: orgId,
      account_id: accountId ?? null,
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
        AND ${accountIdScopedWhere()}
    `, {
      parent_id: parentTemplateId,
      org_id: orgId,
      account_id: accountId ?? null,
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

    // Phase B4a: dual-write account_id alongside org_id. account_id is
    // option<string>; null is valid when caller has no accountId claim.
    // account_id_version=1 marks this row as Phase B dual-written.
    await surrealDB.query(`
      CREATE type::thing("activity", $variant_id) SET
        name = $name,
        description = $description,
        tags = $tags,
        category = $category,
        tasks = $tasks,
        scope = $scope,
        org_id = $org_id,
        account_id = $account_id,
        account_id_version = $account_id_version,
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
      account_id: accountId ?? null,
      account_id_version: 1,
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
 *
 * Phase B4a: dual-tenant scoping on reads. The UPDATE on activity:⟨id⟩ is
 * a record-id targeted update with no org_id WHERE clause, so no change
 * needed there.
 */
export async function checkAndRetireTemplate(
  templateId: string,
  orgId: string,
  accountId?: string | null
): Promise<boolean> {
  try {
    // Get last 20 executions
    const recentExecutions = await surrealDB.query<any[]>(`
      SELECT success
      FROM execution
      WHERE activity_id = $template_id
        AND ${accountIdScopedWhere()}
      ORDER BY created_at DESC
      LIMIT 20
    `, {
      template_id: templateId,
      org_id: orgId,
      account_id: accountId ?? null,
    });

    const executions = recentExecutions[0] || [];

    // Need at least 20 executions to retire
    if (executions.length < 20) {
      return false;
    }

    // Calculate success rate
    const successes = executions.filter((e: any) => e.success === true).length;
    const successRate = successes / executions.length;

    // BIND THE RECORD ID, DO NOT INTERPOLATE IT INTO THE BRACKETS.
    //
    // This UPDATE read `activity:⟨$template_id⟩`. SurrealQL parameters bind VALUES, not
    // IDENTIFIERS, so that targets a record whose id is the literal text "$template_id" — it
    // matches nothing, changes nothing, and returns success. Proven against the live store:
    //
    //   LET $tid = "testrec"; UPDATE zz_probe:⟨$tid⟩        SET retired = true;  -> [] , unchanged
    //   LET $tid = "testrec"; UPDATE type::thing("zz_probe2", $tid) SET retired = true;  -> retired: true
    //
    // And the consequence, measured: across 3,849 activities (1,210 of them retired by other
    // paths) the count of `retired_reason = "poor_performance"` is ZERO. This sweep has never
    // once retired anything. `retired` is the OPERATIVE flag selection filters on, so every arm
    // that earned retirement stayed fully selectable — including one observed at 202 executions
    // and 0 successes, still winning the last pick and failing every goal it won.
    //
    // That is the missing half of law 3: minting is cheap and retirement was inert, so bad arms
    // only ever accumulate. Same defect at the CREATE above, which is why it is fixed too.
    // Retire if success rate < 30%
    if (successRate < 0.3) {
      await surrealDB.query(`
        UPDATE type::thing("activity", $template_id) SET
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
 * Retire an arm on the evidence the learning loop actually maintains.
 *
 * WHY THIS EXISTS ALONGSIDE checkAndRetireTemplate (2026-08-16). That function cannot retire
 * anything, for four independent reasons — each sufficient on its own, all four measured:
 *
 *  1. Its only call site is `POST /v2/activities/executions` (routes/activities.ts). Nothing in
 *     the fleet posts there; the walk's traces go to `POST /v2/activities/execution-traces`
 *     (ias-executor-ts adapters/activity-api-trace-sink.ts). Commit f2857fc repaired its UPDATE
 *     binding correctly, and the repair was inert because no caller reaches it.
 *  2. It reads `FROM execution`. The trace-ingest handler writes `activity_execution_traces`.
 *     Different tables — so the walk's outcomes never appear in the rows it counts.
 *  3. Measured on the live hub: `learned-auto-bridge-shellresult` carries 407 executions in
 *     variant_performance_metrics and ZERO rows in `execution`. Its `< 20 → return false` guard
 *     therefore refuses precisely the arms that earned retirement. That same filtered read took
 *     43.5s against the live store (unindexed on activity_id) and must never sit on a hot path.
 *  4. `surrealDB.query<T>` returns a FLAT `T[]`, but it does `recentExecutions[0] || []` and then
 *     `.filter(...)` on it — i.e. `.filter` on a single row object, which throws, is swallowed by
 *     its own catch, and returns false. It has never once completed its own body.
 *
 * This function reads variant_performance_metrics instead: the table `applyOutcomeToPosteriors`
 * already maintains, keyed by variant, indexed, O(1). Tenancy scoping and the variant_id spellings
 * mirror the working reader in db/paradigm.ts (`activity:⟨…⟩` and bare ids both occur).
 *
 * IT DELIBERATELY DOES NOT SWEEP. It is called only when a trace has just added blame to this arm,
 * so arms retire one fresh failure at a time. A retroactive pass over the same predicate would
 * retire most of the live corpus at once — measured, the highest posterior mean in a 91-arm sample
 * is 0.604 and most sit far below 0.3 — which would strip the walk of its candidates in one write.
 */
export async function checkAndRetireByPosterior(
  templateId: string,
  orgId: string,
  accountId?: string | null,
): Promise<boolean> {
  try {
    const bareId = String(templateId).replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');
    if (!bareId) return false;

    const rows = await surrealDB.query<{
      total_executions?: number | null;
      thompson_alpha?: number | null;
      thompson_beta?: number | null;
    }>(
      `SELECT total_executions, thompson_alpha, thompson_beta
       FROM variant_performance_metrics
       WHERE ((account_id = $account_id) OR (account_id IS NONE AND org_id = $org_id))
         AND (variant_id = $bare_id OR variant_id = $bracketed_id OR activity_id = $bare_id)
       LIMIT 1`,
      {
        org_id: orgId.startsWith('organizations:') ? orgId.replace('organizations:', '') : orgId,
        account_id: accountId ?? null,
        bare_id: bareId,
        bracketed_id: `activity:⟨${bareId}⟩`,
      },
    );

    const row = rows?.[0];
    if (!row) return false;

    // Thresholds are read at use time from substrate_tuning_param (falling back to the 20 / 0.3
    // this replaces), NOT frozen into constants — a retirement threshold is behaviour, and
    // behaviour the system cannot observe or adjust is behaviour it cannot learn.
    const minExecutions = await getTuningParam('RETIREMENT_MIN_EXECUTIONS', undefined, 20);
    const successFloor = await getTuningParam('RETIREMENT_SUCCESS_FLOOR', undefined, 0.3);

    const totalExecutions = typeof row.total_executions === 'number' ? row.total_executions : 0;
    if (totalExecutions < minExecutions) return false;

    // Posterior mean, not the stored success_rate: success_rate was written as int/int on two
    // TYPE int columns and truncates to exactly 0 or 1 (see the self-healing note in
    // lib/posterior-update.ts — 438 of 1,059 mixed-outcome rows carry an impossible value).
    const alpha = typeof row.thompson_alpha === 'number' ? row.thompson_alpha : 1;
    const beta = typeof row.thompson_beta === 'number' ? row.thompson_beta : 1;
    if (alpha <= 0 || beta <= 0) return false;
    const posteriorMean = alpha / (alpha + beta);
    if (posteriorMean >= successFloor) return false;

    // Match on the id PART, not on bracket spelling. `activity:⟨x⟩` and `activity:x` are the same
    // record and both spellings occur in this store; meta::id(id) is what the other working retire
    // path (routes/activities.ts) uses, and 1,210 activities carry a retired flag set that way.
    const updated = await surrealDB.query(
      `UPDATE activity SET
         retired = true,
         retired_at = time::now(),
         retired_reason = "poor_performance"
       WHERE meta::id(id) = $bare_id AND (retired = false OR retired IS NONE)
       RETURN meta::id(id)`,
      { bare_id: bareId },
    );

    const didRetire = Array.isArray(updated) && updated.length > 0;
    if (didRetire) {
      logger.info('Retired arm on posterior evidence', {
        templateId: bareId,
        totalExecutions,
        posteriorMean,
        alpha,
        beta,
      });
    }
    return didRetire;
  } catch (error) {
    logger.error('Error checking posterior retirement', {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Auto-create variant after recording execution if needed
 *
 * Phase B4a: thread accountId through to inner reads + create.
 */
export async function autoCreateVariantIfNeeded(
  templateId: string,
  orgId: string,
  executionSuccess: boolean,
  accountId?: string | null
): Promise<VariantCreationResult | null> {
  // Only check after failures
  if (executionSuccess) {
    return null;
  }

  // Check if variant should be created
  const failurePattern = await shouldCreateVariant(templateId, orgId, accountId);
  if (!failurePattern) {
    return null;
  }

  // Check if we already created a variant recently (within last hour)
  const recentVariants = await surrealDB.query<any[]>(`
    SELECT created_at
    FROM activity
    WHERE variant_of = $parent_id
      AND ${accountIdScopedWhere()}
      AND created_at > time::now() - 1h
    LIMIT 1
  `, {
    parent_id: templateId,
    org_id: orgId,
    account_id: accountId ?? null,
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
    'consecutive_failures',
    accountId
  );
}
