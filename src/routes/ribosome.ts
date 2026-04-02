/**
 * Ribosome - Mechanical Template Extraction from Execution Traces
 *
 * Converts captured execution traces into reusable activity templates.
 * This is purely mechanical - no LLM required.
 *
 * The name comes from biology: ribosomes assemble proteins from RNA templates.
 * Here, we assemble activity templates from execution traces.
 *
 * Key insight: Source code IS an implicit activity template.
 * Running it produces traces. Traces can be mechanically converted to explicit templates.
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

const app = new Hono();

// =============================================================================
// TYPES
// =============================================================================

interface ExecutionTrace {
  execution_id: string;
  variant_id: string;
  activity_id: string;
  success: boolean;
  duration_ms: number;
  cost: number;
  tokens: {
    input: number;
    output: number;
    cache: number;
  };
  tasks?: Array<{
    task_id: string;
    description?: string;
    status: string;
    duration_ms?: number;
    tool_calls?: Array<{
      tool: string;
      args?: unknown;
      duration_ms: number;
      success: boolean;
    }>;
  }>;
  state_snapshot?: {
    input_state?: {
      filesAvailable?: string[];
      variables?: Record<string, unknown>;
    };
    output_state?: {
      filesModified?: string[];
      filesCreated?: string[];
      filesDeleted?: string[];
    };
  };
  executed_at: string;
}

interface ExtractedTask {
  id: string;
  description: string;
  dependencies: string[];
  tools: {
    required: string[];
    optional: string[];
  };
  validation: {
    requiredFiles: string[];
    requiredPatterns: string[];
  };
  prompt: {
    template: string;
    variables: Array<{
      name: string;
      type: string;
      required: boolean;
      extractedFrom: string;
    }>;
  };
}

interface ExtractedTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  extractedFrom: {
    executionIds: string[];
    traceCount: number;
    successRate: number;
  };
  tasks: ExtractedTask[];
  validation: {
    requiredFiles: string[];
    successIndicators: string[];
  };
  variables: Array<{
    name: string;
    type: string;
    extractedFrom: string;
    defaultValue?: unknown;
  }>;
  impulses: Array<{
    id: string;
    pointer: {
      type: string;
      [key: string]: unknown;
    };
    budget: number;
    priority: 'critical' | 'high' | 'medium' | 'low';
    description?: string;
  }>;
  confidence: number;
  generatedAt: string;
}

// =============================================================================
// EXTRACTION FUNCTIONS (Pure/Mechanical)
// =============================================================================

/**
 * Group tool calls into logical tasks
 * This is mechanical - based on tool category and timing
 */
function groupToolCallsIntoTasks(traces: ExecutionTrace[]): ExtractedTask[] {
  const tasks: ExtractedTask[] = [];
  let taskIndex = 0;

  // Flatten all tool calls across traces
  const allToolCalls: Array<{
    tool: string;
    args?: unknown;
    success: boolean;
    traceId: string;
    taskDescription?: string;
  }> = [];

  for (const trace of traces) {
    if (!trace.tasks) continue;
    for (const task of trace.tasks) {
      if (!task.tool_calls) continue;
      for (const toolCall of task.tool_calls) {
        allToolCalls.push({
          ...toolCall,
          traceId: trace.execution_id,
          taskDescription: task.description,
        });
      }
    }
  }

  if (allToolCalls.length === 0) return [];

  // Group by category transitions
  const readTools = ['read', 'glob', 'grep'];
  const writeTools = ['write', 'edit', 'bash'];
  const analyzeTools = ['search_activities', 'goal'];

  let currentTask: ExtractedTask | null = null;
  let lastCategory: 'read' | 'write' | 'analyze' | 'other' | null = null;

  for (const toolCall of allToolCalls) {
    const category = getToolCategory(toolCall.tool, readTools, writeTools, analyzeTools);

    // Start new task on category change
    if (category !== lastCategory || !currentTask) {
      if (currentTask) {
        tasks.push(currentTask);
      }

      taskIndex++;
      currentTask = {
        id: `task-${taskIndex}`,
        description: toolCall.taskDescription || `${category} operations`,
        dependencies: taskIndex > 1 ? [`task-${taskIndex - 1}`] : [],
        tools: {
          required: [],
          optional: [],
        },
        validation: {
          requiredFiles: [],
          requiredPatterns: [],
        },
        prompt: {
          template: '',
          variables: [],
        },
      };

      lastCategory = category;
    }

    // Add tool to current task
    if (!currentTask.tools.required.includes(toolCall.tool)) {
      if (toolCall.success) {
        currentTask.tools.required.push(toolCall.tool);
      } else {
        currentTask.tools.optional.push(toolCall.tool);
      }
    }

    // Extract variables from args
    if (toolCall.args) {
      const variables = extractVariablesFromArgs(toolCall.tool, toolCall.args);
      for (const variable of variables) {
        if (!currentTask.prompt.variables.some(v => v.name === variable.name)) {
          currentTask.prompt.variables.push(variable);
        }
      }
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  // Generate prompt templates from tasks
  for (const task of tasks) {
    task.prompt.template = generatePromptTemplate(task);
  }

  return tasks;
}

function getToolCategory(
  tool: string,
  readTools: string[],
  writeTools: string[],
  analyzeTools: string[]
): 'read' | 'write' | 'analyze' | 'other' {
  if (readTools.some(t => tool.includes(t))) return 'read';
  if (writeTools.some(t => tool.includes(t))) return 'write';
  if (analyzeTools.some(t => tool.includes(t))) return 'analyze';
  return 'other';
}

/**
 * Extract variables from tool call arguments
 * Mechanical pattern matching - no LLM
 */
function extractVariablesFromArgs(
  tool: string,
  args: unknown
): Array<{ name: string; type: string; required: boolean; extractedFrom: string }> {
  const variables: Array<{ name: string; type: string; required: boolean; extractedFrom: string }> = [];

  if (typeof args !== 'object' || args === null) return variables;

  const argObj = args as Record<string, unknown>;

  for (const [key, value] of Object.entries(argObj)) {
    let type = 'string';

    if (typeof value === 'string') {
      if (value.includes('/')) type = 'path';
      else if (value.includes('*')) type = 'pattern';
    } else if (typeof value === 'number') {
      type = 'number';
    } else if (typeof value === 'boolean') {
      type = 'boolean';
    }

    variables.push({
      name: `${tool}_${key}`,
      type,
      required: true,
      extractedFrom: `${tool}.args.${key}`,
    });
  }

  return variables;
}

/**
 * Generate a prompt template from extracted task
 */
function generatePromptTemplate(task: ExtractedTask): string {
  const toolList = task.tools.required.join(', ');
  const varList = task.prompt.variables.map(v => `{{${v.name}}}`).join(', ');

  return `${task.description}

Use the following tools: ${toolList}
${varList ? `Variables available: ${varList}` : ''}

Complete this task and validate the results.`;
}

/**
 * Extract validation rules from successful traces
 */
function extractValidation(traces: ExecutionTrace[]): {
  requiredFiles: string[];
  successIndicators: string[];
} {
  const requiredFiles = new Set<string>();
  const successIndicators: string[] = [];

  for (const trace of traces) {
    if (!trace.success) continue;

    // Extract files that were created/modified
    if (trace.state_snapshot?.output_state?.filesCreated) {
      for (const file of trace.state_snapshot.output_state.filesCreated) {
        requiredFiles.add(file);
      }
    }
    if (trace.state_snapshot?.output_state?.filesModified) {
      for (const file of trace.state_snapshot.output_state.filesModified) {
        requiredFiles.add(file);
      }
    }

    // Success indicator from trace
    successIndicators.push(`Execution ${trace.execution_id} completed successfully`);
  }

  return {
    requiredFiles: Array.from(requiredFiles),
    successIndicators: successIndicators.slice(0, 3), // Keep top 3
  };
}

/**
 * Extract impulse pointers from tool calls
 * Converts data access patterns into reusable impulse definitions
 */
function extractImpulses(traces: ExecutionTrace[]): Array<{
  id: string;
  pointer: {
    type: string;
    [key: string]: unknown;
  };
  budget: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  description?: string;
}> {
  const impulses: Array<{
    id: string;
    pointer: { type: string; [key: string]: unknown };
    budget: number;
    priority: 'critical' | 'high' | 'medium' | 'low';
    description?: string;
  }> = [];

  const seenFiles = new Set<string>();
  let impulseIndex = 0;

  for (const trace of traces) {
    if (!trace.tasks) continue;

    for (const task of trace.tasks) {
      if (!task.tool_calls) continue;

      for (const toolCall of task.tool_calls) {
        const args = toolCall.args as Record<string, unknown> | undefined;
        if (!args) continue;

        // Extract file read operations as file impulses
        if (toolCall.tool === 'read' && args.file_path && typeof args.file_path === 'string') {
          if (!seenFiles.has(args.file_path)) {
            seenFiles.add(args.file_path);
            impulses.push({
              id: `file_${impulseIndex++}`,
              pointer: {
                type: 'file',
                path: args.file_path,
              },
              budget: 3000,
              priority: 'high',
              description: `File read from ${toolCall.tool} call`,
            });
          }
        }

        // Extract grep patterns as file impulses with pattern
        if (toolCall.tool === 'grep' && args.pattern && args.path) {
          const key = `${args.path}:${args.pattern}`;
          if (!seenFiles.has(key)) {
            seenFiles.add(key);
            impulses.push({
              id: `grep_${impulseIndex++}`,
              pointer: {
                type: 'file',
                path: args.path as string,
                pattern: args.pattern as string,
              },
              budget: 2000,
              priority: 'medium',
              description: `Grep search for pattern in ${args.path}`,
            });
          }
        }

        // Extract glob patterns as file collection impulses
        if (toolCall.tool === 'glob' && args.pattern) {
          const key = `glob:${args.pattern}`;
          if (!seenFiles.has(key)) {
            seenFiles.add(key);
            impulses.push({
              id: `glob_${impulseIndex++}`,
              pointer: {
                type: 'file',
                glob: args.pattern as string,
              },
              budget: 5000,
              priority: 'medium',
              description: `File collection matching ${args.pattern}`,
            });
          }
        }
      }
    }
  }

  return impulses;
}

/**
 * Calculate confidence score for extracted template
 */
function calculateConfidence(traces: ExecutionTrace[]): number {
  if (traces.length === 0) return 0;

  let confidence = 0.3; // Base confidence

  // More traces = higher confidence
  confidence += Math.min(0.3, traces.length * 0.05);

  // Higher success rate = higher confidence
  const successRate = traces.filter(t => t.success).length / traces.length;
  confidence += successRate * 0.3;

  // Consistent tool usage = higher confidence
  const toolSets = traces.map(t =>
    t.tasks?.flatMap(task => task.tool_calls?.map(tc => tc.tool) || []) || []
  );
  const firstToolSet = new Set(toolSets[0] || []);
  const consistency = toolSets.slice(1).reduce((acc, set) => {
    const overlap = set.filter(t => firstToolSet.has(t)).length;
    return acc + (overlap / Math.max(set.length, firstToolSet.size));
  }, 0) / Math.max(toolSets.length - 1, 1);
  confidence += consistency * 0.1;

  return Math.min(1, confidence);
}

/**
 * Derive template name from traces
 */
function deriveTemplateName(traces: ExecutionTrace[]): string {
  // Use activity_id if consistent
  const activityIds = new Set(traces.map(t => t.activity_id));
  if (activityIds.size === 1) {
    const [id] = activityIds;
    return `extracted-${id}`;
  }

  // Otherwise use first trace's activity
  return `extracted-${traces[0]?.activity_id || 'unknown'}-${Date.now()}`;
}

/**
 * Main extraction function - purely mechanical
 */
function extractTemplateFromTraces(traces: ExecutionTrace[]): ExtractedTemplate {
  const tasks = groupToolCallsIntoTasks(traces);
  const validation = extractValidation(traces);
  const impulses = extractImpulses(traces);
  const confidence = calculateConfidence(traces);
  const name = deriveTemplateName(traces);

  // Collect all unique variables
  const allVariables = new Map<string, ExtractedTask['prompt']['variables'][0]>();
  for (const task of tasks) {
    for (const variable of task.prompt.variables) {
      if (!allVariables.has(variable.name)) {
        allVariables.set(variable.name, variable);
      }
    }
  }

  return {
    id: `template_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
    name,
    description: `Auto-extracted template from ${traces.length} execution trace(s)`,
    category: 'infrastructure',
    extractedFrom: {
      executionIds: traces.map(t => t.execution_id),
      traceCount: traces.length,
      successRate: traces.filter(t => t.success).length / traces.length,
    },
    tasks,
    validation,
    variables: Array.from(allVariables.values()),
    impulses,
    confidence,
    generatedAt: new Date().toISOString(),
  };
}

// =============================================================================
// API ENDPOINTS
// =============================================================================

/**
 * POST /v2/ribosome/extract
 *
 * Extract an activity template from execution traces.
 * This is mechanical extraction - no LLM involved.
 *
 * Body:
 * - execution_ids: string[] - Execution IDs to extract from
 * - name?: string - Override template name
 * - category?: string - Override category
 */
app.post('/extract', async (c) => {
  try {
    const body = await c.req.json();
    const { execution_ids, name, category } = body;

    if (!execution_ids || !Array.isArray(execution_ids) || execution_ids.length === 0) {
      return c.json({
        error: 'Missing required field: execution_ids (array of execution IDs)',
      }, 400);
    }

    logger.info('Ribosome extraction requested', {
      executionIds: execution_ids,
      count: execution_ids.length,
    });

    // Fetch execution traces
    const placeholders = execution_ids.map((_, i) => `$id_${i}`).join(', ');
    const params: Record<string, string> = {};
    execution_ids.forEach((id: string, i: number) => {
      params[`id_${i}`] = id;
    });

    const query = `
      SELECT * FROM activity_execution_traces
      WHERE execution_id IN [${placeholders}]
      ORDER BY executed_at ASC
    `;

    const traces = await surrealDB.query<ExecutionTrace>(query, params);

    if (!traces || traces.length === 0) {
      return c.json({
        error: 'No execution traces found for the provided IDs',
        execution_ids,
      }, 404);
    }

    logger.info('Fetched traces for extraction', {
      requested: execution_ids.length,
      found: traces.length,
    });

    // Extract template (mechanical - no LLM)
    const template = extractTemplateFromTraces(traces);

    // Override name/category if provided
    if (name) template.name = name;
    if (category) template.category = category;

    logger.info('Template extracted', {
      templateId: template.id,
      taskCount: template.tasks.length,
      confidence: template.confidence,
      variableCount: template.variables.length,
      impulseCount: template.impulses.length,
    });

    // Store the extracted template
    const storeQuery = `
      INSERT INTO activity_templates {
        template_id: $template_id,
        name: $name,
        description: $description,
        category: $category,
        tasks: $tasks,
        validation: $validation,
        variables: $variables,
        impulses: $impulses,
        metadata: {
          extracted: true,
          extractedFrom: $extracted_from,
          confidence: $confidence,
          generatedAt: $generated_at
        },
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    await surrealDB.query(storeQuery, {
      template_id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      tasks: template.tasks,
      validation: template.validation,
      variables: template.variables,
      impulses: template.impulses,
      extracted_from: template.extractedFrom,
      confidence: template.confidence,
      generated_at: template.generatedAt,
    });

    return c.json({
      success: true,
      template,
      stored: true,
    });

  } catch (error) {
    logger.error('Ribosome extraction failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Extraction failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/ribosome/extract-from-session
 *
 * Extract template from all traces in a session.
 * Useful for formalizing an improvised session.
 */
app.post('/extract-from-session', async (c) => {
  try {
    const body = await c.req.json();
    const { session_id, min_traces, success_only } = body;

    if (!session_id) {
      return c.json({ error: 'Missing required field: session_id' }, 400);
    }

    // Fetch traces for session
    let query = `
      SELECT * FROM activity_execution_traces
      WHERE variant_id CONTAINS $session_id
      ORDER BY executed_at ASC
    `;

    if (success_only) {
      query = `
        SELECT * FROM activity_execution_traces
        WHERE variant_id CONTAINS $session_id AND success = true
        ORDER BY executed_at ASC
      `;
    }

    const traces = await surrealDB.query<ExecutionTrace>(query, { session_id });

    if (!traces || traces.length < (min_traces || 1)) {
      return c.json({
        error: 'Insufficient traces for extraction',
        found: traces?.length || 0,
        required: min_traces || 1,
      }, 400);
    }

    const template = extractTemplateFromTraces(traces);

    return c.json({
      success: true,
      template,
      traceCount: traces.length,
    });

  } catch (error) {
    logger.error('Session extraction failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Extraction failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/ribosome/candidates
 *
 * Find execution trace sequences that are good candidates for extraction.
 * Returns successful trace sequences with consistent patterns.
 */
app.get('/candidates', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '10', 10);
    const minTraces = parseInt(c.req.query('min_traces') || '2', 10);

    // Find activity_ids with multiple successful executions
    // Note: SurrealDB doesn't support HAVING, so we filter after grouping
    const query = `
      SELECT
        activity_id,
        count() as execution_count,
        math::sum(IF success THEN 1 ELSE 0 END) as success_count,
        array::group(execution_id) as execution_ids
      FROM activity_execution_traces
      GROUP BY activity_id
      ORDER BY success_count DESC
    `;

    const results = await surrealDB.query<{
      activity_id: string;
      execution_count: number;
      success_count: number;
      execution_ids: string[];
    }>(query, {});

    // Filter results where success_count >= min_traces (client-side filtering since SurrealDB doesn't support HAVING)
    const candidates = (results || [])
      .filter(r => r.success_count >= minTraces)
      .slice(0, limit);

    return c.json({
      candidates,
      count: candidates.length,
    });

  } catch (error) {
    logger.error('Failed to find extraction candidates', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to find candidates',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

export default app;
