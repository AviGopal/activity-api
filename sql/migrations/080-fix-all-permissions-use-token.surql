-- =============================================================================
-- Migration 080: Fix ALL Table PERMISSIONS to use $token Instead of $auth
-- =============================================================================
-- Date: 2026-04-22
--
-- Problem: ALL multi-tenant tables use $auth.org_id in PERMISSIONS clauses,
-- but $auth is not populated for TYPE JWT access methods. This causes
-- "The access method cannot be used in the requested operation" errors.
--
-- Root Cause:
-- - Our apikey_token ACCESS is TYPE JWT (not TYPE RECORD)
-- - $auth requires 'id' claim to point to a valid SurrealDB record
-- - Our JWT has id: "api_key:${keyId}" which is NOT a record
-- - Therefore $auth is undefined and $auth.org_id evaluates to NONE
--
-- Solution: Replace ALL occurrences of $auth with $token in PERMISSIONS
--
-- Affected Tables (from migration 068 + schema files):
-- 1. activity_execution_traces (fixed in 079)
-- 2. activity_composition_graph
-- 3. impulse_relevance_metrics
-- 4. tool_usage
-- 5. thompson_selection_log
-- 6. execution_traces (legacy)
-- 7. goal_execution_paths
-- 8. composition_node
-- 9. composition_chain
-- 10. composition_impulse_flow
-- 11. resolver
-- 12. impulse_state_pattern
-- 13. state_transition
-- 14. tool_argument_pattern
-- 15. llm_resolution_log
-- 16. pattern
-- 17. composite_sequence_patterns
--
-- References:
-- - https://surrealdb.com/docs/surrealql/statements/define/access/jwt
-- - https://github.com/surrealdb/surrealdb/issues/4229
-- =============================================================================

-- =============================================================================
-- 2. activity_composition_graph
-- =============================================================================

DEFINE TABLE activity_composition_graph OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 3. impulse_relevance_metrics
-- =============================================================================

DEFINE TABLE impulse_relevance_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 4. tool_usage
-- =============================================================================

DEFINE TABLE tool_usage OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 5. thompson_selection_log
-- =============================================================================

DEFINE TABLE thompson_selection_log OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id AND $token.role = 'admin'
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 6. execution_traces (legacy table)
-- =============================================================================

DEFINE TABLE execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    -- SELECT: Allow access if org_id matches OR org_id is NULL (legacy records)
    FOR select WHERE org_id = $token.org_id OR org_id IS NONE
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id OR org_id IS NONE
    FOR delete WHERE (org_id = $token.org_id OR org_id IS NONE) AND $token.role = 'admin';

-- =============================================================================
-- 7. goal_execution_paths
-- =============================================================================

DEFINE TABLE goal_execution_paths OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $token.org_id
      AND (project_id IS NONE OR project_id IN $token.project_ids)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 8. composition_node
-- =============================================================================

DEFINE TABLE composition_node OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id OR public = true
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 9. composition_chain
-- =============================================================================

DEFINE TABLE composition_chain OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 10. composition_impulse_flow
-- =============================================================================

DEFINE TABLE composition_impulse_flow OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 11. resolver
-- =============================================================================

DEFINE TABLE resolver OVERWRITE SCHEMAFULL
  PERMISSIONS
    -- SELECT: Public discovery (all resolvers visible for discovery)
    FOR select WHERE true
    -- CREATE/UPDATE: Authenticated users can create/update
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id IS NONE OR org_id = $token.org_id
    -- DELETE: Only admins can delete org-scoped resolvers
    FOR delete WHERE (org_id IS NONE AND $token.role = 'admin') OR (org_id = $token.org_id AND $token.role = 'admin');

-- =============================================================================
-- 12. impulse_state_pattern
-- =============================================================================

DEFINE TABLE impulse_state_pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id OR scope = 'global'
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 13. state_transition
-- =============================================================================

DEFINE TABLE state_transition OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id AND $token.role = 'admin'
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 14. tool_argument_pattern
-- =============================================================================

DEFINE TABLE tool_argument_pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 15. llm_resolution_log
-- =============================================================================

DEFINE TABLE llm_resolution_log OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE
      org_id = $token.org_id
      AND (created_by = $token.id OR $token.role = 'admin')
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 16. pattern
-- =============================================================================

DEFINE TABLE pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id OR public = true
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE
      org_id = $token.org_id
      AND (created_by = $token.id OR $token.role = 'admin')
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- 17. composite_sequence_patterns
-- =============================================================================

DEFINE TABLE composite_sequence_patterns OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE org_id = $token.org_id
    FOR delete WHERE org_id = $token.org_id AND $token.role = 'admin';

-- =============================================================================
-- Verification Query
-- =============================================================================
-- Run these after migration to verify PERMISSIONS were updated:
--
-- INFO FOR TABLE activity_composition_graph;
-- INFO FOR TABLE impulse_relevance_metrics;
-- INFO FOR TABLE tool_usage;
-- INFO FOR TABLE thompson_selection_log;
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
-- Expected: All should show PERMISSIONS with $token.org_id (not $auth.org_id)
-- =============================================================================
