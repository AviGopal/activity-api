-- 190: Force-(re)define goal_execution_paths.expected_output_shapes.
--
-- 188/189 (plain / IF NOT EXISTS) never made the field writable on the live DB,
-- and OVERWRITE does NOT parse in this SurrealDB build (`Unexpected token
-- OVERWRITE` — the same reason migrations 068/074/080/085/099 that use
-- `DEFINE TABLE ... OVERWRITE SCHEMAFULL` have been silently failing). Plain
-- `DEFINE FIELD` (re)defines unconditionally and is exactly what migration 092
-- used for endpoint_output_shapes (which works), so it force-corrects the field.
-- The authoritative fix runs pre-loop in scripts/init-database.ts; this file is
-- the matching sql/ change that triggers substrate-pull-sync to restart
-- activity-api and run it.

DEFINE FIELD expected_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Planned terminal output shapes (goal target set) from the goal-host walk. Sibling of endpoint_output_shapes.";

DEFINE INDEX IF NOT EXISTS idx_goal_paths_expected_shapes
  ON goal_execution_paths FIELDS expected_output_shapes;
