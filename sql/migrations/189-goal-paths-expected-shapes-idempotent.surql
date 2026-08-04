-- 189: Idempotent (re)definition of goal_execution_paths.expected_output_shapes.
--
-- WHY a second file for a field 188 already declares: migration 188 was marked
-- "applied" WITHOUT running (a contended-startup read of init_migrations timed
-- out, looked empty, and triggered the live-DB bootstrap that marks every file
-- applied-without-running — see scripts/init-database.ts getAppliedMigrations /
-- bootstrapMigrationsTable). On the SCHEMAFULL goal_execution_paths table the
-- undefined field is then silently DROPPED on write, so the plan-vs-observed
-- reconciliation column never persists. 188's filename is stuck in init_migrations,
-- so it will never re-run; this NEW filename is unseen by tracking and applies.
--
-- It is also the restart TRIGGER: substrate-pull-sync scans src + sql for changes,
-- so a sql/ commit is what makes the hub mirror the (already-pushed) init-database
-- fix and restart activity-api to run it. `IF NOT EXISTS` keeps this a no-op once
-- the field exists.

DEFINE FIELD IF NOT EXISTS expected_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Planned terminal output shapes (goal target set) supplied by the goal-host walk. Sibling of endpoint_output_shapes (observed produced shapes).";

DEFINE INDEX IF NOT EXISTS idx_goal_paths_expected_shapes
  ON goal_execution_paths FIELDS expected_output_shapes;
