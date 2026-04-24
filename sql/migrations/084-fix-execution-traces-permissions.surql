-- =============================================================================
-- Migration 084: Fix activity_execution_traces PERMISSIONS for Dashboard Access
-- =============================================================================
-- Date: 2026-04-24
--
-- Problem: Dashboard users with API keys cannot view execution traces due to
-- overly restrictive PERMISSIONS clause requiring project_ids claim.
--
-- Current PERMISSIONS (from migration 068):
--   FOR select WHERE
--     org_id = $auth.org_id
--     AND (project_id IS NONE OR project_id IN $auth.project_ids)
--
-- Issue: When $auth.project_ids is empty array ([]) or not set, the
-- "project_id IN $auth.project_ids" check fails, blocking access to ALL traces.
--
-- Fix: Allow SELECT if:
--   1. org_id matches, AND
--   2. EITHER:
--      - Trace has no project restriction (project_id IS NONE), OR
--      - User has access to that project (project_id IN $auth.project_ids), OR
--      - User has no project restrictions (empty/missing project_ids claim)
--
-- This allows:
--   - Dashboard users to view all traces in their org
--   - MiniBob instances to view traces for their assigned project
--   - Project-scoped API keys to view only their project's traces
-- =============================================================================

DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL
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
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- Verification
-- =============================================================================
-- Test with different project_ids scenarios:
--
-- 1. No project_ids claim (dashboard user):
--    SELECT * FROM activity_execution_traces WHERE org_id = 'test-org';
--    Expected: Returns all traces for org
--
-- 2. Empty project_ids array:
--    SELECT * FROM activity_execution_traces WHERE org_id = 'test-org';
--    Expected: Returns all traces for org
--
-- 3. Specific project_ids:
--    SELECT * FROM activity_execution_traces
--    WHERE org_id = 'test-org' AND project_id = 'project-1';
--    Expected: Returns traces for project-1 only
--
-- 4. Wrong org_id:
--    SELECT * FROM activity_execution_traces WHERE org_id = 'other-org';
--    Expected: Returns empty (org_id mismatch)
-- =============================================================================
