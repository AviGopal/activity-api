-- Migration 074: Fix activity table PERMISSIONS for API key authentication
--
-- ISSUE: Templates endpoint returns 500 error with API keys
-- CAUSE: org_id type mismatch between JWT claims and database fields
--   - JWT claims: org_id = 'organizations:<orgId>' (record ID format)
--   - Database: org_id stored as record reference
--   - SurrealDB 3.0 strict type matching in PERMISSIONS
--
-- SOLUTION: Add explicit type casting to handle both formats
--
-- Date: 2026-04-21
-- Version: 1.3.1

-- Update activity table (paradigm schema) PERMISSIONS
DEFINE TABLE activity OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (scope = 'global' AND public = true)
      OR (
        -- Handle multiple type combinations for org_id matching
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      OR (scope = 'project' AND project_id IN $auth.project_ids)
    FOR create WHERE
      $auth != NONE  -- Allow any authenticated user (including root)
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- Note: This PERMISSIONS update is backward compatible
-- - Works with API key authentication (JWT with org_id as record ID)
-- - Works with JWT authentication (org_id in various formats)
-- - Maintains multi-tenant isolation
-- - Preserves existing security model
