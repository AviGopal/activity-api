/**
 * Activity Generator Service
 * 
 * Generates activity templates from goal descriptions.
 * 
 * Phase 1: Simple rule-based generation (no LLM)
 * Phase 2: LLM-based decomposition (future)
 */

import { logger } from '../utils/logger';

export interface GenerateActivityParams {
  goalDescription: string;
  templateName: string;
  category: string;
  variables: Record<string, unknown>;
  impulseRefs?: string[];
  constraints?: {
    maxTasks?: number;
    maxCost?: number;
    preferComposition?: boolean;
  };
}

// =============================================================================
// GeneratedActivity Interface (Canonical Field Names)
// =============================================================================
// Aligned with 020-paradigm-core-tables.surql 'activity' table schema.
// Uses canonical field names: id, name, tasks (not variant_id, variant_name, task_steps)
// =============================================================================
export interface GeneratedActivity {
  // Canonical fields
  id: string;
  name: string;
  description: string;
  category: string;
  // Canonical: 'tasks' (was task_steps)
  tasks: Array<{
    id: string;
    description: string;
    dependencies: string[];
    subagent: string;
    prompt: {
      template: string;
      variables: Array<{
        name: string;
        type: string;
        required: boolean;
        description: string;
      }>;
      maxTokens: number;
      compressionStrategy: string;
    };
    retry: {
      strategy: string;
      max_attempts?: number;
      maxAttempts?: number;
    };
  }>;
  scope: string;
  execution_type: string;
}

/**
 * Generate activity template from goal description
 * 
 * Current implementation: Rule-based generation
 * - Creates a single-task activity with general agent
 * - Passes goal description as the task prompt
 * - Uses provided variables as template variables
 * 
 * Future: LLM-based decomposition
 * - Parse goal into sub-tasks
 * - Identify dependencies
 * - Select appropriate subagents
 * - Generate prompts for each task
 */
export async function generateActivity(
  params: GenerateActivityParams
): Promise<GeneratedActivity> {
  logger.info('Generating activity template', {
    goalDescription: params.goalDescription,
    category: params.category,
  });

  const timestamp = Date.now();
  const variantId = params.templateName || `generated-${params.category}-${timestamp}`;
  const activityId = `generated-activity-${timestamp}`;

  // Extract variable names from provided context
  const variables = Object.keys(params.variables).map(name => ({
    name,
    type: typeof params.variables[name] === 'string' ? 'string' : 'object',
    required: false,
    description: `${name} from context`,
  }));

  // Add a 'goal' variable for the description
  variables.push({
    name: 'goal',
    type: 'string',
    required: true,
    description: 'The goal to accomplish',
  });

  // Simple rule-based generation: single task
  const taskSteps = [
    {
      id: 'task-1',
      description: `Accomplish: ${params.goalDescription.substring(0, 100)}`,
      dependencies: [],
      subagent: 'general',
      prompt: {
        template: `${params.goalDescription}\n\nContext:\n{{#each this}}\n- {{@key}}: {{this}}\n{{/each}}\n\nPlease accomplish this goal step by step.`,
        variables,
        // Conservative maxTokens to prevent context overflow
        // Most tasks don't need more than 4-8K output tokens
        // Input context + output must stay under 200K total
        maxTokens: 4096,
        compressionStrategy: 'filter',
      },
      retry: {
        strategy: 'simple',
        maxAttempts: 2,
      },
    },
  ];

  const generated: GeneratedActivity = {
    // Canonical field names
    id: variantId,
    name: params.templateName || `Generated: ${params.goalDescription.substring(0, 50)}`,
    description: `Auto-generated activity for: ${params.goalDescription}`,
    category: params.category,
    // Canonical: 'tasks' (was task_steps)
    tasks: taskSteps,
    scope: 'global',
    execution_type: 'template',
  };

  logger.info('Generated activity template', {
    id: variantId,
    tasks: taskSteps.length,
  });

  return generated;
}
