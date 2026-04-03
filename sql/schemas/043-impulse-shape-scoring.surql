-- ============================================================================
-- Impulse Shape Activity Scoring for Thompson Sampling
-- ============================================================================
-- Persistent table storing shape-based Thompson Sampling parameters.
-- Unlike the computed view v_shape_conditioned_score, this table allows:
-- 1. Manual initialization of priors for new shape/activity pairs
-- 2. Incremental updates without full recomputation
-- 3. Custom prior adjustments based on domain knowledge
-- 4. Faster lookups for real-time activity selection
--
-- Each row represents: "How well does activity X perform when given shape Y?"
-- ============================================================================

-- ============================================================================
-- Table: impulse_shape_activity_score
-- ============================================================================
-- Purpose: Store Thompson Sampling parameters for shape-based activity selection
-- Key: (org_id, shape, activity_id) - unique score per org/shape/activity combo
-- ============================================================================

DEFINE TABLE IF NOT EXISTS impulse_shape_activity_score SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Shape: The impulse shape this score applies to (e.g., 'goal', 'error', 'source_code')
DEFINE FIELD IF NOT EXISTS shape ON impulse_shape_activity_score TYPE string
  ASSERT $value != NONE
  COMMENT "Impulse shape for this score (e.g., goal, error, source_code)";

-- Activity ID: The activity being scored for this shape
DEFINE FIELD IF NOT EXISTS activity_id ON impulse_shape_activity_score TYPE string
  ASSERT $value != NONE
  COMMENT "Activity ID this score applies to";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON impulse_shape_activity_score TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Success/Failure counts for Thompson Sampling
DEFINE FIELD IF NOT EXISTS success_count ON impulse_shape_activity_score TYPE int
  VALUE $value OR 0
  ASSERT $value >= 0
  COMMENT "Number of successful executions with this shape";

DEFINE FIELD IF NOT EXISTS failure_count ON impulse_shape_activity_score TYPE int
  VALUE $value OR 0
  ASSERT $value >= 0
  COMMENT "Number of failed executions with this shape";

-- Thompson Sampling priors
-- NOTE: SurrealDB VALUE clauses with cross-field references (e.g., success_count + 1)
-- only evaluate at write time for that specific field, NOT when the referenced field changes.
-- Therefore, the application MUST compute and provide alpha/beta on every create/update:
--   alpha = success_count + 1
--   beta = failure_count + 1
DEFINE FIELD IF NOT EXISTS alpha ON impulse_shape_activity_score TYPE int
  VALUE $value OR 1
  ASSERT $value >= 1
  COMMENT "Thompson Sampling alpha. Application must set to success_count + 1";

DEFINE FIELD IF NOT EXISTS beta ON impulse_shape_activity_score TYPE int
  VALUE $value OR 1
  ASSERT $value >= 1
  COMMENT "Thompson Sampling beta. Application must set to failure_count + 1";

-- Timestamp
DEFINE FIELD IF NOT EXISTS updated_at ON impulse_shape_activity_score TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- ============================================================================
-- Indexes
-- ============================================================================

-- Primary lookup: Find scores for a shape within an org
DEFINE INDEX IF NOT EXISTS idx_shape_activity_score_lookup
  ON impulse_shape_activity_score FIELDS org_id, shape;

-- Secondary: Find all scores for an activity
DEFINE INDEX IF NOT EXISTS idx_shape_activity_score_activity
  ON impulse_shape_activity_score FIELDS org_id, activity_id;

-- Unique constraint: One score per (org, shape, activity) combination
DEFINE INDEX IF NOT EXISTS idx_shape_activity_score_unique
  ON impulse_shape_activity_score FIELDS org_id, shape, activity_id UNIQUE;

-- ============================================================================
-- Usage Examples
-- ============================================================================
--
-- 1. Find activities ranked by Thompson Sampling score for a shape:
--    SELECT *, rand::float() * (alpha / (alpha + beta)) AS sample
--    FROM impulse_shape_activity_score
--    WHERE org_id = $auth.org_id AND shape = 'goal'
--    ORDER BY sample DESC
--
-- 2. Update score after successful execution (app must compute alpha/beta):
--    UPDATE impulse_shape_activity_score
--    SET success_count += 1, alpha = success_count + 2
--    WHERE org_id = $auth.org_id
--      AND shape = 'goal'
--      AND activity_id = 'debug-null-pointer'
--
-- 3. Update score after failed execution (app must compute alpha/beta):
--    UPDATE impulse_shape_activity_score
--    SET failure_count += 1, beta = failure_count + 2
--    WHERE org_id = $auth.org_id
--      AND shape = 'goal'
--      AND activity_id = 'debug-null-pointer'
--
-- 4. Initialize score for new shape/activity pair:
--    CREATE impulse_shape_activity_score CONTENT {
--      shape: 'error',
--      activity_id: 'debug-error',
--      org_id: $auth.org_id,
--      success_count: 0,
--      failure_count: 0,
--      alpha: 1,
--      beta: 1
--    }
-- ============================================================================
