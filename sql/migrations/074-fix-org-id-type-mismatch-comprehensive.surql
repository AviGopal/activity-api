-- =============================================================================
-- Migration 074: Comprehensive org_id Type Mismatch Fix
-- =============================================================================
-- ISSUE: Templates endpoint and other endpoints return 500 errors with API keys
-- CAUSE: org_id type mismatch in PERMISSIONS clauses
--   - JWT claims: org_id = 'organizations:<orgId>' (string in record format)
--   - Database: org_id stored as string or record<organizations>
--   - SurrealDB 3.0 strict type matching fails without explicit casts
--
-- SOLUTION: Add explicit type casting to handle all combinations:
--   1. org_id = $auth.org_id          (both as-is)
--   2. org_id = <string>$auth.org_id  (cast $auth to string)
--   3. <string>org_id = $auth.org_id  (cast org_id to string)
--   4. <string>org_id = <string>$auth.org_id  (cast both to string)
--
-- SCOPE: Fixes all critical tables in Phase 1:
--   - Core activity system (activity, activity_template, metrics)
--   - Execution system (traces, execution table)
--   - Composition system (graph, edges, dataflow)
--   - Goal execution paths
--
-- Date: 2026-04-21
-- Version: 1.3.1
-- Author: DevBob investigation team
-- =============================================================================

-- =============================================================================
-- 1. ACTIVITY (Paradigm Schema) - Primary template table
-- =============================================================================
-- Impact: Template selection, Thompson Sampling, all activity queries
-- Fixes: Templates endpoint 500 error
-- =============================================================================

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
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND $auth.role = 'admin';

-- =============================================================================
-- 2. ACTIVITY_TEMPLATE (Legacy Schema) - Backward compatibility
-- =============================================================================
-- Impact: Templates endpoint, ribosome, goal processor
-- Fixes: GET /v2/activities/templates with API key auth
-- =============================================================================

DEFINE TABLE activity_template OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      scope = 'global'
      OR org_id IS NONE
      OR (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR create WHERE $auth != NONE
    FOR update WHERE
      org_id IS NONE
      OR (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      org_id IS NONE
      OR (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      );

-- =============================================================================
-- 3. VARIANT_PERFORMANCE_METRICS - Thompson Sampling data
-- =============================================================================
-- Impact: Thompson Sampling alpha/beta updates
-- Fixes: Template metric updates failing
-- =============================================================================

DEFINE TABLE variant_performance_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id IS NONE
      OR (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR create WHERE $auth != NONE
    FOR update WHERE
      org_id IS NONE
      OR (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      org_id IS NONE
      OR (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      );

-- =============================================================================
-- 4. ACTIVITY_EXECUTION_TRACES (Legacy Execution Tracking)
-- =============================================================================
-- Impact: Execution filtering, trace retrieval
-- Fixes: POST /v2/activities/execution-traces
-- =============================================================================

DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND $auth.role = 'admin';

-- =============================================================================
-- 5. EXECUTION (Paradigm Schema) - New execution tracking
-- =============================================================================
-- Impact: New paradigm execution tracking
-- Fixes: Execution storage in paradigm schema
-- =============================================================================

DEFINE TABLE execution OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND $auth.role = 'admin';

-- =============================================================================
-- 6. ACTIVITY_COMPOSITION_GRAPH - Parent/child relationships
-- =============================================================================
-- Impact: Composition tracking, parent/child NULL bug
-- Fixes: GET /v2/activities/composition/graph
-- =============================================================================

DEFINE TABLE activity_composition_graph OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      OR public = true
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      );

-- =============================================================================
-- 7. COMPOSITION_EDGE - Activity dependencies
-- =============================================================================
-- Impact: Activity ordering and dependencies
-- Fixes: Composition edge queries
-- =============================================================================

DEFINE TABLE composition_edge OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      OR public = true
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      );

-- =============================================================================
-- 8. DATAFLOW_CONNECTION - Impulse flow tracking
-- =============================================================================
-- Impact: Impulse dataflow between activities
-- Fixes: Dataflow queries
-- =============================================================================

DEFINE TABLE dataflow_connection OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND $auth.role = 'admin';

-- =============================================================================
-- 9. PREREQUISITE - Activity ordering
-- =============================================================================
-- Impact: Activity prerequisite tracking
-- Fixes: Prerequisite queries
-- =============================================================================

DEFINE TABLE prerequisite OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND $auth.role = 'admin';

-- =============================================================================
-- 10. COMPOSITION_INSTANCE - Composition execution instances
-- =============================================================================
-- Impact: Composition instance tracking
-- Fixes: Composition instance queries
-- =============================================================================

DEFINE TABLE composition_instance OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND $auth.role = 'admin';

-- =============================================================================
-- 11. GOAL_EXECUTION_PATHS - Multi-activity path recommendations
-- =============================================================================
-- Impact: Goal to activity path mapping
-- Fixes: Goal path queries for Thompson Sampling
-- =============================================================================

DEFINE TABLE goal_execution_paths OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND $auth.role = 'admin';

-- =============================================================================
-- 12. IMPULSE (Paradigm Schema) - All impulse data
-- =============================================================================
-- Impact: All impulse queries and resolution
-- Fixes: Impulse filtering by org_id
-- =============================================================================

DEFINE TABLE impulse OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      (
        org_id = $auth.org_id
        OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id
        OR <string>org_id = <string>$auth.org_id
      )
      AND ($auth.role = 'admin' OR created_by = $auth.id);

-- =============================================================================
-- MIGRATION NOTES
-- =============================================================================
--
-- BACKWARD COMPATIBILITY:
-- - All type casting is additive (doesn't break existing queries)
-- - Works with API key authentication (JWT with org_id as string)
-- - Works with JWT authentication (org_id in various formats)
-- - Maintains multi-tenant isolation
-- - Preserves existing security model
--
-- TESTING REQUIRED:
-- 1. Templates endpoint: GET /v2/activities/templates
-- 2. Composition graph: GET /v2/activities/composition/graph?limit=10
-- 3. Execution traces: POST /v2/activities/execution-traces
-- 4. Thompson Sampling: POST /v2/activities/recommend
-- 5. Multi-tenant isolation: Verify org_id filtering works
--
-- ROLLBACK:
-- If issues occur, revert to migration 073 and use previous schema
--
-- FOLLOW-UP MIGRATIONS:
-- - Migration 075: Fix remaining core system tables (tool_usage, impulse_relevance_metrics, etc.)
-- - Migration 076: Fix learning system tables (resolvers, patterns, views)
-- =============================================================================
