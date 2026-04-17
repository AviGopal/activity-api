-- ============================================================================
-- Migration 067: Add resolver tracking fields
-- ============================================================================
-- Purpose: Track which vessel/resolver processed impulses during execution
-- Date: 2026-04-16
-- Related: AUDIT_RESOLUTION_PLAN.md Repository 1, Commit 1
-- ============================================================================

-- Add resolver tracking fields to execution table
DEFINE FIELD IF NOT EXISTS resolved_by_vessel_id ON execution TYPE option<string>
  COMMENT "Vessel ID that resolved impulses for this execution";

DEFINE FIELD IF NOT EXISTS resolver_tier ON execution TYPE option<string>
  COMMENT "Resolver tier used: pattern, haiku, sonnet, opus";

-- Indexes for query performance
DEFINE INDEX IF NOT EXISTS idx_execution_vessel ON execution FIELDS resolved_by_vessel_id;
DEFINE INDEX IF NOT EXISTS idx_execution_tier ON execution FIELDS resolver_tier;

-- ============================================================================
-- Note: trace.impulse_resolutions is already a flexible object field
-- ============================================================================
-- The execution.trace field is already defined as FLEXIBLE object type.
-- Expected format for impulse_resolutions within trace:
--
-- trace: {
--   impulse_resolutions: [{
--     impulse_id: string,
--     resolver_id: string,
--     resolver_tier: string,
--     latency_ms: number,
--     cost_usd: number
--   }],
--   tasks: [...],
--   state_transition: {...}
-- }
-- ============================================================================
