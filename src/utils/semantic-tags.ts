/**
 * Semantic tag extraction and mapping
 *
 * Maps natural language keywords in task descriptions to hierarchical tags.
 * Used to pre-filter activity templates before Thompson Sampling.
 */

/**
 * Keyword to tag prefix mappings
 *
 * Structure: keyword → tag prefixes (ordered by specificity)
 * When multiple keywords match, all tag prefixes are combined.
 */
const KEYWORD_TO_TAGS: Record<string, string[]> = {
  // Testing
  'test': ['development.testing', 'development.quality', 'tool.code.test', 'tool'],
  'tests': ['development.testing', 'development.quality', 'tool.code.test', 'tool'],
  'testing': ['development.testing', 'development.quality', 'tool.code.test', 'tool'],
  'unit test': ['development.testing', 'tool.code.test', 'tool'],
  'integration test': ['development.testing', 'tool.code.test', 'tool'],
  'e2e': ['development.testing', 'tool.code.test', 'tool'],
  'quality': ['development.quality', 'tool.code.quality', 'tool'],

  // Debugging and analysis
  'debug': ['meta.debug', 'meta'],
  'debugging': ['meta.debug', 'meta'],
  'analyze': ['meta.debug', 'meta.learning'],
  'analyse': ['meta.debug', 'meta.learning'],
  'investigate': ['meta.debug', 'meta'],
  'diagnose': ['meta.debug', 'meta'],
  'troubleshoot': ['meta.debug', 'meta'],
  'failure': ['meta.debug', 'meta'],
  'error': ['meta.debug', 'meta'],
  'failed': ['meta.debug', 'meta'],
  'failing': ['meta.debug', 'meta'],

  // Feature development
  'implement': ['development.feature', 'feature', 'feature.vessel'],
  'add': ['development.feature', 'development.enhancement', 'feature', 'feature.vessel'],
  'create': ['development.scaffold', 'development', 'feature', 'tool'],
  'build': ['development.scaffold', 'development', 'feature', 'feature.vessel'],
  'develop': ['development', 'development.feature', 'feature', 'meta.develop'],
  'feature': ['development.feature', 'development.enhancement', 'feature'],
  'enhance': ['development.enhancement', 'development.feature', 'feature'],
  'enhancement': ['development.enhancement', 'development.feature', 'feature'],
  'extend': ['development.enhancement', 'development.feature', 'feature'],
  'endpoint': ['feature.vessel.api', 'feature'],
  'api': ['feature.vessel.api', 'feature'],
  'route': ['feature.vessel.api', 'feature'],

  // Refactoring
  'refactor': ['meta.refactor', 'meta'],
  'refactoring': ['meta.refactor', 'meta'],
  'cleanup': ['meta.refactor', 'meta'],
  'simplify': ['meta.refactor', 'meta'],
  'optimize': ['meta.refactor', 'meta'],
  'improve': ['meta.refactor', 'meta.learning'],
  'restructure': ['meta.refactor', 'meta'],

  // Bug fixing
  'fix': ['bugfix', 'meta.debug'],
  'bugfix': ['bugfix'],
  'bug': ['bugfix', 'meta.debug'],
  'patch': ['bugfix'],
  'repair': ['bugfix', 'meta.debug'],

  // Code exploration
  'explore': ['development.exploration', 'tool.exploration', 'tool'],
  'exploration': ['development.exploration', 'tool.exploration', 'tool'],
  'understand': ['development.exploration', 'tool.exploration', 'meta.learning'],
  'analyze structure': ['development.exploration', 'tool.exploration', 'tool'],
  'codebase': ['development.exploration', 'tool.exploration', 'tool'],
  'dependencies': ['development.exploration', 'tool.exploration', 'tool'],
  'architecture': ['development.exploration', 'tool.exploration', 'meta'],
  'investigate codebase': ['development.exploration', 'development.documentation', 'tool.exploration'],

  // Meta-learning
  'extract': ['meta.learning', 'meta'],
  'learn': ['meta.learning', 'meta'],
  'pattern': ['meta.learning', 'meta'],
  'discover': ['meta.learning', 'meta.debug'],
  'template': ['meta.learning', 'meta'],
  'variant': ['meta.learning', 'meta'],
  'generalize': ['meta.learning', 'meta'],
  'specialize': ['meta.learning', 'meta'],

  // Instrumentation
  'instrument': ['tool.instrumentation', 'tool'],
  'instrumentation': ['tool.instrumentation', 'tool'],
  'trace': ['tool.instrumentation', 'tool.code.trace'],
  'tracing': ['tool.instrumentation', 'tool.code.trace'],
  'monitor': ['tool.instrumentation', 'tool'],
  'observability': ['tool.instrumentation', 'tool'],

  // Documentation
  'document': ['development.documentation', 'tool.documentation', 'tool'],
  'documentation': ['development.documentation', 'tool.documentation', 'tool'],
  'readme': ['development.documentation', 'tool.documentation', 'tool'],
  'docs': ['development.documentation', 'tool.documentation', 'tool'],
  'comment': ['development.documentation', 'tool.documentation', 'tool'],

  // Infrastructure
  'deploy': ['infrastructure', 'tool.deployment'],
  'deployment': ['infrastructure', 'tool.deployment'],
  'configure': ['infrastructure', 'feature.vessel.state'],
  'setup': ['infrastructure', 'feature.vessel'],
  'infrastructure': ['infrastructure'],
  'devops': ['infrastructure', 'tool'],

  // State management
  'state': ['feature.vessel.state', 'feature'],
  'persistence': ['feature.vessel.state', 'feature'],
  'storage': ['feature.vessel.state', 'feature'],
  'database': ['feature.vessel.state', 'infrastructure'],

  // Communication
  'websocket': ['feature.vessel.state.communication', 'feature'],
  'notification': ['feature.vessel.state.communication', 'feature'],
  'event': ['feature.vessel.state.communication', 'feature'],
  'message': ['feature.vessel.state.communication', 'feature'],

  // Code quality
  'lint': ['tool.code.quality', 'tool'],
  'format': ['tool.code.quality', 'tool'],
  'type': ['tool.code.quality', 'tool'],
  'types': ['tool.code.quality', 'tool'],
  'typescript': ['development.typescript', 'tool.code.quality', 'tool'],

  // Development / Scaffolding
  'module': ['development.scaffold', 'development', 'feature'],
  'scaffold': ['development.scaffold', 'development'],
  'boilerplate': ['development.scaffold', 'development'],
  'starter': ['development.scaffold', 'development'],
  'skeleton': ['development.scaffold', 'development'],
  'development': ['development', 'feature'],
  'component': ['development.scaffold', 'development', 'feature'],
  'service': ['development.scaffold', 'development', 'feature'],
  'class': ['development.scaffold', 'development', 'feature'],
  'function': ['development.scaffold', 'development', 'feature'],
  'utility': ['development.scaffold', 'development', 'tool'],
  'helper': ['development.scaffold', 'development', 'tool'],

  // Security
  'security': ['bugfix.security', 'bugfix'],
  'vulnerability': ['bugfix.security', 'bugfix'],
  'cve': ['bugfix.security', 'bugfix'],
  'auth': ['feature.security', 'feature.vessel.api'],
  'authentication': ['feature.security', 'feature.vessel.api'],
  'authorization': ['feature.security', 'feature.vessel.api'],
  'injection': ['bugfix.security', 'bugfix'],
  'xss': ['bugfix.security', 'bugfix'],
  'csrf': ['bugfix.security', 'bugfix'],

  // Performance
  'performance': ['meta.refactor', 'tool'],
  'slow': ['meta.refactor', 'meta.debug'],
  'latency': ['meta.refactor', 'meta.debug'],
  'memory': ['meta.debug', 'meta.refactor'],
  'cpu': ['meta.debug', 'meta.refactor'],
  'cache': ['meta.refactor', 'feature.vessel.state'],

  // Migration
  'migrate': ['infrastructure', 'meta.refactor'],
  'migration': ['infrastructure', 'meta.refactor'],
  'upgrade': ['infrastructure', 'meta.refactor'],
  'schema': ['infrastructure', 'feature.vessel.state'],

  // CI/CD
  'ci': ['infrastructure', 'tool.deployment'],
  'cd': ['infrastructure', 'tool.deployment'],
  'pipeline': ['infrastructure', 'tool.deployment'],
  'github': ['infrastructure', 'tool'],
  'actions': ['infrastructure', 'tool'],
  'workflow': ['infrastructure', 'tool'],

  // Containers
  'docker': ['infrastructure', 'tool.deployment'],
  'kubernetes': ['infrastructure', 'tool.deployment'],
  'k8s': ['infrastructure', 'tool.deployment'],
  'helm': ['infrastructure', 'tool.deployment'],
  'container': ['infrastructure', 'tool.deployment'],

  // Logging/Monitoring
  'log': ['tool.instrumentation', 'tool'],
  'logging': ['tool.instrumentation', 'tool'],
  'metrics': ['tool.instrumentation', 'tool'],
  'alert': ['tool.instrumentation', 'tool'],
  'dashboard': ['tool.instrumentation', 'tool'],
};

/**
 * Extract tag prefixes from a task description
 *
 * @param taskDescription - Natural language goal description
 * @returns Array of tag prefixes to filter by, ordered by confidence
 */
export function extractTagPrefixes(taskDescription: string): string[] {
  const lowerDesc = taskDescription.toLowerCase();
  const matchedTags = new Set<string>();
  const tagScores = new Map<string, number>();

  // Find all matching keywords
  for (const [keyword, tagPrefixes] of Object.entries(KEYWORD_TO_TAGS)) {
    if (lowerDesc.includes(keyword)) {
      // Add all associated tag prefixes
      for (let i = 0; i < tagPrefixes.length; i++) {
        const tag = tagPrefixes[i];
        matchedTags.add(tag);

        // Score by specificity (first tag in list = most specific = highest score)
        const specificityScore = tagPrefixes.length - i;
        const currentScore = tagScores.get(tag) || 0;
        tagScores.set(tag, currentScore + specificityScore);
      }
    }
  }

  // Sort by score (descending)
  const sortedTags = Array.from(matchedTags).sort((a, b) => {
    const scoreA = tagScores.get(a) || 0;
    const scoreB = tagScores.get(b) || 0;
    if (scoreB !== scoreA) return scoreB - scoreA;

    // Tie-break: more specific (more dots) wins
    const dotsA = (a.match(/\./g) || []).length;
    const dotsB = (b.match(/\./g) || []).length;
    return dotsB - dotsA;
  });

  return sortedTags;
}

/**
 * Calculate tag match quality between extracted tags and template tags
 *
 * @param extractedPrefixes - Tag prefixes from task description
 * @param templateTags - Tags assigned to activity template
 * @returns Match quality score (0.0 to 1.0)
 */
export function calculateTagMatchQuality(
  extractedPrefixes: string[],
  templateTags: string[]
): number {
  if (extractedPrefixes.length === 0 || templateTags.length === 0) {
    return 0;
  }

  let totalScore = 0;
  let maxScore = 0;

  for (let i = 0; i < extractedPrefixes.length; i++) {
    const prefix = extractedPrefixes[i];
    const prefixWeight = 1.0 / (i + 1); // First match = 1.0, second = 0.5, third = 0.33...
    maxScore += prefixWeight;

    // Check if any template tag starts with this prefix
    const hasMatch = templateTags.some(tag => tag.startsWith(prefix));
    if (hasMatch) {
      totalScore += prefixWeight;
    }
  }

  return maxScore > 0 ? totalScore / maxScore : 0;
}

/**
 * Extract specific entities that might map to impulse shapes
 *
 * @param taskDescription - Natural language goal description
 * @returns Suggested impulse shapes to look for
 */
export function extractImpliedShapes(taskDescription: string): string[] {
  // NOTE: These shapes must align with the canonical schema shapes:
  // goal, source_code, error, trace, execution_trace, activity_template,
  // activity_metrics, test_suite, sql_schema, metrics, config_file
  const shapes = new Set<string>();
  const lowerDesc = taskDescription.toLowerCase();

  // File/code patterns - use source_code (file is a pointer type, not a shape)
  if (lowerDesc.match(/\b\w+\.(ts|js|py|go|rs|java)\b/)) {
    shapes.add('source_code');
  }

  // Error/failure patterns
  if (lowerDesc.match(/\b(error|exception|failure|crash|bug)\b/)) {
    shapes.add('error');
    shapes.add('trace');
  }

  // Execution/trace patterns
  if (lowerDesc.match(/\b(execution|trace|activity|run|running)\b/)) {
    shapes.add('execution_trace');
  }

  // Template/pattern patterns
  if (lowerDesc.match(/\b(template|activity|pattern|variant)\b/)) {
    shapes.add('activity_template');
  }

  // Metrics/performance patterns
  if (lowerDesc.match(/\b(metric|performance|stats|success rate|failing)\b/)) {
    shapes.add('activity_metrics');
  }

  // Test patterns
  if (lowerDesc.match(/\b(test|spec|suite)\b/)) {
    shapes.add('test_suite');
    shapes.add('source_code');
  }

  // Goal/requirement patterns - explicit mentions
  if (lowerDesc.match(/\b(goal|requirement|spec)\b/)) {
    shapes.add('goal');
  }

  // Action-oriented tasks implicitly have goals
  // Tasks starting with action verbs like "fix", "implement", "add" are goal-directed
  if (lowerDesc.match(/^(fix|implement|add|update|build|create|resolve|debug|refactor|optimize|improve)\b/)) {
    shapes.add('goal');
  }

  // Security patterns - security issues are a type of error
  if (lowerDesc.match(/\b(security|vulnerability|cve|auth|injection|xss|csrf)\b/)) {
    shapes.add('error');
    shapes.add('source_code');
  }

  // Migration patterns - migrations are sql_schema
  if (lowerDesc.match(/\b(migrat|upgrade|schema|database)\b/)) {
    shapes.add('sql_schema');
  }

  // Performance patterns
  if (lowerDesc.match(/\b(performance|slow|optimize|latency|memory|cpu)\b/)) {
    shapes.add('metrics');
    shapes.add('trace');
  }

  // CI/CD patterns - ci configs and workflows are config_file
  if (lowerDesc.match(/\b(ci|cd|pipeline|github|actions|workflow)\b/)) {
    shapes.add('config_file');
  }

  // Container patterns - container and infrastructure configs are config_file
  if (lowerDesc.match(/\b(docker|kubernetes|k8s|helm|container)\b/)) {
    shapes.add('config_file');
  }

  return Array.from(shapes);
}

/**
 * Compute comprehensive semantic analysis of task description
 *
 * @param taskDescription - Natural language goal description
 * @returns Analysis with tag prefixes, match quality helper, and shape suggestions
 */
export function analyzeTaskSemantics(taskDescription: string) {
  const tagPrefixes = extractTagPrefixes(taskDescription);
  const impliedShapes = extractImpliedShapes(taskDescription);

  return {
    tagPrefixes,
    impliedShapes,

    /**
     * Helper to calculate match quality for a given template
     */
    getMatchQuality: (templateTags: string[]) =>
      calculateTagMatchQuality(tagPrefixes, templateTags),

    /**
     * Get the primary intent category
     */
    primaryIntent: tagPrefixes[0]?.split('.')[0] || null,

    /**
     * Get all intents (top-level categories)
     */
    allIntents: [...new Set(tagPrefixes.map(t => t.split('.')[0]))],
  };
}
