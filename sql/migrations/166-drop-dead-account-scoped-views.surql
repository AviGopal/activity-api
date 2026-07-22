-- 166-drop-dead-account-scoped-views.surql
-- ============================================================================
-- Purpose: Remove the 47 dead `v_*_by_account` materialised views.
--
-- WHY (write-amplification, core principle):
--   Each is a materialised view (DEFINE TABLE ... AS SELECT ... FROM <base>) that
--   re-materialises on EVERY write to its base table. The views over hot tables
--   (v_execution_by_account over `execution` = 110k rows, v_impulse_by_account,
--   v_activity_by_account, v_variant_performance_metrics_by_account, etc.)
--   therefore add per-insert view maintenance on the busiest write paths. Pure
--   write-amplification churn + latency.
--
-- WHY SAFE (verified, operator-authorised):
--   * These are the account-id back-compat scaffold from migrations 096/098
--     (account-id OpenSpec migration). Phase B consumers were never wired; the
--     Phase D/G drop never landed; the OpenSpec change dir is absent from the
--     tree. The migration is withdrawn (operator confirmed 2026-07-22).
--   * ZERO runtime references across all repos/*/src + packages/*/src (non-test,
--     non-.surql) — verified by grep of all 47 names. All carry PERMISSIONS NONE
--     (structurally unreadable by any tenant), so nothing consumes them.
--   Removing them changes NO application behaviour — deletes dead
--   write-amplification only.
--
-- ORDERING: migrations apply AFTER schemas in init-database.ts and already-applied
--   files are skipped, so this REMOVE is durable live; on a fresh boot the
--   defining schema/migration (096/098) creates them then this 166 removes them
--   → net removed. (Follow-up: neutralise the DEFINEs in the 096/098 sources for
--   explicit intent — flagged, not required for correctness.)
--
-- REVERSIBILITY: every view is re-DEFINE-able verbatim from migrations 096/098
--   if the account-id migration is ever resumed. The views are pure aliases /
--   account-scoped projections of their base tables — no source data is lost.
--
-- LIVE NOTE (2026-07-22): 42 of the 47 drop durably. The 5 over hot Phase-A
--   tables — v_execution_by_account, v_impulse_by_account,
--   v_variant_performance_metrics_by_account, v_goal_execution_paths_by_account,
--   v_impulse_shape_activity_score_by_account — are re-created on each boot by
--   migrations 096/098 (DEFINE TABLE OVERWRITE), which are NOT recorded in
--   init_migrations and therefore re-run every start. The account-id migration
--   is in fact LIVE (Phase B dual-write of account_id is active, e.g.
--   routes/impulses.ts:443), i.e. NOT withdrawn. Fully removing those 5 requires
--   deciding the account-id migration's fate first (complete it, or formally
--   withdraw it and neutralise the OVERWRITE DEFINEs in 096/098). Dropping them
--   here is still safe (0 src readers) but will be undone by the next boot until
--   that decision lands. This migration removes the 42 genuinely-dead views now.
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
