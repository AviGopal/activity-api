import { z } from 'zod';

// Session schemas
export const SessionPostRequestSchema = z.object({
  org_id: z.string().optional(),
  project_id: z.string().optional(),
  api_key: z.string().optional(),
});

export const SessionDataSchema = z.object({
  session_id: z.string(),
  org_id: z.string().nullable(),
  project_id: z.string().nullable(),
  api_key: z.string().nullable(),
  latest_job_id: z.string().nullable(),
});

export const SessionPostResponseSchema = z.object({
  session: z.string(),
});

// Activity Template schemas
export const TemplateTaskSchema = z.object({
  id: z.string(),
  subagent: z.string(),
  description: z.string(),
  dependencies: z.array(z.string()),
  prompt: z.object({
    template: z.string(),
    maxTokens: z.number().optional(),
    compressionStrategy: z.string().optional(),
    variables: z.array(z.any()).optional(),
  }),
  validation: z.object({
    requiredFiles: z.array(z.string()).optional(),
    requiredPatterns: z.array(z.any()).optional(),
    forbiddenPatterns: z.array(z.any()).optional(),
    commands: z.array(z.any()).optional(),
  }).optional(),
  retry: z.object({
    maxAttempts: z.number(),
    strategy: z.string(),
  }).optional(),
});

export const TemplateMetricsSchema = z.object({
  variant_id: z.string(),
  activity_id: z.string(),
  total_executions: z.number(),
  successful_executions: z.number(),
  failed_executions: z.number(),
  success_rate: z.number(),
  avg_duration_ms: z.number(),
  avg_cost_usd: z.number(),
  avg_tokens_input: z.number().optional(),
  avg_tokens_output: z.number().optional(),
  avg_tokens_cache: z.number().optional(),
  thompson_alpha: z.number(),
  thompson_beta: z.number(),
  total_selections: z.number().optional(),
  last_executed_at: z.union([z.string(), z.object({}).passthrough()]).optional(),
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const ActivityTemplateSchema = z.object({
  variant_id: z.string(),
  activity_id: z.string(),
  variant_name: z.string(),
  description: z.string(),
  category: z.string(),
  task_steps: z.array(TemplateTaskSchema).optional(),
  scope: z.string().nullable(),
  org_id: z.string().nullable(),
  project_id: z.string().nullable(),
  genealogy: z.record(z.any()).optional(),
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
  // Metrics merged in from template_metrics
  metrics: TemplateMetricsSchema.optional(),
});

export const TemplateListResponseSchema = z.object({
  templates: z.array(z.any()),  // Workaround for circular type issue
  total: z.number(),
});

// Template Registration/Creation schemas
export const CreateTemplateRequestSchema = z.object({
  variant_id: z.string(),
  activity_id: z.string(),
  variant_name: z.string(),
  description: z.string(),
  category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']),
  task_steps: z.array(TemplateTaskSchema),
  scope: z.enum(['global', 'org', 'project']).default('global'),
  // Public templates are visible in template marketplace regardless of scope
  // scope=global + public=true = visible to everyone
  // scope=org + public=true = visible to org members + discoverable in marketplace
  public: z.boolean().default(false),
  org_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  genealogy: z.record(z.any()).optional(),
});

export const CreateTemplateResponseSchema = z.object({
  success: z.boolean(),
  variant_id: z.string(),
  message: z.string().optional(),
});

// Execution schemas
export const ExecutionTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache: z.number(),
});

export const ExecutionRecordSchema = z.object({
  variant_id: z.string(),
  success: z.boolean(),
  duration_ms: z.number(),
  cost: z.number(),
  tokens: ExecutionTokensSchema,
  error_message: z.string().optional(),
  error_type: z.string().optional(),
  failed_task_id: z.string().optional(),
  impulses_used: z.array(z.string()).optional(),
  component_changes: z.array(z.string()).optional(),
});

export const ExecutionRecordResponseSchema = z.object({
  success: z.boolean(),
  execution_id: z.string(),
  metrics: TemplateMetricsSchema.optional(),
});

// Type exports
export type SessionPostRequest = z.infer<typeof SessionPostRequestSchema>;
export type SessionData = z.infer<typeof SessionDataSchema>;
export type SessionPostResponse = z.infer<typeof SessionPostResponseSchema>;
export type TemplateTask = z.infer<typeof TemplateTaskSchema>;
export type TemplateMetrics = z.infer<typeof TemplateMetricsSchema>;
export type ActivityTemplate = z.infer<typeof ActivityTemplateSchema>;
export type TemplateListResponse = z.infer<typeof TemplateListResponseSchema>;
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;
export type CreateTemplateResponse = z.infer<typeof CreateTemplateResponseSchema>;
export type ExecutionTokens = z.infer<typeof ExecutionTokensSchema>;
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;
export type ExecutionRecordResponse = z.infer<typeof ExecutionRecordResponseSchema>;

// Impulse schemas
export const ImpulsePointerSchema = z.object({
  type: z.string(), // file, memo, component, activityOutput, etc.
  content: z.string().optional(), // memo content
  file_path: z.string().optional(), // file pointer
  component_id: z.string().optional(), // component pointer
  source: z.string().optional(), // source identifier
});

export const ImpulseDataSchema = z.object({
  id: z.string(),
  type: z.string(),
  pointer: ImpulsePointerSchema,
  budget: z.number(),
  priority: z.number().optional(),
  scope: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

export const ImpulseCreateRequestSchema = z.object({
  impulse_id: z.string(),
  project_id: z.string(),
  impulse_data: ImpulseDataSchema,
});

export const ImpulseResponseSchema = z.object({
  impulse_id: z.string(),
  api_key: z.string(),
  project_id: z.string(),
  impulse_data: ImpulseDataSchema,
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const ImpulseListResponseSchema = z.object({
  impulses: z.array(ImpulseResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

// Type exports for impulses
export type ImpulsePointer = z.infer<typeof ImpulsePointerSchema>;
export type ImpulseData = z.infer<typeof ImpulseDataSchema>;
export type ImpulseCreateRequest = z.infer<typeof ImpulseCreateRequestSchema>;
export type ImpulseResponse = z.infer<typeof ImpulseResponseSchema>;
export type ImpulseListResponse = z.infer<typeof ImpulseListResponseSchema>;

// Activity Composition Graph schemas
export const CompositionEdgeSchema = z.object({
  parent_activity_id: z.string(),
  child_activity_id: z.string(),
  execution_id: z.string(),
  goal_context: z.string().optional(),
  success: z.boolean(),
  execution_count: z.number().int().default(1),
  success_count: z.number().int().default(0),
  weight: z.number().min(0).max(1), // Computed: success_count / execution_count
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const CompositionRecordRequestSchema = z.object({
  parent_activity_id: z.string(),
  child_activity_id: z.string(),
  execution_id: z.string(),
  goal_context: z.string().optional(),
  success: z.boolean(),
});

export const CompositionGraphQuerySchema = z.object({
  activity_id: z.string().optional(), // Filter by parent or child
  min_weight: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
});

export const CompositionGraphResponseSchema = z.object({
  edges: z.array(CompositionEdgeSchema),
  total: z.number().int(),
});

// Type exports for composition graph
export type CompositionEdge = z.infer<typeof CompositionEdgeSchema>;
export type CompositionRecordRequest = z.infer<typeof CompositionRecordRequestSchema>;
export type CompositionGraphQuery = z.infer<typeof CompositionGraphQuerySchema>;
export type CompositionGraphResponse = z.infer<typeof CompositionGraphResponseSchema>;

// Impulse Relevance Metrics schemas
export const ImpulseRelevanceMetricSchema = z.object({
  impulse_id: z.string(),
  activity_variant_id: z.string(),
  task_id: z.string().optional(),
  
  // Relevance tracking
  times_loaded: z.number().int().default(0),
  times_execution_succeeded: z.number().int().default(0),
  times_execution_failed: z.number().int().default(0),
  times_not_loaded_succeeded: z.number().int().default(0),
  times_not_loaded_failed: z.number().int().default(0),
  
  // Learned scores (Bayesian)
  relevance_score: z.number().min(0).max(1), // P(success | impulse present)
  irrelevance_score: z.number().min(0).max(1), // P(success | impulse absent)
  
  // Context metadata
  avg_content_size_tokens: z.number().int().default(0),
  typical_pointer_type: z.string().optional(),
  
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const ImpulseRelevanceRecordRequestSchema = z.object({
  impulse_id: z.string(),
  activity_variant_id: z.string(),
  task_id: z.string().optional(),
  was_loaded: z.boolean(),
  execution_succeeded: z.boolean(),
  content_size_tokens: z.number().int().optional(),
  pointer_type: z.string().optional(),
});

export const ImpulseRelevanceQuerySchema = z.object({
  impulse_id: z.string().optional(),
  activity_variant_id: z.string().optional(),
  min_relevance_score: z.number().min(0).max(1).optional(),
  max_irrelevance_score: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
});

export const ImpulseRelevanceResponseSchema = z.object({
  metrics: z.array(ImpulseRelevanceMetricSchema),
  total: z.number().int(),
});

// Type exports for impulse relevance
export type ImpulseRelevanceMetric = z.infer<typeof ImpulseRelevanceMetricSchema>;
export type ImpulseRelevanceRecordRequest = z.infer<typeof ImpulseRelevanceRecordRequestSchema>;
export type ImpulseRelevanceQuery = z.infer<typeof ImpulseRelevanceQuerySchema>;
export type ImpulseRelevanceResponse = z.infer<typeof ImpulseRelevanceResponseSchema>;

// Tool Usage Patterns schemas
export const ToolUsagePatternSchema = z.object({
  tool_name: z.string(),
  activity_variant_id: z.string(),
  task_id: z.string().optional(),
  
  // Usage tracking
  times_used: z.number().int().default(0),
  times_succeeded: z.number().int().default(0),
  times_failed: z.number().int().default(0),
  times_activity_succeeded_with_tool: z.number().int().default(0),
  times_activity_succeeded_without_tool: z.number().int().default(0),
  
  // Learned patterns
  usage_probability: z.number().min(0).max(1), // P(tool used | activity executes)
  success_correlation: z.number().min(-1).max(1), // Correlation between tool usage and success
  is_required: z.boolean().default(false), // true if activity never succeeds without this tool
  is_optional: z.boolean().default(true), // false if tool always used
  
  // Context metadata
  avg_params_complexity: z.number().default(0), // Average param object size
  typical_error_rate: z.number().min(0).max(1).default(0),
  
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const ToolUsageRecordRequestSchema = z.object({
  tool_name: z.string(),
  activity_variant_id: z.string(),
  task_id: z.string().optional(),
  execution_id: z.string(),
  tool_succeeded: z.boolean(),
  activity_succeeded: z.boolean(),
  params_complexity: z.number().optional(), // Size/complexity of params passed
});

export const ToolUsageQuerySchema = z.object({
  tool_name: z.string().optional(),
  activity_variant_id: z.string().optional(),
  is_required: z.boolean().optional(), // Filter to only required tools
  min_usage_probability: z.number().min(0).max(1).optional(),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
});

export const ToolUsageResponseSchema = z.object({
  patterns: z.array(ToolUsagePatternSchema),
  total: z.number().int(),
});

// Type exports for tool usage patterns
export type ToolUsagePattern = z.infer<typeof ToolUsagePatternSchema>;
export type ToolUsageRecordRequest = z.infer<typeof ToolUsageRecordRequestSchema>;
export type ToolUsageQuery = z.infer<typeof ToolUsageQuerySchema>;
export type ToolUsageResponse = z.infer<typeof ToolUsageResponseSchema>;

// Execution Sequences schemas
export const ExecutionSequenceItemSchema = z.object({
  activity_id: z.string(),
  execution_id: z.string(),
  order: z.number().int(), // Position in sequence (0-based)
  trigger_type: z.enum(['goal', 'nested', 'boredom', 'manual']),
  parent_execution_id: z.string().optional(), // If nested call
  success: z.boolean(),
  duration_ms: z.number(),
  cost_usd: z.number(),
});

export const ExecutionSequenceSchema = z.object({
  session_id: z.string(),
  goal_context: z.string().optional(), // High-level goal being achieved
  sequence: z.array(ExecutionSequenceItemSchema),
  outcome: z.enum(['success', 'partial', 'failure']),
  total_duration_ms: z.number(),
  total_cost_usd: z.number(),
  total_activities: z.number().int(),
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const ExecutionSequenceRecordRequestSchema = z.object({
  session_id: z.string(),
  goal_context: z.string().optional(),
  sequence: z.array(ExecutionSequenceItemSchema),
  outcome: z.enum(['success', 'partial', 'failure']),
});

export const ExecutionSequenceQuerySchema = z.object({
  session_id: z.string().optional(),
  goal_context: z.string().optional(), // Fuzzy match on goal
  min_activities: z.number().int().optional(), // Minimum sequence length
  max_activities: z.number().int().optional(), // Maximum sequence length
  outcome: z.enum(['success', 'partial', 'failure']).optional(),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
});

export const ExecutionSequenceResponseSchema = z.object({
  sequences: z.array(ExecutionSequenceSchema),
  total: z.number().int(),
});

// Type exports for execution sequences
export type ExecutionSequenceItem = z.infer<typeof ExecutionSequenceItemSchema>;
export type ExecutionSequence = z.infer<typeof ExecutionSequenceSchema>;
export type ExecutionSequenceRecordRequest = z.infer<typeof ExecutionSequenceRecordRequestSchema>;
export type ExecutionSequenceQuery = z.infer<typeof ExecutionSequenceQuerySchema>;
export type ExecutionSequenceResponse = z.infer<typeof ExecutionSequenceResponseSchema>;
// Goal Execution Paths schemas (Phase 1.7)
export const GoalExecutionPathSchema = z.object({
  goal_hash: z.string(),
  goal_text: z.string(),
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']),
  
  // Path definition
  path_activities: z.array(z.string()),
  path_signature: z.string(),
  
  // Thompson Sampling
  total_executions: z.number().int().default(0),
  successful_executions: z.number().int().default(0),
  failed_executions: z.number().int().default(0),
  thompson_alpha: z.number().default(1.0),
  thompson_beta: z.number().default(1.0),
  success_rate: z.number().min(0).max(1),
  
  // Performance
  avg_duration_ms: z.number().default(0),
  avg_cost_usd: z.number().default(0),
  avg_token_usage: z.number().int().default(0),
  
  // Context
  typical_files_modified: z.array(z.string()).optional(),
  typical_tools_used: z.array(z.string()).optional(),
  
  // Timestamps
  last_executed_at: z.union([z.string(), z.object({}).passthrough()]).optional(),
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const PathRecordRequestSchema = z.object({
  goal_text: z.string(),
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']),
  path_activities: z.array(z.string()).min(1),
  success: z.boolean(),
  duration_ms: z.number().int(),
  cost_usd: z.number(),
  token_usage: z.number().int().optional(),
  files_modified: z.array(z.string()).optional(),
  tools_used: z.array(z.string()).optional(),
});

export const PathQuerySchema = z.object({
  goal_text: z.string().optional(),
  goal_hash: z.string().optional(),
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']).optional(),
  min_executions: z.number().int().positive().default(1),
  limit: z.number().int().positive().default(10),
  offset: z.number().int().nonnegative().default(0),
});

export const PathRecommendationRequestSchema = z.object({
  goal_text: z.string(),
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']).optional(),
  exploration_rate: z.number().min(0).max(1).default(0.1), // 10% exploration
  top_k: z.number().int().positive().default(3),
});

export const RecommendedPathSchema = z.object({
  path_activities: z.array(z.string()),
  confidence: z.number().min(0).max(1), // Thompson sample score
  success_rate: z.number().min(0).max(1),
  avg_duration_ms: z.number(),
  avg_cost_usd: z.number(),
  total_executions: z.number().int(),
  exploration_bonus: z.number().optional(), // If recommended for exploration
});

export const PathRecommendationResponseSchema = z.object({
  goal_hash: z.string(),
  recommended_paths: z.array(RecommendedPathSchema),
});

export const PathStatsResponseSchema = z.object({
  total_goals: z.number().int(),
  total_paths: z.number().int(),
  avg_paths_per_goal: z.number(),
  most_common_goals: z.array(z.object({
    goal_hash: z.string(),
    goal_text: z.string(),
    path_count: z.number().int(),
  })),
  best_performing_paths: z.array(z.object({
    goal_text: z.string(),
    path_activities: z.array(z.string()),
    success_rate: z.number().min(0).max(1),
    total_executions: z.number().int(),
  })),
});

export const PathsResponseSchema = z.object({
  paths: z.array(GoalExecutionPathSchema),
  total: z.number().int(),
});

// Type exports for goal execution paths
export type GoalExecutionPath = z.infer<typeof GoalExecutionPathSchema>;
export type PathRecordRequest = z.infer<typeof PathRecordRequestSchema>;
export type PathQuery = z.infer<typeof PathQuerySchema>;
export type PathRecommendationRequest = z.infer<typeof PathRecommendationRequestSchema>;
export type RecommendedPath = z.infer<typeof RecommendedPathSchema>;
export type PathRecommendationResponse = z.infer<typeof PathRecommendationResponseSchema>;
export type PathStatsResponse = z.infer<typeof PathStatsResponseSchema>;
export type PathsResponse = z.infer<typeof PathsResponseSchema>;

// =============================================================================
// PHASE 1.8: UNIFIED IMPULSE-DRIVEN ARCHITECTURE
// =============================================================================

/**
 * Execution trace schemas for storing and resolving execution traces as impulses
 */

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.any()),
  result: z.object({
    success: z.boolean(),
    output: z.string().optional(),
    error: z.string().optional(),
    metadata: z.record(z.any()).optional(),
  }).optional(),
});

export const ValidationResultsSchema = z.object({
  requiredFiles: z.array(z.object({
    path: z.string(),
    exists: z.boolean(),
  })).optional(),
  requiredPatterns: z.array(z.object({
    pattern: z.string(),
    found: z.boolean(),
  })).optional(),
  forbiddenPatterns: z.array(z.object({
    pattern: z.string(),
    found: z.boolean(),
  })).optional(),
});

export const ExecutedTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  actualPrompt: z.string(),
  toolCalls: z.array(ToolCallSchema),
  response: z.string(),
  validationResults: ValidationResultsSchema.optional(),
  result: z.object({
    status: z.enum(["success", "failure", "partial"]),
    error: z.string().optional(),
    metadata: z.record(z.any()).optional(),
  }),
  inputState: z.object({
    filesAvailable: z.array(z.string()),
    environment: z.record(z.string()),
    impulses: z.array(z.string()),
    variables: z.record(z.any()),
  }).optional(),
  outputState: z.object({
    filesModified: z.array(z.string()),
    filesCreated: z.array(z.string()),
    filesDeleted: z.array(z.string()),
    exitCode: z.number().optional(),
    stderr: z.string().optional(),
  }).optional(),
  stateTransition: z.object({
    before: z.record(z.string()),
    after: z.record(z.string()),
    workingDirectory: z.string(),
  }).optional(),
});

export const ExecutionTraceDataSchema = z.object({
  tasks: z.array(ExecutedTaskSchema),
  impulsesCreated: z.array(z.string()),
  filesModified: z.array(z.string()),
  goalContext: z.object({
    goal: z.string(),
    intent: z.string(),
    context: z.record(z.any()),
  }).optional(),
});

export const StoreExecutionTraceRequestSchema = z.object({
  execution_id: z.string(),
  template_id: z.string(),
  status: z.enum(["success", "failure", "partial"]),
  duration_ms: z.number(),
  cost_usd: z.number(),
  execution_trace: ExecutionTraceDataSchema,
});

export const StoreExecutionTraceResponseSchema = z.object({
  success: z.boolean(),
  execution_id: z.string(),
  message: z.string().optional(),
});

/**
 * Impulse resolution schemas
 */

export const ImpulseResolveRequestSchema = z.object({
  pointer: ImpulsePointerSchema.extend({
    // Extended pointer types for backend resolution
    executionId: z.string().optional(),
    templateId: z.string().optional(),
    activityId: z.string().optional(),
    // For recentExecutions pointer type
    filter: z.enum(['failed', 'successful', 'all']).optional(),
    limit: z.number().int().positive().optional(),
    since: z.string().optional(), // ISO date string
  }),
});

export const ImpulseResolveResponseSchema = z.object({
  success: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
});

// Type exports
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ValidationResults = z.infer<typeof ValidationResultsSchema>;
export type ExecutedTask = z.infer<typeof ExecutedTaskSchema>;
export type ExecutionTraceData = z.infer<typeof ExecutionTraceDataSchema>;
export type StoreExecutionTraceRequest = z.infer<typeof StoreExecutionTraceRequestSchema>;
export type StoreExecutionTraceResponse = z.infer<typeof StoreExecutionTraceResponseSchema>;
export type ImpulseResolveRequest = z.infer<typeof ImpulseResolveRequestSchema>;
export type ImpulseResolveResponse = z.infer<typeof ImpulseResolveResponseSchema>;

// =============================================================================
// CI/CD INTEGRATION SCHEMAS
// =============================================================================

/**
 * CI/CD result schemas for webhook integration
 */

export const CIArtifactSchema = z.object({
  name: z.string(),
  type: z.enum(['docker_image', 'npm_package', 'binary', 'coverage_report', 'test_report', 'other']),
  url: z.string().optional(),
  size_bytes: z.number().optional(),
  metadata: z.record(z.any()).optional(),
});

export const CIStageResultSchema = z.object({
  success: z.boolean(),
  duration_ms: z.number().optional(),
  error: z.string().optional(),
});

export const CITestStageResultSchema = CIStageResultSchema.extend({
  tests_passed: z.number().optional(),
  tests_failed: z.number().optional(),
  coverage_percent: z.number().optional(),
});

export const CILintStageResultSchema = CIStageResultSchema.extend({
  errors: z.number().optional(),
  warnings: z.number().optional(),
});

export const CIResultRequestSchema = z.object({
  execution_id: z.string(),
  template_id: z.string().optional(),
  branch: z.string(),
  commit: z.string(),
  success: z.boolean(),
  duration_ms: z.number(),
  ci_provider: z.enum(['github_actions', 'gitlab_ci', 'jenkins', 'circleci', 'other']).default('github_actions'),
  workflow_name: z.string().optional(),
  run_id: z.string().optional(),
  run_url: z.string().optional(),
  stages: z.object({
    build: CIStageResultSchema.optional(),
    typecheck: CIStageResultSchema.optional(),
    test: CITestStageResultSchema.optional(),
    lint: CILintStageResultSchema.optional(),
  }).optional(),
  artifacts: z.array(CIArtifactSchema).optional(),
  metadata: z.record(z.any()).optional(),
});

export const CIResultResponseSchema = z.object({
  success: z.boolean(),
  execution_id: z.string(),
  ci_status_updated: z.boolean(),
  metrics_updated: z.boolean(),
  deployment_enqueued: z.boolean().optional(),
  message: z.string().optional(),
});

export const CIResultsListResponseSchema = z.object({
  ci_results: z.array(z.object({
    execution_id: z.string(),
    template_id: z.string().optional(),
    status: z.string(),
    duration_ms: z.number(),
    cost_usd: z.number(),
    ci_status: z.object({
      success: z.boolean(),
      branch: z.string(),
      commit: z.string(),
      provider: z.string(),
      completed_at: z.string(),
    }).passthrough(),
    created_at: z.union([z.string(), z.object({}).passthrough()]),
  })),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

// Type exports
export type CIArtifact = z.infer<typeof CIArtifactSchema>;
export type CIStageResult = z.infer<typeof CIStageResultSchema>;
export type CITestStageResult = z.infer<typeof CITestStageResultSchema>;
export type CILintStageResult = z.infer<typeof CILintStageResultSchema>;
export type CIResultRequest = z.infer<typeof CIResultRequestSchema>;
export type CIResultResponse = z.infer<typeof CIResultResponseSchema>;
export type CIResultsListResponse = z.infer<typeof CIResultsListResponseSchema>;
