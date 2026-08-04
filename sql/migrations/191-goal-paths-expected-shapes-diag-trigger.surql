-- 191: harmless idempotent re-assert of the expected_output_shapes index.
-- Its real purpose is to be a sql/ change so substrate-pull-sync (which scans
-- src+sql) mirrors the paired scripts/init-database.ts diagnostic and restarts
-- activity-api to run it. DEFINE INDEX IF NOT EXISTS parses in this build and is
-- a no-op once present.

DEFINE INDEX IF NOT EXISTS idx_goal_paths_expected_shapes
  ON goal_execution_paths FIELDS expected_output_shapes;
