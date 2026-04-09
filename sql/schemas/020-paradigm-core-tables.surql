-- ============================================================================
-- Paradigm Core Tables (schema-paradigm-alignment)
-- ============================================================================
-- 4 core tables implementing the impulse/activity/vessel paradigm:
-- 1. impulse  - All data with pointer + shape + metadata
-- 2. activity - All state transitions with input/output shapes
-- 3. execution - All traces linking inputs to outputs
-- 4. vessel   - Execution environments with resolver capabilities
-- ============================================================================

-- ============================================================================
-- Table 1: impulse
-- ============================================================================
-- Purpose: Store all data as impulses with pointers and metadata
-- Replaces: impulse_data, goal-related data, inline trace data
-- ============================================================================

DEFINE TABLE IF NOT EXISTS impulse SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id);

-- Identity
DEFINE FIELD IF NOT EXISTS id ON impulse TYPE string
  ASSERT $value != NONE
  COMMENT "Unique impulse identifier (uuid or semantic: goal-{hash}, trace-{id})";

-- Pointer: WHERE the data is
DEFINE FIELD IF NOT EXISTS pointer ON impulse TYPE object FLEXIBLE
  ASSERT $value != NONE
  COMMENT "Pointer structure varies by type: file, memo, trace, activity, goal, error";

-- Shape: WHAT the data looks like (for activity matching)
DEFINE FIELD IF NOT EXISTS shape ON impulse TYPE string
  ASSERT $value != NONE
  COMMENT "Semantic type for activity matching: goal, source_code, error, trace, recommendation, analysis, patch, test_result";

-- Summary: Human/LLM readable
DEFINE FIELD IF NOT EXISTS summary ON impulse TYPE option<string>
  COMMENT "Brief description (<100 chars)";

-- Token estimate
DEFINE FIELD IF NOT EXISTS token_estimate ON impulse TYPE option<int>
  COMMENT "Estimated tokens when loaded";

-- Content: Actual data (nullable - null means not loaded)
DEFINE FIELD IF NOT EXISTS content ON impulse TYPE option<string>
  COMMENT "Materialized content (null = not loaded yet)";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON impulse TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON impulse TYPE option<record<projects>>
  VALUE $value OR $auth.project_id;

DEFINE FIELD IF NOT EXISTS vessel_id ON impulse TYPE option<string>
  COMMENT "Vessel that created this impulse";

DEFINE FIELD IF NOT EXISTS created_by ON impulse TYPE option<string | record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User, MiniBob instance, or instance ID string who created this impulse";

-- Lifecycle
DEFINE FIELD IF NOT EXISTS created_at ON impulse TYPE datetime
  VALUE $value OR time::now();

DEFINE FIELD IF NOT EXISTS expires_at ON impulse TYPE option<datetime>;

-- Rich metadata for impulse-driven investigation
-- Contains: rowCount, columns, sample, availableOps, producedBy, etc.
DEFINE FIELD IF NOT EXISTS metadata ON impulse TYPE option<object> FLEXIBLE
  COMMENT "Rich metadata: rowCount, columns, sample, availableOps, producedBy";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_impulse_id ON impulse FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_impulse_shape ON impulse FIELDS shape;
DEFINE INDEX IF NOT EXISTS idx_impulse_org ON impulse FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_impulse_org_shape ON impulse FIELDS org_id, shape;
DEFINE INDEX IF NOT EXISTS idx_impulse_org_project ON impulse FIELDS org_id, project_id;
DEFINE INDEX IF NOT EXISTS idx_impulse_vessel ON impulse FIELDS vessel_id;
DEFINE INDEX IF NOT EXISTS idx_impulse_expires ON impulse FIELDS expires_at;
DEFINE INDEX IF NOT EXISTS idx_impulse_pointer_type ON impulse FIELDS pointer.type;

-- ============================================================================
-- Table 2: activity
-- ============================================================================
-- Purpose: Store all state transitions (templates, tools, compositions)
-- Replaces: activity_template, activity_registry, goal_execution_paths, tool definitions
-- ============================================================================

DEFINE TABLE IF NOT EXISTS activity SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (scope = 'global' AND public = true)
      OR (org_id = $auth.org_id)
      OR (scope = 'project' AND project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- Identity
DEFINE FIELD IF NOT EXISTS id ON activity TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS name ON activity TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS description ON activity TYPE option<string>;

-- Input/Output Shapes (for shape-based matching)
DEFINE FIELD IF NOT EXISTS input_shapes ON activity TYPE array<string>
  VALUE $value OR []
  COMMENT "Required impulse shapes for this activity";

DEFINE FIELD IF NOT EXISTS output_shapes ON activity TYPE array<string>
  VALUE $value OR []
  COMMENT "Impulse shapes produced by this activity";

-- Execution definition
DEFINE FIELD IF NOT EXISTS execution_type ON activity TYPE string
  ASSERT $value IN ['template', 'tool', 'composition', 'vessel_function'];

-- Category (backward compat with activity_registry)
DEFINE FIELD IF NOT EXISTS category ON activity TYPE option<string>;

-- Hierarchical tags for classification
DEFINE FIELD IF NOT EXISTS tags ON activity TYPE option<array<string>>
  COMMENT "Hierarchical tags using dot-notation (e.g., 'feature.ui', 'bugfix.auth')";

DEFINE FIELD IF NOT EXISTS tag_prefixes ON activity TYPE option<array<string>>
  COMMENT "All prefixes of tags for efficient prefix matching";

-- Template-specific: Task steps for any resolver type
-- FLEXIBLE without object type specification allows truly arbitrary nested structures
-- Supports: LLM resolvers (prompt/variables), deterministic resolvers (resolver/config),
--           tool invocations, compositions, and any future resolver patterns
DEFINE FIELD IF NOT EXISTS tasks ON activity TYPE option<array> FLEXIBLE
  COMMENT "Task steps array - supports any resolver type (LLM, deterministic, tool, etc.)";

-- Tool-specific: Tool name for tool invocation
DEFINE FIELD IF NOT EXISTS tool_name ON activity TYPE option<string>;

-- Composition-specific: Ordered child activity IDs
DEFINE FIELD IF NOT EXISTS child_activities ON activity TYPE option<array<string>>;

-- Vessel function-specific: Location in codebase
DEFINE FIELD IF NOT EXISTS source_location ON activity TYPE option<object> FLEXIBLE;

-- Lineage (for ribosome-extracted activities)
DEFINE FIELD IF NOT EXISTS extracted_from ON activity TYPE option<string>
  COMMENT "Execution ID this activity was extracted from";

DEFINE FIELD IF NOT EXISTS variant_of ON activity TYPE option<string>
  COMMENT "Activity ID this is a variant of";

-- Scope
DEFINE FIELD IF NOT EXISTS scope ON activity TYPE string
  ASSERT $value IN ['global', 'org', 'project', 'vessel']
  VALUE $value OR 'org';

DEFINE FIELD IF NOT EXISTS public ON activity TYPE bool
  VALUE $value OR false;

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON activity TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON activity TYPE option<record<projects>>;

DEFINE FIELD IF NOT EXISTS created_by ON activity TYPE option<string | record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User, MiniBob instance, or instance ID string who created this activity";

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON activity TYPE datetime
  VALUE $value OR time::now();

DEFINE FIELD IF NOT EXISTS updated_at ON activity TYPE datetime
  VALUE time::now();

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_activity_id ON activity FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_activity_name ON activity FIELDS name;
DEFINE INDEX IF NOT EXISTS idx_activity_type ON activity FIELDS execution_type;
DEFINE INDEX IF NOT EXISTS idx_activity_category ON activity FIELDS category;
DEFINE INDEX IF NOT EXISTS idx_activity_scope ON activity FIELDS scope;
DEFINE INDEX IF NOT EXISTS idx_activity_public ON activity FIELDS public, scope;
DEFINE INDEX IF NOT EXISTS idx_activity_org ON activity FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_activity_org_type ON activity FIELDS org_id, execution_type;
DEFINE INDEX IF NOT EXISTS idx_activity_variant_of ON activity FIELDS variant_of;
-- Index for shape-based matching (ALLINSIDE operator)
DEFINE INDEX IF NOT EXISTS idx_activity_input_shapes ON activity FIELDS input_shapes;
DEFINE INDEX IF NOT EXISTS idx_activity_output_shapes ON activity FIELDS output_shapes;

-- ============================================================================
-- Table 3: execution
-- ============================================================================
-- Purpose: Store all execution traces
-- Replaces: activity_execution_traces, activity_executions, tool_usage, execution_sequences
-- ============================================================================

DEFINE TABLE IF NOT EXISTS execution SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- Identity
DEFINE FIELD IF NOT EXISTS id ON execution TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS activity_id ON execution TYPE string
  ASSERT $value != NONE;

-- Core trace data: Input and output impulses
DEFINE FIELD IF NOT EXISTS input_impulses ON execution TYPE array<string>
  VALUE $value OR []
  COMMENT "IDs of impulses consumed by this execution";

DEFINE FIELD IF NOT EXISTS output_impulses ON execution TYPE array<string>
  VALUE $value OR []
  COMMENT "IDs of impulses produced by this execution";

-- Outcome
DEFINE FIELD IF NOT EXISTS success ON execution TYPE bool
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS error ON execution TYPE option<object> FLEXIBLE
  COMMENT "Error details if success=false: {message, type, task_id, stack}";

-- Metrics
DEFINE FIELD IF NOT EXISTS duration_ms ON execution TYPE int
  ASSERT $value >= 0;

DEFINE FIELD IF NOT EXISTS cost_usd ON execution TYPE float
  ASSERT $value >= 0;

DEFINE FIELD IF NOT EXISTS tokens_in ON execution TYPE int
  VALUE $value OR 0;

DEFINE FIELD IF NOT EXISTS tokens_out ON execution TYPE int
  VALUE $value OR 0;

-- Composition: Parent execution for nested activities
DEFINE FIELD IF NOT EXISTS parent_execution_id ON execution TYPE option<string>
  COMMENT "Parent execution ID for composition child executions";

-- Detailed trace (task-by-task, tool calls, state transitions)
DEFINE FIELD IF NOT EXISTS trace ON execution TYPE option<object> FLEXIBLE
  COMMENT "Full execution trace: tasks, tool_calls, state_transition, impulse_evolution";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON execution TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON execution TYPE option<record<projects>>
  VALUE $value OR $auth.project_id;

DEFINE FIELD IF NOT EXISTS vessel_id ON execution TYPE option<string>
  COMMENT "Vessel that executed this activity";

DEFINE FIELD IF NOT EXISTS vessel_version ON execution TYPE option<string>
  COMMENT "Vessel version in format semver-sha7 (e.g., 0.3.3-f24a329) for learning correlation";

DEFINE FIELD IF NOT EXISTS created_by ON execution TYPE option<string | record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User, MiniBob instance, or instance ID string who created this execution";

-- Edge Learning Fields (from improvisation traces)
DEFINE FIELD IF NOT EXISTS improvisation ON execution TYPE option<bool>
  COMMENT "Whether this was an LLM improvisation (no template matched)";

DEFINE FIELD IF NOT EXISTS input_impulse_shapes ON execution TYPE option<array<string>>
  COMMENT "Shapes of input impulses for edge learning";

DEFINE FIELD IF NOT EXISTS output_impulse_shapes ON execution TYPE option<array<string>>
  COMMENT "Shapes of output impulses for edge learning";

DEFINE FIELD IF NOT EXISTS metadata ON execution TYPE option<object> FLEXIBLE
  COMMENT "Extensible metadata for learning";

-- Timestamps
DEFINE FIELD IF NOT EXISTS executed_at ON execution TYPE datetime
  VALUE $value OR time::now();

DEFINE FIELD IF NOT EXISTS created_at ON execution TYPE datetime
  VALUE $value OR time::now();

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_execution_id ON execution FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_execution_activity ON execution FIELDS activity_id;
DEFINE INDEX IF NOT EXISTS idx_execution_success ON execution FIELDS success;
DEFINE INDEX IF NOT EXISTS idx_execution_parent ON execution FIELDS parent_execution_id;
DEFINE INDEX IF NOT EXISTS idx_execution_org ON execution FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_execution_org_activity ON execution FIELDS org_id, activity_id;
DEFINE INDEX IF NOT EXISTS idx_execution_vessel ON execution FIELDS vessel_id;
DEFINE INDEX IF NOT EXISTS idx_execution_vessel_version ON execution FIELDS vessel_version;
DEFINE INDEX IF NOT EXISTS idx_execution_executed_at ON execution FIELDS executed_at;

-- Composite index for dashboard success rate time-series queries
DEFINE INDEX IF NOT EXISTS idx_execution_org_success_time ON execution FIELDS org_id, success, executed_at;

-- ============================================================================
-- Table 4: vessel
-- ============================================================================
-- Purpose: Store execution environments with resolver capabilities
-- Replaces: minibob_instance
-- ============================================================================

DEFINE TABLE IF NOT EXISTS vessel SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      id = $auth.id
      OR (org_id = $auth.org_id AND $auth.role = 'admin')
    FOR create, update WHERE
      $auth.role = 'admin'
      AND org_id = $auth.org_id
    FOR delete WHERE
      $auth.role = 'admin'
      AND org_id = $auth.org_id;

-- Identity
DEFINE FIELD IF NOT EXISTS id ON vessel TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS name ON vessel TYPE string
  ASSERT $value != NONE;

-- Capabilities: Which impulse types this vessel can resolve
DEFINE FIELD IF NOT EXISTS resolves ON vessel TYPE array<string>
  VALUE $value OR ['file', 'memo']
  COMMENT "Impulse pointer types this vessel can resolve locally";

-- Authentication
DEFINE FIELD IF NOT EXISTS api_key_hash ON vessel TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS is_active ON vessel TYPE bool
  VALUE $value OR true;

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON vessel TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON vessel TYPE option<record<projects>>;

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON vessel TYPE datetime
  VALUE $value OR time::now();

DEFINE FIELD IF NOT EXISTS last_active_at ON vessel TYPE option<datetime>;

DEFINE FIELD IF NOT EXISTS expires_at ON vessel TYPE option<datetime>;

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_vessel_id ON vessel FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_vessel_org ON vessel FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_vessel_active ON vessel FIELDS is_active;
DEFINE INDEX IF NOT EXISTS idx_vessel_resolves ON vessel FIELDS resolves;
