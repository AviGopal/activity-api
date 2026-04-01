-- =============================================================================
-- Create activity_template alias for backward compatibility
-- =============================================================================
-- Problem: Application code queries 'activity_template' but the actual schema
--          defines 'view_activity_template' (in 010-activity-registry.surql).
--          This mismatch causes "table does not exist" errors at runtime.
--
-- Solution: Create activity_template as a view with identical definition.
--           This maintains backward compatibility while the codebase is
--           gradually migrated to use view_activity_template.
--
-- Migration Path:
--   1. Apply this migration (creates activity_template view)
--   2. Gradually update code to use view_activity_template
--   3. Remove this file once all code is migrated
-- =============================================================================

DEFINE TABLE IF NOT EXISTS activity_template AS
  SELECT
    id,
    id AS variant_id,
    id AS activity_id,
    name AS variant_name,
    description,
    category,
    tags,
    tag_prefixes,
    task_steps,
    scope,
    org_id,
    project_id,
    genealogy,
    created_at,
    updated_at
  FROM activity_registry
  WHERE execution_format = 'template'
  PERMISSIONS NONE;
