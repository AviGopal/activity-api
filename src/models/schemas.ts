import { z } from 'zod';

// =============================================================================
// HIERARCHICAL TAG SYSTEM
// =============================================================================

/**
 * Tag validation schema
 * Tags use dot-notation for hierarchy: feature.vessel.state.communication
 */
export const TagSchema = z.string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/, {
    message: 'Tags must be lowercase alphanumeric with dots (e.g., "feature.vessel.state")',
  })
  .max(100, 'Tag must be at most 100 characters');

/**
 * Legacy category enum for backward compatibility
 */
export const LegacyCategorySchema = z.enum([
  'feature',
  'bugfix',
  'refactor',
  'tool',
  'infrastructure',
  'meta',
]);

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
// Task prompt schema for LLM-based tasks
const TaskPromptSchema = z.object({
  template: z.string(),
  maxTokens: z.number().optional(),
  compressionStrategy: z.string().optional(),
  variables: z.array(z.any()).optional(),
});

// Task config schema for resolver-based tasks
const TaskConfigSchema = z.record(z.any());

// Validation schema for task output
const TaskValidationSchema = z.object({
  exitCode: z.number().optional(),
  outputContains: z.string().optional(),
  outputMatches: z.string().optional(),
  requiredFiles: z.array(z.string()).optional(),
  requiredPatterns: z.array(z.any()).optional(),
  forbiddenPatterns: z.array(z.any()).optional(),
  commands: z.array(z.any()).optional(),
});

export const TemplateTaskSchema = z.object({
  id: z.string(),
  subagent: z.string().optional(),
  description: z.string(),
  dependencies: z.array(z.string()).optional(),
  // Task execution: either prompt-based or resolver-based
  prompt: TaskPromptSchema.optional(),
  resolver: z.string().optional(), // e.g., "bash", "llm", "http", "file"
  config: TaskConfigSchema.optional(), // resolver-specific config
  // Validation for task output
  validation: TaskValidationSchema.optional(),
  retry: z.object({
    // Accept both snake_case (from MiniBob MCP) and camelCase (from ribosome)
    max_attempts: z.number().optional(),
    maxAttempts: z.number().optional(),
    strategy: z.string(),
  }).refine(
    (data) => data.max_attempts !== undefined || data.maxAttempts !== undefined,
    { message: "Either max_attempts or maxAttempts is required" }
  ).optional(),
}).refine(
  // Either prompt OR resolver must be provided
  (data) => data.prompt !== undefined || data.resolver !== undefined,
  { message: "Either 'prompt' or 'resolver' is required" }
);

export const TemplateMetricsSchema = z.object({
  // Canonical: use 'id' as the primary identifier
  id: z.string(),
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
  // Canonical field names (aligned with 020-paradigm-core-tables.surql)
  id: z.string(),
  name: z.string(),
  description: z.string(),
  // Hierarchical tags (primary classification)
  tags: z.array(z.string()).default([]),
  tag_prefixes: z.array(z.string()).optional(),
  // Legacy category (deprecated, kept for backward compatibility)
  category: z.string().optional(),
  // Canonical: 'tasks' instead of 'task_steps'
  tasks: z.array(TemplateTaskSchema).optional(),
  scope: z.string().nullable(),
  // Public templates are discoverable by all orgs (ribosome-generated templates)
  public: z.boolean().default(false),
  org_id: z.string().nullable(),
  project_id: z.string().nullable(),
  // Input/output shapes for paradigm alignment
  // input_shapes: Optional - activities can work with any input
  input_shapes: z.array(z.string()).optional(),
  // output_shapes: REQUIRED - must declare what the activity produces
  // This enables output-based activity selection and composition learning
  output_shapes: z.array(z.string()).min(1, 'output_shapes must have at least one shape'),
  execution_type: z.string().optional(),
  variant_of: z.record(z.any()).optional(),
  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
  // Metrics merged in from template_metrics
  metrics: TemplateMetricsSchema.optional(),
});

export const TemplateListResponseSchema = z.object({
  templates: z.array(z.any()),  // Workaround for circular type issue
  total: z.number(),
});

// Template impulse pointer schema
export const TemplateImpulseSchema = z.object({
  id: z.string(),
  pointer: z.object({
    type: z.string(),
  }).passthrough(), // Allow additional fields
  budget: z.number(),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  description: z.string().optional(),
});

// Template Registration/Creation schemas
// Accepts both canonical and legacy field names for backward compatibility
export const CreateTemplateRequestSchema = z.object({
  // Canonical field: 'id' (also accept legacy 'variant_id')
  id: z.string().optional(),
  variant_id: z.string().optional(),
  // Legacy field: 'activity_id' is redundant with 'id' - ignored
  activity_id: z.string().optional(),
  // Canonical field: 'name' (also accept legacy 'variant_name')
  name: z.string().optional(),
  variant_name: z.string().optional(),
  description: z.string(),
  // Primary: Hierarchical tags using dot-notation
  tags: z.array(TagSchema).min(1).optional(),
  // Deprecated: Legacy category (auto-converted to tags if tags not provided)
  category: LegacyCategorySchema.optional(),
  // Canonical field: 'tasks' (also accept legacy 'task_steps')
  tasks: z.array(TemplateTaskSchema).optional(),
  task_steps: z.array(TemplateTaskSchema).optional(),
  scope: z.enum(['global', 'org', 'project']).default('global'),
  // Public templates are discoverable by all orgs (ribosome-generated templates)
  public: z.boolean().default(false),
  org_id: z.string().nullable().optional(),
  project_id: z.string().nullable().optional(),
  // Canonical field: 'variant_of' (also accept legacy 'genealogy')
  variant_of: z.record(z.any()).optional(),
  genealogy: z.record(z.any()).optional(),
  // Template-level impulse definitions
  impulses: z.array(TemplateImpulseSchema).optional(),
  // Input/output shapes for paradigm alignment
  // input_shapes: Optional - activities can work with any input
  input_shapes: z.array(z.string()).optional(),
  // output_shapes: Optional in request (will be inferred if not provided)
  // but required in stored template after shape inference
  output_shapes: z.array(z.string()).optional(),
  // Legacy input/output schemas (converted to shapes internally)
  input_schema: z.object({
    required: z.array(z.object({
      shape: z.string(),
      description: z.string().optional(),
      collection: z.boolean().optional(),
    })).optional(),
    optional: z.array(z.object({
      shape: z.string(),
      description: z.string().optional(),
      collection: z.boolean().optional(),
    })).optional(),
  }).optional(),
  output_schema: z.object({
    produces: z.array(z.object({
      shape: z.string(),
      description: z.string().optional(),
    })).optional(),
  }).optional(),
  // Schema confidence for template generation (goal-execution-foundation-alignment)
  schema_confidence: z.number().min(0).max(1).optional(),
}).refine(
  data => data.tags?.length || data.category,
  { message: 'Either tags or category must be provided' }
).refine(
  data => data.id || data.variant_id,
  { message: 'Either id or variant_id must be provided' }
).refine(
  data => data.name || data.variant_name,
  { message: 'Either name or variant_name must be provided' }
).refine(
  data => data.tasks || data.task_steps,
  { message: 'Either tasks or task_steps must be provided' }
);

export const CreateTemplateResponseSchema = z.object({
  success: z.boolean(),
  // Canonical: 'id' (kept variant_id for backward compatibility in response)
  id: z.string(),
  variant_id: z.string().optional(), // Legacy alias
  message: z.string().optional(),
});

// Execution schemas
export const ExecutionTokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache: z.number(),
});

export const ExecutionRecordSchema = z.object({
  // Canonical: use 'activity_id' (also accept legacy 'variant_id')
  activity_id: z.string().optional(),
  variant_id: z.string().optional(), // Legacy alias
  success: z.boolean(),
  duration_ms: z.number(),
  cost: z.number(),
  tokens: ExecutionTokensSchema,
  error_message: z.string().optional(),
  error_type: z.string().optional(),
  failed_task_id: z.string().optional(),
  impulses_used: z.array(z.string()).optional(),
  component_changes: z.array(z.string()).optional(),
  // Edge learning fields (from improvisation traces)
  improvisation: z.boolean().optional(),
  input_impulse_shapes: z.array(z.string()).optional(),
  output_impulse_shapes: z.array(z.string()).optional(),
  output_impulses: z.array(z.object({
    shape: z.string(),
    pointer: z.record(z.unknown()),
  })).optional(),
  metadata: z.record(z.unknown()).optional(),
}).refine(
  data => data.activity_id || data.variant_id,
  { message: 'Either activity_id or variant_id must be provided' }
);

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
  file_path: z.string().optional(), // file pointer (backend field name)
  path: z.string().optional(), // file pointer (MiniBob field name - accepts both)
  component_id: z.string().optional(), // component pointer
  source: z.string().optional(), // source identifier
});

/**
 * Impulse metadata schema for impulse-driven investigation
 * Contains: shape, rowCount, columns, sample, availableOps, producedBy, etc.
 */
export const ImpulseMetadataObjectSchema = z.object({
  // Shape describes the data structure
  shape: z.string().optional(),
  // Count information for reasoning
  rowCount: z.number().int().optional(),
  // Column names for tabular data
  columns: z.array(z.string()).optional(),
  // Sample data for LLM context
  sample: z.array(z.any()).optional(),
  // Human-readable summary
  summary: z.string().optional(),
  // Available operations for process_impulse
  availableOps: z.array(z.string()).optional(),
  // Lineage tracking for investigation chains
  producedBy: z.string().optional(),
  // Legacy fields for backward compatibility
  tags: z.array(z.string()).optional(),
  content: z.string().optional(),
}).passthrough(); // Allow additional metadata fields

export const ImpulseDataSchema = z.object({
  id: z.string(),
  type: z.string(),
  pointer: ImpulsePointerSchema,
  budget: z.number(),
  // Accept both string ("high", "medium", "low") and number (1, 2, 3, 4)
  priority: z.union([z.number(), z.string()]).optional(),
  scope: z.string().optional(),
  // Full metadata object for impulse-driven investigation
  metadata: ImpulseMetadataObjectSchema.optional(),
});

export const ImpulseCreateRequestSchema = z.object({
  impulse_id: z.string(),
  project_id: z.string().optional(), // Optional for MiniBob instances without projects
  impulse_data: ImpulseDataSchema,
  org_id: z.string().optional(), // Optional, inferred from auth context if not provided
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
export type ImpulseMetadataObject = z.infer<typeof ImpulseMetadataObjectSchema>;
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
  // Impulse flow fields (goal-execution-foundation-alignment)
  input_impulse_shapes: z.array(z.string()).optional(),
  output_impulse_shapes: z.array(z.string()).optional(),
  duration_ms: z.number().optional(),
  cost_usd: z.number().optional(),
  tokens_input: z.number().int().optional(),
  tokens_output: z.number().int().optional(),
  depth: z.number().int().optional(),
  composition_chain: z.array(z.string()).optional(),
});

export const CompositionRecordRequestSchema = z.object({
  parent_activity_id: z.string(),
  child_activity_id: z.string(),
  execution_id: z.string(),
  goal_context: z.string().optional(),
  success: z.boolean(),
  // Impulse flow fields (goal-execution-foundation-alignment)
  input_impulse_ids: z.array(z.string()).optional(),
  input_impulse_shapes: z.array(z.string()).optional(),
  output_impulse_ids: z.array(z.string()).optional(),
  output_impulse_shapes: z.array(z.string()).optional(),
  // Additional metrics
  duration_ms: z.number().optional(),
  cost_usd: z.number().optional(),
  tokens_input: z.number().int().optional(),
  tokens_output: z.number().int().optional(),
  depth: z.number().int().optional(),
  composition_chain: z.array(z.string()).optional(),
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

  // Resolver tracking (resolver-tier-tracking)
  resolver_tier: z.string().optional(),
  resolver_name: z.string().optional(),
  avg_resolution_latency_ms: z.number().int().default(0),
  resolver_success_count: z.number().int().default(0),
  resolver_failure_count: z.number().int().default(0),

  created_at: z.union([z.string(), z.object({}).passthrough()]),
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

export const ImpulseRelevanceRecordRequestSchema = z.object({
  impulse_id: z.string(),
  activity_variant_id: z.string(),
  task_id: z.string().optional(),
  execution_id: z.string().optional(),
  was_loaded: z.boolean(),
  execution_succeeded: z.boolean(),
  content_size_tokens: z.number().int().optional(),
  pointer_type: z.string().optional(),
  // Resolver tracking fields (resolver-tier-tracking)
  resolver_tier: z.string().optional(),
  resolver_name: z.string().optional(),
  resolution_latency_ms: z.number().int().optional(),
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
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure', 'meta']),
  
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
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure', 'meta']),
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
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure', 'meta']).optional(),
  min_executions: z.number().int().positive().default(1),
  limit: z.number().int().positive().default(10),
  offset: z.number().int().nonnegative().default(0),
});

export const PathRecommendationRequestSchema = z.object({
  goal_text: z.string(),
  goal_category: z.enum(['feature', 'bugfix', 'refactor', 'tool', 'infrastructure', 'meta']).optional(),
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
    git: z.object({
      branch: z.string(),
      commit: z.string(),
      dirty: z.boolean(),
      changedFiles: z.array(z.string()),
      stagedFiles: z.array(z.string()),
      unstagedFiles: z.array(z.string()),
      ahead: z.number().optional(),
      behind: z.number().optional(),
    }).optional(),
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
  // Session context for within-session composition learning (Task #26)
  session_context: z.object({
    session_id: z.string(),
    previous_activities: z.array(z.object({
      activity_id: z.string(),
      shapes_produced: z.array(z.string()),
      success: z.boolean(),
    })),
    accumulated_shapes: z.array(z.string()),
    goal_chain: z.array(z.string()),
  }).optional(),
});

export const StoreExecutionTraceRequestSchema = z.object({
  execution_id: z.string(),
  template_id: z.string(),
  status: z.enum(["success", "failure", "partial"]),
  duration_ms: z.number(),
  cost_usd: z.number(),
  execution_trace: ExecutionTraceDataSchema,
  // Composition tracking (three-level activity tracing from minibob).
  // parent_execution_id: direct parent in the composition tree.
  // composition_chain: denormalized ancestor chain, ordered root-first,
  //   so consumers can reconstruct composition trees in a single read.
  parent_execution_id: z.string().optional(),
  composition_chain: z.array(z.string()).optional(),
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
    limit: z.union([z.number(), z.string().transform(v => parseInt(v, 10))]).pipe(z.number().int().positive()).optional(),
    since: z.string().optional(), // ISO date string
    // Analysis-specific pointer types (M3 - Impulse Bridge)
    resultId: z.string().optional(), // For analysisResult pointer
    componentIds: z.array(z.string()).optional(), // For cochangeSuggestions pointer
    changedFiles: z.array(z.string()).optional(), // For impactAnalysis pointer
    query: z.string().optional(), // For codebaseSearch and activityTemplateRecommendation pointer
    maxDepth: z.number().int().positive().optional(), // For impactAnalysis and variantGenealogy
    format: z.enum(['full', 'summary']).optional(), // For analysisResult
    severity: z.array(z.string()).optional(), // For codebaseSearch filters
    category: z.union([z.array(z.string()), z.string()]).optional(), // For codebaseSearch/template filters (accepts string or array)
    status: z.enum(['open', 'in_progress', 'resolved', 'ignored']).optional(), // For problemCluster filter
    // For activityExecutionTrace pointer type
    includeImpulses: z.boolean().optional(), // Include referenced impulses in response
    // For bootstrap template pointer types
    sortBy: z.enum(['success_rate', 'total_executions', 'avg_duration_ms', 'momentum', 'executions', 'cost']).optional(), // Extended for variantFamily
    minExecutions: z.union([z.number(), z.string().transform(v => parseInt(v, 10))]).pipe(z.number().int().nonnegative()).optional(), // For activityTemplatesByMetrics
    success: z.boolean().optional(), // For executionTraces - filter by success/failure
    // Variant-aware pointer types
    baseActivityId: z.string().optional(), // For variantGenealogy, variantPerformance, variantFamily
    variantId: z.string().optional(), // For variantPerformance - specific variant to query
    includeMetrics: z.boolean().optional(), // For variantGenealogy - include performance metrics
    includeHistory: z.boolean().optional(), // For variantPerformance - include historical data
    timeWindow: z.string().optional(), // For variantPerformance - time range (e.g., "24h", "7d", "30d")
    onlyActive: z.boolean().optional(), // For variantFamily - filter to active variants only
    includeInputImpulses: z.boolean().optional(), // For failedExecutionContext - include input impulses
    includeTrace: z.boolean().optional(), // For failedExecutionContext - include execution trace
    // Unified Learning Architecture pointer types
    toolName: z.string().optional(), // For toolRiskProfile - filter by tool name
    parentActivityId: z.string().optional(), // For compositionSuccess - filter by parent
    childActivityId: z.string().optional(), // For compositionSuccess - filter by child
    impulseShape: z.string().optional(), // For impulseRelevance - filter by shape
    argumentHash: z.string().optional(), // For preValidationResult - specific argument pattern
    arguments: z.record(z.unknown()).optional(), // For preValidationResult - argument values to validate
    minSuccessRate: z.number().min(0).max(1).optional(), // For preValidationResult - threshold for skip
    skipThreshold: z.number().min(0).max(1).optional(), // For preValidationResult - confidence threshold
  }).passthrough(), // Allow unknown pointer fields (v1.5.0 *_write/_delete/_update resolvers carry typed payloads like traceData, feedbackData, updates, olderThan, etc. — enumerating every one here would fight the open-ended design)
});

// =============================================================================
// IMPULSE METADATA SCHEMA (Analysis Integration)
// =============================================================================
// Enables impulse-driven investigation: LLM sees metadata, hypothesizes,
// then drills down via process_impulse operations.
// =============================================================================

export const ImpulseMetadataSchema = z.object({
  // Shape describes the data structure
  shape: z.string().optional(), // "problem_list", "cpg", "impact_graph", "cochange_list"

  // Count information for reasoning
  rowCount: z.number().int().optional(),

  // Human-readable summary for LLM context
  summary: z.string().optional(),

  // Available operations for process_impulse
  availableOps: z.array(z.string()).optional(), // ["filter", "expand", "group", "resolve"]

  // Breakdown by category (for problemCluster)
  bySeverity: z.record(z.number()).optional(), // { "CRITICAL": 2, "HIGH": 5 }
  byCategory: z.record(z.number()).optional(), // { "security": 3, "complexity": 6 }

  // Top item for quick context
  topIssue: z.object({
    category: z.string(),
    brief: z.string(),
    impactScore: z.number().optional(),
  }).optional(),

  // Lineage tracking for investigation chains
  producedBy: z.string().optional(), // Parent impulse ID
  operation: z.string().optional(), // Operation that created this
  operationParams: z.record(z.any()).optional(), // Params used
  producedAt: z.string().optional(), // ISO timestamp

  // Extensible for domain-specific metadata
}).passthrough();

export const ImpulseResolveResponseSchema = z.object({
  success: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
  // NEW: Metadata for impulse-driven investigation
  // When present, LLM sees metadata summary instead of full content
  metadata: ImpulseMetadataSchema.optional(),
  // Whether content is loaded or just metadata
  loaded: z.boolean().optional(),
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
export type ImpulseMetadata = z.infer<typeof ImpulseMetadataSchema>;

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

// =============================================================================
// LEARNED CORPUS DASHBOARD SCHEMAS
// =============================================================================

/**
 * ActivityScore - Thompson Sampling data from v_activity_score view
 * Used for visualizing learned corpus beliefs
 */
export const ActivityScoreSchema = z.object({
  activity_id: z.string(),
  org_id: z.string(),
  total_executions: z.number().int(),
  alpha: z.number(), // Thompson: successes + 1
  beta: z.number(), // Thompson: failures + 1
  successes: z.number().int(),
  failures: z.number().int(),
  avg_duration_ms: z.number(),
  avg_cost_usd: z.number(),
  total_cost_usd: z.number(),
  total_tokens_in: z.number().int(),
  total_tokens_out: z.number().int(),
  last_executed_at: z.string().optional(),
  first_executed_at: z.string().optional(),
});

/**
 * ActivityScoresResponse - Response for GET /v2/activities/scores
 */
export const ActivityScoresResponseSchema = z.object({
  scores: z.array(ActivityScoreSchema),
  total: z.number().int(),
  path: z.enum(['paradigm', 'legacy']),
});

/**
 * CorpusSummaryResponse - Aggregate metrics for GET /v2/activities/corpus-summary
 */
export const CorpusSummaryResponseSchema = z.object({
  total_activities: z.number().int(),
  total_executions: z.number().int(),
  total_successes: z.number().int(),
  total_failures: z.number().int(),
  overall_success_rate: z.number(),
  total_cost_usd: z.number(),
  avg_belief: z.number(), // Mean of all alpha/(alpha+beta)
  exploration_count: z.number().int(), // Activities with <5 executions
  exploitation_count: z.number().int(), // Activities with >=10 executions
});

// Type exports for Learned Corpus Dashboard
export type ActivityScore = z.infer<typeof ActivityScoreSchema>;
export type ActivityScoresResponse = z.infer<typeof ActivityScoresResponseSchema>;
export type CorpusSummaryResponse = z.infer<typeof CorpusSummaryResponseSchema>;

// =============================================================================
// TOOL ARGUMENT PATTERN TRACKING SCHEMAS
// =============================================================================

/**
 * Failure type enum for tool argument patterns
 */
export const FailureTypeSchema = z.enum([
  'validation',
  'execution',
  'tool_failure',
  'timeout',
]);

/**
 * ToolArgumentPatternRecordRequest - Request body for POST /tool-argument-patterns
 * Records argument patterns observed during tool execution for learning
 *
 * Extended with failure fields for goal-execution-foundation-alignment:
 * - failure_type: Type of failure (validation, execution, tool_failure, timeout)
 * - failure_reason: Human-readable error message
 * - tool_succeeded: Whether the individual tool call succeeded
 * - validation_error: Specific validation rule that failed
 */
export const ToolArgumentPatternRecordRequestSchema = z.object({
  activity_id: z.string(),
  tool_name: z.string(),
  argument_shape: z.string(),
  argument_hash: z.string(),
  arguments: z.record(z.unknown()),
  execution_succeeded: z.boolean(),
  execution_ms: z.number(),
  // Failure pattern learning fields (optional for backward compatibility)
  failure_type: FailureTypeSchema.optional(),
  failure_reason: z.string().optional(),
  tool_succeeded: z.boolean().optional(),
  validation_error: z.string().optional(),
});

/**
 * ToolArgumentRecommendationsQuery - Query params for GET /tool-argument-recommendations
 */
export const ToolArgumentRecommendationsQuerySchema = z.object({
  activity_id: z.string(),
});

/**
 * ToolArgumentPattern - Pattern record from v_argument_recommendations view
 * Extended with failure statistics for pattern analysis
 */
export const ToolArgumentPatternSchema = z.object({
  activity_id: z.string(),
  tool_name: z.string(),
  argument_shape: z.string(),
  argument_hash: z.string(),
  arguments: z.record(z.unknown()),
  success_rate: z.number(),
  times_used: z.number().int(),
  avg_execution_ms: z.number().optional(),
  last_used_at: z.union([z.string(), z.object({}).passthrough()]).optional(),
  org_id: z.string().optional(),
  // Failure statistics (goal-execution-foundation-alignment)
  failure_rate: z.number().optional(),
  times_succeeded: z.number().int().optional(),
  times_failed: z.number().int().optional(),
  failure_type: FailureTypeSchema.optional(),
  failure_counts: z.record(z.number()).optional(),
});

/**
 * ToolArgumentRecommendationsResponse - Response for GET /tool-argument-recommendations
 */
export const ToolArgumentRecommendationsResponseSchema = z.object({
  patterns: z.array(ToolArgumentPatternSchema),
});

// Type exports for Tool Argument Pattern Tracking
export type FailureType = z.infer<typeof FailureTypeSchema>;
export type ToolArgumentPatternRecordRequest = z.infer<typeof ToolArgumentPatternRecordRequestSchema>;
export type ToolArgumentRecommendationsQuery = z.infer<typeof ToolArgumentRecommendationsQuerySchema>;
export type ToolArgumentPattern = z.infer<typeof ToolArgumentPatternSchema>;
export type ToolArgumentRecommendationsResponse = z.infer<typeof ToolArgumentRecommendationsResponseSchema>;

// =============================================================================
// COMPOSITION IMPULSE FLOW SCHEMAS (goal-execution-foundation-alignment)
// =============================================================================

/**
 * CompositionImpulseFlow - Per-impulse tracking for composition edges
 * Enables queries like "Success rate when parent X calls child Y with shape Z"
 */
export const CompositionImpulseFlowSchema = z.object({
  edge_id: z.string(),
  execution_id: z.string(),
  impulse_id: z.string(),
  direction: z.enum(['input', 'output']),
  shape: z.string(),
  execution_succeeded: z.boolean(),
  org_id: z.string().optional(),
  project_id: z.string().optional(),
  created_at: z.union([z.string(), z.object({}).passthrough()]).optional(),
});

/**
 * CompositionImpulseSuccessQuery - Query for impulse-conditioned success rates
 */
export const CompositionImpulseSuccessQuerySchema = z.object({
  edge_id: z.string().optional(),
  shape: z.string().optional(),
  direction: z.enum(['input', 'output']).optional(),
  min_count: z.number().int().positive().default(3),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
});

/**
 * CompositionImpulseSuccessRate - Success rate conditioned on shape
 */
export const CompositionImpulseSuccessRateSchema = z.object({
  edge_id: z.string(),
  shape: z.string(),
  direction: z.enum(['input', 'output']),
  total_count: z.number().int(),
  success_count: z.number().int(),
  success_rate: z.number().min(0).max(1),
});

/**
 * CompositionImpulseSuccessResponse - Response for impulse-conditioned success queries
 */
export const CompositionImpulseSuccessResponseSchema = z.object({
  rates: z.array(CompositionImpulseSuccessRateSchema),
  total: z.number().int(),
});

// Type exports for Composition Impulse Flow
export type CompositionImpulseFlow = z.infer<typeof CompositionImpulseFlowSchema>;
export type CompositionImpulseSuccessQuery = z.infer<typeof CompositionImpulseSuccessQuerySchema>;
export type CompositionImpulseSuccessRate = z.infer<typeof CompositionImpulseSuccessRateSchema>;
export type CompositionImpulseSuccessResponse = z.infer<typeof CompositionImpulseSuccessResponseSchema>;

// =============================================================================
// FAILURE PATTERN ANALYSIS SCHEMAS (goal-execution-foundation-alignment)
// =============================================================================

/**
 * FailurePatternQuery - Query for analyzing failure patterns
 */
export const FailurePatternQuerySchema = z.object({
  activity_id: z.string().optional(),
  tool_name: z.string().optional(),
  failure_type: FailureTypeSchema.optional(),
  min_failures: z.number().int().positive().default(1),
  limit: z.number().int().positive().default(100),
  offset: z.number().int().nonnegative().default(0),
});

/**
 * FailurePattern - Pattern record from v_failure_patterns view
 */
export const FailurePatternSchema = z.object({
  activity_id: z.string(),
  tool_name: z.string(),
  argument_shape: z.string(),
  argument_hash: z.string(),
  arguments: z.record(z.unknown()),
  success_rate: z.number(),
  failure_rate: z.number(),
  times_used: z.number().int(),
  times_succeeded: z.number().int(),
  times_failed: z.number().int(),
  avg_execution_ms: z.number().optional(),
  failure_type: FailureTypeSchema.optional(),
  failure_reason: z.string().optional(),
  validation_error: z.string().optional(),
  failure_counts: z.record(z.number()).optional(),
  org_id: z.string().optional(),
});

/**
 * FailurePatternResponse - Response for failure pattern queries
 */
export const FailurePatternResponseSchema = z.object({
  patterns: z.array(FailurePatternSchema),
  total: z.number().int(),
});

// Type exports for Failure Pattern Analysis
export type FailurePatternQuery = z.infer<typeof FailurePatternQuerySchema>;
export type FailurePattern = z.infer<typeof FailurePatternSchema>;
export type FailurePatternResponse = z.infer<typeof FailurePatternResponseSchema>;

// =============================================================================
// TEMPLATE SCHEMA FIELDS (goal-execution-foundation-alignment)
// =============================================================================

/**
 * ImpulseSchemaShape - Shape definition for input/output schemas
 */
export const ImpulseSchemaShapeSchema = z.object({
  shape: z.string(),
  description: z.string().optional(),
  collection: z.boolean().optional(),
});

/**
 * ActivityInputSchema - Structured input schema for activity templates
 */
export const ActivityInputSchemaSchema = z.object({
  required: z.array(ImpulseSchemaShapeSchema).optional(),
  optional: z.array(ImpulseSchemaShapeSchema).optional(),
});

/**
 * ActivityOutputSchema - Structured output schema for activity templates
 */
export const ActivityOutputSchemaSchema = z.object({
  produces: z.array(ImpulseSchemaShapeSchema).optional(),
});

// Type exports for Template Schema Fields
export type ImpulseSchemaShape = z.infer<typeof ImpulseSchemaShapeSchema>;
export type ActivityInputSchema = z.infer<typeof ActivityInputSchemaSchema>;
export type ActivityOutputSchema = z.infer<typeof ActivityOutputSchemaSchema>;

// =============================================================================
// VARIANT-AWARE IMPULSE POINTER SCHEMAS
// =============================================================================

/**
 * VariantGenealogyPointer - Pointer type for variant genealogy lookup
 * Resolves to the genealogy tree of an activity template, showing parent-child
 * relationships and variant lineage.
 *
 * Use case: Understanding how a variant evolved, finding root templates,
 * tracing inheritance of task structures.
 */
export const VariantGenealogyPointerSchema = z.object({
  type: z.literal('variantGenealogy'),
  /** Base activity ID to look up genealogy for */
  baseActivityId: z.string(),
  /** Maximum number of genealogy entries to return */
  limit: z.number().int().positive().optional(),
  /** Include performance metrics for each variant in the tree */
  includeMetrics: z.boolean().optional(),
  /** Maximum depth to traverse in the genealogy tree */
  maxDepth: z.number().int().positive().optional(),
});

/**
 * VariantPerformancePointer - Pointer type for per-variant performance scores
 * Resolves to Thompson Sampling statistics and execution metrics for a specific
 * variant or all variants of a base activity.
 *
 * Use case: Comparing variant performance, selecting best-performing variants,
 * understanding why certain variants are chosen over others.
 */
export const VariantPerformancePointerSchema = z.object({
  type: z.literal('variantPerformance'),
  /** Base activity ID to get performance for */
  baseActivityId: z.string(),
  /** Specific variant ID (optional - if not provided, returns all variants) */
  variantId: z.string().optional(),
  /** Include historical performance data over time */
  includeHistory: z.boolean().optional(),
  /** Time window for metrics (e.g., "24h", "7d", "30d") */
  timeWindow: z.string().optional(),
});

/**
 * VariantFamilyPointer - Pointer type for variant family enumeration
 * Resolves to a list of all variants belonging to the same activity family,
 * with optional filtering and sorting.
 *
 * Use case: Discovering available variants, comparing family members,
 * finding variants with specific characteristics.
 */
export const VariantFamilyPointerSchema = z.object({
  type: z.literal('variantFamily'),
  /** Base activity ID to enumerate family for */
  baseActivityId: z.string(),
  /** Only return active (non-deprecated) variants */
  onlyActive: z.boolean().optional(),
  /** Sort variants by specific metric */
  sortBy: z.enum(['success_rate', 'momentum', 'executions', 'cost']).optional(),
  /** Maximum number of variants to return */
  limit: z.number().int().positive().optional(),
});

/**
 * FailedExecutionContextPointer - Pointer type for failure context retrieval
 * Resolves to comprehensive context about a failed execution, including
 * input impulses, execution trace, and error details.
 *
 * Use case: Debugging failed executions, creating debug activities,
 * understanding why a specific execution failed.
 */
export const FailedExecutionContextPointerSchema = z.object({
  type: z.literal('failedExecutionContext'),
  /** Execution ID of the failed execution */
  executionId: z.string(),
  /** Include input impulses that were available during execution */
  includeInputImpulses: z.boolean().optional(),
  /** Include full execution trace with task-level details */
  includeTrace: z.boolean().optional(),
});

// Type exports for Variant-Aware Impulse Pointers
export type VariantGenealogyPointer = z.infer<typeof VariantGenealogyPointerSchema>;
export type VariantPerformancePointer = z.infer<typeof VariantPerformancePointerSchema>;
export type VariantFamilyPointer = z.infer<typeof VariantFamilyPointerSchema>;
export type FailedExecutionContextPointer = z.infer<typeof FailedExecutionContextPointerSchema>;

// =============================================================================
// IMPULSE SHAPE ACTIVITY SCORING SCHEMAS
// =============================================================================
// Persistent Thompson Sampling parameters for shape-based activity selection.
// Unlike computed views, this allows incremental updates and custom priors.
// =============================================================================

/**
 * ShapeScoreUpdateRequest - Request body for POST /v2/activities/shape-scores
 * Records execution outcome for shape-based Thompson Sampling.
 *
 * The endpoint performs atomic UPSERT operations:
 * - If row exists: increment success_count or failure_count
 * - If row doesn't exist: create with initial counts
 * - Always: recompute alpha = success_count + 1, beta = failure_count + 1
 */
export const ShapeScoreUpdateRequestSchema = z.object({
  /** Activity ID that was executed */
  activity_id: z.string(),
  /** Input impulse shapes observed during execution */
  shapes: z.array(z.string()).min(1),
  /** Whether the execution succeeded */
  success: z.boolean(),
  /** Organization ID (optional, inferred from auth context if not provided) */
  org_id: z.string().optional(),
});

/**
 * ShapeScoreUpdateResponse - Response for POST /v2/activities/shape-scores
 */
export const ShapeScoreUpdateResponseSchema = z.object({
  success: z.boolean(),
  /** Number of shape scores updated */
  updated_count: z.number().int(),
  /** Message describing the operation */
  message: z.string().optional(),
});

/**
 * ImpulseShapeActivityScore - Shape-based Thompson Sampling score record
 * Matches the impulse_shape_activity_score table schema.
 */
export const ImpulseShapeActivityScoreSchema = z.object({
  shape: z.string(),
  activity_id: z.string(),
  org_id: z.string(),
  success_count: z.number().int(),
  failure_count: z.number().int(),
  alpha: z.number().int(), // success_count + 1
  beta: z.number().int(),  // failure_count + 1
  updated_at: z.union([z.string(), z.object({}).passthrough()]),
});

// Type exports for Impulse Shape Activity Scoring
export type ShapeScoreUpdateRequest = z.infer<typeof ShapeScoreUpdateRequestSchema>;
export type ShapeScoreUpdateResponse = z.infer<typeof ShapeScoreUpdateResponseSchema>;
export type ImpulseShapeActivityScore = z.infer<typeof ImpulseShapeActivityScoreSchema>;

// =============================================================================
// MANUAL FEEDBACK SCHEMAS
// =============================================================================

/**
 * ActivityFeedbackRequest - Manual feedback from /teach and /warn commands
 * Request body for POST /v2/activities/feedback
 */
export const ActivityFeedbackRequestSchema = z.object({
  activity_id: z.string()
    .describe('Activity ID to provide feedback on'),
  direction: z.enum(['positive', 'negative'])
    .describe('Feedback type: positive (teach) or negative (warn)'),
  intensity: z.number().int().min(0).max(3).default(0)
    .describe('Feedback strength: 0=1.5x, 1=2x, 2=2.5x, 3=3x'),
  include_adjacent: z.boolean().optional()
    .describe('Whether to apply feedback to adjacent activities (composition graph)'),
  session_id: z.string().optional()
    .describe('Session ID for finding adjacent activities'),
  reason: z.string().optional()
    .describe('Optional reason for feedback (logged for learning)'),
});

/**
 * ActivityFeedbackResponse - Response from feedback endpoint
 * Returns updated Thompson Sampling parameters
 */
export const ActivityFeedbackResponseSchema = z.object({
  success: z.boolean()
    .describe('Whether feedback was successfully recorded'),
  affected_activities: z.array(z.string())
    .describe('Activity IDs that received feedback updates'),
  multiplier: z.number()
    .describe('Applied multiplier based on intensity'),
  direction: z.string()
    .describe('Feedback direction that was applied'),
  message: z.string().optional()
    .describe('Optional status message'),
});

export type ActivityFeedbackRequest = z.infer<typeof ActivityFeedbackRequestSchema>;
export type ActivityFeedbackResponse = z.infer<typeof ActivityFeedbackResponseSchema>;
