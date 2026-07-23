-- =============================================================================
-- 046 — v_selection_outcomes (RETIRED → REMOVE)
--
-- RETIRED. Formerly DEFINEd the computed view `v_selection_outcomes AS SELECT
-- ... FROM thompson_selection_log`. It has ZERO runtime FROM-readers and
-- re-materializes on every thompson_selection_log write (churn). The base table
-- thompson_selection_log is the authority. Converted to REMOVE so the 30-min
-- db-maintenance reconcile (which re-applies this file) retires it durably
-- instead of recreating it. Idempotent.
-- =============================================================================

REMOVE TABLE IF EXISTS v_selection_outcomes;
