-- =============================================================================
-- Migration: Add correlation_id for selection-to-execution linkage
-- =============================================================================
-- Links Thompson Sampling selections to actual execution traces
-- Enables exact attribution (not just activity-level matching)
-- =============================================================================

-- Add correlation_id to thompson_selection_log
DEFINE FIELD IF NOT EXISTS correlation_id ON thompson_selection_log TYPE string
  ASSERT $value != NONE
  COMMENT "Unique correlation ID to link selection to execution";

-- Create unique index on correlation_id for efficient joins
DEFINE INDEX IF NOT EXISTS idx_thompson_selection_correlation
  ON thompson_selection_log FIELDS correlation_id UNIQUE;

-- Add correlation_id to activity_execution_traces
DEFINE FIELD IF NOT EXISTS correlation_id ON activity_execution_traces TYPE option<string>
  COMMENT "Correlation ID linking to thompson_selection_log (optional - not all executions come from recommendations)";

-- Create index on correlation_id for efficient joins
DEFINE INDEX IF NOT EXISTS idx_activity_executions_correlation
  ON activity_execution_traces FIELDS correlation_id;
