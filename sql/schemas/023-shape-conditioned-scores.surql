-- ============================================================================
-- Shape-Conditioned Thompson Sampling Scores
-- ============================================================================
-- Computes Thompson priors conditioned on input impulse shapes.
-- This allows learning that "activity A works well for goal+error inputs
-- but poorly for just goal inputs."
--
-- The shape signature is computed from input_impulse_shapes array.
-- ============================================================================

-- ============================================================================
-- View: v_shape_conditioned_score
-- ============================================================================
-- Purpose: Thompson Sampling parameters conditioned on input shapes
-- Groups executions by (activity_id, org_id, input_shape_signature)
-- Shape signature is the sorted, deduplicated input_impulse_shapes as JSON
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_shape_conditioned_score AS
  SELECT
    activity_id,
    org_id,
    -- Shape signature: canonical sorted array of unique shapes
    -- Note: array::sort and array::distinct ensure consistent grouping
    array::sort(array::distinct(input_impulse_shapes)) AS shape_signature,
    -- Thompson Sampling priors
    count() AS total_executions,
    count(IF success = true THEN 1 ELSE NONE END) + 1 AS alpha,
    count(IF success = false THEN 1 ELSE NONE END) + 1 AS beta,
    -- Success counts
    count(IF success = true THEN 1 ELSE NONE END) AS successes,
    count(IF success = false THEN 1 ELSE NONE END) AS failures,
    -- Aggregate metrics
    math::mean(<float> duration_ms) AS avg_duration_ms,
    math::mean(<float> cost_usd) AS avg_cost_usd,
    -- Temporal
    time::max(executed_at) AS last_executed_at,
    time::min(executed_at) AS first_executed_at
  FROM execution
  WHERE input_impulse_shapes IS NOT NONE
    AND array::len(input_impulse_shapes) > 0
  GROUP BY activity_id, org_id, array::sort(array::distinct(input_impulse_shapes))
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- Index for efficient shape-conditioned lookups
DEFINE INDEX IF NOT EXISTS idx_v_shape_score_activity
  ON v_shape_conditioned_score FIELDS activity_id;
DEFINE INDEX IF NOT EXISTS idx_v_shape_score_org_activity
  ON v_shape_conditioned_score FIELDS org_id, activity_id;
DEFINE INDEX IF NOT EXISTS idx_v_shape_score_signature
  ON v_shape_conditioned_score FIELDS shape_signature;

-- ============================================================================
-- View: v_shape_pattern_performance
-- ============================================================================
-- Purpose: Analyze which shape patterns work best across activities
-- Useful for discovering effective impulse combinations
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_shape_pattern_performance AS
  SELECT
    array::sort(array::distinct(input_impulse_shapes)) AS shape_pattern,
    org_id,
    count() AS total_uses,
    count(IF success = true THEN 1 ELSE NONE END) AS successes,
    count(IF success = false THEN 1 ELSE NONE END) AS failures,
    -- Overall success rate for this shape pattern
    <float> count(IF success = true THEN 1 ELSE NONE END) / <float> count() AS success_rate,
    -- Number of unique activities this pattern was used with
    array::len(array::distinct(array::group(activity_id))) AS activity_count,
    -- Most recent use
    time::max(executed_at) AS last_used_at
  FROM execution
  WHERE input_impulse_shapes IS NOT NONE
    AND array::len(input_impulse_shapes) > 0
  GROUP BY array::sort(array::distinct(input_impulse_shapes)), org_id
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- Index for pattern analysis
DEFINE INDEX IF NOT EXISTS idx_v_pattern_perf_org
  ON v_shape_pattern_performance FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_v_pattern_perf_success_rate
  ON v_shape_pattern_performance FIELDS org_id, success_rate;

-- ============================================================================
-- Helper: Get shape-conditioned score for an activity
-- ============================================================================
-- Usage example:
--   SELECT * FROM v_shape_conditioned_score
--   WHERE activity_id = 'debug-null-pointer'
--     AND shape_signature = ['error', 'goal', 'source_code']
-- ============================================================================
