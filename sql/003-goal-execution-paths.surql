-- =============================================================================
-- Goal Execution Paths
-- =============================================================================
-- Aggregates activity execution sequences by goal for path-level recommendations
-- Implements Thompson Sampling over paths instead of individual activities
-- =============================================================================

-- =============================================================================
-- Table: goal_execution_paths
-- =============================================================================
-- Stores aggregated execution paths for specific goals
-- Enables multi-activity path recommendations with Thompson Sampling
-- =============================================================================

DEFINE TABLE goal_execution_paths SCHEMAFULL;

-- Goal identification
DEFINE FIELD goal_hash ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  COMMENT "Hash of normalized goal text (lowercase, trimmed)";

DEFINE FIELD goal_text ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  COMMENT "Original goal text as provided by user";

DEFINE FIELD goal_category ON goal_execution_paths TYPE string
  ASSERT $value IN ['feature', 'bugfix', 'refactor', 'tool', 'infrastructure', 'meta']
  COMMENT "Goal category for filtering (meta = self-referential goals)";

-- Path definition
DEFINE FIELD path_activities ON goal_execution_paths TYPE array<string>
  ASSERT $value != NONE
  COMMENT "Ordered sequence of activity IDs in this path";

DEFINE FIELD path_signature ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  COMMENT "Hash of path_activities for uniqueness";

-- Thompson Sampling parameters (Beta distribution)
DEFINE FIELD total_executions ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Total number of times this path was executed";

DEFINE FIELD successful_executions ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions";

DEFINE FIELD failed_executions ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions";

DEFINE FIELD thompson_alpha ON goal_execution_paths TYPE float
  VALUE $value OR 1.0
  COMMENT "Beta distribution alpha parameter (successes + 1)";

DEFINE FIELD thompson_beta ON goal_execution_paths TYPE float
  VALUE $value OR 1.0
  COMMENT "Beta distribution beta parameter (failures + 1)";

DEFINE FIELD success_rate ON goal_execution_paths TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate: successful_executions / total_executions";

-- Performance metrics (rolling averages)
DEFINE FIELD avg_duration_ms ON goal_execution_paths TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution duration in milliseconds";

DEFINE FIELD avg_cost_usd ON goal_execution_paths TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution cost in USD";

DEFINE FIELD avg_token_usage ON goal_execution_paths TYPE int
  VALUE $value OR 0
  COMMENT "Average total tokens used";

-- Context metadata (for analysis)
DEFINE FIELD typical_files_modified ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Most frequently modified files in successful executions";

DEFINE FIELD typical_tools_used ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Most frequently used tools in this path";

-- Denormalized terminal output shapes (OpenSpec change 2026-04-26-shape-provider-goal-creation)
DEFINE FIELD endpoint_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Denormalized terminal output shapes accumulated from path_activities[*].output_shapes. Indexed for shape-keyed lookup. See OpenSpec change 2026-04-26-shape-provider-goal-creation.";

-- Timestamps
DEFINE FIELD last_executed_at ON goal_execution_paths TYPE option<datetime>
  COMMENT "Timestamp of last execution";

DEFINE FIELD created_at ON goal_execution_paths TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First execution timestamp";

DEFINE FIELD updated_at ON goal_execution_paths TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX idx_goal_paths_hash 
  ON goal_execution_paths FIELDS goal_hash;

DEFINE INDEX idx_goal_paths_category 
  ON goal_execution_paths FIELDS goal_category;

DEFINE INDEX idx_goal_paths_signature 
  ON goal_execution_paths FIELDS goal_hash, path_signature UNIQUE;

DEFINE INDEX idx_goal_paths_success_rate 
  ON goal_execution_paths FIELDS success_rate;

DEFINE INDEX idx_goal_paths_executions
  ON goal_execution_paths FIELDS total_executions;

-- Shape-keyed lookup index (OpenSpec change 2026-04-26-shape-provider-goal-creation)
DEFINE INDEX idx_goal_paths_endpoint_shapes
  ON goal_execution_paths FIELDS endpoint_output_shapes;
