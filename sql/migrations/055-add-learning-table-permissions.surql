-- Migration 055: Add PERMISSIONS to Learning Tables
-- Date: 2026-04-10
-- Purpose: Fix multi-tenant isolation for learning system tables
--
-- CRITICAL: These tables have org_id fields but no PERMISSIONS clauses,
-- causing data to be stored but invisible when querying. This blocks
-- all teaching loop functionality.

-- ============================================================================
-- activity_composition_graph: Tracks which activities are executed together
-- ============================================================================

DEFINE TABLE activity_composition_graph SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- ============================================================================
-- activity_tool_usage: Tracks tool call patterns per activity
-- ============================================================================

DEFINE TABLE activity_tool_usage SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- ============================================================================
-- activity_impulse_relevance: Tracks which impulses are useful per activity
-- ============================================================================

DEFINE TABLE activity_impulse_relevance SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- ============================================================================
-- activity_execution_sequence: Records sequences of activities in sessions
-- ============================================================================

DEFINE TABLE activity_execution_sequence SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE
      org_id = $auth.org_id
      AND $auth.role = 'admin';

-- ============================================================================
-- Verification: Query to confirm PERMISSIONS are active
-- ============================================================================

-- Expected: This query should now return data filtered by org_id
-- SELECT count() FROM activity_composition_graph GROUP BY org_id;
-- SELECT count() FROM activity_tool_usage GROUP BY org_id;
-- SELECT count() FROM activity_impulse_relevance GROUP BY org_id;
-- SELECT count() FROM activity_execution_sequence GROUP BY org_id;
