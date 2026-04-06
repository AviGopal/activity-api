/**
 * Shape Inference Utilities (Bootstrap Heuristics)
 *
 * IMPORTANT: These are heuristics for bootstrapping templates that lack shapes.
 * Shapes are NOT a predefined vocabulary - they emerge from usage and are
 * refined through execution data via Thompson Sampling.
 *
 * Inference approach:
 * - Task prompt keywords → likely input shapes
 * - Validation rules (requiredFiles, requiredPatterns) → likely output shapes
 * - Category defaults → fallback shapes
 *
 * The inference is intentionally loose. Execution data will correct mistakes
 * by tracking which shape combinations lead to success/failure.
 */

// Heuristic patterns for shape inference
// These are starting points - not a canonical vocabulary
// New shapes can emerge from usage; these just help bootstrap templates
const SHAPE_INFERENCE_RULES: Record<string, {
  inputKeywords: RegExp[];
  outputKeywords: RegExp[];
  validationPatterns: RegExp[];
}> = {
  goal: {
    inputKeywords: [
      /\b(goal|requirement|task|objective|intent|request|feature|implement|create|build)\b/i,
      /what needs to be done/i,
      /user wants/i,
    ],
    outputKeywords: [],
    validationPatterns: [],
  },
  error: {
    inputKeywords: [
      /\b(error|exception|failure|crash|bug|issue|problem)\b/i,
      /stack trace/i,
      /traceback/i,
      /\bfailed\b/i,
    ],
    outputKeywords: [],
    validationPatterns: [],
  },
  trace: {
    inputKeywords: [
      /\b(trace|log|execution|debug)\b/i,
      /execution history/i,
    ],
    outputKeywords: [],
    validationPatterns: [],
  },
  source_code: {
    inputKeywords: [
      /\b(code|file|source|implementation)\b/i,
      /read (the )?file/i,
      /load (the )?file/i,
      /\b(function|class|module|component)\b/i,
    ],
    outputKeywords: [
      /\b(write|create|modify|edit) (the )?(file|code)\b/i,
      /\bfiles? (changed|modified|created)\b/i,
    ],
    validationPatterns: [
      /requiredFiles/i,
      /\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|rb)$/i,
    ],
  },
  test_suite: {
    inputKeywords: [
      /\b(test|spec|expect|assert|coverage)\b/i,
      /unit test/i,
      /integration test/i,
    ],
    outputKeywords: [
      /\b(write|create|add) (the )?tests?\b/i,
      /tests? (written|passing|failing)/i,
    ],
    validationPatterns: [
      /\.(test|spec)\.(ts|js|tsx|jsx)$/i,
      /test_.*\.py$/i,
      /_test\.(go|rs)$/i,
    ],
  },
  config_file: {
    inputKeywords: [
      /\b(config|configuration|settings|env|environment)\b/i,
    ],
    outputKeywords: [],
    validationPatterns: [
      /config\./i,
      /\.(json|yaml|yml|toml|env)$/i,
    ],
  },
  sql_schema: {
    inputKeywords: [
      /\b(schema|database|sql|table|query|migration)\b/i,
      /\bsurql\b/i,
    ],
    outputKeywords: [],
    validationPatterns: [
      /\.(sql|surql)$/i,
      /migration/i,
    ],
  },
  patch: {
    inputKeywords: [],
    outputKeywords: [
      /\b(change|diff|patch|modify|update|edit)\b/i,
    ],
    validationPatterns: [
      /files changed/i,
      /\bmodified\b/i,
      /\bcreated\b/i,
    ],
  },
  documentation: {
    inputKeywords: [],
    outputKeywords: [
      /\b(document|explain|describe)\b/i,
    ],
    validationPatterns: [
      /\.(md|rst|txt)$/i,
      /README/i,
      /docs?\//i,
    ],
  },
  analysis: {
    inputKeywords: [],
    outputKeywords: [
      /\b(analyze|report|assessment|review|audit|evaluation|findings)\b/i,
    ],
    validationPatterns: [
      /report/i,
      /analysis/i,
      /summary/i,
    ],
  },
  recommendation: {
    inputKeywords: [],
    outputKeywords: [
      /\b(recommend|suggest|propose|advice|improvement|optimization)\b/i,
    ],
    validationPatterns: [
      /recommendation/i,
      /suggestion/i,
      /next steps/i,
    ],
  },
  activity_template: {
    inputKeywords: [
      /\b(template|activity|workflow)\b/i,
      /activity template/i,
    ],
    outputKeywords: [
      /register (new )?template/i,
      /create (new )?activity/i,
    ],
    validationPatterns: [],
  },
  execution_trace: {
    inputKeywords: [
      /execution trace/i,
      /\btrace\b.*\bexecution\b/i,
    ],
    outputKeywords: [],
    validationPatterns: [],
  },
  activity_metrics: {
    inputKeywords: [
      /\b(metrics|performance|statistics)\b/i,
      /success rate/i,
    ],
    outputKeywords: [],
    validationPatterns: [],
  },
};

/**
 * Infer input shapes from a task prompt
 */
export function inferInputShapesFromPrompt(prompt: string): string[] {
  const shapes = new Set<string>();

  // Always include 'goal' for LLM-driven activities
  // (the prompt itself represents a goal to achieve)
  shapes.add('goal');

  for (const [shape, rules] of Object.entries(SHAPE_INFERENCE_RULES)) {
    for (const pattern of rules.inputKeywords) {
      if (pattern.test(prompt)) {
        shapes.add(shape);
        break;
      }
    }
  }

  return Array.from(shapes).sort();
}

/**
 * Infer output shapes from validation rules
 */
export function inferOutputShapesFromValidation(validation: {
  requiredFiles?: string[];
  requiredPatterns?: string[];
  forbiddenPatterns?: string[];
  commands?: string[];
} | undefined): string[] {
  if (!validation) return [];

  const shapes = new Set<string>();

  // Check requiredFiles for file type patterns
  if (validation.requiredFiles?.length) {
    for (const file of validation.requiredFiles) {
      // Source code files
      if (/\.(ts|js|tsx|jsx|py|go|rs|java|cpp|c|rb)$/i.test(file)) {
        shapes.add('source_code');
      }
      // Test files
      if (/\.(test|spec)\./i.test(file) || /test_/i.test(file) || /_test\./i.test(file)) {
        shapes.add('test_suite');
      }
      // Documentation
      if (/\.(md|rst|txt)$/i.test(file) || /README/i.test(file)) {
        shapes.add('documentation');
      }
      // Config
      if (/\.(json|yaml|yml|toml|env)$/i.test(file) || /config/i.test(file)) {
        shapes.add('config_file');
      }
      // SQL/Schema
      if (/\.(sql|surql)$/i.test(file) || /migration/i.test(file)) {
        shapes.add('sql_schema');
      }
    }
  }

  // Check requiredPatterns for content patterns
  if (validation.requiredPatterns?.length) {
    const combinedPatterns = validation.requiredPatterns.join(' ');

    for (const [shape, rules] of Object.entries(SHAPE_INFERENCE_RULES)) {
      for (const pattern of rules.validationPatterns) {
        if (pattern.test(combinedPatterns)) {
          shapes.add(shape);
          break;
        }
      }
    }
  }

  return Array.from(shapes).sort();
}

/**
 * Infer output shapes from a task prompt (looking for output indicators)
 */
export function inferOutputShapesFromPrompt(prompt: string): string[] {
  const shapes = new Set<string>();

  for (const [shape, rules] of Object.entries(SHAPE_INFERENCE_RULES)) {
    for (const pattern of rules.outputKeywords) {
      if (pattern.test(prompt)) {
        shapes.add(shape);
        break;
      }
    }
  }

  return Array.from(shapes).sort();
}

/**
 * Get default output shape based on category
 * Used as a fallback when no shapes can be inferred from content
 */
function getDefaultOutputShapeForCategory(category: string | undefined): string {
  if (!category) {
    return 'unknown_output';
  }

  switch (category.toLowerCase()) {
    case 'bugfix':
      return 'patch';
    case 'feature':
      return 'source_code';
    case 'refactor':
      return 'source_code';
    case 'test':
      return 'test_result';
    case 'tool':
      return 'tool_output';
    case 'infrastructure':
      return 'config_file';
    case 'meta':
      return 'activity_template';
    case 'docs':
      return 'documentation';
    default:
      return 'unknown_output';
  }
}

/**
 * Infer both input and output shapes from a complete activity template
 *
 * IMPORTANT: This function ALWAYS returns at least one output shape.
 * output_shapes is a required field for activity templates because it enables
 * output-based activity selection and composition learning.
 *
 * If no output shapes can be inferred from the template content, a category-based
 * fallback is used:
 *   - bugfix → ['patch']
 *   - feature → ['source_code']
 *   - refactor → ['source_code']
 *   - test → ['test_result']
 *   - tool → ['tool_output']
 *   - infrastructure → ['config_file']
 *   - meta → ['activity_template']
 *   - docs → ['documentation']
 *   - other/unknown → ['unknown_output']
 */
export function inferShapesFromTemplate(template: {
  tasks?: Array<{
    id?: string;
    description?: string;
    prompt?: { template?: string };
    validation?: {
      requiredFiles?: string[];
      requiredPatterns?: string[];
      forbiddenPatterns?: string[];
      commands?: string[];
    };
  }>;
  task_steps?: Array<{
    id?: string;
    description?: string;
    prompt?: { template?: string };
    validation?: {
      requiredFiles?: string[];
      requiredPatterns?: string[];
      forbiddenPatterns?: string[];
      commands?: string[];
    };
  }>;
  description?: string;
  category?: string;
}): { input_shapes: string[]; output_shapes: string[] } {
  const inputShapes = new Set<string>();
  const outputShapes = new Set<string>();

  // Use tasks or task_steps (backward compat)
  const tasks = template.tasks || template.task_steps || [];

  // Analyze each task
  for (const task of tasks) {
    const prompt = task.prompt?.template || '';
    const description = task.description || '';
    const combinedText = `${prompt} ${description}`;

    // Infer inputs from prompt
    for (const shape of inferInputShapesFromPrompt(combinedText)) {
      inputShapes.add(shape);
    }

    // Infer outputs from prompt
    for (const shape of inferOutputShapesFromPrompt(combinedText)) {
      outputShapes.add(shape);
    }

    // Infer outputs from validation
    for (const shape of inferOutputShapesFromValidation(task.validation)) {
      outputShapes.add(shape);
    }
  }

  // Analyze template description for output indicators
  if (template.description) {
    // Infer inputs from description
    for (const shape of inferInputShapesFromPrompt(template.description)) {
      inputShapes.add(shape);
    }
    // Also check description for output shapes
    for (const shape of inferOutputShapesFromPrompt(template.description)) {
      outputShapes.add(shape);
    }
  }

  // Category-based defaults (add to output shapes, enrich input shapes)
  if (template.category) {
    switch (template.category.toLowerCase()) {
      case 'bugfix':
        inputShapes.add('error');
        outputShapes.add('patch');
        break;
      case 'feature':
        outputShapes.add('source_code');
        break;
      case 'refactor':
        inputShapes.add('source_code');
        outputShapes.add('patch');
        break;
      case 'test':
        outputShapes.add('test_result');
        break;
      case 'docs':
        outputShapes.add('documentation');
        break;
      case 'tool':
        outputShapes.add('tool_output');
        break;
      case 'infrastructure':
        outputShapes.add('config_file');
        break;
      case 'meta':
        outputShapes.add('activity_template');
        break;
    }
  }

  // CRITICAL: Ensure at least one output shape is present
  // output_shapes is a required field for activity templates
  if (outputShapes.size === 0) {
    const fallbackShape = getDefaultOutputShapeForCategory(template.category);
    outputShapes.add(fallbackShape);
  }

  return {
    input_shapes: Array.from(inputShapes).sort(),
    output_shapes: Array.from(outputShapes).sort(),
  };
}

/**
 * Merge inferred shapes with existing shapes (if any)
 * Preserves manually-set shapes while adding inferred ones
 */
export function mergeShapes(
  existing: string[] | null | undefined,
  inferred: string[]
): string[] {
  const merged = new Set<string>(existing || []);
  for (const shape of inferred) {
    merged.add(shape);
  }
  return Array.from(merged).sort();
}

/**
 * Check which shapes have inference rules defined
 * Note: Shapes NOT in this list are still valid - they just can't be inferred
 * Returns { known: string[], novel: string[] }
 */
export function categorizeShapes(shapes: string[]): { known: string[]; novel: string[] } {
  const knownShapes = Object.keys(SHAPE_INFERENCE_RULES);
  const known: string[] = [];
  const novel: string[] = [];

  for (const shape of shapes) {
    if (knownShapes.includes(shape)) {
      known.push(shape);
    } else {
      novel.push(shape);
    }
  }

  return { known, novel };
}

/**
 * Get shapes that have inference heuristics defined
 * Note: This is NOT a canonical list - just shapes we can infer
 */
export function getInferableShapes(): string[] {
  return Object.keys(SHAPE_INFERENCE_RULES).sort();
}
