-- 174-neutralize-regenerating-account-views.surql
-- ============================================================================
-- Purpose: durably drop the 7 stale-survivor views that migrations 165/166/170
--   were meant to remove but did not fully remove on the running volume, and
--   which are now stranded ALIVE because 165/166/170 are recorded in
--   init_migrations (so they never re-run) while their re-creators (042/096/098)
--   are ALSO recorded (so they never re-run either).
--
-- MECHANISM (measured 2026-07-22, live DB activity-system/learning_loop):
--   * scripts/init-database.ts (ExecStartPre of activity-api.service) is the ONLY
--     schema applier. It skips any file whose bare filename is in init_migrations.
--   * init_migrations (188 rows) RECORDS 042-enhanced-activity-score.surql,
--     096-back-compat-account-views.surql, 098-back-compat-account-views-tier2.surql
--     AND 165/166/170 — so on restart NONE of them run. The 7 views below are
--     therefore stale survivors of migration 166's batched REMOVE-over-stdin
--     (which silently dropped a subset of its statements against the non-empty
--     running volume), never retried because 166/170 are recorded.
--   * INFO FOR DB confirmed all 7 ALIVE with post-restart writes.
--
-- WHY SAFE (verified, not assumed):
--   * ZERO runtime references across all repos/*/src + packages (non-test,
--     non-.surql) for all 7 names (rg, empty).
--   * NO other view SELECTs FROM any of the 7 (INFO FOR DB — no view-of-view).
--   * v_activity_score_enhanced is a dead write-amplifying aggregate over the
--     hot `execution` table (see migration 165). The 6 v_*_by_account views are
--     the abandoned account-id back-compat scaffold (migrations 096/098), all
--     PERMISSIONS NONE (structurally unreadable). Removing them changes NO
--     selection / scoring / reach outcome — deletes write-amplification only.
--
-- DURABILITY: this is a FRESH, unrecorded migration → init-database applies it
--   (HTTP POST) and records it. The orchestrator applies each REMOVE statement
--   INDIVIDUALLY (not a batched stdin pipe) so none is silently dropped — the
--   failure mode that left 166/170 partial. The re-creating source DEFINEs in
--   042/096/098 are neutralised in the same change, so nothing re-asserts these
--   views on any replay path (fresh-volume boot, manual re-run, migrations reset).
--
-- REVERSIBILITY: the original DEFINEs are preserved verbatim in git history of
--   the edited re-creator files (sql/schemas/042-enhanced-activity-score.surql,
--   sql/migrations/096-back-compat-account-views.surql,
--   sql/migrations/098-back-compat-account-views-tier2.surql) and in migration
--   165's REVERSIBILITY header. REMOVE TABLE cascades index removal. The views
--   hold no source data (pure projections/aggregates of their base tables).
-- ============================================================================

REMOVE TABLE IF EXISTS v_activity_score_enhanced;
REMOVE TABLE IF EXISTS v_impulse_by_account;
REMOVE TABLE IF EXISTS v_goal_execution_paths_by_account;
REMOVE TABLE IF EXISTS v_thompson_selection_log_by_account;
REMOVE TABLE IF EXISTS v_variant_performance_metrics_by_account;
REMOVE TABLE IF EXISTS v_context_thompson_scores_by_account;
REMOVE TABLE IF EXISTS v_impulse_shape_activity_score_by_account;
