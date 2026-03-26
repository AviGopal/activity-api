-- =============================================================================
-- Activity Executions with RBAC Multi-Tenancy
-- =============================================================================
-- Merges: 002-learning-system-phase1.surql + 004-execution-traces.surql
-- Tracks all activity execution results with org/project isolation
-- =============================================================================

-- =============================================================================
-- Table: activity_execution_traces
-- =============================================================================
-- Records individual activity execution results
-- RBAC: Users can only access execution traces in their org/projects
-- =============================================================================

DEFINE TABLE IF NOT EXISTS activity_execution_traces SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see executions in their org and assigned projects
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)

    -- CREATE: Any authenticated user can create execution traces
    --   org_id and project_id are auto-assigned from $auth
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Users can update executions they created or admins in their org
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)

    -- DELETE: Only admins can delete execution traces
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Primary identification
DEFINE FIELD IF NOT EXISTS execution_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE
  COMMENT "Unique execution identifier";

DEFINE FIELD IF NOT EXISTS activity_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE
  COMMENT "Activity identifier (FK to activity_registry)";

DEFINE FIELD IF NOT EXISTS variant_id ON activity_execution_traces TYPE option<string>
  COMMENT "Template variant identifier (for backward compatibility)";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON activity_execution_traces TYPE record<organizations>
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (required for all executions)";

DEFINE FIELD IF NOT EXISTS project_id ON activity_execution_traces TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional, inherited from auth context)";

-- created_by can be either a user (dashboard) or a minibob_instance (autonomous vessel)
DEFINE FIELD IF NOT EXISTS created_by ON activity_execution_traces TYPE option<record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User or MiniBob instance who created this execution";

-- Execution results
DEFINE FIELD IF NOT EXISTS success ON activity_execution_traces TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether execution succeeded";

DEFINE FIELD IF NOT EXISTS status ON activity_execution_traces TYPE string
  ASSERT $value IN ['success', 'failure', 'partial', 'timeout', 'cancelled']
  VALUE $value OR 'failure'
  COMMENT "Execution status (backward compatibility)";

DEFINE FIELD IF NOT EXISTS duration_ms ON activity_execution_traces TYPE int
  ASSERT $value >= 0
  COMMENT "Execution duration in milliseconds";

DEFINE FIELD IF NOT EXISTS cost_usd ON activity_execution_traces TYPE float
  ASSERT $value >= 0
  COMMENT "Execution cost in USD";

-- Token usage
DEFINE FIELD IF NOT EXISTS tokens_input ON activity_execution_traces TYPE int
  VALUE $value OR 0
  COMMENT "Input tokens consumed";

DEFINE FIELD IF NOT EXISTS tokens_output ON activity_execution_traces TYPE int
  VALUE $value OR 0
  COMMENT "Output tokens generated";

DEFINE FIELD IF NOT EXISTS tokens_cache ON activity_execution_traces TYPE int
  VALUE $value OR 0
  COMMENT "Cache tokens reused";

-- Error information
DEFINE FIELD IF NOT EXISTS error_message ON activity_execution_traces TYPE option<string>
  COMMENT "Error message if execution failed";

DEFINE FIELD IF NOT EXISTS error_type ON activity_execution_traces TYPE option<string>
  COMMENT "Error category: validation, timeout, tool_error, etc.";

DEFINE FIELD IF NOT EXISTS failed_task_id ON activity_execution_traces TYPE option<string>
  COMMENT "Task ID where failure occurred";

-- Context and relationships
DEFINE FIELD IF NOT EXISTS impulses_used ON activity_execution_traces TYPE option<array<string>>
  COMMENT "Array of impulse IDs used in this execution";

DEFINE FIELD IF NOT EXISTS component_changes ON activity_execution_traces TYPE option<array<string>>
  COMMENT "Array of component IDs changed in this execution";

DEFINE FIELD IF NOT EXISTS execution_trace ON activity_execution_traces TYPE option<object>
  COMMENT "Full execution trace data (task-by-task details)";

DEFINE FIELD IF NOT EXISTS parent_execution_id ON activity_execution_traces TYPE option<string>
  COMMENT "Parent execution ID (for composition tracking)";

-- Timestamps
DEFINE FIELD IF NOT EXISTS executed_at ON activity_execution_traces TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Execution timestamp";

DEFINE FIELD IF NOT EXISTS created_at ON activity_execution_traces TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

DEFINE FIELD IF NOT EXISTS stored_at ON activity_execution_traces TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Trace storage timestamp (backward compatibility)";

DEFINE FIELD IF NOT EXISTS updated_at ON activity_execution_traces TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_activity_executions_execution_id
  ON activity_execution_traces FIELDS execution_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_activity_id
  ON activity_execution_traces FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_variant_id
  ON activity_execution_traces FIELDS variant_id;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_executed_at
  ON activity_execution_traces FIELDS executed_at;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_status
  ON activity_execution_traces FIELDS status;

-- Multi-tenant indexes (CRITICAL for RBAC performance)
DEFINE INDEX IF NOT EXISTS idx_activity_executions_org
  ON activity_execution_traces FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_project
  ON activity_execution_traces FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_created_by
  ON activity_execution_traces FIELDS created_by;

-- Composite indexes for common queries
DEFINE INDEX IF NOT EXISTS idx_activity_executions_org_project
  ON activity_execution_traces FIELDS org_id, project_id;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_org_project_activity
  ON activity_execution_traces FIELDS org_id, project_id, activity_id;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_org_status
  ON activity_execution_traces FIELDS org_id, status;

DEFINE INDEX IF NOT EXISTS idx_activity_executions_parent
  ON activity_execution_traces FIELDS parent_execution_id;

-- =============================================================================
-- Table: activity_composition_graph
-- =============================================================================
-- Tracks parent-child relationships between activities (aggregated metrics)
-- RBAC: Scoped by organization
-- =============================================================================

DEFINE TABLE IF NOT EXISTS activity_composition_graph SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS parent_activity_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  COMMENT "Parent activity ID in composition";

DEFINE FIELD IF NOT EXISTS child_activity_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  COMMENT "Child activity ID in composition";

DEFINE FIELD IF NOT EXISTS execution_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  COMMENT "Last execution ID where composition occurred";

DEFINE FIELD IF NOT EXISTS org_id ON activity_composition_graph TYPE record<organizations>
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (required for RBAC)";

DEFINE FIELD IF NOT EXISTS project_id ON activity_composition_graph TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS goal_context ON activity_composition_graph TYPE option<string>
  COMMENT "Goal or context for composition";

DEFINE FIELD IF NOT EXISTS success ON activity_composition_graph TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether last execution succeeded";

DEFINE FIELD IF NOT EXISTS execution_count ON activity_composition_graph TYPE int
  VALUE $value OR 1
  COMMENT "Number of times this composition occurred";

DEFINE FIELD IF NOT EXISTS success_count ON activity_composition_graph TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful compositions";

DEFINE FIELD IF NOT EXISTS weight ON activity_composition_graph TYPE float
  VALUE $value OR 0.0
  COMMENT "Success probability (success_count / execution_count)";

DEFINE FIELD IF NOT EXISTS created_at ON activity_composition_graph TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First composition timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON activity_composition_graph TYPE datetime
  VALUE time::now()
  COMMENT "Last composition timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_composition_parent
  ON activity_composition_graph FIELDS parent_activity_id;

DEFINE INDEX IF NOT EXISTS idx_composition_child
  ON activity_composition_graph FIELDS child_activity_id;

DEFINE INDEX IF NOT EXISTS idx_composition_execution
  ON activity_composition_graph FIELDS execution_id;

DEFINE INDEX IF NOT EXISTS idx_composition_org
  ON activity_composition_graph FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_composition_org_parent
  ON activity_composition_graph FIELDS org_id, parent_activity_id;

-- =============================================================================
-- Table: impulse_relevance_metrics
-- =============================================================================
-- Tracks aggregated impulse relevance metrics
-- RBAC: Scoped by organization
-- =============================================================================

DEFINE TABLE IF NOT EXISTS impulse_relevance_metrics SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS impulse_id ON impulse_relevance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Impulse identifier";

DEFINE FIELD IF NOT EXISTS activity_variant_id ON impulse_relevance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Activity variant that uses this impulse";

DEFINE FIELD IF NOT EXISTS org_id ON impulse_relevance_metrics TYPE record<organizations>
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (required for RBAC)";

DEFINE FIELD IF NOT EXISTS project_id ON impulse_relevance_metrics TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS task_id ON impulse_relevance_metrics TYPE option<string>
  COMMENT "Optional task ID for task-level tracking";

DEFINE FIELD IF NOT EXISTS times_loaded ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of times impulse was loaded";

DEFINE FIELD IF NOT EXISTS times_execution_succeeded ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions when impulse was loaded";

DEFINE FIELD IF NOT EXISTS times_execution_failed ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions when impulse was loaded";

DEFINE FIELD IF NOT EXISTS relevance_score ON impulse_relevance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Calculated relevance score (success rate when loaded)";

DEFINE FIELD IF NOT EXISTS avg_tokens ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Average token count of this impulse";

DEFINE FIELD IF NOT EXISTS created_at ON impulse_relevance_metrics TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON impulse_relevance_metrics TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_impulse_relevance_impulse
  ON impulse_relevance_metrics FIELDS impulse_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_relevance_activity
  ON impulse_relevance_metrics FIELDS activity_variant_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_relevance_org
  ON impulse_relevance_metrics FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_relevance_composite
  ON impulse_relevance_metrics FIELDS activity_variant_id, impulse_id UNIQUE;

-- =============================================================================
-- Table: tool_usage
-- =============================================================================
-- Tracks tool invocation patterns
-- RBAC: Scoped by organization
-- =============================================================================

DEFINE TABLE IF NOT EXISTS tool_usage SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS tool_name ON tool_usage TYPE string
  ASSERT $value != NONE
  COMMENT "Tool identifier (bash, read, write, etc.)";

DEFINE FIELD IF NOT EXISTS activity_id ON tool_usage TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that called this tool";

DEFINE FIELD IF NOT EXISTS execution_id ON tool_usage TYPE string
  ASSERT $value != NONE
  COMMENT "Execution where tool was called";

DEFINE FIELD IF NOT EXISTS org_id ON tool_usage TYPE record<organizations>
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (required for RBAC)";

DEFINE FIELD IF NOT EXISTS project_id ON tool_usage TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS task_id ON tool_usage TYPE option<string>
  COMMENT "Task ID where tool was called";

DEFINE FIELD IF NOT EXISTS call_count ON tool_usage TYPE int
  VALUE $value OR 1
  COMMENT "Number of times tool was called";

DEFINE FIELD IF NOT EXISTS success_count ON tool_usage TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful tool calls";

DEFINE FIELD IF NOT EXISTS failure_count ON tool_usage TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed tool calls";

DEFINE FIELD IF NOT EXISTS avg_duration_ms ON tool_usage TYPE float
  VALUE $value OR 0.0
  COMMENT "Average tool call duration";

DEFINE FIELD IF NOT EXISTS parameters ON tool_usage TYPE option<object>
  COMMENT "Common parameters used with this tool";

DEFINE FIELD IF NOT EXISTS created_at ON tool_usage TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First call timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON tool_usage TYPE datetime
  VALUE time::now()
  COMMENT "Last call timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_tool_usage_tool
  ON tool_usage FIELDS tool_name;

DEFINE INDEX IF NOT EXISTS idx_tool_usage_activity
  ON tool_usage FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_tool_usage_execution
  ON tool_usage FIELDS execution_id;

DEFINE INDEX IF NOT EXISTS idx_tool_usage_org
  ON tool_usage FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_tool_usage_composite
  ON tool_usage FIELDS activity_id, tool_name;

-- =============================================================================
-- Backward compatibility views
-- =============================================================================

-- View: execution_traces (legacy table name)
-- Note: SurrealDB 3.0 views cannot use CASE expressions, so we pass status through as-is
DEFINE TABLE IF NOT EXISTS view_execution_traces AS
  SELECT
    execution_id,
    activity_id AS template_id,
    status,
    duration_ms,
    cost_usd,
    execution_trace,
    stored_at,
    created_at,
    updated_at
  FROM activity_execution_traces;

-- View: activity_executions (legacy table name from 001-init-schema.surql)
DEFINE TABLE IF NOT EXISTS view_activity_executions AS
  SELECT
    execution_id,
    variant_id,
    org_id,
    project_id,
    success,
    duration_ms,
    cost_usd,
    tokens_input,
    tokens_output,
    tokens_cache,
    error_message,
    error_type,
    failed_task_id,
    impulses_used,
    component_changes,
    executed_at,
    created_at
  FROM activity_execution_traces;
