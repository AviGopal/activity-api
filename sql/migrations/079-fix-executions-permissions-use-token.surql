-- =============================================================================
-- Migration 079: Fix activity_execution_traces PERMISSIONS to use $token
-- =============================================================================
-- Date: 2026-04-22
--
-- Problem: PERMISSIONS clauses use $auth.org_id which is not populated for
-- TYPE JWT access methods. The $auth variable requires an 'id' claim pointing
-- to a valid SurrealDB record.
--
-- Solution: Use $token.org_id instead, which accesses custom JWT claims directly.
--
-- Root Cause:
-- - Our apikey_token ACCESS is TYPE JWT (not TYPE RECORD)
-- - JWT tokens have id: "api_key:${keyId}" which is NOT a valid record ID
-- - $auth is undefined because the id claim doesn't point to a record
-- - $auth.org_id evaluates to NONE, causing permission check to fail
-- - Error: "The access method cannot be used in the requested operation"
--
-- References:
-- - https://surrealdb.com/docs/surrealql/statements/define/access/jwt
-- - https://github.com/surrealdb/surrealdb/issues/4229
-- - https://surrealdb.com/docs/surrealql/parameters
--
-- Testing:
-- - Local: curl http://activity.metabob.local/v2/activities/executions -H "Authorization: ApiKey <key>"
-- - Canary: curl https://activity.metabob.com/v2/activities/executions -H "Authorization: ApiKey <key>"
-- =============================================================================

DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see executions in their org and assigned projects
    -- Changed $auth.org_id -> $token.org_id (fix for TYPE JWT access)
    FOR select WHERE
      org_id = $token.org_id
      AND (project_id IS NONE OR project_id IN $token.project_ids)

    -- CREATE: Any authenticated user can create execution traces
    --   org_id and project_id are auto-assigned from $token
    FOR create WHERE $token.org_id != NONE

    -- UPDATE: Users can update executions they created or admins in their org
    FOR update WHERE
      org_id = $token.org_id
      AND ($token.role = 'admin' OR created_by = $token.id)

    -- DELETE: Only admins can delete execution traces
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- Verification Query
-- =============================================================================
-- Run this after migration to verify PERMISSIONS were updated:
--
-- INFO FOR TABLE activity_execution_traces;
--
-- Expected output should show PERMISSIONS with $token.org_id (not $auth.org_id)
-- =============================================================================
