/**
 * Template Merger Service
 *
 * Merges multiple activity templates into a single composite template.
 * This enables N:1 ribosome extraction where sequences like A→B→C become
 * a single optimized template "A-B-C-composite".
 *
 * Key challenges:
 * - Task ID conflicts: Multiple templates may have task-1, task-2, etc.
 * - Dependency updates: Dependencies must be remapped to new task IDs
 * - Template chaining: Last task of A must link to first task of B
 * - Variable/impulse deduplication: Avoid duplicate definitions
 * - Validation: Ensure no circular dependencies, reasonable complexity
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import type { SequencePattern } from './pattern-miner';

// Simplified types - actual types come from schemas.ts
interface ActivityTask {
  id: string;
  description: string;
  prompt: {
    template: string;
    variables?: any[];
    maxTokens?: number;
    compressionStrategy?: string;
  };
  dependencies?: string[];
  validation?: {
    requiredFiles?: string[];
    requiredPatterns?: string[] | Array<{ file: string; pattern: string }>;
    forbiddenPatterns?: Array<{ file: string; pattern: string }>;
    commands?: Array<{ command: string; expectedOutput?: string }>;
  };
  retry?: {
    max_attempts?: number;
    maxAttempts?: number;
    strategy: string;
  };
  subagent?: string;
  impulseReferences?: string[];
  outputImpulses?: string[];
}

interface ActivityTemplate {
  variant_id: string;
  activity_id: string;
  variant_name: string;
  description: string;
  tags?: string[];
  category?: string;
  task_steps?: ActivityTask[];
  variables?: any[];
  impulses?: any[];
  genealogy?: any;
  metadata?: any;
  scope?: string;
  org_id?: string | null;
  project_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MergeResult {
  compositeTemplate: ActivityTemplate;
  sourceTemplates: ActivityTemplate[];
  taskIdMapping: Record<string, string>;  // old task ID → new task ID
}

const MAX_COMPOSITE_TASKS = 20;  // Safety limit
const MAX_COMPOSITION_DEPTH = 2; // Prevent deep nesting

/**
 * Merge multiple templates into a single composite template
 *
 * Main orchestration function that:
 * 1. Loads source templates
 * 2. Renames task IDs with prefixes
 * 3. Updates dependencies
 * 4. Chains templates
 * 5. Deduplicates variables/impulses
 * 6. Creates composite template
 * 7. Validates result
 */
export async function mergeTemplates(
  pattern: SequencePattern
): Promise<MergeResult> {

  logger.info('Merging templates for pattern', {
    activityIds: pattern.activityIds,
    frequency: pattern.frequency,
    successRate: pattern.successRate
  });

  // Step 1: Load source templates
  const sourceTemplates = await loadSourceTemplates(pattern.activityIds);

  if (sourceTemplates.length !== pattern.activityIds.length) {
    throw new Error(
      `Failed to load all source templates. Expected ${pattern.activityIds.length}, got ${sourceTemplates.length}`
    );
  }

  // Step 2: Check composition depth (prevent ribosome-sequence from ribosome-sequence)
  for (const template of sourceTemplates) {
    const depth = getCompositionDepth(template);
    if (depth >= MAX_COMPOSITION_DEPTH) {
      throw new Error(
        `Template ${template.variant_id} has composition depth ${depth}, max is ${MAX_COMPOSITION_DEPTH}`
      );
    }
  }

  // Step 3: Rename task IDs and update dependencies
  const { mergedTasks, taskIdMapping } = renameAndMergeTasks(sourceTemplates);

  // Step 4: Chain templates by linking last task of N to first task of N+1
  chainTemplates(mergedTasks, sourceTemplates.length);

  // Step 5: Validate total task count
  if (mergedTasks.length > MAX_COMPOSITE_TASKS) {
    throw new Error(
      `Composite template would have ${mergedTasks.length} tasks, max is ${MAX_COMPOSITE_TASKS}`
    );
  }

  // Step 6: Deduplicate variables and impulses
  const uniqueVariables = deduplicateVariables(sourceTemplates);
  const uniqueImpulses = deduplicateImpulses(sourceTemplates);

  // Step 7: Create composite template
  const compositeId = `composite_${pattern.activityIds.join('_')}_${Date.now()}`;
  const compositeName = sourceTemplates
    .map(t => t.variant_name || t.activity_id)
    .join(' → ');

  const compositeTemplate: ActivityTemplate = {
    variant_id: compositeId,
    activity_id: compositeId,
    variant_name: `Composite: ${compositeName}`,
    description: `Learned composite sequence: ${pattern.activityIds.join(' → ')}\nObserved ${pattern.frequency} times with ${(pattern.successRate * 100).toFixed(1)}% success rate.`,

    // Merge all tags from source templates
    tags: [...new Set(sourceTemplates.flatMap(t => t.tags || []))],

    // Derive category from first template
    category: sourceTemplates[0]?.category || 'tool',

    // Merged tasks with renamed IDs and chained dependencies
    task_steps: mergedTasks,

    // Deduplicated variables and impulses
    variables: uniqueVariables,
    impulses: uniqueImpulses,

    // Genealogy for provenance tracking
    genealogy: {
      source: 'ribosome-sequence',
      sourcePattern: pattern.activityIds,
      sourceTemplates: sourceTemplates.map(t => ({
        id: t.variant_id,
        name: t.variant_name || t.activity_id
      })),
      frequency: pattern.frequency,
      successRate: pattern.successRate,
      avgDuration: pattern.avgDuration,
      avgCost: pattern.avgCost,
      extractedAt: Date.now(),
      compositionWeights: pattern.compositionWeights
    },

    // Metadata
    metadata: {
      author: 'ribosome-sequence',
      generatedFrom: 'pattern-mining',
      patternSignature: hashPattern(pattern.activityIds)
    },

    scope: 'global',
    org_id: null,
    project_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const result: MergeResult = {
    compositeTemplate,
    sourceTemplates,
    taskIdMapping
  };

  // Step 8: Validate the merged template
  validateMergedTemplate(result);

  logger.info('Template merge complete', {
    compositeId,
    taskCount: mergedTasks.length,
    sourceCount: sourceTemplates.length
  });

  return result;
}

/**
 * Load source templates from database
 */
async function loadSourceTemplates(
  activityIds: string[]
): Promise<ActivityTemplate[]> {

  const templates: ActivityTemplate[] = [];

  for (const activityId of activityIds) {
    const query = `
      SELECT * FROM activity_template
      WHERE activity_id = $activity_id
        OR variant_id = $activity_id
      LIMIT 1
    `;

    try {
      const results = await surrealDB.query<ActivityTemplate[]>(query, {
        activity_id: activityId
      });

      if (!results || results.length === 0) {
        throw new Error(`Template not found: ${activityId}`);
      }

      const template = results[0];

      // Safety check: Don't merge from ribosome-sequence templates
      if (template.metadata?.author === 'ribosome-sequence') {
        throw new Error(
          `Cannot merge from ribosome-sequence template: ${activityId}`
        );
      }

      templates.push(template);

    } catch (error) {
      logger.error('Error loading template', { activityId, error });
      throw error;
    }
  }

  return templates;
}

/**
 * Rename task IDs with prefixes and update dependencies
 *
 * Each template gets a prefix (step1_, step2_, step3_) to avoid ID conflicts.
 * Dependencies within each template are also updated to use new IDs.
 */
function renameAndMergeTasks(
  templates: ActivityTemplate[]
): { mergedTasks: ActivityTask[]; taskIdMapping: Record<string, string> } {

  const taskIdMapping: Record<string, string> = {};
  const mergedTasks: ActivityTask[] = [];

  for (let templateIdx = 0; templateIdx < templates.length; templateIdx++) {
    const template = templates[templateIdx];
    const prefix = `step${templateIdx + 1}_`;  // step1_, step2_, step3_

    const tasks = template.task_steps || [];

    for (const task of tasks) {
      const oldId = task.id;
      const newId = `${prefix}${task.id}`;

      // Record mapping
      taskIdMapping[oldId] = newId;

      // Create new task with renamed ID and updated dependencies
      const renamedTask: ActivityTask = {
        ...task,
        id: newId,
        dependencies: (task.dependencies || []).map(depId => {
          // Remap to new ID if it exists in this template
          const newDepId = `${prefix}${depId}`;
          return taskIdMapping[depId] || newDepId;
        })
      };

      mergedTasks.push(renamedTask);
    }
  }

  return { mergedTasks, taskIdMapping };
}

/**
 * Chain templates by linking last task of N to first task of N+1
 *
 * Finds tasks with no dependents (last tasks) and tasks with no dependencies
 * (first tasks), then creates cross-template dependency links.
 */
function chainTemplates(
  mergedTasks: ActivityTask[],
  templateCount: number
): void {

  for (let i = 0; i < templateCount - 1; i++) {
    const currentPrefix = `step${i + 1}_`;
    const nextPrefix = `step${i + 2}_`;

    // Find last tasks of current template (no dependents)
    const currentTasks = mergedTasks.filter(t => t.id.startsWith(currentPrefix));
    const lastTasks = currentTasks.filter(task => {
      const isDependedOn = mergedTasks.some(other =>
        (other.dependencies || []).includes(task.id)
      );
      return !isDependedOn;
    });

    // Find first tasks of next template (no dependencies)
    const nextTasks = mergedTasks.filter(t => t.id.startsWith(nextPrefix));
    const firstTasks = nextTasks.filter(task =>
      !task.dependencies || task.dependencies.length === 0
    );

    // Link first tasks of next to last tasks of current
    for (const firstTask of firstTasks) {
      if (!firstTask.dependencies) {
        firstTask.dependencies = [];
      }
      firstTask.dependencies.push(...lastTasks.map(t => t.id));
    }

    logger.debug('Chained templates', {
      from: i + 1,
      to: i + 2,
      lastTasks: lastTasks.map(t => t.id),
      firstTasks: firstTasks.map(t => t.id)
    });
  }
}

/**
 * Deduplicate variables by name
 *
 * If multiple templates define the same variable, keep the first definition.
 */
function deduplicateVariables(templates: ActivityTemplate[]): any[] {
  const seen = new Set<string>();
  const unique: any[] = [];

  for (const template of templates) {
    const variables = template.variables || [];

    for (const variable of variables) {
      const name = variable.name;
      if (!seen.has(name)) {
        seen.add(name);
        unique.push(variable);
      }
    }
  }

  return unique;
}

/**
 * Deduplicate impulses by ID
 */
function deduplicateImpulses(templates: ActivityTemplate[]): any[] {
  const seen = new Set<string>();
  const unique: any[] = [];

  for (const template of templates) {
    const impulses = template.impulses || [];

    for (const impulse of impulses) {
      const id = impulse.id;
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(impulse);
      }
    }
  }

  return unique;
}

/**
 * Validate merged template for common errors
 */
export function validateMergedTemplate(result: MergeResult): void {
  const { compositeTemplate } = result;
  const tasks = compositeTemplate.task_steps || [];

  // Check 1: All task IDs are unique
  const taskIds = tasks.map(t => t.id);
  const uniqueTaskIds = new Set(taskIds);
  if (uniqueTaskIds.size !== taskIds.length) {
    throw new Error('Duplicate task IDs found in merged template');
  }

  // Check 2: All dependencies exist
  for (const task of tasks) {
    const dependencies = task.dependencies || [];
    for (const depId of dependencies) {
      if (!taskIds.includes(depId)) {
        throw new Error(
          `Invalid dependency: Task ${task.id} depends on non-existent task ${depId}`
        );
      }
    }
  }

  // Check 3: No circular dependencies (topological sort must succeed)
  try {
    topologicalSort(tasks);
  } catch (error) {
    throw new Error(`Circular dependency detected in merged template: ${error}`);
  }

  // Check 4: Validate task count
  if (tasks.length === 0) {
    throw new Error('Merged template has no tasks');
  }

  if (tasks.length > MAX_COMPOSITE_TASKS) {
    throw new Error(
      `Merged template has ${tasks.length} tasks, max is ${MAX_COMPOSITE_TASKS}`
    );
  }

  logger.info('Template validation passed', {
    taskCount: tasks.length,
    uniqueTaskIds: uniqueTaskIds.size
  });
}

/**
 * Topological sort to detect circular dependencies
 *
 * Throws error if cycle detected.
 */
function topologicalSort(tasks: ActivityTask[]): ActivityTask[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();  // For cycle detection
  const result: ActivityTask[] = [];

  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;

    if (visiting.has(taskId)) {
      throw new Error(`Circular dependency involving task ${taskId}`);
    }

    visiting.add(taskId);

    const task = taskMap.get(taskId);
    if (!task) return;

    // Visit dependencies first
    for (const depId of task.dependencies || []) {
      visit(depId);
    }

    visiting.delete(taskId);
    visited.add(taskId);
    result.push(task);
  };

  for (const task of tasks) {
    visit(task.id);
  }

  return result;
}

/**
 * Get composition depth of a template
 *
 * Returns 0 for atomic templates, 1 for composites of atomics, etc.
 */
function getCompositionDepth(template: ActivityTemplate): number {
  if (!template.genealogy?.source) return 0;

  if (template.genealogy.source === 'ribosome-sequence') {
    // This is a composite - check if its sources are also composites
    const sourceTemplates = template.genealogy.sourceTemplates || [];
    if (sourceTemplates.length === 0) return 1;

    // Would need to recursively load and check, but for now assume depth 1
    // This is a simplification - in practice, sources are stored as IDs not full templates
    return 1;
  }

  return 0;
}

/**
 * Hash pattern for signature generation
 */
function hashPattern(activityIds: string[]): string {
  const str = JSON.stringify(activityIds);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return `seq_${activityIds.length}_${(hash >>> 0).toString(16)}`;
}
