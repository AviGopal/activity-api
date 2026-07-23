-- =============================================================================
-- 177 — churn / duplication / latency cleanup (evidence-backed, individual DROPs)
--
-- Authored from a live 102-table audit (fresh measurement, not cache). Every
-- object below was confirmed at apply time: 0 rows (tables) / 0 runtime FROM-
-- readers (views) / not a record<> link target. Numbered 177 so it runs AFTER
-- the DEFINEs it supersedes (096/098 account-views, 069 paradigm view, 163
-- index) on BOTH a fresh boot (define-then-remove, in filename order) and a live
-- DB (drop the surviving objects) — then stays applied-and-skipped, so the
-- removals are durable across restarts.
--
-- LESSON APPLIED (mig 165-176 pass): batched REMOVE over one stdin silently
-- drops only a SUBSET. These are exactly the 7 account-views that SURVIVED the
-- batched drops in 166/170/174. Each REMOVE here is its own statement.
-- =============================================================================

-- ── Group 1: abandoned account-id compat views (churn) ──────────────────────
-- The account-id migration is ABANDONED-verdict (multi-session). 48 were DEFINEd
-- in 096/098; 41 already dropped; these 7 survived the batched-drop subset bug.
-- Each is a computed `DEFINE TABLE ... AS SELECT` that re-materializes on every
-- write to its hot base table (activity/impulse/execution/thompson_selection_log)
-- with ZERO runtime readers (grep: 0 `FROM v_*_by_account` in src; the only ref
-- is an incidental name-list in db-admin-reconcile.ts). Pure write-amplification.
REMOVE TABLE IF EXISTS v_activity_by_account;
REMOVE TABLE IF EXISTS v_impulse_by_account;
REMOVE TABLE IF EXISTS v_impulse_relevance_metrics_by_account;
REMOVE TABLE IF EXISTS v_impulse_shape_activity_score_by_account;
REMOVE TABLE IF EXISTS v_goal_execution_paths_by_account;
REMOVE TABLE IF EXISTS v_thompson_selection_log_by_account;
REMOVE TABLE IF EXISTS v_variant_performance_metrics_by_account;

-- ── Group 2: other unread computed views (churn) ────────────────────────────
-- v_paradigm_impulse_data (069:92): re-materializes on every `impulse` write
-- (hot /v2/activities/recommend path); 0 runtime FROM-readers.
-- v_selection_outcomes (schemas/046): re-materializes on every
-- thompson_selection_log write; 0 runtime FROM-readers.
REMOVE TABLE IF EXISTS v_paradigm_impulse_data;
REMOVE TABLE IF EXISTS v_selection_outcomes;

-- ── Group 3: dead tables — no live DEFINE (durable) ─────────────────────────
-- 0 rows, 0 runtime readers/writers, not a record<> link target. No DEFINE in
-- any deployed migration, so a bare REMOVE sticks.
REMOVE TABLE IF EXISTS activity_registry;
REMOVE TABLE IF EXISTS upkeep_stats;
REMOVE TABLE IF EXISTS ci_runs;
REMOVE TABLE IF EXISTS code_variants;
REMOVE TABLE IF EXISTS resolver;
REMOVE TABLE IF EXISTS impulse_budget_log;

-- ── Group 4: dead learning tables — DEFINE'd but never used (duplication) ────
-- Schemafull DEFINEs exist (012-composition:217; 055-add-learning-table-
-- permissions:30,47) but ZERO TS references anywhere in repos/, scripts/, or
-- deployed /vessels/*/dist. Removed AFTER their DEFINEs by migration order.
REMOVE TABLE IF EXISTS activity_dataflows;
REMOVE TABLE IF EXISTS activity_tool_usage;
REMOVE TABLE IF EXISTS activity_impulse_relevance;

-- ── Group 5: dead index on the hot >1M-row execution table (churn/latency) ──
-- idx_execution_created_at (163:52) is maintained on every execution INSERT
-- (highest write volume in the store) but NO runtime query filters/orders
-- `execution` by created_at (every created_at ORDER BY/WHERE in src is on
-- activity/impulse/goal_execution_paths/activity_template). Pure write cost, no
-- reader → dropping is a pure write saving with no read regression.
REMOVE INDEX IF EXISTS idx_execution_created_at ON execution;
