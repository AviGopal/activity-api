-- =============================================================================
-- Progressive Determinism: Model Selection Tracking
-- =============================================================================
-- Tracks model tier selection decisions for Progressive Determinism learning.
-- Enables cost reduction analysis and learning progression visualization.
--
-- Model Tiers:
-- - deterministic: Task uses resolver (no LLM, cost_multiplier = 0)
-- - learned: Patterns reliable, uses cheaper model (Haiku, cost_multiplier = 0.33)
-- - standard: Good activity history (Sonnet, cost_multiplier = 1.0)
-- - new: No history or low success (Sonnet, cost_multiplier = 1.0)
-- =============================================================================

-- =============================================================================
-- Table: model_selection_trace
-- =============================================================================
-- Individual model selection decisions per task execution
-- =============================================================================

DEFINE TABLE IF NOT EXISTS model_selection_trace SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id,
    FOR create WHERE $auth.org_id != NONE,
    FOR update WHERE org_id = $auth.org_id,
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Identifiers
DEFINE FIELD IF NOT EXISTS execution_id ON model_selection_trace TYPE string
  ASSERT $value != NONE
  COMMENT "Execution ID where selection occurred";

DEFINE FIELD IF NOT EXISTS activity_id ON model_selection_trace TYPE string
  ASSERT $value != NONE
  COMMENT "Activity ID";

DEFINE FIELD IF NOT EXISTS task_id ON model_selection_trace TYPE string
  ASSERT $value != NONE
  COMMENT "Task ID within the activity";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON model_selection_trace TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID";

DEFINE FIELD IF NOT EXISTS project_id ON model_selection_trace TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Model Selection Details
DEFINE FIELD IF NOT EXISTS tier ON model_selection_trace TYPE string
  ASSERT $value IN ['deterministic', 'learned', 'standard', 'new']
  COMMENT "Model selection tier";

DEFINE FIELD IF NOT EXISTS model ON model_selection_trace TYPE string
  COMMENT "Model identifier (e.g., claude-sonnet-4-20250514, claude-haiku-4-5, none)";

DEFINE FIELD IF NOT EXISTS reasoning ON model_selection_trace TYPE string
  COMMENT "Why this model/tier was selected";

DEFINE FIELD IF NOT EXISTS cost_multiplier ON model_selection_trace TYPE float
  ASSERT $value >= 0 AND $value <= 1
  COMMENT "Cost relative to baseline (0 = free, 0.33 = haiku, 1.0 = sonnet)";

-- Context at Selection Time
DEFINE FIELD IF NOT EXISTS pattern_count ON model_selection_trace TYPE option<int>
  COMMENT "Number of patterns available at selection time";

DEFINE FIELD IF NOT EXISTS pattern_success_rate ON model_selection_trace TYPE option<float>
  COMMENT "Average pattern success rate at selection time";

DEFINE FIELD IF NOT EXISTS activity_execution_count ON model_selection_trace TYPE option<int>
  COMMENT "Total activity executions at selection time";

DEFINE FIELD IF NOT EXISTS activity_success_rate ON model_selection_trace TYPE option<float>
  COMMENT "Activity success rate at selection time";

-- Task Execution Result (updated after execution)
DEFINE FIELD IF NOT EXISTS task_success ON model_selection_trace TYPE option<bool>
  COMMENT "Whether the task succeeded (updated after execution)";

DEFINE FIELD IF NOT EXISTS actual_cost_usd ON model_selection_trace TYPE option<float>
  COMMENT "Actual cost of this task execution";

DEFINE FIELD IF NOT EXISTS actual_duration_ms ON model_selection_trace TYPE option<int>
  COMMENT "Actual duration of this task execution";

-- Timestamps
DEFINE FIELD IF NOT EXISTS selected_at ON model_selection_trace TYPE datetime
  VALUE $value OR time::now()
  COMMENT "When the selection was made";

DEFINE FIELD IF NOT EXISTS updated_at ON model_selection_trace TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes for efficient queries
DEFINE INDEX IF NOT EXISTS idx_model_selection_execution
  ON model_selection_trace FIELDS execution_id;

DEFINE INDEX IF NOT EXISTS idx_model_selection_activity
  ON model_selection_trace FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_model_selection_task
  ON model_selection_trace FIELDS activity_id, task_id;

DEFINE INDEX IF NOT EXISTS idx_model_selection_tier
  ON model_selection_trace FIELDS tier;

DEFINE INDEX IF NOT EXISTS idx_model_selection_org
  ON model_selection_trace FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_model_selection_org_activity
  ON model_selection_trace FIELDS org_id, activity_id;

DEFINE INDEX IF NOT EXISTS idx_model_selection_time
  ON model_selection_trace FIELDS selected_at;

-- Composite unique index
DEFINE INDEX IF NOT EXISTS idx_model_selection_unique
  ON model_selection_trace FIELDS execution_id, task_id UNIQUE;

-- =============================================================================
-- Table: activity_model_stats
-- =============================================================================
-- Aggregated model selection statistics per activity
-- Updated after each execution for fast dashboard queries
-- =============================================================================

DEFINE TABLE IF NOT EXISTS activity_model_stats SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id,
    FOR create WHERE $auth.org_id != NONE,
    FOR update WHERE org_id = $auth.org_id,
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Identifiers
DEFINE FIELD IF NOT EXISTS activity_id ON activity_model_stats TYPE string
  ASSERT $value != NONE
  COMMENT "Activity ID";

DEFINE FIELD IF NOT EXISTS org_id ON activity_model_stats TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID";

-- Execution Counts by Tier
DEFINE FIELD IF NOT EXISTS total_task_executions ON activity_model_stats TYPE int
  VALUE $value OR 0
  COMMENT "Total task executions for this activity";

DEFINE FIELD IF NOT EXISTS deterministic_count ON activity_model_stats TYPE int
  VALUE $value OR 0
  COMMENT "Tasks executed with deterministic resolver";

DEFINE FIELD IF NOT EXISTS learned_count ON activity_model_stats TYPE int
  VALUE $value OR 0
  COMMENT "Tasks executed with learned tier (Haiku)";

DEFINE FIELD IF NOT EXISTS standard_count ON activity_model_stats TYPE int
  VALUE $value OR 0
  COMMENT "Tasks executed with standard tier (Sonnet)";

DEFINE FIELD IF NOT EXISTS new_count ON activity_model_stats TYPE int
  VALUE $value OR 0
  COMMENT "Tasks executed with new tier (Sonnet, no history)";

-- Success Rates by Tier
DEFINE FIELD IF NOT EXISTS deterministic_success_rate ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate for deterministic tier";

DEFINE FIELD IF NOT EXISTS learned_success_rate ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate for learned tier";

DEFINE FIELD IF NOT EXISTS standard_success_rate ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate for standard tier";

DEFINE FIELD IF NOT EXISTS new_success_rate ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate for new tier";

-- Cost Metrics
DEFINE FIELD IF NOT EXISTS total_cost_usd ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Total cost across all task executions";

DEFINE FIELD IF NOT EXISTS avg_cost_usd ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Average cost per task execution";

DEFINE FIELD IF NOT EXISTS baseline_cost_usd ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Estimated baseline cost if all tasks used standard tier";

DEFINE FIELD IF NOT EXISTS cost_savings_percent ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Cost savings percentage from Progressive Determinism";

-- Learning Progression
DEFINE FIELD IF NOT EXISTS deterministic_ratio ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Ratio of deterministic tier usage (0.0 - 1.0)";

DEFINE FIELD IF NOT EXISTS learned_ratio ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Ratio of learned tier usage (0.0 - 1.0)";

DEFINE FIELD IF NOT EXISTS optimization_score ON activity_model_stats TYPE float
  VALUE $value OR 0.0
  COMMENT "Overall optimization score: (deterministic * 1.0 + learned * 0.67) / total";

-- Timestamps
DEFINE FIELD IF NOT EXISTS first_execution_at ON activity_model_stats TYPE option<datetime>
  COMMENT "First execution timestamp";

DEFINE FIELD IF NOT EXISTS last_execution_at ON activity_model_stats TYPE option<datetime>
  COMMENT "Most recent execution timestamp";

DEFINE FIELD IF NOT EXISTS created_at ON activity_model_stats TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON activity_model_stats TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_activity_model_stats_activity
  ON activity_model_stats FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_activity_model_stats_org
  ON activity_model_stats FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_activity_model_stats_unique
  ON activity_model_stats FIELDS org_id, activity_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_activity_model_stats_optimization
  ON activity_model_stats FIELDS optimization_score;

-- =============================================================================
-- View: v_learning_progression
-- =============================================================================
-- Dashboard view showing learning progression over time
-- =============================================================================

DEFINE TABLE IF NOT EXISTS v_learning_progression AS
  SELECT
    activity_id,
    org_id,
    total_task_executions,
    deterministic_ratio,
    learned_ratio,
    optimization_score,
    cost_savings_percent,
    avg_cost_usd,
    last_execution_at
  FROM activity_model_stats
  WHERE total_task_executions > 0
  ORDER BY optimization_score DESC;
