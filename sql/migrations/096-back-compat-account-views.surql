-- =============================================================================
-- Migration 096: Phase A — Back-compat account-scoped alias views
-- =============================================================================
-- Created: 2026-04-28
-- Related OpenSpec: activity-api-account-id-migration-2026-04-28
-- Depends on:        migration 095 (must run first — adds the account_id field)
--
-- PURPOSE
-- -------
-- Provide read-only view surfaces, one per migrated table, that expose every
-- row keyed by an *effective* account_id — populated either from the row's
-- own `account_id` (when Phase B+ wrote it) or derived from `org_id` (legacy
-- rows). This lets Phase B handlers query account-scoped without needing to
-- handle "row missing account_id" inline; the view materializes the fallback.
--
-- View naming: `v_<table>_by_account` — read-only, written by no Phase. Phase B
-- handlers may SELECT from it; INSERT/UPDATE/DELETE remain on the base table.
--
-- effective_account_id = account_id ?? org_id
--   * When Phase F backfill completes for a row, account_id IS NOT NONE and
--     account_id_version > 0 — view returns the canonical value.
--   * For legacy rows (account_id IS NONE, account_id_version = 0), the view
--     falls back to org_id so callers can still scope queries during the
--     transition window. Yes, this means a legacy row will appear "scoped"
--     to its org_id under the account_id key — that's the dual-write contract
--     until Phase F lands. Phase D drops the fallback (see Phase G of the spec).
--
-- IDEMPOTENCY
-- -----------
-- DEFINE TABLE OVERWRITE drops and re-creates each view atomically; safe to
-- re-run. Views never carry data — they always reflect the current rows of
-- the base table at SELECT time.
--
-- TABLES MIRRORED (matches migration 095, alphabetical)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Paradigm core
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_activity_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM activity;

DEFINE TABLE OVERWRITE v_execution_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM execution;

DEFINE TABLE OVERWRITE v_impulse_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse;

DEFINE TABLE OVERWRITE v_vessel_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM vessel;

-- -----------------------------------------------------------------------------
-- Activity bookkeeping
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_activity_composition_graph_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM activity_composition_graph;

DEFINE TABLE OVERWRITE v_activity_dataflows_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM activity_dataflows;

DEFINE TABLE OVERWRITE v_activity_execution_traces_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM activity_execution_traces;

DEFINE TABLE OVERWRITE v_activity_prerequisites_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM activity_prerequisites;

DEFINE TABLE OVERWRITE v_activity_registry_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM activity_registry;

DEFINE TABLE OVERWRITE v_activity_state_affinity_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM activity_state_affinity;

-- -----------------------------------------------------------------------------
-- Execution patterns / state
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_circuit_breaker_trace_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM circuit_breaker_trace;

DEFINE TABLE OVERWRITE v_code_variants_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM code_variants;

DEFINE TABLE OVERWRITE v_composite_sequence_patterns_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM composite_sequence_patterns;

DEFINE TABLE OVERWRITE v_composition_edge_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM composition_edge;

DEFINE TABLE OVERWRITE v_context_thompson_scores_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM context_thompson_scores;

DEFINE TABLE OVERWRITE v_discovered_state_pattern_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM discovered_state_pattern;

DEFINE TABLE OVERWRITE v_execution_pattern_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM execution_pattern;

DEFINE TABLE OVERWRITE v_execution_sequences_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM execution_sequences;

DEFINE TABLE OVERWRITE v_execution_state_snapshot_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM execution_state_snapshot;

DEFINE TABLE OVERWRITE v_execution_traces_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM execution_traces;

DEFINE TABLE OVERWRITE v_external_validation_history_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM external_validation_history;

DEFINE TABLE OVERWRITE v_state_feature_importance_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM state_feature_importance;

DEFINE TABLE OVERWRITE v_state_transition_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM state_transition;

DEFINE TABLE OVERWRITE v_thompson_selection_log_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM thompson_selection_log;

-- -----------------------------------------------------------------------------
-- Goal / path
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_goal_execution_paths_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM goal_execution_paths;

-- -----------------------------------------------------------------------------
-- Impulse bookkeeping
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_impulse_budget_log_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse_budget_log;

DEFINE TABLE OVERWRITE v_impulse_data_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse_data;

DEFINE TABLE OVERWRITE v_impulse_relevance_metrics_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse_relevance_metrics;

DEFINE TABLE OVERWRITE v_impulse_resolution_metrics_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse_resolution_metrics;

DEFINE TABLE OVERWRITE v_impulse_state_pattern_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse_state_pattern;

DEFINE TABLE OVERWRITE v_impulse_usage_history_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse_usage_history;

DEFINE TABLE OVERWRITE v_llm_resolution_log_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM llm_resolution_log;

-- -----------------------------------------------------------------------------
-- Patterns
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_pattern_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM pattern;

DEFINE TABLE OVERWRITE v_prerequisite_patterns_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM prerequisite_patterns;

DEFINE TABLE OVERWRITE v_relevance_feedback_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM relevance_feedback;

DEFINE TABLE OVERWRITE v_routing_trace_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM routing_trace;

DEFINE TABLE OVERWRITE v_shape_definition_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM shape_definition;

DEFINE TABLE OVERWRITE v_tool_usage_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM tool_usage;

DEFINE TABLE OVERWRITE v_variant_performance_metrics_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM variant_performance_metrics;

-- -----------------------------------------------------------------------------
-- CI integration
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_ci_runs_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM ci_runs;

-- -----------------------------------------------------------------------------
-- Deprecated table (read-only compat)
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_minibob_instance_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM minibob_instance;

-- =============================================================================
-- End of migration 096. Total: 32 views (one per migrated table).
-- =============================================================================
