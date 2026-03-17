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
  last_executed_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
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
  created_at: z.string(),
  updated_at: z.string(),
  // Metrics merged in from template_metrics
  metrics: TemplateMetricsSchema.optional(),
});

export const TemplateListResponseSchema = z.object({
  templates: z.array(z.any()),  // Workaround for circular type issue
  total: z.number(),
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
  created_at: z.string(),
  updated_at: z.string(),
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
