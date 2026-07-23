-- =============================================================================
-- 098 — account-scoped compat views tier-2 (RETIRED → REMOVE)
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

REMOVE TABLE IF EXISTS v_composition_chain_by_account;
REMOVE TABLE IF EXISTS v_composition_node_by_account;
REMOVE TABLE IF EXISTS v_impulse_shape_activity_score_by_account;
REMOVE TABLE IF EXISTS v_tool_argument_pattern_by_account;
REMOVE TABLE IF EXISTS v_tool_usage_patterns_by_account;
REMOVE TABLE IF EXISTS v_vessel_circuit_breaker_by_account;
REMOVE TABLE IF EXISTS v_vessel_health_metrics_by_account;
