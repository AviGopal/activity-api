-- =============================================================================
-- View: v_selection_outcomes
-- =============================================================================
-- Links Thompson Sampling selections to actual execution outcomes
-- Enables analysis of: "Did what we selected actually succeed?"
-- Task 15: Selection-to-Execution Correlation
-- =============================================================================

-- =============================================================================
-- View: v_selection_outcomes
-- =============================================================================
-- Purpose: Base view for selection data with computed expected success rate
--
-- This view provides:
--   1. Selection parameters at recommendation time (alpha, beta, thompson_sample)
--   2. Expected success rate based on Beta distribution parameters
--
-- NOTE: The JOIN with execution traces is handled in the API layer for better
-- LEFT JOIN semantics. SurrealDB 3.x views have limited JOIN support.
--
-- Used for:
--   - Thompson Sampling calibration analysis
--   - Selection→Outcome success rate tracking
--   - Identifying mis-calibrated activities
--   - Dashboard explainability metrics
-- =============================================================================

DEFINE TABLE IF NOT EXISTS v_selection_outcomes AS
  SELECT
    correlation_id,
    activity_id,
    thompson_sample AS selection_probability,
    alpha AS alpha_at_selection,
    beta AS beta_at_selection,
    selection_method,
    candidates_count,
    selected_at,
    org_id,
    -- Expected success based on alpha/(alpha+beta) at selection time
    <float> alpha / (<float> alpha + <float> beta) AS expected_success_rate
  FROM thompson_selection_log
PERMISSIONS
  FOR select WHERE org_id = $auth.org_id;

-- =============================================================================
-- Indexes for v_selection_outcomes performance
-- =============================================================================

DEFINE INDEX IF NOT EXISTS idx_v_selection_outcomes_org
  ON v_selection_outcomes FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_v_selection_outcomes_activity
  ON v_selection_outcomes FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_v_selection_outcomes_selected_at
  ON v_selection_outcomes FIELDS selected_at;

DEFINE INDEX IF NOT EXISTS idx_v_selection_outcomes_correlation
  ON v_selection_outcomes FIELDS correlation_id;

-- =============================================================================
-- NOTE: v_selection_calibration and v_org_calibration_summary
-- =============================================================================
-- These views are computed at query time in the API layer rather than as
-- SurrealDB views because:
--
-- 1. They require LEFT JOIN semantics (selection without execution = pending)
-- 2. Calibration error computation needs post-processing
-- 3. Better performance for filtered queries
--
-- See: repos/metabob-activity-api/src/routes/execution-traces.ts
--   - GET /v2/activities/execution-traces/selection-calibration
--   - GET /v2/activities/execution-traces/calibration-summary
-- =============================================================================
