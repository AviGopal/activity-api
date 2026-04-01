-- =============================================================================
-- Activity Composition and Goal Paths with RBAC Multi-Tenancy
-- =============================================================================
-- Merges: 003-goal-execution-paths.surql + 007-control-flow-data-flow-learning.surql
-- Tracks goal execution paths, dataflows, and prerequisites with org/project isolation
-- =============================================================================

-- =============================================================================
-- Table: goal_execution_paths
-- =============================================================================
-- Stores aggregated execution paths for specific goals
-- Enables multi-activity path recommendations with Thompson Sampling
-- RBAC: Scoped by organization and project
-- =============================================================================

DEFINE TABLE IF NOT EXISTS goal_execution_paths SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Goal identification
DEFINE FIELD IF NOT EXISTS goal_hash ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  COMMENT "Hash of normalized goal text (lowercase, trimmed)";

DEFINE FIELD IF NOT EXISTS goal_text ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  COMMENT "Original goal text as provided by user";

DEFINE FIELD IF NOT EXISTS goal_pattern ON goal_execution_paths TYPE option<string>
  COMMENT "Normalized goal pattern (for matching)";

DEFINE FIELD IF NOT EXISTS goal_category ON goal_execution_paths TYPE string
  ASSERT $value IN ['feature', 'bugfix', 'refactor', 'tool', 'infrastructure', 'meta']
  COMMENT "Goal category for filtering (meta = self-referential goals)";

DEFINE FIELD IF NOT EXISTS goal_embedding ON goal_execution_paths TYPE option<array<float>>
  COMMENT "Goal text embedding for semantic matching";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON goal_execution_paths TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Path definition
DEFINE FIELD IF NOT EXISTS path_activities ON goal_execution_paths TYPE array<string>
  ASSERT $value != NONE
  COMMENT "Ordered sequence of activity IDs in this path";

DEFINE FIELD IF NOT EXISTS path_signature ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  COMMENT "Hash of path_activities for uniqueness";

DEFINE FIELD IF NOT EXISTS activity_sequence ON goal_execution_paths TYPE option<array<object>>
  COMMENT "Detailed activity sequence with per-step metrics";

-- Initial state context
DEFINE FIELD IF NOT EXISTS initial_state ON goal_execution_paths TYPE option<object>
  COMMENT "Initial state when goal was started";

DEFINE FIELD IF NOT EXISTS initial_impulses ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Impulse types available at start";

-- Thompson Sampling parameters (Beta distribution)
DEFINE FIELD IF NOT EXISTS total_executions ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Total number of times this path was executed";

DEFINE FIELD IF NOT EXISTS successful_executions ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions";

DEFINE FIELD IF NOT EXISTS failed_executions ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions";

DEFINE FIELD IF NOT EXISTS execution_count ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Alias for total_executions (backward compatibility)";

DEFINE FIELD IF NOT EXISTS success_count ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Alias for successful_executions (backward compatibility)";

DEFINE FIELD IF NOT EXISTS thompson_alpha ON goal_execution_paths TYPE float
  VALUE $value OR 1.0
  COMMENT "Beta distribution alpha parameter (successes + 1)";

DEFINE FIELD IF NOT EXISTS thompson_beta ON goal_execution_paths TYPE float
  VALUE $value OR 1.0
  COMMENT "Beta distribution beta parameter (failures + 1)";

DEFINE FIELD IF NOT EXISTS success_rate ON goal_execution_paths TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate: successful_executions / total_executions";

DEFINE FIELD IF NOT EXISTS success ON goal_execution_paths TYPE option<bool>
  COMMENT "Last execution success status";

DEFINE FIELD IF NOT EXISTS goal_achieved ON goal_execution_paths TYPE option<bool>
  COMMENT "Whether goal was achieved";

-- Performance metrics (rolling averages)
DEFINE FIELD IF NOT EXISTS avg_duration_ms ON goal_execution_paths TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution duration in milliseconds";

DEFINE FIELD IF NOT EXISTS total_duration_ms ON goal_execution_paths TYPE option<float>
  COMMENT "Total duration of last execution";

DEFINE FIELD IF NOT EXISTS avg_cost_usd ON goal_execution_paths TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution cost in USD";

DEFINE FIELD IF NOT EXISTS total_cost ON goal_execution_paths TYPE option<float>
  COMMENT "Total cost of last execution";

DEFINE FIELD IF NOT EXISTS avg_token_usage ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Average total tokens used";

-- Context metadata (for analysis)
DEFINE FIELD IF NOT EXISTS typical_files_modified ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Most frequently modified files in successful executions";

DEFINE FIELD IF NOT EXISTS typical_tools_used ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Most frequently used tools in this path";

-- Timestamps
DEFINE FIELD IF NOT EXISTS last_executed_at ON goal_execution_paths TYPE option<datetime>
  COMMENT "Timestamp of last execution";

DEFINE FIELD IF NOT EXISTS created_at ON goal_execution_paths TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First execution timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON goal_execution_paths TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_goal_paths_hash
  ON goal_execution_paths FIELDS goal_hash;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_category
  ON goal_execution_paths FIELDS goal_category;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_signature
  ON goal_execution_paths FIELDS goal_hash, path_signature UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_success_rate
  ON goal_execution_paths FIELDS success_rate;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_executions
  ON goal_execution_paths FIELDS total_executions;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_pattern
  ON goal_execution_paths FIELDS goal_pattern;

-- Multi-tenant indexes (CRITICAL for RBAC performance)
DEFINE INDEX IF NOT EXISTS idx_goal_paths_org
  ON goal_execution_paths FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_project
  ON goal_execution_paths FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_org_category
  ON goal_execution_paths FIELDS org_id, goal_category;

DEFINE INDEX IF NOT EXISTS idx_goal_paths_org_project
  ON goal_execution_paths FIELDS org_id, project_id;

-- =============================================================================
-- Table: goal_paths (DEPRECATED - merged into goal_execution_paths)
-- =============================================================================
-- Kept as view for backward compatibility
-- =============================================================================

DEFINE TABLE IF NOT EXISTS view_goal_paths AS
  SELECT
    (goal_hash + '-' + path_signature) AS id,
    goal_pattern,
    goal_embedding,
    initial_state,
    initial_impulses,
    activity_sequence,
    success,
    total_duration_ms,
    total_cost,
    goal_achieved,
    execution_count,
    success_count,
    success_rate,
    thompson_alpha,
    thompson_beta,
    created_at,
    updated_at
  FROM goal_execution_paths;

-- =============================================================================
-- Table: activity_dataflows
-- =============================================================================
-- Tracks data flow between activities (function call chains)
-- Enables understanding how data moves through compositions
-- RBAC: Scoped by organization and project
-- =============================================================================

DEFINE TABLE IF NOT EXISTS activity_dataflows SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS caller_activity_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that initiated the call";

DEFINE FIELD IF NOT EXISTS callee_activity_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that was called";

DEFINE FIELD IF NOT EXISTS execution_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  COMMENT "Execution trace ID where this flow occurred";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON activity_dataflows TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS data_passed ON activity_dataflows TYPE option<object>
  COMMENT "Data passed from caller to callee (impulses, args)";

DEFINE FIELD IF NOT EXISTS data_returned ON activity_dataflows TYPE option<object>
  COMMENT "Data returned from callee to caller";

DEFINE FIELD IF NOT EXISTS success ON activity_dataflows TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether the callee execution succeeded";

DEFINE FIELD IF NOT EXISTS duration_ms ON activity_dataflows TYPE float
  VALUE $value OR 0.0
  COMMENT "Callee execution duration";

DEFINE FIELD IF NOT EXISTS call_count ON activity_dataflows TYPE int
  VALUE $value OR 1
  COMMENT "Number of times this flow occurred";

DEFINE FIELD IF NOT EXISTS created_at ON activity_dataflows TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First occurrence timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON activity_dataflows TYPE datetime
  VALUE time::now()
  COMMENT "Last occurrence timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_dataflow_caller
  ON activity_dataflows FIELDS caller_activity_id;

DEFINE INDEX IF NOT EXISTS idx_dataflow_callee
  ON activity_dataflows FIELDS callee_activity_id;

DEFINE INDEX IF NOT EXISTS idx_dataflow_execution
  ON activity_dataflows FIELDS execution_id;

DEFINE INDEX IF NOT EXISTS idx_dataflow_pair
  ON activity_dataflows FIELDS caller_activity_id, callee_activity_id;

-- Multi-tenant indexes
DEFINE INDEX IF NOT EXISTS idx_dataflow_org
  ON activity_dataflows FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_dataflow_project
  ON activity_dataflows FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_dataflow_org_caller
  ON activity_dataflows FIELDS org_id, caller_activity_id;

-- =============================================================================
-- Table: activity_prerequisites
-- =============================================================================
-- Activities declare what they need (preconditions) and produce (postconditions)
-- Enables automatic composition through prerequisite satisfaction
-- RBAC: Scoped by organization
-- =============================================================================

DEFINE TABLE IF NOT EXISTS activity_prerequisites SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS id ON activity_prerequisites TYPE string
  ASSERT $value != NONE
  COMMENT "Unique prerequisite record ID";

DEFINE FIELD IF NOT EXISTS template_id ON activity_prerequisites TYPE string
  ASSERT $value != NONE
  COMMENT "Template identifier";

DEFINE FIELD IF NOT EXISTS variant_id ON activity_prerequisites TYPE string
  ASSERT $value != NONE
  COMMENT "Variant identifier";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON activity_prerequisites TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON activity_prerequisites TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Preconditions: What this activity REQUIRES to run
DEFINE FIELD IF NOT EXISTS required_impulses ON activity_prerequisites TYPE array<object>
  VALUE $value OR []
  COMMENT "Impulses required for execution";

DEFINE FIELD IF NOT EXISTS state_requirements ON activity_prerequisites TYPE option<object>
  COMMENT "State conditions that must be met";

-- Postconditions: What this activity GUARANTEES to create
DEFINE FIELD IF NOT EXISTS produces_impulses ON activity_prerequisites TYPE array<object>
  VALUE $value OR []
  COMMENT "Impulses produced by execution";

DEFINE FIELD IF NOT EXISTS state_changes ON activity_prerequisites TYPE option<object>
  COMMENT "Expected state delta after execution";

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON activity_prerequisites TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON activity_prerequisites TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_prerequisites_template
  ON activity_prerequisites FIELDS template_id;

DEFINE INDEX IF NOT EXISTS idx_prerequisites_variant
  ON activity_prerequisites FIELDS variant_id;

DEFINE INDEX IF NOT EXISTS idx_prerequisites_org
  ON activity_prerequisites FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_prerequisites_id
  ON activity_prerequisites FIELDS id UNIQUE;

-- =============================================================================
-- Table: prerequisite_patterns
-- =============================================================================
-- Tracks which activities successfully satisfy which prerequisites
-- Enables learned composition: "Activity A needs X → Activity B produces X → Compose B→A"
-- RBAC: Scoped by organization
-- =============================================================================

DEFINE TABLE IF NOT EXISTS prerequisite_patterns SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS id ON prerequisite_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Unique pattern ID";

-- What's needed
DEFINE FIELD IF NOT EXISTS required_impulse_type ON prerequisite_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Type of impulse required";

DEFINE FIELD IF NOT EXISTS required_state ON prerequisite_patterns TYPE option<object>
  COMMENT "Required state conditions";

-- What satisfies it
DEFINE FIELD IF NOT EXISTS satisfying_activity_id ON prerequisite_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that satisfies this requirement";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON prerequisite_patterns TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON prerequisite_patterns TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Success metrics
DEFINE FIELD IF NOT EXISTS success_count ON prerequisite_patterns TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful satisfactions";

DEFINE FIELD IF NOT EXISTS failure_count ON prerequisite_patterns TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed satisfactions";

DEFINE FIELD IF NOT EXISTS reliability ON prerequisite_patterns TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate for this pattern";

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON prerequisite_patterns TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON prerequisite_patterns TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_patterns_impulse_type
  ON prerequisite_patterns FIELDS required_impulse_type;

DEFINE INDEX IF NOT EXISTS idx_patterns_activity
  ON prerequisite_patterns FIELDS satisfying_activity_id;

DEFINE INDEX IF NOT EXISTS idx_patterns_org
  ON prerequisite_patterns FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_patterns_id
  ON prerequisite_patterns FIELDS id UNIQUE;

-- =============================================================================
-- Table: execution_sequences
-- =============================================================================
-- Records ordered sequences of activities executed to achieve goals
-- Enables pattern recognition across multiple goal attempts
-- RBAC: Scoped by organization and project
-- =============================================================================

DEFINE TABLE IF NOT EXISTS execution_sequences SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS sequence_id ON execution_sequences TYPE string
  ASSERT $value != NONE
  COMMENT "Unique sequence identifier";

DEFINE FIELD IF NOT EXISTS goal_id ON execution_sequences TYPE string
  ASSERT $value != NONE
  COMMENT "Goal identifier (FK to goal_execution_paths)";

DEFINE FIELD IF NOT EXISTS goal_description ON execution_sequences TYPE string
  ASSERT $value != NONE
  COMMENT "Goal description text";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON execution_sequences TYPE string
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON execution_sequences TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS activity_ids ON execution_sequences TYPE array<string>
  ASSERT $value != NONE
  COMMENT "Ordered list of activity IDs in sequence";

DEFINE FIELD IF NOT EXISTS execution_ids ON execution_sequences TYPE array<string>
  COMMENT "Corresponding execution trace IDs";

DEFINE FIELD IF NOT EXISTS success ON execution_sequences TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether sequence achieved goal";

DEFINE FIELD IF NOT EXISTS duration_ms ON execution_sequences TYPE float
  VALUE $value OR 0.0
  COMMENT "Total sequence duration";

DEFINE FIELD IF NOT EXISTS cost_usd ON execution_sequences TYPE float
  VALUE $value OR 0.0
  COMMENT "Total sequence cost";

DEFINE FIELD IF NOT EXISTS created_at ON execution_sequences TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Sequence execution timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_sequences_sequence_id
  ON execution_sequences FIELDS sequence_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_sequences_goal
  ON execution_sequences FIELDS goal_id;

DEFINE INDEX IF NOT EXISTS idx_sequences_success
  ON execution_sequences FIELDS success;

DEFINE INDEX IF NOT EXISTS idx_sequences_org
  ON execution_sequences FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_sequences_project
  ON execution_sequences FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_sequences_org_goal
  ON execution_sequences FIELDS org_id, goal_id;
