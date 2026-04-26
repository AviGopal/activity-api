/**
 * WebSocket Message Types
 * Matches dashboard types (activity-dashboard/src/lib/types.ts)
 */

export interface WebSocketMessage {
  type: 'execution_started' | 'execution_completed' | 'template_updated' | 'pod_status_changed' | 'ci_result' | 'feedback_recorded' | 'variant_created' | 'template_retired' | 'task.started' | 'task.completed' | 'tool.call';
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
