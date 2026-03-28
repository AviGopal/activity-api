-- Database Schema for Dashboard Components
-- Phase: Dashboard Observability
-- Tables: vessel_heartbeats
--
-- NOTE: activity_execution_traces is now defined in schemas/011-executions.surql
-- with full RBAC multi-tenancy support. Do not redefine it here.

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

-- ============================================================================
-- Analytics Queries
-- ============================================================================

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
