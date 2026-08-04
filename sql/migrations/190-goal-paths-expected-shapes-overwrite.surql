-- 190: Cleanly recreate goal_execution_paths.expected_output_shapes.
--
-- The field ALREADY EXISTS (init-database's surfaced DEFINE error confirmed it)
-- but stores null on write, while the sibling endpoint_output_shapes (same
-- option<array<string>> type) works — so expected is defined in a broken form.
-- This SurrealDB build can't redefine in place: OVERWRITE doesn't parse, plain
-- DEFINE FIELD errors "already exists", IF NOT EXISTS no-ops. REMOVE then DEFINE
-- force-recreates it cleanly. The authoritative fix runs pre-loop in
-- scripts/init-database.ts; this file is the matching sql/ change that triggers
-- substrate-pull-sync to restart activity-api and run it.

REMOVE FIELD expected_output_shapes ON goal_execution_paths;

DEFINE FIELD expected_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Planned terminal output shapes (goal target set) from the goal-host walk. Sibling of endpoint_output_shapes.";

DEFINE INDEX IF NOT EXISTS idx_goal_paths_expected_shapes
  ON goal_execution_paths FIELDS expected_output_shapes;
