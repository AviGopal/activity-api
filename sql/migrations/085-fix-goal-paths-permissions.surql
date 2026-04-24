-- =============================================================================
-- Migration 085: Fix goal_execution_paths PERMISSIONS for Dashboard Access
-- =============================================================================
-- Date: 2026-04-24
--
-- Problem: Same as migration 084 - dashboard users cannot view goal execution
-- paths due to overly restrictive project_ids filtering.
--
-- Current PERMISSIONS (from migration 068):
--   FOR select WHERE
--     org_id = $auth.org_id
--     AND (project_id IS NONE OR project_id IN $auth.project_ids)
--
-- Fix: Apply same logic as migration 084 to allow dashboard access.
-- =============================================================================

DEFINE TABLE goal_execution_paths OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (
        project_id IS NONE
        OR project_id IN $auth.project_ids
        OR $auth.project_ids IS NONE
        OR array::len($auth.project_ids) = 0
      )
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';
