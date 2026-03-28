-- ============================================================================
-- Paradigm Computed Views (schema-paradigm-alignment)
-- ============================================================================
-- Computed views that derive metrics from the execution table.
-- All metrics are computed rather than stored separately.
-- ============================================================================

-- ============================================================================
-- View: v_activity_score
-- ============================================================================
-- Purpose: Thompson Sampling parameters and aggregate metrics per activity
-- Replaces: variant_performance_metrics
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_activity_score AS
  SELECT
    activity_id,
    org_id,
    count() AS total_executions,
    -- Thompson Sampling: Beta(alpha, beta) where alpha = successes + 1, beta = failures + 1
    count(IF success = true THEN 1 ELSE NONE END) + 1 AS alpha,
    count(IF success = false THEN 1 ELSE NONE END) + 1 AS beta,
    -- Success counts
    count(IF success = true THEN 1 ELSE NONE END) AS successes,
    count(IF success = false THEN 1 ELSE NONE END) AS failures,
    -- Aggregate metrics
    math::mean(<float> duration_ms) AS avg_duration_ms,
    math::mean(<float> cost_usd) AS avg_cost_usd,
    math::sum(<float> cost_usd) AS total_cost_usd,
    math::sum(<int> tokens_in) AS total_tokens_in,
    math::sum(<int> tokens_out) AS total_tokens_out,
    -- Temporal data
    time::max(executed_at) AS last_executed_at,
    time::min(executed_at) AS first_executed_at
  FROM execution
  GROUP BY activity_id, org_id
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- Note: Thompson Sampling selection happens application-side
-- SurrealDB doesn't have native Beta distribution sampling
-- Usage:
--   const scores = await db.query('SELECT * FROM v_activity_score WHERE org_id = $org');
--   const ranked = scores.map(s => ({ ...s, sample: betaRandom(s.alpha, s.beta) }))
--                        .sort((a, b) => b.sample - a.sample);

-- ============================================================================
-- View: v_goal_paths
-- ============================================================================
-- Purpose: Find composition activities that accept goal impulses
-- Replaces: goal_execution_paths
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_goal_paths AS
  SELECT
    id AS path_id,
    name AS path_name,
    description,
    child_activities,
    input_shapes,
    output_shapes,
    org_id,
    public
  FROM activity
  WHERE execution_type = 'composition'
    AND 'goal' INSIDE input_shapes;

-- ============================================================================
-- View: v_tool_usage
-- ============================================================================
-- Purpose: Aggregate tool usage patterns
-- Replaces: tool_usage, tool_usage_patterns
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_tool_usage AS
  SELECT
    activity_id AS tool_id,
    org_id,
    count() AS call_count,
    count(IF success = true THEN 1 ELSE NONE END) AS success_count,
    count(IF success = false THEN 1 ELSE NONE END) AS failure_count,
    math::mean(<float> duration_ms) AS avg_duration_ms,
    time::max(executed_at) AS last_used_at
  FROM execution
  WHERE activity_id IN (SELECT id FROM activity WHERE execution_type = 'tool')
  GROUP BY activity_id, org_id;

-- ============================================================================
-- View: v_vessel_activity
-- ============================================================================
-- Purpose: Track vessel activity and health
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_vessel_activity AS
  SELECT
    vessel_id,
    org_id,
    count() AS total_executions,
    count(IF success = true THEN 1 ELSE NONE END) AS successful,
    count(IF success = false THEN 1 ELSE NONE END) AS failed,
    math::mean(<float> duration_ms) AS avg_duration_ms,
    math::sum(<float> cost_usd) AS total_cost_usd,
    time::max(executed_at) AS last_execution_at
  FROM execution
  WHERE vessel_id IS NOT NONE
  GROUP BY vessel_id, org_id;

-- ============================================================================
-- View: v_execution_tree
-- ============================================================================
-- Purpose: Show parent-child execution relationships for compositions
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_execution_tree AS
  SELECT
    parent_execution_id AS parent,
    id AS child,
    activity_id,
    success,
    duration_ms,
    org_id
  FROM execution
  WHERE parent_execution_id IS NOT NONE;

-- ============================================================================
-- View: v_activity_shapes
-- ============================================================================
-- Purpose: Quick lookup of input/output shapes per activity
-- For shape-based matching queries
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_activity_shapes AS
  SELECT
    id AS activity_id,
    name,
    execution_type,
    input_shapes,
    output_shapes,
    org_id,
    public,
    scope
  FROM activity
  WHERE execution_type IN ['template', 'composition'];

-- ============================================================================
-- Helper function: impulse_relevance
-- ============================================================================
-- Purpose: Compute relevance of a shape for an activity
-- Usage: RETURN fn::impulse_relevance('debug-null-pointer', 'error')
-- ============================================================================

-- Note: SurrealDB 3.0 function syntax
-- This function computes how often a shape correlates with success
-- DEFINE FUNCTION IF NOT EXISTS fn::impulse_relevance($activity_id: string, $shape: string) {
--   -- Get executions with this shape in input_impulses
--   LET $with_shape = (
--     SELECT
--       count() AS total,
--       count(IF success = true THEN 1 ELSE NONE END) AS success
--     FROM execution
--     WHERE activity_id = $activity_id
--     GROUP ALL
--   )[0];
--
--   RETURN {
--     activity_id: $activity_id,
--     shape: $shape,
--     total: $with_shape.total OR 0,
--     success: $with_shape.success OR 0,
--     relevance: IF $with_shape.total > 0 THEN <float> $with_shape.success / <float> $with_shape.total ELSE 0.0
--   };
-- };
-- Note: Function disabled - complex subqueries may cause issues. Use query-time computation.

-- ============================================================================
-- View: v_impulse_relevance
-- ============================================================================
-- Purpose: Compute relevance of impulses for activities based on execution success
-- Used by: Graph Dashboard - Impulse Contribution Analysis
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_impulse_relevance AS
  SELECT
    impulse_id,
    activity_id,
    org_id,
    count() AS times_loaded,
    count(IF success = true THEN 1 ELSE NONE END) AS times_succeeded,
    count(IF success = false THEN 1 ELSE NONE END) AS times_failed,
    -- Relevance score: proportion of successful executions when this impulse was loaded
    <float> count(IF success = true THEN 1 ELSE NONE END) / <float> count() AS relevance_score
  FROM execution, execution.input_impulses AS impulse_id
  GROUP BY impulse_id, activity_id, org_id
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- Index for efficient impulse relevance lookups
DEFINE INDEX IF NOT EXISTS idx_v_impulse_relevance_activity
  ON v_impulse_relevance FIELDS activity_id;
DEFINE INDEX IF NOT EXISTS idx_v_impulse_relevance_impulse
  ON v_impulse_relevance FIELDS impulse_id;

-- ============================================================================
-- View: v_composition_graph
-- ============================================================================
-- Purpose: Aggregate parent→child execution relationships with success rates
-- Used by: Graph Dashboard - Composition Strength Visualization
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_composition_graph AS
  SELECT
    parent.activity_id AS parent_activity_id,
    child.activity_id AS child_activity_id,
    parent.org_id AS org_id,
    count() AS execution_count,
    count(IF child.success = true THEN 1 ELSE NONE END) AS success_count,
    count(IF child.success = false THEN 1 ELSE NONE END) AS failure_count,
    -- Weight: success rate for this edge
    <float> count(IF child.success = true THEN 1 ELSE NONE END) / <float> count() AS weight,
    time::max(child.executed_at) AS last_executed_at
  FROM execution AS child
  JOIN execution AS parent ON child.parent_execution_id = parent.id
  GROUP BY parent.activity_id, child.activity_id, parent.org_id
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- Indexes for composition graph traversal
DEFINE INDEX IF NOT EXISTS idx_v_composition_parent
  ON v_composition_graph FIELDS parent_activity_id;
DEFINE INDEX IF NOT EXISTS idx_v_composition_child
  ON v_composition_graph FIELDS child_activity_id;
DEFINE INDEX IF NOT EXISTS idx_v_composition_weight
  ON v_composition_graph FIELDS org_id, weight;

-- ============================================================================
-- View: v_convergence_metrics
-- ============================================================================
-- Purpose: Aggregate convergence indicators for dashboard overview
-- Used by: Graph Dashboard - Convergence Overview
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_convergence_metrics AS
  SELECT
    org_id,
    count() AS total_activities,
    -- Exploration: activities with <5 executions (high uncertainty)
    count(IF total_executions < 5 THEN 1 ELSE NONE END) AS exploration_count,
    -- Transition: activities with 5-9 executions
    count(IF total_executions >= 5 AND total_executions < 10 THEN 1 ELSE NONE END) AS transition_count,
    -- Exploitation: activities with ≥10 executions (low uncertainty)
    count(IF total_executions >= 10 THEN 1 ELSE NONE END) AS exploitation_count,
    -- Average belief across all activities: alpha / (alpha + beta)
    math::mean(<float> alpha / (<float> alpha + <float> beta)) AS avg_belief,
    -- Total executions across all activities
    math::sum(total_executions) AS total_executions_all
  FROM v_activity_score
  GROUP BY org_id
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;
