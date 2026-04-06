-- ============================================================================
-- Emergent Shape Statistics
-- ============================================================================
-- Shapes are free-form strings that emerge from usage. This schema tracks
-- shape statistics to understand the network topology, NOT to constrain
-- what shapes are valid.
--
-- Philosophy:
-- - Shapes are discovered, not prescribed
-- - Shapes without resolvers are fine (system learns what works)
-- - Inference heuristics provide starting points, refined by execution data
-- - These views reveal the network; they don't define it
-- ============================================================================

-- ============================================================================
-- View: v_shape_usage
-- ============================================================================
-- Purpose: Aggregate shape usage across activities
-- Shows which shapes exist in the network and how frequently they're used
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_shape_usage AS
  SELECT
    shape,
    role,
    count() AS activity_count,
    array::distinct(array::flatten(array::group(activity_id))) AS activities
  FROM (
    -- Input shapes
    SELECT id AS activity_id, 'input' AS role, array::flatten([input_shapes]) AS shapes
    FROM activity
    WHERE input_shapes IS NOT NONE AND array::len(input_shapes) > 0

    UNION ALL

    -- Output shapes
    SELECT id AS activity_id, 'output' AS role, array::flatten([output_shapes]) AS shapes
    FROM activity
    WHERE output_shapes IS NOT NONE AND array::len(output_shapes) > 0
  )
  SPLIT shapes AS shape
  GROUP BY shape, role
PERMISSIONS FOR select FULL;

-- ============================================================================
-- View: v_shape_network
-- ============================================================================
-- Purpose: Show shape transformations (input → output) across activities
-- Reveals which shapes can be transformed into which other shapes
-- Includes execution success rates for each transformation edge
-- Edge weight = number of activities performing this transformation
--
-- Note: Uses v_activity_score from 021-paradigm-computed-views.surql for
-- execution statistics (total_executions, successes). That view must be
-- defined before this one.
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_shape_network AS
  SELECT
    input_shape,
    output_shape,
    count() AS edge_weight,
    array::distinct(array::flatten(array::group(activity_id))) AS activities,
    math::sum(total_execs) AS total_executions,
    math::sum(success_execs) AS success_count,
    IF math::sum(total_execs) > 0 THEN
      <float> math::sum(success_execs) / <float> math::sum(total_execs)
    ELSE
      0.0
    END AS success_rate
  FROM (
    SELECT
      a.id AS activity_id,
      a.input_shapes,
      a.output_shapes,
      -- Join with pre-aggregated execution stats from v_activity_score
      -- v_activity_score already aggregates total_executions and successes per activity_id
      (SELECT total_executions FROM v_activity_score WHERE activity_id = a.id)[0].total_executions OR 0 AS total_execs,
      (SELECT successes FROM v_activity_score WHERE activity_id = a.id)[0].successes OR 0 AS success_execs
    FROM activity AS a
    WHERE array::len(a.input_shapes) > 0 AND array::len(a.output_shapes) > 0
  )
  SPLIT input_shapes AS input_shape
  SPLIT output_shapes AS output_shape
  GROUP BY input_shape, output_shape
PERMISSIONS FOR select FULL;

-- ============================================================================
-- View: v_shape_execution_stats
-- ============================================================================
-- Purpose: Track shape performance from execution data
-- Shows which shapes correlate with success/failure
-- This is where learning happens - execution data refines shape understanding
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_shape_execution_stats AS
  SELECT
    shape,
    count() AS execution_count,
    count(IF success = true THEN 1 ELSE NONE END) AS successes,
    count(IF success = false THEN 1 ELSE NONE END) AS failures,
    <float> count(IF success = true THEN 1 ELSE NONE END) / <float> count() AS success_rate,
    math::mean(<float> duration_ms) AS avg_duration_ms,
    time::max(executed_at) AS last_used_at
  FROM (
    SELECT
      success,
      duration_ms,
      executed_at,
      array::flatten([input_impulse_shapes]) AS shapes
    FROM execution
    WHERE input_impulse_shapes IS NOT NONE AND array::len(input_impulse_shapes) > 0
  )
  SPLIT shapes AS shape
  GROUP BY shape
PERMISSIONS FOR select FULL;

-- ============================================================================
-- View: v_shapes_for_autocomplete
-- ============================================================================
-- Purpose: Suggest shapes based on observed usage (not a predefined list)
-- Returns shapes sorted by frequency for UI autocomplete
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_shapes_for_autocomplete AS
  SELECT
    shape,
    math::sum(activity_count) AS total_uses,
    array::distinct(array::flatten(array::group(role))) AS roles
  FROM v_shape_usage
  GROUP BY shape
  ORDER BY total_uses DESC;

-- ============================================================================
-- Indexes for efficient lookups
-- ============================================================================

DEFINE INDEX IF NOT EXISTS idx_v_shape_usage_shape ON v_shape_usage FIELDS shape;
DEFINE INDEX IF NOT EXISTS idx_v_shape_network_input ON v_shape_network FIELDS input_shape;
DEFINE INDEX IF NOT EXISTS idx_v_shape_network_output ON v_shape_network FIELDS output_shape;
DEFINE INDEX IF NOT EXISTS idx_v_shape_network_success_rate ON v_shape_network FIELDS success_rate;
DEFINE INDEX IF NOT EXISTS idx_v_shape_exec_stats_shape ON v_shape_execution_stats FIELDS shape;
