/**
 * WebSocket Message Types
 * Matches dashboard types (activity-dashboard/src/lib/types.ts)
 */

export interface WebSocketMessage {
  type: 'execution_started' | 'execution_completed' | 'template_updated' | 'pod_status_changed' | 'ci_result' | 'feedback_recorded' | 'variant_created' | 'template_retired' | 'task.started' | 'task.completed' | 'tool.call' | 'impulse.resolved';
  timestamp?: string;
  sequence?: number;  // Event sequence number for catchup protocol
  data: any;
}

export interface ExecutionStartedMessage extends WebSocketMessage {
  type: 'execution_started';
  data: {
    execution_id: string;
    variant_id: string;
    pod_name?: string;
  };
}

export interface ExecutionCompletedMessage extends WebSocketMessage {
  type: 'execution_completed';
  data: {
    execution_id: string;
    variant_id: string;
    success: boolean;
    duration_ms: number;
    cost: number;
    completed_at: string;
  };
}

export interface TemplateMetricsUpdatedMessage extends WebSocketMessage {
  type: 'template_updated';
  data: {
    variant_id: string;
    metrics: {
      success_rate: number;
      avg_duration_ms: number;
      avg_cost_usd: number;
      thompson_alpha: number;
      thompson_beta: number;
    };
  };
}

export interface PodStatusChangedMessage extends WebSocketMessage {
  type: 'pod_status_changed';
  data: {
    pod_name: string;
    status: string;
    timestamp: string;
  };
}

export interface TaskStartedMessage extends WebSocketMessage {
  type: 'task.started';
  sequence: number;
  data: {
    execution_id: string;
    task_id: string;
    task_index: number;
    description: string;
    started_at: string;
  };
}

export interface TaskCompletedMessage extends WebSocketMessage {
  type: 'task.completed';
  sequence: number;
  data: {
    execution_id: string;
    task_id: string;
    task_index: number;
    success: boolean;
    duration_ms: number;
    completed_at: string;
    error?: string;
    // Per-task impulse grouping. Always present (possibly empty arrays).
    // Symmetric with `tasks[*].input_impulse_ids` / `output_impulse_ids` on
    // the persisted row. See docs/specs/broadcaster-per-task-grouping.md.
    input_impulse_ids: string[];
    output_impulse_ids: string[];
  };
}

export interface ToolCallMessage extends WebSocketMessage {
  type: 'tool.call';
  sequence: number;
  data: {
    execution_id: string;
    task_id: string;
    tool_name: string;
    resolver_tier: 'deterministic' | 'pattern' | 'llm';
    latency_ms: number;
    cost_usd: number;
    timestamp: string;
  };
}

/**
 * `impulse.resolved` event — emitted once per resolved impulse during
 * trace ingestion (sourced from the trace's `impulse_resolutions[]` array
 * symmetric with the persisted shape; see migration 086).
 *
 * **Contract (formalised 2026-04-26 — design F-9 resolution).**
 * All canonical fields ride FLAT on `data`. The legacy/defensive nested-
 * `impulse` envelope variant is no longer emitted by activity-api; consumers
 * may keep tolerating both for forward-compat with other vessels (e.g.
 * minibob's normalized `impulse:completed`) but activity-api always sends
 * the flat form documented here.
 *
 * `body` is OPTIONAL and present when the resolved-impulse content is
 * available at trace-ingest time — i.e. when minibob included `body` on the
 * matching `output_impulses[]` entry (or, for `validation_result` shapes,
 * embedded the parsed `ValidationResult` in the pointer/content). When the
 * body cannot be sourced (e.g. file-pointer impulses where content lives on
 * disk only), the field is omitted. Consumers MUST treat absent `body` as a
 * non-error signal — the impulse is still considered resolved.
 *
 * See `docs/API_PHASE1_ENDPOINTS.md` §1 for the WS-level contract;
 * `repos/workbench/src/hooks/useTrajectoryExecution.ts` documents the
 * consumer-side parsing for `validation_result` shapes.
 */
export interface ImpulseResolvedMessage extends WebSocketMessage {
  type: 'impulse.resolved';
  sequence: number;
  data: {
    execution_id: string;
    /** Owning task — undefined when the resolution is execution-scoped (no task attribution). */
    task_id?: string;
    impulse_id: string;
    shape?: string;
    resolver_id: string;
    resolver_tier: 'deterministic' | 'pattern' | 'llm';
    vessel_id: string;
    latency_ms: number;
    cost_usd: number;
    /**
     * Resolved impulse content. Optional; included when minibob populated
     * the matching `output_impulses[]` entry with embedded content (e.g.
     * `validation_result` payloads). Type is `unknown` because the shape
     * varies — consumers parse defensively per-shape.
     */
    body?: unknown;
    timestamp: string;
  };
}
