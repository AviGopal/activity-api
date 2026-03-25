-- Database Schema for Dashboard Components
-- Phase: Dashboard Observability
-- Tables: activity_execution_traces, vessel_heartbeats

-- ============================================================================
-- Activity Execution Traces
-- ============================================================================
-- Stores complete execution traces with state snapshots and task breakdowns
-- Used by ExecutionHistory component to display execution timeline

DEFINE TABLE activity_execution_traces SCHEMAFULL;

DEFINE FIELD execution_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE;

DEFINE FIELD variant_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE;

DEFINE FIELD activity_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE;

DEFINE FIELD success ON activity_execution_traces TYPE bool
  ASSERT $value != NONE;

DEFINE FIELD duration_ms ON activity_execution_traces TYPE number
  ASSERT $value >= 0;

DEFINE FIELD cost ON activity_execution_traces TYPE number
  ASSERT $value >= 0;

DEFINE FIELD tokens ON activity_execution_traces TYPE object;
DEFINE FIELD tokens.input ON activity_execution_traces TYPE number;
DEFINE FIELD tokens.output ON activity_execution_traces TYPE number;
DEFINE FIELD tokens.cache ON activity_execution_traces TYPE number;

DEFINE FIELD error_message ON activity_execution_traces TYPE option<string>;
DEFINE FIELD error_type ON activity_execution_traces TYPE option<string>;
DEFINE FIELD failed_task_id ON activity_execution_traces TYPE option<string>;

DEFINE FIELD impulses_used ON activity_execution_traces TYPE option<array>;
DEFINE FIELD component_changes ON activity_execution_traces TYPE option<array>;
DEFINE FIELD tasks ON activity_execution_traces TYPE option<array>;
DEFINE FIELD state_snapshot ON activity_execution_traces TYPE option<object>;

DEFINE FIELD org_id ON activity_execution_traces TYPE option<string>;
DEFINE FIELD project_id ON activity_execution_traces TYPE option<string>;

DEFINE FIELD executed_at ON activity_execution_traces TYPE datetime
  ASSERT $value != NONE;

DEFINE FIELD created_at ON activity_execution_traces TYPE datetime
  VALUE $before OR time::now();

-- Indexes for performance
DEFINE INDEX idx_execution_variant ON activity_execution_traces FIELDS variant_id;
DEFINE INDEX idx_execution_activity ON activity_execution_traces FIELDS activity_id;
DEFINE INDEX idx_execution_time ON activity_execution_traces FIELDS executed_at;
DEFINE INDEX idx_execution_success ON activity_execution_traces FIELDS success;
DEFINE INDEX idx_execution_composite ON activity_execution_traces FIELDS variant_id, executed_at;

-- ============================================================================
-- Vessel Heartbeats
-- ============================================================================
-- Stores MiniBob vessel status and current activity
-- Used by VesselStatus component to display real-time pod monitoring
-- Vessels send heartbeats every 30 seconds via POST /v2/vessels/heartbeat

DEFINE TABLE vessel_heartbeats SCHEMAFULL;

DEFINE FIELD pod_name ON vessel_heartbeats TYPE string
  ASSERT $value != NONE;

DEFINE FIELD namespace ON vessel_heartbeats TYPE string
  ASSERT $value != NONE;

DEFINE FIELD status ON vessel_heartbeats TYPE string
  ASSERT $value IN ['idle', 'executing', 'bored', 'error', 'unknown'];

DEFINE FIELD current_activity ON vessel_heartbeats TYPE option<object>;
DEFINE FIELD current_activity.variant_id ON vessel_heartbeats TYPE option<string>;
DEFINE FIELD current_activity.activity_id ON vessel_heartbeats TYPE option<string>;
DEFINE FIELD current_activity.variant_name ON vessel_heartbeats TYPE option<string>;
DEFINE FIELD current_activity.started_at ON vessel_heartbeats TYPE option<datetime>;
DEFINE FIELD current_activity.current_task ON vessel_heartbeats TYPE option<string>;
DEFINE FIELD current_activity.progress ON vessel_heartbeats TYPE option<number>;

DEFINE FIELD metrics ON vessel_heartbeats TYPE option<object>;
DEFINE FIELD metrics.cpu_usage ON vessel_heartbeats TYPE option<number>;
DEFINE FIELD metrics.memory_usage ON vessel_heartbeats TYPE option<number>;
DEFINE FIELD metrics.executions_completed ON vessel_heartbeats TYPE option<number>;
DEFINE FIELD metrics.total_cost_usd ON vessel_heartbeats TYPE option<number>;
DEFINE FIELD metrics.uptime_seconds ON vessel_heartbeats TYPE option<number>;

DEFINE FIELD last_heartbeat ON vessel_heartbeats TYPE datetime
  ASSERT $value != NONE;

DEFINE FIELD created_at ON vessel_heartbeats TYPE datetime
  VALUE $before OR time::now();

DEFINE FIELD updated_at ON vessel_heartbeats TYPE datetime
  VALUE time::now();

-- Indexes for performance
DEFINE INDEX idx_vessel_pod ON vessel_heartbeats FIELDS pod_name, namespace;
DEFINE INDEX idx_vessel_heartbeat ON vessel_heartbeats FIELDS last_heartbeat;
DEFINE INDEX idx_vessel_status ON vessel_heartbeats FIELDS status;

-- Unique constraint on pod_name + namespace
DEFINE INDEX idx_vessel_unique ON vessel_heartbeats FIELDS pod_name, namespace UNIQUE;

-- ============================================================================
-- Sample Data for Testing
-- ============================================================================

-- Sample execution trace (successful)
INSERT INTO activity_execution_traces {
  execution_id: "exec_20260322_001",
  variant_id: "fix-bug-v1",
  activity_id: "fix-null-pointer",
  success: true,
  duration_ms: 15420,
  cost: 0.0234,
  tokens: {
    input: 1200,
    output: 450,
    cache: 0
  },
  impulses_used: ["file:/src/utils/validator.ts", "memo:error-context"],
  tasks: [
    {
      task_id: "task1",
      description: "Analyze error logs",
      status: "completed",
      duration_ms: 3200,
      tool_calls: [
        { tool: "read", duration_ms: 120, success: true },
        { tool: "grep", duration_ms: 450, success: true }
      ]
    },
    {
      task_id: "task2",
      description: "Fix null pointer",
      status: "completed",
      duration_ms: 8500,
      tool_calls: [
        { tool: "edit", duration_ms: 2300, success: true }
      ]
    },
    {
      task_id: "task3",
      description: "Run tests",
      status: "completed",
      duration_ms: 3720,
      tool_calls: [
        { tool: "bash", duration_ms: 3600, success: true }
      ]
    }
  ],
  state_snapshot: {
    input_state: {
      filesAvailable: ["src/utils/validator.ts", "tests/validator.test.ts"],
      environment: { NODE_ENV: "development" }
    },
    output_state: {
      filesModified: ["src/utils/validator.ts"],
      filesCreated: [],
      filesDeleted: [],
      exitCode: 0
    }
  },
  org_id: "default",
  project_id: "minibob",
  executed_at: time::now(),
  created_at: time::now()
};

-- Sample execution trace (failed)
INSERT INTO activity_execution_traces {
  execution_id: "exec_20260322_002",
  variant_id: "add-feature-v2",
  activity_id: "add-user-auth",
  success: false,
  duration_ms: 8200,
  cost: 0.0156,
  tokens: {
    input: 980,
    output: 320,
    cache: 0
  },
  error_message: "Test suite failed: 3 tests failed",
  error_type: "ValidationError",
  failed_task_id: "task3",
  impulses_used: ["file:/src/auth/login.ts"],
  tasks: [
    {
      task_id: "task1",
      description: "Implement login endpoint",
      status: "completed",
      duration_ms: 5200
    },
    {
      task_id: "task2",
      description: "Add validation",
      status: "completed",
      duration_ms: 2100
    },
    {
      task_id: "task3",
      description: "Run tests",
      status: "failed",
      duration_ms: 900,
      tool_calls: [
        { tool: "bash", duration_ms: 850, success: false }
      ]
    }
  ],
  state_snapshot: {
    output_state: {
      filesModified: ["src/auth/login.ts"],
      exitCode: 1,
      stderr: "Error: Expected 200, got 401"
    }
  },
  org_id: "default",
  project_id: "minibob",
  executed_at: time::now(),
  created_at: time::now()
};

-- Sample vessel heartbeat
INSERT INTO vessel_heartbeats {
  pod_name: "minibob-0",
  namespace: "activity-system",
  status: "executing",
  current_activity: {
    variant_id: "refactor-api-v1",
    activity_id: "refactor-routes",
    variant_name: "Refactor API Routes",
    started_at: time::now(),
    current_task: "Analyzing route dependencies",
    progress: 45
  },
  metrics: {
    cpu_usage: 23.5,
    memory_usage: 256.8,
    executions_completed: 12,
    total_cost_usd: 0.78,
    uptime_seconds: 7200
  },
  last_heartbeat: time::now(),
  created_at: time::now(),
  updated_at: time::now()
};

-- Sample vessel heartbeat (idle)
INSERT INTO vessel_heartbeats {
  pod_name: "minibob-1",
  namespace: "activity-system",
  status: "idle",
  metrics: {
    cpu_usage: 2.1,
    memory_usage: 128.4,
    executions_completed: 8,
    total_cost_usd: 0.52,
    uptime_seconds: 3600
  },
  last_heartbeat: time::now(),
  created_at: time::now(),
  updated_at: time::now()
};

-- ============================================================================
-- Cleanup Queries (for development/testing)
-- ============================================================================

-- Remove old heartbeats (older than 5 minutes)
-- DELETE FROM vessel_heartbeats WHERE last_heartbeat < time::now() - 5m;

-- Remove old execution traces (keep last 1000)
-- DELETE FROM activity_execution_traces WHERE execution_id NOT IN (
--   SELECT execution_id FROM activity_execution_traces ORDER BY executed_at DESC LIMIT 1000
-- );

-- ============================================================================
-- Analytics Queries
-- ============================================================================

-- Get execution success rate by variant
-- SELECT
--   variant_id,
--   count() as total,
--   math::sum(success::int) as successful,
--   (math::sum(success::int) / count()) * 100 as success_rate_percent
-- FROM activity_execution_traces
-- GROUP BY variant_id
-- ORDER BY success_rate_percent DESC;

-- Get average execution duration by activity
-- SELECT
--   activity_id,
--   count() as executions,
--   math::mean(duration_ms) as avg_duration_ms,
--   math::mean(cost) as avg_cost_usd
-- FROM activity_execution_traces
-- GROUP BY activity_id;

-- Get active vessels with current work
-- SELECT
--   pod_name,
--   namespace,
--   status,
--   current_activity.variant_name as working_on,
--   current_activity.progress as progress_percent,
--   metrics.executions_completed as total_executions
-- FROM vessel_heartbeats
-- WHERE status = 'executing'
-- ORDER BY last_heartbeat DESC;

-- Get vessel utilization
-- SELECT
--   count() as total_vessels,
--   math::sum(IF status = 'executing' THEN 1 ELSE 0 END) as executing,
--   math::sum(IF status = 'idle' THEN 1 ELSE 0 END) as idle,
--   math::sum(IF status = 'bored' THEN 1 ELSE 0 END) as bored,
--   (math::sum(IF status = 'executing' THEN 1 ELSE 0 END) / count()) * 100 as utilization_percent
-- FROM vessel_heartbeats
-- WHERE last_heartbeat >= time::now() - 1m;
