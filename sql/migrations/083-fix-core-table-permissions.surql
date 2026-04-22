-- =============================================================================
-- Migration 083: Fix PERMISSIONS on Core Tables (activity, activity_template, impulse)
-- =============================================================================
-- Date: 2026-04-22
--
-- Problem: Migration 080 fixed 17 tables but missed the 3 most critical tables:
-- - activity: Used by Thompson Sampling SELECT queries
-- - activity_template: Used by templates endpoint (GET /v2/activities/templates)
-- - impulse: Used by impulse resolution endpoints
--
-- All three still use $auth.org_id which fails for API key authentication.
--
-- Root Cause:
-- - Our apikey_token ACCESS is TYPE JWT (not TYPE RECORD)
-- - $auth requires 'id' claim to point to a valid SurrealDB record
-- - Our JWT has id: "api_key:${keyId}" which is NOT a record
-- - Therefore $auth is undefined and $auth.org_id evaluates to NONE
-- - This breaks Thompson Sampling, template queries, and impulse resolution
--
-- Solution: Replace $auth with $token in PERMISSIONS (same as Migration 080)
--
-- Related Migrations:
-- - Migration 079: Fixed activity_execution_traces
-- - Migration 080: Fixed 17 other tables
-- - Migration 082: Added deprecated field to activity table
--
-- References:
-- - https://surrealdb.com/docs/surrealql/statements/define/access/jwt
-- - https://github.com/surrealdb/surrealdb/issues/4229
-- =============================================================================

-- =============================================================================
-- 1. activity - Core activity/template table (new paradigm)
-- =============================================================================
-- Impact: Thompson Sampling queries, template selection, all activity operations
-- Fixes: Template recommendation failures with API key authentication
-- =============================================================================

DEFINE TABLE activity OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (scope = 'global' AND public = true)
      OR org_id = $token.org_id
      OR (scope = 'project' AND project_id IN $token.project_ids)
    FOR create WHERE
      $token.org_id != NONE
    FOR update WHERE
      org_id = $token.org_id
      AND ($token.role = 'admin' OR created_by = $token.id)
    FOR delete WHERE
      org_id = $token.org_id
      AND $token.role = 'admin';

-- =============================================================================
-- 2. activity_template - Legacy activity template table
-- =============================================================================
-- Impact: Templates endpoint (GET /v2/activities/templates), ribosome, goal processor
-- Fixes: Template listing and retrieval with API key authentication
-- =============================================================================

DEFINE TABLE activity_template OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      scope = 'global'
      OR org_id IS NONE
      OR org_id = $token.org_id
    FOR create WHERE
      $token.org_id != NONE
    FOR update WHERE
      org_id IS NONE
      OR org_id = $token.org_id
    FOR delete WHERE
      org_id IS NONE
      OR org_id = $token.org_id;

-- =============================================================================
-- 3. impulse - Universal data access table
-- =============================================================================
-- Impact: Impulse resolution (POST /v2/impulses/resolve), all impulse operations
-- Fixes: Impulse queries failing with API key authentication
-- =============================================================================

DEFINE TABLE impulse OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $token.org_id
      AND (project_id IS NONE OR project_id IN $token.project_ids)
    FOR create WHERE
      $token.org_id != NONE
    FOR update WHERE
      org_id = $token.org_id
      AND ($token.role = 'admin' OR created_by = $token.id)
    FOR delete WHERE
      org_id = $token.org_id
      AND ($token.role = 'admin' OR created_by = $token.id);

-- =============================================================================
-- Verification Queries
-- =============================================================================
-- Run these after migration to verify PERMISSIONS were updated:
--
-- INFO FOR TABLE activity;
-- INFO FOR TABLE activity_template;
-- INFO FOR TABLE impulse;
--
-- Expected: All should show PERMISSIONS with $token.org_id (not $auth.org_id)
--
-- Test with API key:
-- curl https://activity.metabob.com/v2/activities/templates \
--   -H "Authorization: ApiKey <your-api-key>"
--
-- curl https://activity.metabob.com/v2/impulses/resolve \
--   -H "Authorization: ApiKey <your-api-key>" \
--   -H "Content-Type: application/json" \
--   -d '{"impulses":[{"type":"activityTemplate","templateId":"test"}]}'
-- =============================================================================
