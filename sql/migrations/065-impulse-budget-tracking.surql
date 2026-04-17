-- ============================================================================
-- Migration 065: Impulse Budget Tracking (Sequence 2 Requirement)
-- ============================================================================
-- Purpose: Add budget tracking fields to impulse table and create budget log
-- Related: validation/sequence-validation/docs/SEQUENCE_2_REQUIREMENTS.md
-- ============================================================================

-- ============================================================================
-- Add Budget Fields to impulse Table
-- ============================================================================
-- Budget tracking enables resource-aware impulse resolution
-- Prevents runaway token/row/byte consumption per impulse

DEFINE FIELD IF NOT EXISTS budget ON impulse TYPE int
  ASSERT $value >= 0
  VALUE $value OR 10000
  COMMENT "Total resource budget (tokens, rows, bytes depending on resolver type)";

DEFINE FIELD IF NOT EXISTS resources_consumed ON impulse TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  COMMENT "Resources consumed from this impulse during resolution";

DEFINE FIELD IF NOT EXISTS budget_exhausted ON impulse TYPE bool
  VALUE $value OR false
  COMMENT "Whether budget was exceeded during resolution";

-- ============================================================================
-- Table: impulse_budget_log
-- ============================================================================
-- Purpose: Track budget consumption over time for learning and auditing
-- Enables analysis of:
--   - Which activities consume most resources per impulse
--   - Optimal budget allocation per (activity, impulse shape) pair
--   - Budget exhaustion patterns
-- ============================================================================

DEFINE TABLE IF NOT EXISTS impulse_budget_log SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Impulse reference
DEFINE FIELD IF NOT EXISTS impulse_id ON impulse_budget_log TYPE string
  ASSERT $value != NONE
  COMMENT "Impulse identifier (FK to impulse.id)";

-- Activity reference (what consumed the budget)
DEFINE FIELD IF NOT EXISTS activity_id ON impulse_budget_log TYPE string
  ASSERT $value != NONE
  COMMENT "Activity ID that consumed resources from this impulse";

-- Execution reference (for trace linking)
DEFINE FIELD IF NOT EXISTS execution_id ON impulse_budget_log TYPE option<string>
  COMMENT "Execution trace ID (if available)";

-- Budget tracking
DEFINE FIELD IF NOT EXISTS budget_initial ON impulse_budget_log TYPE int
  ASSERT $value >= 0
  COMMENT "Initial budget when impulse was loaded";

DEFINE FIELD IF NOT EXISTS budget_consumed ON impulse_budget_log TYPE int
  ASSERT $value >= 0
  COMMENT "Resources consumed during this usage";

DEFINE FIELD IF NOT EXISTS budget_remaining ON impulse_budget_log TYPE int
  COMMENT "Remaining budget after consumption (can be negative if exceeded)";

-- Exhaustion tracking
DEFINE FIELD IF NOT EXISTS exhausted_at ON impulse_budget_log TYPE option<datetime>
  COMMENT "Timestamp when budget was exhausted (null if not exhausted)";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON impulse_budget_log TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON impulse_budget_log TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Metadata
DEFINE FIELD IF NOT EXISTS created_at ON impulse_budget_log TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Budget consumption timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_impulse_budget_log_org
  ON impulse_budget_log FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_budget_log_impulse
  ON impulse_budget_log FIELDS impulse_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_budget_log_activity
  ON impulse_budget_log FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_budget_log_execution
  ON impulse_budget_log FIELDS execution_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_budget_log_exhausted
  ON impulse_budget_log FIELDS exhausted_at;

-- Composite index for budget analysis (org + impulse + activity)
DEFINE INDEX IF NOT EXISTS idx_impulse_budget_log_org_impulse
  ON impulse_budget_log FIELDS org_id, impulse_id;

-- Composite index for activity-level budget analysis
DEFINE INDEX IF NOT EXISTS idx_impulse_budget_log_org_activity
  ON impulse_budget_log FIELDS org_id, activity_id;

-- ============================================================================
-- Usage Notes:
--
-- 1. Recording budget consumption (after impulse resolution):
--    INSERT INTO impulse_budget_log {
--      impulse_id: "goal-abc123",
--      activity_id: "debug-failed-execution",
--      execution_id: "exec-xyz789",
--      budget_initial: 10000,
--      budget_consumed: 3500,
--      budget_remaining: 6500,
--      exhausted_at: NONE,
--      org_id: $auth.org_id
--    };
--
-- 2. Update impulse with consumed resources:
--    UPDATE impulse:goal-abc123 SET
--      resources_consumed += 3500,
--      budget_exhausted = (resources_consumed >= budget);
--
-- 3. Query budget exhaustion patterns by activity:
--    SELECT activity_id,
--           COUNT() as total_usages,
--           math::sum(budget_consumed) as total_consumed,
--           math::avg(budget_consumed) as avg_consumed,
--           COUNT(exhausted_at != NONE) as exhaustion_count,
--           COUNT(exhausted_at != NONE) / COUNT() as exhaustion_rate
--    FROM impulse_budget_log
--    WHERE org_id = $auth.org_id
--    GROUP BY activity_id
--    ORDER BY exhaustion_rate DESC, avg_consumed DESC;
--
-- 4. Query optimal budget by (activity, impulse shape):
--    SELECT activity_id,
--           i.shape as impulse_shape,
--           math::percentile(budget_consumed, 0.95) as p95_consumed,
--           math::max(budget_consumed) as max_consumed,
--           COUNT(exhausted_at != NONE) / COUNT() as exhaustion_rate
--    FROM impulse_budget_log AS log
--    RELATE log.impulse_id -> impulse AS i
--    WHERE log.org_id = $auth.org_id
--    GROUP BY activity_id, i.shape;
--
-- ============================================================================
-- Verification query (run after migration):
-- INFO FOR TABLE impulse_budget_log;
-- INFO FOR FIELD budget ON impulse;
-- INFO FOR FIELD resources_consumed ON impulse;
-- INFO FOR FIELD budget_exhausted ON impulse;
-- ============================================================================
