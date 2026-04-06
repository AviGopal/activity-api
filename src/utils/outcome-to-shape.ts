/**
 * Outcome to Shape Mapping Utilities
 *
 * Maps natural language expected outcomes (from goal enrichment) to canonical output shapes.
 * This enables activity selection based on whether activity output_shapes match the
 * goal's expectedOutcomes.
 *
 * Example mapping:
 * - "Authentication flow working" -> ["source_code", "test_suite"]
 * - "Tests passing" -> ["test_suite"]
 * - "Bug fixed" -> ["patch"]
 * - "Schema migration applied" -> ["sql_schema"]
 */

/**
 * Outcome pattern to output shape mappings
 * Patterns are checked in order; first match wins
 */
const OUTCOME_TO_SHAPES: Array<{
  patterns: RegExp[];
  shapes: string[];
}> = [
  // Test-related outcomes
  {
    patterns: [
      /\btests?\s+(pass|passing|succeed|work|green)/i,
      /\btest\s+suite\b/i,
      /\bunit\s+tests?\b/i,
      /\bintegration\s+tests?\b/i,
      /\btest\s+coverage\b/i,
      /\bvalidat(ed?|ion)\s+(pass|succeed)/i,
    ],
    shapes: ['test_suite'],
  },

  // Bug fix / patch outcomes
  {
    patterns: [
      /\b(bug|error|issue)\s+(fixed|resolved|patched)/i,
      /\b(fix|patch)\s+(applied|complete|working)/i,
      /\bno\s+(more\s+)?(errors?|failures?|crashes?)/i,
      /\bfix(ed)?\s+(the\s+)?bug/i,
      /\bproblem\s+solved/i,
    ],
    shapes: ['patch'],
  },

  // Code/feature outcomes
  {
    patterns: [
      /\b(feature|functionality|function|method|class)\s+(work|implemented|added|created)/i,
      /\b(endpoint|api|route)\s+(work|live|deployed|available)/i,
      /\b(auth|authentication|authorization)\s+(flow|system)?\s*(work|implement)/i,
      /\b(code|implementation)\s+(complete|working|ready)/i,
      /\bcomponent\s+(render|work|display)/i,
      /\bnew\s+(file|code|function)/i,
    ],
    shapes: ['source_code'],
  },

  // Documentation outcomes
  {
    patterns: [
      /\b(docs?|documentation)\s+(updated?|written|complete)/i,
      /\breadme\s+(updated?|written)/i,
      /\bcomments?\s+added/i,
      /\bapi\s+docs?/i,
    ],
    shapes: ['documentation'],
  },

  // Schema / database outcomes
  {
    patterns: [
      /\b(schema|migration)\s+(applied|complete|run)/i,
      /\b(database|db)\s+(updated?|migrated?)/i,
      /\btable\s+(created?|altered?|updated?)/i,
      /\bsql\s+(executed?|run)/i,
    ],
    shapes: ['sql_schema'],
  },

  // Configuration outcomes
  {
    patterns: [
      /\b(config|configuration)\s+(updated?|set|complete)/i,
      /\benvironment\s+(vars?|variables?)\s+(set|configured)/i,
      /\bsettings?\s+(updated?|configured)/i,
    ],
    shapes: ['config_file'],
  },

  // Analysis / report outcomes
  {
    patterns: [
      /\b(analysis|report)\s+(complete|generated|available)/i,
      /\b(findings?|results?)\s+(documented|reported)/i,
      /\baudit\s+complete/i,
      /\breview\s+complete/i,
    ],
    shapes: ['analysis'],
  },

  // Recommendation outcomes
  {
    patterns: [
      /\brecommendations?\s+(provided|generated|available)/i,
      /\bsuggestions?\s+(provided|generated)/i,
      /\bnext\s+steps?\s+(identified|documented)/i,
      /\bimprovements?\s+suggested/i,
    ],
    shapes: ['recommendation'],
  },

  // Metrics / performance outcomes
  {
    patterns: [
      /\b(metrics|performance)\s+(improved|measured|tracked)/i,
      /\blatency\s+(reduced|improved)/i,
      /\b(faster|quicker|optimized)/i,
    ],
    shapes: ['metrics', 'patch'],
  },

  // Trace / debugging outcomes
  {
    patterns: [
      /\b(trace|tracing|logging)\s+(added|enabled|working)/i,
      /\bdebugging\s+(info|data)\s+(available|logged)/i,
      /\bobservability\s+improved/i,
    ],
    shapes: ['trace', 'source_code'],
  },
];

/**
 * Map a single expected outcome to canonical output shapes
 *
 * @param outcome - Natural language outcome description (e.g., "Tests passing")
 * @returns Array of canonical shape names
 */
export function mapOutcomeToShapes(outcome: string): string[] {
  const shapes = new Set<string>();

  for (const mapping of OUTCOME_TO_SHAPES) {
    for (const pattern of mapping.patterns) {
      if (pattern.test(outcome)) {
        for (const shape of mapping.shapes) {
          shapes.add(shape);
        }
        // Don't break - allow multiple pattern groups to match
      }
    }
  }

  return Array.from(shapes).sort();
}

/**
 * Map multiple expected outcomes to canonical output shapes
 *
 * @param outcomes - Array of outcome descriptions from goal enrichment
 * @returns Deduplicated array of canonical shape names
 */
export function mapOutcomesToShapes(outcomes: string[]): string[] {
  const shapes = new Set<string>();

  for (const outcome of outcomes) {
    for (const shape of mapOutcomeToShapes(outcome)) {
      shapes.add(shape);
    }
  }

  return Array.from(shapes).sort();
}

/**
 * Calculate coverage score between expected output shapes and activity output shapes
 *
 * @param expectedShapes - Shapes derived from goal expectedOutcomes
 * @param activityShapes - output_shapes from activity template
 * @returns Score from 0.0 to 1.0 (1.0 = full coverage)
 */
export function calculateOutputShapeCoverage(
  expectedShapes: string[],
  activityShapes: string[] | null | undefined
): number {
  // If no expected shapes, any activity matches
  if (!expectedShapes || expectedShapes.length === 0) {
    return 1.0;
  }

  // If activity has no output shapes, no match
  if (!activityShapes || activityShapes.length === 0) {
    return 0.0;
  }

  const activitySet = new Set(activityShapes);
  let matchCount = 0;

  for (const expected of expectedShapes) {
    if (activitySet.has(expected)) {
      matchCount++;
    }
  }

  return matchCount / expectedShapes.length;
}

/**
 * Get all known output shape names for reference
 */
export function getKnownOutputShapes(): string[] {
  const shapes = new Set<string>();
  for (const mapping of OUTCOME_TO_SHAPES) {
    for (const shape of mapping.shapes) {
      shapes.add(shape);
    }
  }
  return Array.from(shapes).sort();
}
