-- =============================================================================
-- Activity Executions with RBAC Multi-Tenancy
-- =============================================================================
-- Merges: 002-learning-system-phase1.surql + 004-execution-traces.surql
-- Tracks all activity execution results with org/project isolation
-- =============================================================================

-- =============================================================================
-- ██████╗ ███████╗██████╗ ██████╗ ███████╗ ██████╗ █████╗ ████████╗███████╗██████╗
-- ██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗╚══██╔══╝██╔════╝██╔══██╗
-- ██║  ██║█████╗  ██████╔╝██████╔╝█████╗  ██║     ███████║   ██║   █████╗  ██║  ██║
-- ██║  ██║██╔══╝  ██╔═══╝ ██╔══██╗██╔══╝  ██║     ██╔══██║   ██║   ██╔══╝  ██║  ██║
-- ██████╔╝███████╗██║     ██║  ██║███████╗╚██████╗██║  ██║   ██║   ███████╗██████╔╝
-- ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═════╝
-- =============================================================================
-- Table: activity_execution_traces [DEPRECATED]
-- =============================================================================
--
-- WARNING: THIS TABLE IS DEPRECATED
--
-- New code should use the `execution` table defined in:
--   020-paradigm-core-tables.surql
--
-- The `execution` table is the canonical paradigm-aligned schema that:
--   - Uses `id` instead of `execution_id` for record identity
--   - Uses `input_impulses` and `output_impulses` for impulse tracking
--   - Uses `trace` object for full execution details
--   - Integrates with activity/impulse/vessel tables
--
-- FIELD MAPPING (activity_execution_traces -> execution):
--   execution_id         -> id
--   activity_id          -> activity_id (same)
--   variant_id           -> (use activity_id, variants are separate activities)
--   success              -> success (same)
--   status               -> (derived: success ? 'success' : 'failure')
--   duration_ms          -> duration_ms (same)
--   cost_usd             -> cost_usd (same)
--   tokens_input         -> tokens_in
--   tokens_output        -> tokens_out
--   error_message        -> error.message
--   error_type           -> error.type
--   failed_task_id       -> error.task_id
--   impulses_used        -> input_impulses
--   execution_trace      -> trace
--   state_snapshot       -> trace.state_transition
--   tasks                -> trace.tasks
--   parent_execution_id  -> parent_execution_id (same)
--   executed_at          -> executed_at (same)
--   org_id               -> org_id (same)
--   project_id           -> project_id (same)
--
-- Backward compatibility views are provided in:
--   021-paradigm-computed-views.surql (v_paradigm_execution_traces)
--   011-executions.surql (view_execution_traces, view_activity_executions)
--
-- This table will be removed in a future release after migration is complete.
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
  COMMENT "Activity identifier (FK to activity table)";

DEFINE FIELD IF NOT EXISTS variant_id ON activity_execution_traces TYPE option<string>
  COMMENT "Template variant identifier (for backward compatibility)";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON activity_execution_traces TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional, inherited from auth context)";

-- created_by can be either a user (dashboard) or a minibob_instance (autonomous vessel)
DEFINE FIELD IF NOT EXISTS created_by ON activity_execution_traces TYPE option<string | record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User, MiniBob instance, or instance ID string who created this execution";

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
DEFINE FIELD IF NOT EXISTS impulses_used ON activity_execution_traces TYPE option<array<string>> FLEXIBLE
  COMMENT "Array of impulse IDs used in this execution";

DEFINE FIELD IF NOT EXISTS component_changes ON activity_execution_traces TYPE option<array<string>> FLEXIBLE
  COMMENT "Array of component IDs changed in this execution";

DEFINE FIELD IF NOT EXISTS execution_trace ON activity_execution_traces TYPE option<object> FLEXIBLE
  COMMENT "Full execution trace data (task-by-task details)";

DEFINE FIELD IF NOT EXISTS state_snapshot ON activity_execution_traces TYPE option<object> FLEXIBLE
  COMMENT "State snapshot with any nested structure (input_state, output_state, stateTransition)";

DEFINE FIELD IF NOT EXISTS tasks ON activity_execution_traces TYPE option<array<object>> FLEXIBLE
  COMMENT "Array of task execution details with any nested structure";

-- Nested field definition for tasks array elements (FLEXIBLE required for arbitrary nested task objects)
DEFINE FIELD IF NOT EXISTS tasks.* ON activity_execution_traces TYPE object FLEXIBLE
  COMMENT "Individual task execution detail with arbitrary fields (task_id, description, status, duration_ms, tool_calls, etc.)";

DEFINE FIELD IF NOT EXISTS parent_execution_id ON activity_execution_traces TYPE option<string>
  COMMENT "Parent execution ID (for composition tracking)";

DEFINE FIELD IF NOT EXISTS composition_chain ON activity_execution_traces TYPE option<array<string>>
  COMMENT "Denormalized ancestor chain: [root_execution_id, ..., parent_execution_id]. Ordered root-first. Enables single-read reconstruction of composition trees.";

-- Vessel attribution (added in migration 086)
DEFINE FIELD IF NOT EXISTS vessel_id ON activity_execution_traces TYPE option<string>
  COMMENT "Vessel that executed this activity (sender of the trace)";

DEFINE FIELD IF NOT EXISTS resolved_by_vessel_id ON activity_execution_traces TYPE option<string>
  COMMENT "Vessel that resolved this execution's impulses";

DEFINE FIELD IF NOT EXISTS vessel_version ON activity_execution_traces TYPE option<string>
  COMMENT "Vessel version (semver-sha7) for learning correlation";

-- Per-impulse resolver attribution (added in migration 086)
DEFINE FIELD IF NOT EXISTS impulse_resolutions ON activity_execution_traces TYPE option<array<object>> FLEXIBLE
  COMMENT "Per-impulse resolution detail: [{impulse_id, resolver_id, resolver_tier, vessel_id, latency_ms, cost_usd}]";

DEFINE FIELD IF NOT EXISTS impulse_resolutions.* ON activity_execution_traces TYPE object FLEXIBLE
  COMMENT "Individual impulse resolution entry with arbitrary nested fields";

-- Edge Learning Fields (from improvisation traces)
DEFINE FIELD IF NOT EXISTS improvisation ON activity_execution_traces TYPE option<bool>
  COMMENT "Whether this was an LLM improvisation (no template matched)";

DEFINE FIELD IF NOT EXISTS input_impulse_shapes ON activity_execution_traces TYPE option<array<string>> FLEXIBLE
  COMMENT "Shapes of input impulses (goal, task, previous_result, error_context, etc.)";

DEFINE FIELD IF NOT EXISTS output_impulse_shapes ON activity_execution_traces TYPE option<array<string>> FLEXIBLE
  COMMENT "Shapes of output impulses produced (documentation, source_code, command_result, etc.)";

DEFINE FIELD IF NOT EXISTS output_impulses ON activity_execution_traces TYPE option<array<object>> FLEXIBLE
  COMMENT "Full output impulse data [{shape, pointer}] for ribosome extraction";

-- Nested field definitions for output_impulses array elements (FLEXIBLE required for arbitrary nested structure)
DEFINE FIELD IF NOT EXISTS output_impulses.* ON activity_execution_traces TYPE object FLEXIBLE
  COMMENT "Individual output impulse with shape and pointer (allows arbitrary nested fields)";

DEFINE FIELD IF NOT EXISTS metadata ON activity_execution_traces TYPE option<object> FLEXIBLE
  COMMENT "Extensible metadata for edge learning (inputShapes, outputShapes, producedImpulses, etc.)";

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

-- Vessel-scoped indexes (added in migration 086)
DEFINE INDEX IF NOT EXISTS idx_activity_execution_traces_vessel_id
  ON activity_execution_traces FIELDS vessel_id;

DEFINE INDEX IF NOT EXISTS idx_activity_execution_traces_resolved_by_vessel_id
  ON activity_execution_traces FIELDS resolved_by_vessel_id;

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

DEFINE FIELD IF NOT EXISTS org_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

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

DEFINE FIELD IF NOT EXISTS org_id ON impulse_relevance_metrics TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

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

DEFINE FIELD IF NOT EXISTS times_not_loaded_succeeded ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions when impulse was NOT loaded";

DEFINE FIELD IF NOT EXISTS times_not_loaded_failed ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions when impulse was NOT loaded";

DEFINE FIELD IF NOT EXISTS relevance_score ON impulse_relevance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Calculated relevance score: P(success | impulse loaded)";

DEFINE FIELD IF NOT EXISTS irrelevance_score ON impulse_relevance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Calculated irrelevance score: P(success | impulse NOT loaded)";

DEFINE FIELD IF NOT EXISTS avg_content_size_tokens ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Average token count of this impulse's content";

DEFINE FIELD IF NOT EXISTS typical_pointer_type ON impulse_relevance_metrics TYPE option<string>
  COMMENT "Most common pointer type for this impulse (e.g., 'file', 'activityExecutionTrace')";

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

DEFINE FIELD IF NOT EXISTS org_id ON tool_usage TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

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

DEFINE FIELD IF NOT EXISTS parameters ON tool_usage TYPE option<object> FLEXIBLE
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
-- Table: thompson_selection_log
-- =============================================================================
-- Logs Thompson Sampling selection events for explainability
-- Records the actual sampled value and parameters at selection time
-- RBAC: Scoped by organization
-- =============================================================================

DEFINE TABLE IF NOT EXISTS thompson_selection_log SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id AND $auth.role = 'admin'
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS execution_id ON thompson_selection_log TYPE string
  ASSERT $value != NONE
  COMMENT "Execution ID this selection resulted in";

DEFINE FIELD IF NOT EXISTS activity_id ON thompson_selection_log TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that was selected";

DEFINE FIELD IF NOT EXISTS thompson_sample ON thompson_selection_log TYPE float
  ASSERT $value >= 0 AND $value <= 1
  COMMENT "Actual sampled value from Beta(alpha, beta) distribution";

DEFINE FIELD IF NOT EXISTS alpha ON thompson_selection_log TYPE float
  ASSERT $value > 0
  COMMENT "Alpha parameter at time of selection";

DEFINE FIELD IF NOT EXISTS beta ON thompson_selection_log TYPE float
  ASSERT $value > 0
  COMMENT "Beta parameter at time of selection";

DEFINE FIELD IF NOT EXISTS selection_method ON thompson_selection_log TYPE string
  ASSERT $value IN ['thompson_sampling', 'exploration_forced', 'improvisation', 'deterministic']
  VALUE $value OR 'thompson_sampling'
  COMMENT "How this activity was selected";

DEFINE FIELD IF NOT EXISTS candidates_count ON thompson_selection_log TYPE option<int>
  COMMENT "Number of candidates considered";

DEFINE FIELD IF NOT EXISTS org_id ON thompson_selection_log TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON thompson_selection_log TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS selected_at ON thompson_selection_log TYPE datetime
  VALUE $value OR time::now()
  COMMENT "When selection occurred";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_thompson_selection_execution
  ON thompson_selection_log FIELDS execution_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_thompson_selection_activity
  ON thompson_selection_log FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_thompson_selection_org
  ON thompson_selection_log FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_thompson_selection_time
  ON thompson_selection_log FIELDS selected_at;

DEFINE INDEX IF NOT EXISTS idx_thompson_selection_method
  ON thompson_selection_log FIELDS selection_method;

-- =============================================================================
-- Backward compatibility views
-- =============================================================================

-- View: execution_traces (legacy table name)
-- Note: SurrealDB 3.0 views cannot use CASE expressions, so we pass status through as-is
DEFINE TABLE IF NOT EXISTS view_execution_traces AS
  SELECT
    execution_id AS id,   -- Use execution_id as record ID for view
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
    execution_id AS id,   -- Use execution_id as record ID for view
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
