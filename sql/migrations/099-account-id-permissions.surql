-- =============================================================================
-- Migration 099: Phase C — account_id-aware PERMISSIONS dual-scope
-- =============================================================================
-- Created: 2026-04-28
-- Related OpenSpec: activity-api-account-id-migration-2026-04-28
-- Depends on: 095 (Phase A schema, 32 tables), 097 (Phase A2, +7 tables),
--             080 (canonical $token PERMISSIONS), 084/085 (project_ids escape),
--             087 (admin guard on global activity scope), 074 (type-cast variants).
--
-- PURPOSE
--   Phases A/A2 added the additive `account_id option<string>` field on 39
--   multi-tenant tables. Phase B handlers now dual-write account_id alongside
--   org_id. Phase C teaches SurrealDB PERMISSIONS to honour the new field so
--   account-scoped reads enforce isolation at the DB layer.
--
-- DUAL-SCOPE CONTRACT (every PERMISSIONS clause)
--   account_id takes precedence when present; org_id is the fallback when the
--   row's account_id is unset (legacy + Phase B partial backfill). Concretely
--   each `org_id = $auth.org_id` becomes:
--     (
--       ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
--       OR (account_id IS NONE AND org_id = $auth.org_id)
--     )
--   and similarly for $token.* (API-key auth path). All other conditions
--   (project_id filters, public escapes, scope flags, role checks, IS NONE
--   legacy escapes, type-cast variants from 074) are preserved exactly.
--
-- IDEMPOTENCY
--   Uses DEFINE TABLE <name> OVERWRITE — same pattern as 074, 080, 083, 084,
--   085, 087. SurrealDB preserves FIELD/INDEX/EVENT definitions when only
--   PERMISSIONS are redefined; FLEXIBLE field declarations from 093 are not
--   affected.
--
-- TABLES MIGRATED (41) — see test file for the full enumeration & invariants.
-- TABLES SKIPPED (7):
--   impulse_data              — no DEFINE TABLE (deprecated; only views)
--   activity_registry         — no DEFINE TABLE in any sql/*.surql
--   activity_state_affinity   — field-level perms on org_id only (mig 065)
--   discovered_state_pattern  — field-level perms on org_id only (mig 065)
--   execution_state_snapshot  — field-level perms on org_id only (mig 065)
--   state_feature_importance  — field-level perms on org_id only (mig 065)
--   tool_usage_patterns       — no PERMISSIONS at all (sql/002, predates RBAC)
-- Adding table-level PERMISSIONS to those 7 is a separate scoping decision
-- and out of scope for the additive C phase (per the proposal).
-- =============================================================================

-- Paradigm core ---------------------------------------------------------------

-- activity (087: admin guard on scope=global; mixed $token/$auth)
DEFINE TABLE activity OVERWRITE
  PERMISSIONS
    FOR select WHERE scope = 'global' OR org_id IS NONE
      OR ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND (org_id = $token.org_id OR org_id = <string>$token.org_id))
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND (org_id = $token.org_id OR org_id = <string>$token.org_id)))
      OR (scope = 'global' AND $auth.role = 'admin')
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND (org_id = $token.org_id OR org_id = <string>$token.org_id)))
      OR (scope = 'global' AND $auth.role = 'admin');

-- execution (074: $auth + project_ids + 4-cast)
DEFINE TABLE execution OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
          OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id)))
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
          OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id)))
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
          OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id)))
      AND $auth.role = 'admin';

-- impulse (083: $token + project_id)
DEFINE TABLE impulse OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND (project_id IS NONE OR project_id IN $token.project_ids)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND ($token.role = 'admin' OR created_by = $token.id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND ($token.role = 'admin' OR created_by = $token.id);

-- vessel (027: $auth, simple)
DEFINE TABLE vessel OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create, update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

-- Activity bookkeeping --------------------------------------------------------

-- activity_composition_graph (080: $token, admin delete)
DEFINE TABLE activity_composition_graph OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- activity_dataflows (012: $auth + project_id)
DEFINE TABLE activity_dataflows OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- activity_execution_traces (084: project_ids escape)
DEFINE TABLE activity_execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND (project_id IS NONE OR project_id IN $auth.project_ids
        OR $auth.project_ids IS NONE OR array::len($auth.project_ids) = 0)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- activity_prerequisites (012)
DEFINE TABLE activity_prerequisites OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- Execution patterns / state --------------------------------------------------

DEFINE TABLE circuit_breaker_trace OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

-- code_variants (013: project_id)
DEFINE TABLE code_variants OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

DEFINE TABLE composite_sequence_patterns OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

DEFINE TABLE composition_chain OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- composition_edge (074: 4-cast + public escape)
DEFINE TABLE composition_edge OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
          OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id)))
      OR public = true
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id))
    FOR delete WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id));

-- composition_node (080: $token + public escape)
DEFINE TABLE composition_node OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      OR public = true
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- context_thompson_scores (088: IS NOT NONE create-guard, no delete)
DEFINE TABLE context_thompson_scores OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create, update WHERE $token.org_id IS NOT NONE
    FOR delete NONE;

DEFINE TABLE execution_pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- execution_sequences (012: project_id)
DEFINE TABLE execution_sequences OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- execution_traces (legacy, 080: org_id IS NONE escape)
DEFINE TABLE execution_traces OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND (org_id = $token.org_id OR org_id IS NONE))
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND (org_id = $token.org_id OR org_id IS NONE))
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND (org_id = $token.org_id OR org_id IS NONE)))
      AND $token.role = 'admin';

DEFINE TABLE external_validation_history OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create, update, delete WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

-- state_transition (080: $token, admin update+delete)
DEFINE TABLE state_transition OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin'
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- thompson_selection_log (080: $token, admin update+delete)
DEFINE TABLE thompson_selection_log OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin'
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- Goal/path -------------------------------------------------------------------

-- goal_execution_paths (085: project_ids escape)
DEFINE TABLE goal_execution_paths OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND (project_id IS NONE OR project_id IN $auth.project_ids
        OR $auth.project_ids IS NONE OR array::len($auth.project_ids) = 0)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- Impulse bookkeeping ---------------------------------------------------------

DEFINE TABLE impulse_budget_log OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

DEFINE TABLE impulse_relevance_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- impulse_resolution_metrics (008: 2-action only, no delete)
DEFINE TABLE impulse_resolution_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create, update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

DEFINE TABLE impulse_shape_activity_score OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- impulse_state_pattern (080: $token + scope=global escape)
DEFINE TABLE impulse_state_pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      OR scope = 'global'
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- impulse_usage_history (013: project_id)
DEFINE TABLE impulse_usage_history OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- llm_resolution_log (080: $token + created_by guard)
DEFINE TABLE llm_resolution_log OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND (created_by = $token.id OR $token.role = 'admin')
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- Patterns --------------------------------------------------------------------

-- pattern (080: $token + public escape + created_by guard)
DEFINE TABLE pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      OR public = true
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND (created_by = $token.id OR $token.role = 'admin')
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

DEFINE TABLE prerequisite_patterns OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- relevance_feedback (090: SCHEMALESS, $token, IS NOT NONE create-guard)
DEFINE TABLE relevance_feedback OVERWRITE SCHEMALESS
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id IS NOT NONE
    FOR update, delete NONE;

DEFINE TABLE routing_trace OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

-- shape_definition (056: public + IS NONE escape + JWT-record string-strip)
DEFINE TABLE shape_definition OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE public = true OR org_id IS NONE
      OR ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND (org_id = $auth.org_id
        OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')))
    FOR create WHERE $auth != NONE
    FOR update WHERE org_id IS NONE
      OR ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND (org_id = $auth.org_id
        OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')))
    FOR delete WHERE org_id IS NONE
      OR ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

DEFINE TABLE tool_argument_pattern OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

DEFINE TABLE tool_usage OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR create WHERE $token.org_id != NONE
    FOR update WHERE ($token.account_id IS NOT NONE AND account_id = $token.account_id)
      OR (account_id IS NONE AND org_id = $token.org_id)
    FOR delete WHERE (($token.account_id IS NOT NONE AND account_id = $token.account_id)
        OR (account_id IS NONE AND org_id = $token.org_id))
      AND $token.role = 'admin';

-- variant_performance_metrics (074: 4-cast + IS NONE escape, no auth-id required)
DEFINE TABLE variant_performance_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id IS NONE
      OR ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id))
    FOR create WHERE $auth != NONE
    FOR update WHERE org_id IS NONE
      OR ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id))
    FOR delete WHERE org_id IS NONE
      OR ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND (org_id = $auth.org_id OR org_id = <string>$auth.org_id
        OR <string>org_id = $auth.org_id OR <string>org_id = <string>$auth.org_id));

-- Vessel health (schemas/030) -------------------------------------------------

DEFINE TABLE vessel_circuit_breaker OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create, update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

DEFINE TABLE vessel_health_metrics OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR create, update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id);

-- CI integration --------------------------------------------------------------

DEFINE TABLE ci_runs OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE ($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
      OR (account_id IS NONE AND org_id = $auth.org_id)
    FOR delete WHERE (($auth.account_id IS NOT NONE AND account_id = $auth.account_id)
        OR (account_id IS NONE AND org_id = $auth.org_id))
      AND $auth.role = 'admin';

-- Deprecated (admin-only read; included so future read paths can dual-check)
DEFINE TABLE minibob_instance OVERWRITE SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $auth.role = 'admin'
    FOR create, update, delete NONE;

-- =============================================================================
-- End of migration 099. Total: 41 tables migrated; 7 skipped (see header).
-- Phase D will remove the org_id fallback once Phase F backfill completes.
-- =============================================================================
