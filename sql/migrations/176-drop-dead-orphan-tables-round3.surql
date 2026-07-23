-- Migration 176: Drop dead-orphan tables (round 3)
--
-- Each table below was re-verified independently at authoring time:
--   (1) SELECT count() FROM <t> GROUP ALL == 0 (all 0 rows, live).
--   (2) rg -n "\b<t>\b" repos/*/src -> ZERO runtime readers/writers. The only
--       source hits are the ABANDONED account-id migration CLI
--       (src/cli/migrate-org-to-account.ts PHASE_A_TABLES — imported by nothing
--       except its own test) and account-id migration test fixtures. No vessel
--       issues FROM/CREATE/UPDATE/DELETE against these tables.
--   (3) No record<> link-type reference to any of them on any live table.
--   (4) No live view (DEFINE TABLE ... AS SELECT) references them (INFO FOR DB).
--
-- NOT dropped here (deliberately retained):
--   minibob_instance — referenced as a record<> LINK TYPE on live tables
--     (created_by ON impulse/activity/execution/pattern/llm_resolution_log/
--      activity_execution_traces/tool_argument_pattern). Dropping it would
--      orphan those field type definitions. Deferred.
--
-- Reversibility: recreate from the original schema definitions —
--   goal_paths, prerequisite_patterns, activity_prerequisites ->
--     sql/007-control-flow-data-flow-learning.surql
--   impulse_state_pattern, state_transition ->
--     sql/schemas/028-resolver-architecture.surql
--   external_validation_history ->
--     sql/migrations/053-external-validation.surql
-- Re-running the corresponding DEFINE TABLE / DEFINE FIELD / DEFINE INDEX block
-- restores the (empty) table. No data is lost (all tables are 0 rows).

REMOVE TABLE IF EXISTS goal_paths;
REMOVE TABLE IF EXISTS prerequisite_patterns;
REMOVE TABLE IF EXISTS activity_prerequisites;
REMOVE TABLE IF EXISTS impulse_state_pattern;
REMOVE TABLE IF EXISTS state_transition;
REMOVE TABLE IF EXISTS external_validation_history;
