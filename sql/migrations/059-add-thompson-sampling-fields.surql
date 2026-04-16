-- ============================================================================
-- Migration 059: Add Thompson Sampling Fields to Activity Table
-- ============================================================================
-- Purpose: Enable real-time Thompson Sampling score updates
-- Related: EXECUTION_FIX_PLAN.md - Fix 2
-- ============================================================================

-- Add Thompson Sampling score fields to activity table
DEFINE FIELD IF NOT EXISTS thompson_alpha ON activity TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling alpha parameter (successes + 1)";

DEFINE FIELD IF NOT EXISTS thompson_beta ON activity TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling beta parameter (failures + 1)";

DEFINE FIELD IF NOT EXISTS total_executions ON activity TYPE int
  VALUE $value OR 0
  COMMENT "Total number of executions (successes + failures)";

DEFINE FIELD IF NOT EXISTS successful_executions ON activity TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions";

DEFINE FIELD IF NOT EXISTS failed_executions ON activity TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions";

DEFINE FIELD IF NOT EXISTS last_executed_at ON activity TYPE option<datetime>
  COMMENT "Timestamp of most recent execution";

-- Initialize fields for existing activities that don't have them
UPDATE activity SET
  thompson_alpha = 1.0,
  thompson_beta = 1.0,
  total_executions = 0,
  successful_executions = 0,
  failed_executions = 0
WHERE thompson_alpha IS NULL OR thompson_alpha IS NONE;

-- Note: Scores will be updated by POST /v2/activities/execution-traces endpoint
-- after each execution. The v_activity_score view will continue to work as a
-- fallback/validation mechanism.
