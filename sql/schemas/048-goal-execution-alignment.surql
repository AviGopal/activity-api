-- =============================================================================
-- Goal Execution Foundation Alignment Schema
-- =============================================================================
-- Implements schema changes for:
-- 1. Failure pattern learning on tool_argument_pattern table
-- 2. Composition impulse tracking on activity_composition_graph table
-- 3. New composition_impulse_flow table for detailed tracking
-- 4. Input/output schema fields on activity table for template generation
-- =============================================================================

-- =============================================================================
-- 1. Failure Pattern Learning Fields on tool_argument_pattern
-- =============================================================================
-- Adds failure_type, failure_reason, and tool_succeeded fields to enable
-- learning from failed executions (not just successes)
-- =============================================================================

DEFINE FIELD IF NOT EXISTS failure_type ON tool_argument_pattern TYPE option<string>
  COMMENT "Type of failure: 'validation', 'execution', 'tool_failure', 'timeout'. NULL if succeeded.";

DEFINE FIELD IF NOT EXISTS failure_reason ON tool_argument_pattern TYPE option<string>
  COMMENT "Human-readable failure reason or error message. NULL if succeeded.";

DEFINE FIELD IF NOT EXISTS tool_succeeded ON tool_argument_pattern TYPE option<bool>
  COMMENT "Whether the individual tool call succeeded (may differ from overall execution success).";

DEFINE FIELD IF NOT EXISTS validation_error ON tool_argument_pattern TYPE option<string>
  COMMENT "Specific validation rule that failed. NULL if validation passed or not a validation failure.";

-- Track failure counts for pattern analysis
DEFINE FIELD IF NOT EXISTS times_failed ON tool_argument_pattern TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions using this pattern";

-- Failure type breakdown for detailed analysis
DEFINE FIELD IF NOT EXISTS failure_counts ON tool_argument_pattern TYPE option<object> FLEXIBLE
  COMMENT "Breakdown by failure type: {validation: N, execution: N, tool_failure: N, timeout: N}";

-- Index for failure pattern queries
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_failure_type
  ON tool_argument_pattern FIELDS failure_type;

DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_success_failure
  ON tool_argument_pattern FIELDS times_succeeded, times_failed;

-- =============================================================================
-- 2. Impulse Flow Fields on activity_composition_graph
-- =============================================================================
-- Adds input/output impulse shape tracking for composition learning
-- Enables pattern recognition based on impulse presence/absence
-- =============================================================================

DEFINE FIELD IF NOT EXISTS input_impulse_shapes ON activity_composition_graph TYPE array<string>
  VALUE $value OR []
  COMMENT "Shapes of impulses loaded by the child activity in this composition";

DEFINE FIELD IF NOT EXISTS output_impulse_shapes ON activity_composition_graph TYPE array<string>
  VALUE $value OR []
  COMMENT "Shapes of impulses created by the child activity in this composition";

-- Additional composition metrics
DEFINE FIELD IF NOT EXISTS duration_ms ON activity_composition_graph TYPE option<float>
  COMMENT "Duration of child execution in milliseconds";

DEFINE FIELD IF NOT EXISTS cost_usd ON activity_composition_graph TYPE option<float>
  COMMENT "Cost of child execution in USD";

DEFINE FIELD IF NOT EXISTS tokens_input ON activity_composition_graph TYPE option<int>
  COMMENT "Input tokens used in child execution";

DEFINE FIELD IF NOT EXISTS tokens_output ON activity_composition_graph TYPE option<int>
  COMMENT "Output tokens generated in child execution";

DEFINE FIELD IF NOT EXISTS depth ON activity_composition_graph TYPE option<int>
  COMMENT "Nesting depth of this composition (0 = direct call)";

DEFINE FIELD IF NOT EXISTS composition_chain ON activity_composition_graph TYPE option<array<string>>
  COMMENT "Chain of activity IDs from root to this child";

-- Index for shape-based composition queries
DEFINE INDEX IF NOT EXISTS idx_composition_input_shapes
  ON activity_composition_graph FIELDS input_impulse_shapes;

DEFINE INDEX IF NOT EXISTS idx_composition_output_shapes
  ON activity_composition_graph FIELDS output_impulse_shapes;

-- =============================================================================
-- 3. New composition_impulse_flow Table
-- =============================================================================
-- Per-impulse tracking for composition edges
-- Enables queries like "Success rate when parent X calls child Y with shape Z"
-- =============================================================================

DEFINE TABLE IF NOT EXISTS composition_impulse_flow SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Link to composition edge
DEFINE FIELD IF NOT EXISTS edge_id ON composition_impulse_flow TYPE string
  ASSERT $value != NONE
  COMMENT "Reference to activity_composition_graph record (parent_id + child_id composite key)";

-- Execution context
DEFINE FIELD IF NOT EXISTS execution_id ON composition_impulse_flow TYPE string
  ASSERT $value != NONE
  COMMENT "Execution identifier where this impulse flow occurred";

-- Impulse identification
DEFINE FIELD IF NOT EXISTS impulse_id ON composition_impulse_flow TYPE string
  ASSERT $value != NONE
  COMMENT "The specific impulse ID";

-- Direction: input or output
DEFINE FIELD IF NOT EXISTS direction ON composition_impulse_flow TYPE string
  ASSERT $value IN ['input', 'output']
  COMMENT "Whether this impulse was an input (loaded) or output (created)";

-- Shape for analysis
DEFINE FIELD IF NOT EXISTS shape ON composition_impulse_flow TYPE string
  ASSERT $value != NONE
  COMMENT "The impulse shape (for pattern matching without resolving impulse)";

-- Outcome tracking
DEFINE FIELD IF NOT EXISTS execution_succeeded ON composition_impulse_flow TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether the composition execution succeeded with this impulse";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON composition_impulse_flow TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON composition_impulse_flow TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON composition_impulse_flow TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

-- Indexes for common query patterns
DEFINE INDEX IF NOT EXISTS idx_impulse_flow_edge
  ON composition_impulse_flow FIELDS edge_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_flow_execution
  ON composition_impulse_flow FIELDS execution_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_flow_impulse
  ON composition_impulse_flow FIELDS impulse_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_flow_shape_direction
  ON composition_impulse_flow FIELDS shape, direction;

DEFINE INDEX IF NOT EXISTS idx_impulse_flow_org
  ON composition_impulse_flow FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_flow_org_edge
  ON composition_impulse_flow FIELDS org_id, edge_id;

-- Composite index for success rate queries by shape
DEFINE INDEX IF NOT EXISTS idx_impulse_flow_shape_success
  ON composition_impulse_flow FIELDS shape, direction, execution_succeeded;

-- =============================================================================
-- 4. Schema Fields on activity Table
-- =============================================================================
-- Adds input_schema and output_schema for detailed schema tracking
-- (input_shapes/output_shapes are already present; these add structured schemas)
-- =============================================================================

DEFINE FIELD IF NOT EXISTS input_schema ON activity TYPE option<object> FLEXIBLE
  COMMENT "Structured input schema: {required: ImpulseShape[], optional?: ImpulseShape[]}";

DEFINE FIELD IF NOT EXISTS output_schema ON activity TYPE option<object> FLEXIBLE
  COMMENT "Structured output schema: {produces: ImpulseShape[]}";

DEFINE FIELD IF NOT EXISTS schema_confidence ON activity TYPE option<float>
  COMMENT "Confidence score (0.0-1.0) for extracted schemas. <0.5 triggers warning, <0.7 treated as hints.";

-- Index for schema confidence filtering
DEFINE INDEX IF NOT EXISTS idx_activity_schema_confidence
  ON activity FIELDS schema_confidence;

-- =============================================================================
-- 5. Updated View: v_argument_recommendations with failure data
-- =============================================================================
-- Enhanced view that includes failure statistics for pattern recommendations
-- =============================================================================

REMOVE TABLE IF EXISTS v_argument_recommendations;

DEFINE TABLE IF NOT EXISTS v_argument_recommendations AS
SELECT
  activity_id,
  tool_name,
  argument_shape,
  argument_hash,
  arguments,
  (times_succeeded * 1.0 / times_used) as success_rate,
  (times_failed * 1.0 / times_used) as failure_rate,
  times_used,
  times_succeeded,
  times_failed,
  avg_execution_ms,
  last_used_at,
  failure_type,
  failure_counts,
  org_id
FROM tool_argument_pattern
WHERE times_used >= 3
  AND (times_succeeded * 1.0 / times_used) >= 0.8
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- =============================================================================
-- 6. New View: v_failure_patterns for analyzing failure patterns
-- =============================================================================
-- Surfaces patterns that frequently fail for debugging and improvement
-- =============================================================================

DEFINE TABLE IF NOT EXISTS v_failure_patterns AS
SELECT
  activity_id,
  tool_name,
  argument_shape,
  argument_hash,
  arguments,
  (times_succeeded * 1.0 / times_used) as success_rate,
  (times_failed * 1.0 / times_used) as failure_rate,
  times_used,
  times_succeeded,
  times_failed,
  avg_execution_ms,
  failure_type,
  failure_reason,
  validation_error,
  failure_counts,
  org_id
FROM tool_argument_pattern
WHERE times_failed > 0
ORDER BY times_failed DESC
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- =============================================================================
-- 7. New View: v_composition_impulse_success for shape-conditioned success rates
-- =============================================================================
-- Calculates success rates conditioned on input/output shapes
-- =============================================================================

DEFINE TABLE IF NOT EXISTS v_composition_impulse_success AS
SELECT
  edge_id,
  shape,
  direction,
  count() as total_count,
  count(IF execution_succeeded = true THEN 1 ELSE NONE END) as success_count,
  (count(IF execution_succeeded = true THEN 1 ELSE NONE END) * 1.0 / count()) as success_rate,
  org_id
FROM composition_impulse_flow
GROUP BY edge_id, shape, direction, org_id
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;
