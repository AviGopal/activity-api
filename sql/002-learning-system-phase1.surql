-- =============================================================================
-- Learning System Schema Migration
-- =============================================================================
-- Creates tables for:
--   - Activity composition graph
--   - Impulse relevance metrics
--   - Tool usage patterns
--
-- Activity executions reuse the existing activity_executions table.
-- =============================================================================

-- =============================================================================
-- Table: activity_composition_graph
-- =============================================================================
-- Tracks parent-child relationships between activities (aggregated metrics)
-- Supports multi-activity workflows and composition learning
-- =============================================================================

DEFINE TABLE activity_composition_graph SCHEMAFULL;

DEFINE FIELD parent_activity_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  COMMENT "Parent activity ID in composition";

DEFINE FIELD child_activity_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  COMMENT "Child activity ID in composition";

DEFINE FIELD execution_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  COMMENT "Last execution ID where composition occurred";

DEFINE FIELD goal_context ON activity_composition_graph TYPE option<string>
  COMMENT "Goal or context for composition";

DEFINE FIELD success ON activity_composition_graph TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether last execution succeeded";

DEFINE FIELD execution_count ON activity_composition_graph TYPE int
  VALUE $value OR 1
  COMMENT "Number of times this composition occurred";

DEFINE FIELD success_count ON activity_composition_graph TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful compositions";

DEFINE FIELD weight ON activity_composition_graph TYPE float
  VALUE $value OR 0.0
  COMMENT "Success probability (success_count / execution_count)";

DEFINE FIELD created_at ON activity_composition_graph TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First composition timestamp";

DEFINE FIELD updated_at ON activity_composition_graph TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last composition timestamp";

-- Indexes
DEFINE INDEX idx_composition_parent 
  ON activity_composition_graph FIELDS parent_activity_id;

DEFINE INDEX idx_composition_child 
  ON activity_composition_graph FIELDS child_activity_id;

DEFINE INDEX idx_composition_execution 
  ON activity_composition_graph FIELDS execution_id;


-- =============================================================================
-- Table: impulse_relevance_metrics
-- =============================================================================
-- Tracks aggregated impulse relevance metrics
-- Enables impulse recommendation and lazy loading optimization
-- =============================================================================

DEFINE TABLE impulse_relevance_metrics SCHEMAFULL;

DEFINE FIELD impulse_id ON impulse_relevance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Impulse identifier";

DEFINE FIELD activity_variant_id ON impulse_relevance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Activity variant that uses this impulse";

DEFINE FIELD task_id ON impulse_relevance_metrics TYPE option<string>
  COMMENT "Optional task ID for task-level tracking";

DEFINE FIELD times_loaded ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of times impulse was loaded";

DEFINE FIELD times_execution_succeeded ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions when impulse was loaded";

DEFINE FIELD times_execution_failed ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions when impulse was loaded";

DEFINE FIELD times_not_loaded_succeeded ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions when impulse was NOT loaded";

DEFINE FIELD times_not_loaded_failed ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions when impulse was NOT loaded";

DEFINE FIELD relevance_score ON impulse_relevance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "P(success | impulse loaded): times_execution_succeeded / times_loaded";

DEFINE FIELD irrelevance_score ON impulse_relevance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "P(success | impulse NOT loaded): times_not_loaded_succeeded / (times_not_loaded_succeeded + times_not_loaded_failed)";

DEFINE FIELD avg_content_size_tokens ON impulse_relevance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Average content size in tokens";

DEFINE FIELD typical_pointer_type ON impulse_relevance_metrics TYPE option<string>
  COMMENT "Typical pointer type (file, activityOutput, memo, etc.)";

DEFINE FIELD created_at ON impulse_relevance_metrics TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First recording timestamp";

DEFINE FIELD updated_at ON impulse_relevance_metrics TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX idx_impulse_relevance_impulse 
  ON impulse_relevance_metrics FIELDS impulse_id;

DEFINE INDEX idx_impulse_relevance_variant 
  ON impulse_relevance_metrics FIELDS activity_variant_id;

-- Composite index for aggregation queries
DEFINE INDEX idx_impulse_relevance_combo 
  ON impulse_relevance_metrics FIELDS impulse_id, activity_variant_id;


-- =============================================================================
-- Table: tool_usage_patterns
-- =============================================================================
-- Tracks aggregated tool usage metrics
-- Enables tool recommendation and pattern learning
-- =============================================================================

DEFINE TABLE tool_usage_patterns SCHEMAFULL;

DEFINE FIELD tool_name ON tool_usage_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Tool/function name (e.g., 'read', 'write', 'bash')";

DEFINE FIELD activity_variant_id ON tool_usage_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Activity variant that uses this tool";

DEFINE FIELD task_id ON tool_usage_patterns TYPE option<string>
  COMMENT "Optional task ID for task-level tracking";

DEFINE FIELD times_used ON tool_usage_patterns TYPE int
  VALUE $value OR 0
  COMMENT "Number of times tool was invoked";

DEFINE FIELD times_succeeded ON tool_usage_patterns TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful tool invocations";

DEFINE FIELD times_failed ON tool_usage_patterns TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed tool invocations";

DEFINE FIELD times_activity_succeeded_with_tool ON tool_usage_patterns TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful activity executions when tool was used";

DEFINE FIELD times_activity_succeeded_without_tool ON tool_usage_patterns TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful activity executions when tool was NOT used";

DEFINE FIELD usage_probability ON tool_usage_patterns TYPE float
  VALUE $value OR 0.0
  COMMENT "P(tool used | activity executes)";

DEFINE FIELD success_correlation ON tool_usage_patterns TYPE float
  VALUE $value OR 0.0
  COMMENT "Correlation between tool usage and activity success";

DEFINE FIELD is_required ON tool_usage_patterns TYPE bool
  VALUE $value OR false
  COMMENT "true if activity never succeeds without this tool";

DEFINE FIELD is_optional ON tool_usage_patterns TYPE bool
  VALUE $value OR true
  COMMENT "false if tool is always used";

DEFINE FIELD avg_params_complexity ON tool_usage_patterns TYPE float
  VALUE $value OR 0.0
  COMMENT "Average parameter object complexity/size";

DEFINE FIELD typical_error_rate ON tool_usage_patterns TYPE float
  VALUE $value OR 0.0
  COMMENT "Typical error rate when tool is used";

DEFINE FIELD created_at ON tool_usage_patterns TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First recording timestamp";

DEFINE FIELD updated_at ON tool_usage_patterns TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX idx_tool_usage_tool 
  ON tool_usage_patterns FIELDS tool_name;

DEFINE INDEX idx_tool_usage_variant 
  ON tool_usage_patterns FIELDS activity_variant_id;

-- Composite index for aggregation queries
DEFINE INDEX idx_tool_usage_combo 
  ON tool_usage_patterns FIELDS tool_name, activity_variant_id;
