-- Migration 082: Add `deprecated` field to activity table
-- Date: 2026-04-22
-- Purpose: Unblock activityTemplate_deprecate / activityTemplate_update {deprecated:...}
--          resolvers which fail with "Found field 'deprecated', but no such field
--          exists for table 'activity'" because the table is SCHEMAFULL.
--
-- Idempotent: uses DEFINE FIELD IF NOT EXISTS so re-runs are safe.

DEFINE FIELD IF NOT EXISTS deprecated ON activity TYPE option<bool>
  VALUE $value OR false
  COMMENT "Soft-delete flag. True = excluded from recommendations. Managed via activityTemplate_deprecate resolver.";

DEFINE INDEX IF NOT EXISTS idx_activity_deprecated ON activity FIELDS deprecated;

-- ============================================================================
-- Verification (run after migration)
-- ============================================================================
-- INFO FOR TABLE activity;                   -- should list `deprecated: option<bool>`
-- SELECT count() FROM activity WHERE deprecated = true;  -- should be 0 initially
-- SELECT count() FROM activity WHERE deprecated = false OR deprecated IS NONE; -- all rows
