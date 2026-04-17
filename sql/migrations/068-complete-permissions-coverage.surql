-- =============================================================================
-- Migration 068: Complete PERMISSIONS Coverage for Multi-Tenant Tables
-- =============================================================================
-- Date: 2026-04-17
--
-- Purpose: Ensure all tables with org_id have proper PERMISSIONS clauses
-- for multi-tenant isolation using DEFINE TABLE OVERWRITE.
--
-- Background: Some tables were originally defined without PERMISSIONS in
-- earlier migrations (002-011) and may still exist without proper RBAC.
-- This migration applies consistent PERMISSIONS to all affected tables.
--
-- Standard PERMISSIONS pattern:
--   FOR select WHERE org_id = $auth.org_id
--   FOR create WHERE $auth.org_id != NONE
--   FOR update WHERE org_id = $auth.org_id
--   FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin'
--
-- Tables updated (14 total):
--   1. impulse_relevance_metrics (002-learning-system-phase1.surql)
--   2. activity_execution_traces (011-executions.surql)
--   3. execution_traces (004-execution-traces.surql) - adds org_id field
--   4. goal_execution_paths (003-goal-execution-paths.surql)
--   5. composition_node (046-composition-graph.surql)
--   6. composition_chain (046-composition-graph.surql)
--   7. composition_impulse_flow (048-goal-execution-alignment.surql)
--   8. resolver (028-resolver-architecture.surql)
--   9. impulse_state_pattern (028-resolver-architecture.surql)
--  10. state_transition (028-resolver-architecture.surql)
--  11. tool_argument_pattern (029-tool-argument-patterns.surql)
--  12. llm_resolution_log (017-llm-resolution.surql)
--  13. pattern (018-patterns.surql)
--  14. composite_sequence_patterns (014-ribosome-sequences.surql)
-- =============================================================================

-- =============================================================================
-- 1. impulse_relevance_metrics
-- =============================================================================
-- Original: 002-learning-system-phase1.surql (no PERMISSIONS)
-- =============================================================================

DEFINE TABLE impulse_relevance_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 2. activity_execution_traces
-- =============================================================================
-- Original: 011-executions.surql - may have been created without PERMISSIONS
-- Note: Includes project_id filtering for more granular access control
-- =============================================================================

DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 3. execution_traces
-- =============================================================================
-- Original: 004-execution-traces.surql (no org_id field, no PERMISSIONS)
-- Note: This is a legacy table. Adding org_id field and PERMISSIONS.
-- Existing records will have NULL org_id and may need manual migration.
-- =============================================================================

-- Add org_id field to execution_traces if it doesn't exist
DEFINE FIELD IF NOT EXISTS org_id ON execution_traces TYPE option<string>
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel). Added in migration 068.";

-- Add PERMISSIONS to execution_traces
DEFINE TABLE execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    -- SELECT: Allow access if org_id matches OR org_id is NULL (legacy records)
    FOR select WHERE org_id = $auth.org_id OR org_id IS NONE
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id OR org_id IS NONE
    FOR delete WHERE (org_id = $auth.org_id OR org_id IS NONE) AND $auth.role = 'admin';

-- =============================================================================
-- 4. goal_execution_paths
-- =============================================================================
-- Original: 003-goal-execution-paths.surql (no PERMISSIONS)
-- Note: Includes project_id filtering for more granular access control
-- =============================================================================

DEFINE TABLE goal_execution_paths OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 5. composition_node
-- =============================================================================
-- Original: 046-composition-graph.surql
-- Note: Includes public visibility option for cross-org sharing
-- =============================================================================

DEFINE TABLE composition_node OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id OR public = true
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 6. composition_chain
-- =============================================================================
-- Original: 046-composition-graph.surql
-- =============================================================================

DEFINE TABLE composition_chain OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 7. composition_impulse_flow
-- =============================================================================
-- Original: 048-goal-execution-alignment.surql
-- =============================================================================

DEFINE TABLE composition_impulse_flow OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 8. resolver
-- =============================================================================
-- Original: 028-resolver-architecture.surql
-- Note: Public discovery allowed (SELECT WHERE true for discovery purposes)
-- Global resolvers (org_id = NULL) are visible to all
-- =============================================================================

DEFINE TABLE resolver OVERWRITE SCHEMAFULL
  PERMISSIONS
    -- SELECT: Public discovery (all resolvers visible for discovery)
    FOR select WHERE true
    -- CREATE/UPDATE: Authenticated users can create/update
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id IS NONE OR org_id = $auth.org_id
    -- DELETE: Only admins can delete org-scoped resolvers
    FOR delete WHERE (org_id IS NONE AND $auth.role = 'admin') OR (org_id = $auth.org_id AND $auth.role = 'admin');

-- =============================================================================
-- 9. impulse_state_pattern
-- =============================================================================
-- Original: 028-resolver-architecture.surql
-- Note: Includes scope-based visibility (global patterns visible to all)
-- =============================================================================

DEFINE TABLE impulse_state_pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id OR scope = 'global'
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 10. state_transition
-- =============================================================================
-- Original: 028-resolver-architecture.surql
-- =============================================================================

DEFINE TABLE state_transition OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id AND $auth.role = 'admin'
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 11. tool_argument_pattern
-- =============================================================================
-- Original: 029-tool-argument-patterns.surql
-- =============================================================================

DEFINE TABLE tool_argument_pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 12. llm_resolution_log
-- =============================================================================
-- Original: 017-llm-resolution.surql
-- Note: Includes created_by check for update permissions
-- =============================================================================

DEFINE TABLE llm_resolution_log OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND (created_by = $auth.id OR $auth.role = 'admin')
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 13. pattern
-- =============================================================================
-- Original: 018-patterns.surql
-- Note: Includes public visibility option and created_by check for updates
-- =============================================================================

DEFINE TABLE pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id OR public = true
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE
      org_id = $auth.org_id
      AND (created_by = $auth.id OR $auth.role = 'admin')
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- 14. composite_sequence_patterns
-- =============================================================================
-- Original: 014-ribosome-sequences.surql
-- =============================================================================

DEFINE TABLE composite_sequence_patterns OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- =============================================================================
-- Verification Queries
-- =============================================================================
-- Run these queries to verify PERMISSIONS are active:
--
-- INFO FOR TABLE impulse_relevance_metrics;
-- INFO FOR TABLE activity_execution_traces;
-- INFO FOR TABLE execution_traces;
-- INFO FOR TABLE goal_execution_paths;
-- INFO FOR TABLE composition_node;
-- INFO FOR TABLE composition_chain;
-- INFO FOR TABLE composition_impulse_flow;
-- INFO FOR TABLE resolver;
-- INFO FOR TABLE impulse_state_pattern;
-- INFO FOR TABLE state_transition;
-- INFO FOR TABLE tool_argument_pattern;
-- INFO FOR TABLE llm_resolution_log;
-- INFO FOR TABLE pattern;
-- INFO FOR TABLE composite_sequence_patterns;
--
-- Expected: Each table should show PERMISSIONS in the output.
-- =============================================================================
