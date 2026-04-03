-- ============================================================================
-- Enhanced Activity Score View (042-enhanced-activity-score)
-- ============================================================================
-- Extended view with computed Thompson Sampling fields for direct querying.
-- Includes pre-computed belief and success_rate for dashboard and API use.
-- ============================================================================

-- ============================================================================
-- View: v_activity_score_enhanced
-- ============================================================================
-- Purpose: Thompson Sampling parameters with computed probability fields
-- Extends: v_activity_score with belief and success_rate computations
-- Usage: Direct dashboard queries without client-side computation
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_activity_score_enhanced AS
  SELECT
    activity_id,
    org_id,
    -- Execution counts
    count() AS total_executions,
    -- Thompson Sampling: Beta(alpha, beta) where alpha = successes + 1, beta = failures + 1
    count(IF success = true THEN 1 ELSE NONE END) + 1 AS alpha,
    count(IF success = false THEN 1 ELSE NONE END) + 1 AS beta,
    -- Success/failure counts
    count(IF success = true THEN 1 ELSE NONE END) AS successes,
    count(IF success = false THEN 1 ELSE NONE END) AS failures,
    -- Computed Thompson Sampling belief: alpha / (alpha + beta)
    -- This is the expected value of the Beta distribution (mean posterior probability)
    <float> (count(IF success = true THEN 1 ELSE NONE END) + 1) /
    <float> (count(IF success = true THEN 1 ELSE NONE END) + count(IF success = false THEN 1 ELSE NONE END) + 2) AS belief,
    -- Raw success rate: successes / total_executions
    -- Note: Returns 0 if total_executions is 0 (edge case for computed views)
    IF count() > 0 THEN
      <float> count(IF success = true THEN 1 ELSE NONE END) / <float> count()
    ELSE
      0.0
    END AS success_rate,
    -- Aggregate metrics
    math::mean(<float> duration_ms) AS avg_duration_ms,
    math::mean(<float> cost_usd) AS avg_cost_usd,
    -- Temporal data
    time::max(executed_at) AS last_executed_at
  FROM execution
  GROUP BY activity_id, org_id
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- ============================================================================
-- Indexes for efficient querying
-- ============================================================================

-- Index for activity lookup
DEFINE INDEX IF NOT EXISTS idx_v_activity_score_enhanced_activity
  ON v_activity_score_enhanced FIELDS activity_id;

-- Index for org-scoped queries
DEFINE INDEX IF NOT EXISTS idx_v_activity_score_enhanced_org
  ON v_activity_score_enhanced FIELDS org_id;

-- Index for ranking by belief (Thompson Sampling selection)
DEFINE INDEX IF NOT EXISTS idx_v_activity_score_enhanced_belief
  ON v_activity_score_enhanced FIELDS org_id, belief;

-- Index for ranking by success rate
DEFINE INDEX IF NOT EXISTS idx_v_activity_score_enhanced_success_rate
  ON v_activity_score_enhanced FIELDS org_id, success_rate;

-- ============================================================================
-- Usage Examples
-- ============================================================================
--
-- Get top activities by belief (Thompson Sampling mean):
--   SELECT * FROM v_activity_score_enhanced
--   WHERE org_id = $auth.org_id
--   ORDER BY belief DESC
--   LIMIT 10;
--
-- Get activities needing exploration (low execution count, moderate belief):
--   SELECT * FROM v_activity_score_enhanced
--   WHERE org_id = $auth.org_id
--     AND total_executions < 10
--     AND belief > 0.3
--   ORDER BY belief DESC;
--
-- Compare belief vs raw success rate (belief is regularized with priors):
--   SELECT activity_id, belief, success_rate, total_executions
--   FROM v_activity_score_enhanced
--   WHERE org_id = $auth.org_id
--   ORDER BY total_executions DESC;
--
-- ============================================================================
