-- =============================================================================
-- Migration 095: Phase A — Additive account_id schema scaffolding
-- =============================================================================
-- Created: 2026-04-28
-- Related OpenSpec: activity-api-account-id-migration-2026-04-28
--
-- PURPOSE
-- -------
-- Phase 1 of the multi-tenant migration from `org_id` to `account_id` as the
-- canonical isolation key. This migration is *purely additive* — it does NOT:
--   * remove any existing `org_id` field
--   * change any PERMISSIONS clause   (Phase C)
--   * rewrite any application code   (Phase B)
--   * backfill historical rows        (Phase F, via separate CLI tool)
-- All it does is reserve the new fields on every multi-tenant table so Phase B
-- handlers can begin dual-writing without further schema work.
--
-- WHAT THIS MIGRATION ADDS
-- ------------------------
-- For every table currently scoped by `org_id`, define two new fields:
--
--   account_id         option<string>   -- canonical multi-tenant key (Phase B+)
--                                          format: "accounts:<id>" (record-id form)
--                                          option<> for safe rollout — null on
--                                          legacy rows, set on Phase B writes
--                                          via JWT $token.account_id
--   account_id_version int (DEFAULT 0)  -- migration cohort marker:
--                                          0 = pre-Phase-A row (legacy)
--                                          1 = Phase B dual-write row
--                                          2 = Phase D account-only row
--
-- Plus an index on `account_id` so Phase B handlers can do account-scoped
-- queries without a full table scan.
--
-- IDEMPOTENCY
-- -----------
-- Uses DEFINE FIELD OVERWRITE (SurrealDB 3.x syntax — see migration 094 for
-- precedent and rationale). Re-running the migration redefines fields with
-- identical types, which is a safe no-op. The DEFAULT 0 only applies on
-- INSERT/UPDATE when the field is unset; existing rows are NOT mutated by
-- DEFINE FIELD itself.
--
-- BACKWARD COMPATIBILITY
-- ----------------------
-- account_id is option<string> (NOT required), so rows missing it are valid.
-- Phase B handlers will populate it on every new write; Phase F backfills
-- the legacy rows. Until Phase D, both paths must work side by side — see
-- migration 096 for the back-compat alias views.
--
-- TABLES TOUCHED (alphabetical; ~30 in total)
-- -------------------------------------------
-- Paradigm core:                     activity, execution, impulse, vessel
-- Activity bookkeeping:              activity_composition_graph, activity_dataflows,
--                                    activity_execution_traces, activity_prerequisites,
--                                    activity_registry, activity_state_affinity
-- Execution patterns/state:          circuit_breaker_trace, code_variants, composite_sequence_patterns,
--                                    composition_edge, context_thompson_scores,
--                                    discovered_state_pattern, execution_pattern,
--                                    execution_sequences, execution_state_snapshot,
--                                    execution_traces (legacy alias),
--                                    external_validation_history, state_feature_importance,
--                                    state_transition, thompson_selection_log
-- Goal/path:                         goal_execution_paths
-- Impulse bookkeeping:               impulse_budget_log, impulse_data,
--                                    impulse_relevance_metrics, impulse_resolution_metrics,
--                                    impulse_state_pattern, impulse_usage_history,
--                                    llm_resolution_log
-- Patterns:                          pattern, prerequisite_patterns, relevance_feedback,
--                                    routing_trace, shape_definition, tool_usage,
--                                    variant_performance_metrics
-- Optional CI integration:           ci_runs
-- Deprecated (kept for compat):      minibob_instance
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Paradigm core tables
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE activity TYPE option<string>
  COMMENT "Phase A: canonical multi-tenant isolation key (record-id form 'accounts:<id>'). Populated by Phase B dual-write. Null on pre-Phase-A rows (use account_id_version=0 to filter).";
DEFINE FIELD OVERWRITE account_id_version ON TABLE activity TYPE int DEFAULT 0
  COMMENT "Phase A: cohort marker. 0=legacy (org_id only), 1=Phase B dual-write, 2=Phase D account-only.";
DEFINE INDEX OVERWRITE idx_activity_account_id ON activity FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE execution TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE execution TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_execution_account_id ON execution FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE impulse TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_account_id ON impulse FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE vessel TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE vessel TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_vessel_account_id ON vessel FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Activity bookkeeping tables
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE activity_composition_graph TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE activity_composition_graph TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_activity_composition_graph_account_id
  ON activity_composition_graph FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE activity_dataflows TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE activity_dataflows TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_activity_dataflows_account_id
  ON activity_dataflows FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE activity_execution_traces TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. Phase B dual-writes this alongside org_id; Phase D drops org_id.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE activity_execution_traces TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_activity_execution_traces_account_id
  ON activity_execution_traces FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE activity_prerequisites TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE activity_prerequisites TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_activity_prerequisites_account_id
  ON activity_prerequisites FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE activity_registry TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE activity_registry TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_activity_registry_account_id
  ON activity_registry FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE activity_state_affinity TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE activity_state_affinity TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_activity_state_affinity_account_id
  ON activity_state_affinity FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Execution patterns / state tables
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE circuit_breaker_trace TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE circuit_breaker_trace TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_circuit_breaker_trace_account_id
  ON circuit_breaker_trace FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE code_variants TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE code_variants TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_code_variants_account_id
  ON code_variants FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE composite_sequence_patterns TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE composite_sequence_patterns TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_composite_sequence_patterns_account_id
  ON composite_sequence_patterns FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE composition_edge TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE composition_edge TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_composition_edge_account_id
  ON composition_edge FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE context_thompson_scores TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE context_thompson_scores TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_context_thompson_scores_account_id
  ON context_thompson_scores FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE discovered_state_pattern TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE discovered_state_pattern TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_discovered_state_pattern_account_id
  ON discovered_state_pattern FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE execution_pattern TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE execution_pattern TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_execution_pattern_account_id
  ON execution_pattern FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE execution_sequences TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE execution_sequences TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_execution_sequences_account_id
  ON execution_sequences FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE execution_state_snapshot TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE execution_state_snapshot TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_execution_state_snapshot_account_id
  ON execution_state_snapshot FIELDS account_id;

-- execution_traces is the legacy paradigm-compat alias (see migrations 074, 075).
-- Kept here so dual-write Phase B can populate either form.
DEFINE FIELD OVERWRITE account_id ON TABLE execution_traces TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. Legacy alias of activity_execution_traces; included for completeness.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE execution_traces TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_execution_traces_account_id
  ON execution_traces FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE external_validation_history TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE external_validation_history TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_external_validation_history_account_id
  ON external_validation_history FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE state_feature_importance TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE state_feature_importance TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_state_feature_importance_account_id
  ON state_feature_importance FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE state_transition TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE state_transition TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_state_transition_account_id
  ON state_transition FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE thompson_selection_log TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE thompson_selection_log TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_thompson_selection_log_account_id
  ON thompson_selection_log FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Goal / path tables
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE goal_execution_paths TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. CC1 scope-narrowing ASSERT (Phase C) layered on top of this.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE goal_execution_paths TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_goal_execution_paths_account_id
  ON goal_execution_paths FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Impulse bookkeeping tables
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE impulse_budget_log TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse_budget_log TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_budget_log_account_id
  ON impulse_budget_log FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE impulse_data TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse_data TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_data_account_id
  ON impulse_data FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE impulse_relevance_metrics TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. Phase B retargets Thompson Sampling to this scope.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse_relevance_metrics TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_relevance_metrics_account_id
  ON impulse_relevance_metrics FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE impulse_resolution_metrics TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse_resolution_metrics TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_resolution_metrics_account_id
  ON impulse_resolution_metrics FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE impulse_state_pattern TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse_state_pattern TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_state_pattern_account_id
  ON impulse_state_pattern FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE impulse_usage_history TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse_usage_history TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_usage_history_account_id
  ON impulse_usage_history FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE llm_resolution_log TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE llm_resolution_log TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_llm_resolution_log_account_id
  ON llm_resolution_log FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Pattern tables
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE pattern TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE pattern TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_pattern_account_id
  ON pattern FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE prerequisite_patterns TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE prerequisite_patterns TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_prerequisite_patterns_account_id
  ON prerequisite_patterns FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE relevance_feedback TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE relevance_feedback TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_relevance_feedback_account_id
  ON relevance_feedback FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE routing_trace TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE routing_trace TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_routing_trace_account_id
  ON routing_trace FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE shape_definition TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE shape_definition TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_shape_definition_account_id
  ON shape_definition FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE tool_usage TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE tool_usage TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_tool_usage_account_id
  ON tool_usage FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE variant_performance_metrics TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. Phase B retargets Thompson Sampling variant lookup to this scope.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE variant_performance_metrics TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_variant_performance_metrics_account_id
  ON variant_performance_metrics FIELDS account_id;

-- -----------------------------------------------------------------------------
-- CI integration table (org-scoped CI runs)
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE ci_runs TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. See migration 095.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE ci_runs TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_ci_runs_account_id ON ci_runs FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Deprecated table (kept for backward compatibility — see migration 052)
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE minibob_instance TYPE option<string>
  COMMENT "Phase A: account_id for multi-tenant isolation. Deprecated table kept for compat (migration 052); included so future read paths can dual-check.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE minibob_instance TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_minibob_instance_account_id
  ON minibob_instance FIELDS account_id;

-- =============================================================================
-- End of migration 095. Total: 32 tables touched.
--
-- Phase B handlers can now begin populating account_id alongside org_id without
-- further schema work. PERMISSIONS clauses remain org_id-scoped — Phase C will
-- update them to dual-check (account_id OR org_id).
-- =============================================================================
