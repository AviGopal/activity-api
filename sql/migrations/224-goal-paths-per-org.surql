-- Migration 224: goal_execution_paths rows are PER ORG, with org-scoped reach counters (A2b-proper aa-1; user ruling
-- 2026-10-16T17:53:17Z "Build it as part of A2b").
--
-- A path row was keyed by (goal_hash, path_signature) alone: the POST's lookup and UPDATE had no org, org_id was written
-- only at CREATE, and the GET filtered on goal_hash alone through the shared client. So one org's runs incremented
-- another org's row, and any caller read every org's paths. goal-host's target selection (A2b-proper) reads these
-- counters to choose targets, so one org's outcomes would have steered another org's choices.
--   - The unique key becomes (org_id, goal_hash, path_signature): each org's runs of a path are its own row. Existing
--     rows are unique on (goal_hash, path_signature), hence also on the wider key, so the rebuild cannot collide.
--   - org_successful_executions / org_failed_executions count only runs recorded under the per-org key (from this
--     migration on). A LEGACY row's mixed counters are left as they are for the readers that use them; the org-scoped
--     counters start cold on its first per-org run. Target selection reads only the org-scoped ones.
DEFINE FIELD IF NOT EXISTS org_successful_executions ON goal_execution_paths TYPE option<int>;
DEFINE FIELD IF NOT EXISTS org_failed_executions ON goal_execution_paths TYPE option<int>;
DEFINE INDEX OVERWRITE idx_goal_paths_signature ON goal_execution_paths FIELDS org_id, goal_hash, path_signature UNIQUE;
