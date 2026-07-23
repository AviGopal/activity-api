-- 170-finalize-account-view-withdrawal.surql
-- ============================================================================
-- Finalize withdrawal of the abandoned account-id migration's back-compat views.
--
-- WHY: the account-id migration (OpenSpec activity-api-account-id-migration-
--   2026-04-28) is effectively abandoned — account_id is 0% populated on live
--   data (NONE on all execution/impulse rows, including current writes), the
--   spec was never committed, the last forward commit was 2026-05-14, Phase D
--   cutover never started, and no code reads the v_*_by_account layer (0 runtime
--   src refs; all PERMISSIONS NONE). Each of the 47 views is a materialised
--   view SurrealDB maintains on every write to its base table = pure write-
--   amplification on hot tables (execution/impulse/activity/variant_performance).
--
-- WHY THIS MIGRATION (vs 166): migration 166 was recorded in init_migrations but
--   its live REMOVEs did not fully take on the running volume (a stale set of
--   views over non-empty tables persisted), and being recorded it never re-ran.
--   This is a FRESH, unrecorded migration → the init-database runner applies it
--   reliably (HTTP POST of the whole file, not a line-fragile stdin pipe) and
--   records it, so the withdrawal is durable across restarts. On a fresh volume
--   it runs after 096/098 create the views, netting zero.
--
--   The Phase-B dual-write of account_id and the additive account_id columns
--   (migrations 095/097) are intentionally LEFT in place (harmless no-op, no
--   reader) rather than stripped — that touches many hot write paths and is a
--   separate deliberate change if ever pursued.
--
-- REVERSIBILITY: every view is re-DEFINE-able verbatim from migrations 096/098.
--   The views hold no state (pure account-scoped projections of their base
--   tables) — no source data is lost.
-- ============================================================================

REMOVE TABLE IF EXISTS v_activity_by_account;
REMOVE TABLE IF EXISTS v_activity_composition_graph_by_account;
REMOVE TABLE IF EXISTS v_activity_dataflows_by_account;
REMOVE TABLE IF EXISTS v_activity_prerequisites_by_account;
REMOVE TABLE IF EXISTS v_activity_registry_by_account;
REMOVE TABLE IF EXISTS v_activity_state_affinity_by_account;
REMOVE TABLE IF EXISTS v_circuit_breaker_trace_by_account;
REMOVE TABLE IF EXISTS v_ci_runs_by_account;
REMOVE TABLE IF EXISTS v_code_variants_by_account;
REMOVE TABLE IF EXISTS v_composite_sequence_patterns_by_account;
REMOVE TABLE IF EXISTS v_composition_chain_by_account;
REMOVE TABLE IF EXISTS v_composition_edge_by_account;
REMOVE TABLE IF EXISTS v_composition_node_by_account;
REMOVE TABLE IF EXISTS v_context_thompson_scores_by_account;
REMOVE TABLE IF EXISTS v_discovered_state_pattern_by_account;
REMOVE TABLE IF EXISTS v_execution_by_account;
REMOVE TABLE IF EXISTS v_execution_pattern_by_account;
REMOVE TABLE IF EXISTS v_execution_sequences_by_account;
REMOVE TABLE IF EXISTS v_execution_state_snapshot_by_account;
REMOVE TABLE IF EXISTS v_execution_traces_by_account;
REMOVE TABLE IF EXISTS v_external_validation_history_by_account;
REMOVE TABLE IF EXISTS v_goal_execution_paths_by_account;
REMOVE TABLE IF EXISTS v_impulse_budget_log_by_account;
REMOVE TABLE IF EXISTS v_impulse_by_account;
REMOVE TABLE IF EXISTS v_impulse_data_by_account;
REMOVE TABLE IF EXISTS v_impulse_relevance_metrics_by_account;
REMOVE TABLE IF EXISTS v_impulse_resolution_metrics_by_account;
REMOVE TABLE IF EXISTS v_impulse_shape_activity_score_by_account;
REMOVE TABLE IF EXISTS v_impulse_state_pattern_by_account;
REMOVE TABLE IF EXISTS v_impulse_usage_history_by_account;
REMOVE TABLE IF EXISTS v_llm_resolution_log_by_account;
REMOVE TABLE IF EXISTS v_minibob_instance_by_account;
REMOVE TABLE IF EXISTS v_pattern_by_account;
REMOVE TABLE IF EXISTS v_prerequisite_patterns_by_account;
REMOVE TABLE IF EXISTS v_relevance_feedback_by_account;
REMOVE TABLE IF EXISTS v_routing_trace_by_account;
REMOVE TABLE IF EXISTS v_shape_definition_by_account;
REMOVE TABLE IF EXISTS v_state_feature_importance_by_account;
REMOVE TABLE IF EXISTS v_state_transition_by_account;
REMOVE TABLE IF EXISTS v_thompson_selection_log_by_account;
REMOVE TABLE IF EXISTS v_tool_argument_pattern_by_account;
REMOVE TABLE IF EXISTS v_tool_usage_by_account;
REMOVE TABLE IF EXISTS v_tool_usage_patterns_by_account;
REMOVE TABLE IF EXISTS v_variant_performance_metrics_by_account;
REMOVE TABLE IF EXISTS v_vessel_by_account;
REMOVE TABLE IF EXISTS v_vessel_circuit_breaker_by_account;
REMOVE TABLE IF EXISTS v_vessel_health_metrics_by_account;
