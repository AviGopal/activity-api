-- =============================================================================
-- Activity System Schema Initialization
-- =============================================================================
-- Creates tables for activity templates, executions, and performance metrics
-- =============================================================================

-- Set namespace and database
-- NOTE: These USE statements don't work via HTTP API
-- The namespace/database must be set via HTTP headers instead:
--   surreal-ns: activity-system
--   surreal-db: learning_loop

-- =============================================================================
-- Table: activity_template
-- =============================================================================
-- Stores activity template variants with their task definitions
-- =============================================================================

DEFINE TABLE activity_template SCHEMAFULL;

DEFINE FIELD variant_id ON activity_template TYPE string
  ASSERT $value != NONE
  COMMENT "Unique template variant identifier";

DEFINE FIELD activity_id ON activity_template TYPE string
  ASSERT $value != NONE
  COMMENT "Base activity identifier (multiple variants share same activity_id)";

DEFINE FIELD variant_name ON activity_template TYPE string
  ASSERT $value != NONE
  COMMENT "Human-readable template name";

DEFINE FIELD description ON activity_template TYPE string
  ASSERT $value != NONE
  COMMENT "Template description";

DEFINE FIELD category ON activity_template TYPE string
  ASSERT $value IN ['feature', 'bugfix', 'refactor', 'tool', 'infrastructure']
  COMMENT "Template category";

DEFINE FIELD task_steps ON activity_template TYPE option<array>
  COMMENT "Array of task definitions (flexible structure)";

DEFINE FIELD scope ON activity_template TYPE option<string>
  VALUE $value OR 'global'
  COMMENT "Template scope: global, org, project";

DEFINE FIELD org_id ON activity_template TYPE option<string>
  COMMENT "Organization ID (for org-scoped templates)";

DEFINE FIELD project_id ON activity_template TYPE option<string>
  COMMENT "Project ID (for project-scoped templates)";

DEFINE FIELD genealogy ON activity_template TYPE option<object>
  COMMENT "Template lineage and evolution metadata";

DEFINE FIELD created_at ON activity_template TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD updated_at ON activity_template TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX idx_activity_template_variant_id 
  ON activity_template FIELDS variant_id UNIQUE;

DEFINE INDEX idx_activity_template_activity_id 
  ON activity_template FIELDS activity_id;

DEFINE INDEX idx_activity_template_category 
  ON activity_template FIELDS category;

-- =============================================================================
-- Table: variant_performance_metrics
-- =============================================================================
-- Stores aggregated performance metrics and Thompson Sampling parameters
-- =============================================================================

DEFINE TABLE variant_performance_metrics SCHEMAFULL;

DEFINE FIELD variant_id ON variant_performance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Template variant identifier (FK to activity_template)";

DEFINE FIELD activity_id ON variant_performance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Base activity identifier";

DEFINE FIELD total_executions ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Total number of executions";

DEFINE FIELD successful_executions ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions";

DEFINE FIELD failed_executions ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions";

DEFINE FIELD success_rate ON variant_performance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate (0.0 to 1.0)";

DEFINE FIELD avg_duration_ms ON variant_performance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution duration in milliseconds";

DEFINE FIELD avg_cost_usd ON variant_performance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution cost in USD";

DEFINE FIELD thompson_alpha ON variant_performance_metrics TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling alpha parameter (successes + 1)";

DEFINE FIELD thompson_beta ON variant_performance_metrics TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling beta parameter (failures + 1)";

DEFINE FIELD total_selections ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of times template was selected";

DEFINE FIELD last_executed_at ON variant_performance_metrics TYPE option<datetime>
  COMMENT "Timestamp of last execution";

DEFINE FIELD created_at ON variant_performance_metrics TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD updated_at ON variant_performance_metrics TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX idx_variant_performance_variant_id 
  ON variant_performance_metrics FIELDS variant_id UNIQUE;

DEFINE INDEX idx_variant_performance_activity_id 
  ON variant_performance_metrics FIELDS activity_id;

-- =============================================================================
-- Table: activity_executions
-- =============================================================================
-- Records individual activity execution results
-- =============================================================================

DEFINE TABLE activity_executions SCHEMAFULL;

DEFINE FIELD execution_id ON activity_executions TYPE string
  ASSERT $value != NONE
  COMMENT "Unique execution identifier";

DEFINE FIELD variant_id ON activity_executions TYPE string
  ASSERT $value != NONE
  COMMENT "Template variant identifier (FK to activity_template)";

DEFINE FIELD org_id ON activity_executions TYPE option<string>
  COMMENT "Organization ID";

DEFINE FIELD project_id ON activity_executions TYPE option<string>
  COMMENT "Project ID";

DEFINE FIELD success ON activity_executions TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether execution succeeded";

DEFINE FIELD duration_ms ON activity_executions TYPE int
  ASSERT $value != NONE
  COMMENT "Execution duration in milliseconds";

DEFINE FIELD cost_usd ON activity_executions TYPE float
  ASSERT $value != NONE
  COMMENT "Execution cost in USD";

DEFINE FIELD tokens_input ON activity_executions TYPE int
  VALUE $value OR 0
  COMMENT "Input tokens consumed";

DEFINE FIELD tokens_output ON activity_executions TYPE int
  VALUE $value OR 0
  COMMENT "Output tokens generated";

DEFINE FIELD tokens_cache ON activity_executions TYPE int
  VALUE $value OR 0
  COMMENT "Cache tokens reused";

DEFINE FIELD error_message ON activity_executions TYPE option<string>
  COMMENT "Error message if execution failed";

DEFINE FIELD error_type ON activity_executions TYPE option<string>
  COMMENT "Error category: validation, timeout, tool_error, etc.";

DEFINE FIELD failed_task_id ON activity_executions TYPE option<string>
  COMMENT "Task ID where failure occurred";

DEFINE FIELD impulses_used ON activity_executions TYPE option<array<string>>
  COMMENT "Array of impulse IDs used in this execution";

DEFINE FIELD component_changes ON activity_executions TYPE option<array<string>>
  COMMENT "Array of component IDs changed in this execution";

DEFINE FIELD executed_at ON activity_executions TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Execution timestamp";

DEFINE FIELD created_at ON activity_executions TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

-- Indexes
DEFINE INDEX idx_activity_executions_execution_id 
  ON activity_executions FIELDS execution_id UNIQUE;

DEFINE INDEX idx_activity_executions_variant_id 
  ON activity_executions FIELDS variant_id;

DEFINE INDEX idx_activity_executions_executed_at 
  ON activity_executions FIELDS executed_at;
