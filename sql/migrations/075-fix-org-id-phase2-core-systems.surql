-- =============================================================================
-- Migration 075: Phase 2 - Fix org_id Type Mismatch in Core System Tables
-- =============================================================================
-- SCOPE: Tool system, impulse metrics, goal execution
-- DEPENDS ON: Migration 074 (Phase 1 - Critical tables)
--
-- This migration fixes remaining core system tables that need type casting
-- for org_id PERMISSIONS clauses. These tables are used for:
-- - Tool learning and argument patterns
-- - Impulse relevance tracking
-- - Impulse resolution metrics
-- - Goal execution alignment
--
-- Date: 2026-04-21 (to be applied after 074 is verified)
-- Version: 1.3.2
-- =============================================================================

-- =============================================================================
-- TOOL SYSTEM TABLES
-- =============================================================================

-- 1. TOOL_USAGE - Tool invocation patterns
DEFINE TABLE tool_usage OVERWRITE SCHEMAFULL
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

-- 2. TOOL_ARGUMENT_PATTERN - Tool argument learning
DEFINE TABLE tool_argument_pattern OVERWRITE SCHEMAFULL
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

-- 3. TOOL_EXECUTION_STATS - Tool performance statistics
DEFINE TABLE tool_execution_stats OVERWRITE SCHEMAFULL
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
      );

-- =============================================================================
-- IMPULSE SYSTEM TABLES
-- =============================================================================

-- 4. IMPULSE_RELEVANCE_METRICS - Impulse relevance scoring
DEFINE TABLE impulse_relevance_metrics OVERWRITE SCHEMAFULL
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

-- 5. IMPULSE_RESOLUTION_METRICS - Resolver performance tracking
DEFINE TABLE impulse_resolution_metrics OVERWRITE SCHEMAFULL
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
      );

-- 6. IMPULSE_SHAPE_STATISTICS - Shape-based scoring
DEFINE TABLE impulse_shape_statistics OVERWRITE SCHEMAFULL
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
-- GOAL EXECUTION ALIGNMENT
-- =============================================================================

-- 7. GOAL_EXECUTION_ALIGNMENT - Goal to execution alignment tracking
DEFINE TABLE goal_execution_alignment OVERWRITE SCHEMAFULL
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
-- MIGRATION NOTES
-- =============================================================================
--
-- TESTING REQUIRED:
-- 1. Tool usage queries: GET /v2/activities/tool-usage
-- 2. Tool argument patterns: Pattern learning endpoints
-- 3. Impulse relevance: Relevance scoring queries
-- 4. Impulse resolution: Resolver metrics endpoints
-- 5. Goal alignment: Goal execution alignment queries
--
-- BACKWARD COMPATIBILITY:
-- - All type casting is additive (doesn't break existing queries)
-- - Maintains multi-tenant isolation
-- - Preserves existing security model
--
-- FOLLOW-UP:
-- - Migration 076: Fix learning system tables (resolvers, patterns, views)
-- =============================================================================
