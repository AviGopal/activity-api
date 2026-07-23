-- =============================================================================
-- 096 — account-scoped compat views (RETIRED → REMOVE)
--
-- RETIRED. This migration formerly DEFINEd computed `v_*` views for the
-- ABANDONED account-id migration family (multi-session verdict). Those views
-- have ZERO runtime readers (grep: no `FROM v_*_by_account` in src) and
-- re-materialize on every write to their hot base tables (churn). The 30-min
-- db-maintenance reconcile RE-APPLIES this file, so a mere REMOVE elsewhere
-- (mig 174/177) was resurrected here. Converting the DEFINEs to REMOVEs makes
-- retirement durable: reconcile now removes them instead of recreating them.
-- Idempotent (REMOVE ... IF EXISTS).
-- =============================================================================

REMOVE TABLE IF EXISTS v_activity_by_account;
REMOVE TABLE IF EXISTS v_activity_composition_graph_by_account;
REMOVE TABLE IF EXISTS v_activity_dataflows_by_account;
REMOVE TABLE IF EXISTS v_activity_execution_traces_by_account;
REMOVE TABLE IF EXISTS v_activity_prerequisites_by_account;
REMOVE TABLE IF EXISTS v_activity_registry_by_account;
REMOVE TABLE IF EXISTS v_activity_state_affinity_by_account;
REMOVE TABLE IF EXISTS v_circuit_breaker_trace_by_account;
REMOVE TABLE IF EXISTS v_ci_runs_by_account;
REMOVE TABLE IF EXISTS v_code_variants_by_account;
REMOVE TABLE IF EXISTS v_composite_sequence_patterns_by_account;
REMOVE TABLE IF EXISTS v_composition_edge_by_account;
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
REMOVE TABLE IF EXISTS v_tool_usage_by_account;
REMOVE TABLE IF EXISTS v_variant_performance_metrics_by_account;
REMOVE TABLE IF EXISTS v_vessel_by_account;
