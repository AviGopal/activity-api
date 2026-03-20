/**
 * WebSocket Message Types
 * Matches dashboard types (activity-dashboard/src/lib/types.ts)
 */

export interface WebSocketMessage {
  type: 'execution_started' | 'execution_completed' | 'template_updated' | 'pod_status_changed';
  timestamp: string;
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
