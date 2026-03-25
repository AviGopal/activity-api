-- =============================================================================
-- Unified Activity Model - Vessel Functions as Activities
-- =============================================================================
-- Extends the activity system to treat codebase functions as activities.
-- This enables:
-- - Vessel functions stored alongside template-based activities
-- - Same Thompson Sampling for both
-- - Same execution tracking for both
-- - Same impulse system for both
-- - Unified observability and learning
-- =============================================================================

-- =============================================================================
-- Table: activity_registry
-- =============================================================================
-- Unified registry for ALL activities (templates AND vessel functions)
-- Replaces the conceptual separation between "templates" and "code"
-- =============================================================================

DEFINE TABLE activity_registry SCHEMAFULL;

-- Identity
DEFINE FIELD id ON activity_registry TYPE string
  ASSERT $value != NONE
  COMMENT "Unique activity ID (template: variant_id, vessel: {vessel}:{function})";

DEFINE FIELD name ON activity_registry TYPE string
  ASSERT $value != NONE
  COMMENT "Human-readable activity name";

DEFINE FIELD description ON activity_registry TYPE string
  ASSERT $value != NONE
  COMMENT "What this activity does";

DEFINE FIELD category ON activity_registry TYPE string
  VALUE $value OR 'infrastructure'
  COMMENT "Activity category (feature, bugfix, refactor, tool, infrastructure)";

-- Execution format (how to invoke this activity)
DEFINE FIELD execution_format ON activity_registry TYPE string
  ASSERT $value IN ['template', 'vessel-function', 'native-binary', 'mcp-tool']
  COMMENT "How to execute this activity";

-- Template-based activities (execution_format = 'template')
DEFINE FIELD task_steps ON activity_registry TYPE option<array>
  COMMENT "Task steps for template-based activities";

-- Vessel function activities (execution_format = 'vessel-function')
DEFINE FIELD source_location ON activity_registry TYPE option<object>
  COMMENT "Source location for vessel functions: { vesselId, file, line, functionName, className }";

DEFINE FIELD intent ON activity_registry TYPE option<object>
  COMMENT "Inferred intent: { purpose, confidence, source, rationale }";

-- Learned data (populated from runtime observations)
DEFINE FIELD impulses ON activity_registry TYPE array
  VALUE $value OR []
  COMMENT "Impulses used by this activity (learned from executions)";

DEFINE FIELD tools ON activity_registry TYPE array
  VALUE $value OR []
  COMMENT "Tools called by this activity (learned from executions)";

DEFINE FIELD typical_inputs ON activity_registry TYPE option<object>
  COMMENT "Typical input shape (learned from executions)";

DEFINE FIELD typical_outputs ON activity_registry TYPE option<object>
  COMMENT "Typical output shape (learned from executions)";

-- Thompson Sampling (shared across all activity formats)
DEFINE FIELD executions ON activity_registry TYPE int
  VALUE $value OR 0
  COMMENT "Total execution count";

DEFINE FIELD successes ON activity_registry TYPE int
  VALUE $value OR 0
  COMMENT "Successful execution count";

DEFINE FIELD failures ON activity_registry TYPE int
  VALUE $value OR 0
  COMMENT "Failed execution count";

DEFINE FIELD alpha ON activity_registry TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling alpha (successes + 1)";

DEFINE FIELD beta ON activity_registry TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling beta (failures + 1)";

DEFINE FIELD avg_duration_ms ON activity_registry TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution duration in milliseconds";

DEFINE FIELD avg_cost_usd ON activity_registry TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution cost in USD";

-- Multi-tenancy
DEFINE FIELD scope ON activity_registry TYPE string
  VALUE $value OR 'global'
  COMMENT "Scope: global, org, project, vessel";

DEFINE FIELD org_id ON activity_registry TYPE option<string>
  COMMENT "Organization ID (if scoped)";

DEFINE FIELD project_id ON activity_registry TYPE option<string>
  COMMENT "Project ID (if scoped)";

DEFINE FIELD vessel_id ON activity_registry TYPE option<string>
  COMMENT "Vessel ID (for vessel-function activities)";

-- Metadata
DEFINE FIELD genealogy ON activity_registry TYPE option<object>
  COMMENT "Activity genealogy (extracted_from, variant_of, etc.)";

DEFINE FIELD tags ON activity_registry TYPE array
  VALUE $value OR []
  COMMENT "Activity tags for filtering and discovery";

DEFINE FIELD created_at ON activity_registry TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD updated_at ON activity_registry TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last update timestamp";

DEFINE FIELD last_executed_at ON activity_registry TYPE option<datetime>
  COMMENT "Last execution timestamp";

-- Indexes
DEFINE INDEX idx_activity_id ON activity_registry FIELDS id UNIQUE;
DEFINE INDEX idx_activity_format ON activity_registry FIELDS execution_format;
DEFINE INDEX idx_activity_vessel ON activity_registry FIELDS vessel_id;
DEFINE INDEX idx_activity_category ON activity_registry FIELDS category;
DEFINE INDEX idx_activity_scope ON activity_registry FIELDS scope;

-- Composite indexes for common queries
DEFINE INDEX idx_activity_vessel_format
  ON activity_registry FIELDS vessel_id, execution_format;

DEFINE INDEX idx_activity_scope_category
  ON activity_registry FIELDS scope, category;


-- =============================================================================
-- Table: activity_executions (already exists, extended)
-- =============================================================================
-- Tracks executions for ALL activities (templates AND vessel functions)
-- Links to activity_registry.id instead of variant_id
-- =============================================================================

-- Note: This extends the existing activity_execution_traces table
-- We'll add a migration to rename template_id -> activity_id for clarity


-- =============================================================================
-- Table: activity_dataflows (NEW)
-- =============================================================================
-- Tracks data flow between activities (function call chains)
-- Enables understanding how data moves through the vessel
-- =============================================================================

DEFINE TABLE activity_dataflows SCHEMAFULL;

DEFINE FIELD caller_activity_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that initiated the call";

DEFINE FIELD callee_activity_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that was called";

DEFINE FIELD execution_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  COMMENT "Execution trace ID where this flow occurred";

DEFINE FIELD data_passed ON activity_dataflows TYPE option<object>
  COMMENT "Data passed from caller to callee (impulses, args)";

DEFINE FIELD data_returned ON activity_dataflows TYPE option<object>
  COMMENT "Data returned from callee to caller";

DEFINE FIELD success ON activity_dataflows TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether the callee execution succeeded";

DEFINE FIELD duration_ms ON activity_dataflows TYPE float
  VALUE $value OR 0.0
  COMMENT "Callee execution duration";

DEFINE FIELD call_count ON activity_dataflows TYPE int
  VALUE $value OR 1
  COMMENT "Number of times this flow occurred";

DEFINE FIELD created_at ON activity_dataflows TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First occurrence timestamp";

DEFINE FIELD updated_at ON activity_dataflows TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last occurrence timestamp";

-- Indexes
DEFINE INDEX idx_dataflow_caller ON activity_dataflows FIELDS caller_activity_id;
DEFINE INDEX idx_dataflow_callee ON activity_dataflows FIELDS callee_activity_id;
DEFINE INDEX idx_dataflow_execution ON activity_dataflows FIELDS execution_id;

-- Composite for graph queries
DEFINE INDEX idx_dataflow_pair
  ON activity_dataflows FIELDS caller_activity_id, callee_activity_id;


-- =============================================================================
-- Views: Query helpers
-- =============================================================================

-- View: Template-based activities only
-- (for backward compatibility with existing code)
DEFINE TABLE view_template_activities AS
  SELECT * FROM activity_registry
  WHERE execution_format = 'template';

-- View: Vessel function activities only
DEFINE TABLE view_vessel_functions AS
  SELECT * FROM activity_registry
  WHERE execution_format = 'vessel-function';

-- View: Unused vessel functions (candidates for removal)
DEFINE TABLE view_unused_vessel_functions AS
  SELECT *, executions as execution_count FROM activity_registry
  WHERE execution_format = 'vessel-function' AND executions = 0;

-- View: High-performing activities (success rate > 80%)
DEFINE TABLE view_high_performing_activities AS
  SELECT *, (successes / executions) as success_rate FROM activity_registry
  WHERE executions > 0 AND (successes / executions) > 0.8;
