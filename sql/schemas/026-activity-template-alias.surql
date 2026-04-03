-- =============================================================================
-- Create activity_template alias for backward compatibility
-- =============================================================================
-- Problem: Application code queries 'activity_template' but the canonical
--          table is 'activity' (in 020-paradigm-core-tables.surql).
--          This view provides backward compatibility for legacy queries.
--
-- Solution: Create activity_template as a view mapping activity table fields.
--           This maintains backward compatibility while the codebase is
--           gradually migrated to query the 'activity' table directly.
--
-- Migration Path:
--   1. Apply this migration (creates activity_template view)
--   2. Gradually update code to query 'activity' table directly
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
    -- Map new field names to old names for backward compatibility
    tasks AS task_steps,
    scope,
    org_id,
    project_id,
    variant_of AS genealogy,
    created_at,
    updated_at
  FROM activity
  WHERE execution_type = 'template'
  PERMISSIONS NONE;
