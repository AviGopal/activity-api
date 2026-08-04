-- 190: Force-(re)define goal_execution_paths.expected_output_shapes with OVERWRITE.
--
-- 188/189 used plain / IF NOT EXISTS DEFINE FIELD, and the field never became
-- writable on the live DB — a partial/failed earlier apply likely left it
-- present-but-broken, so IF NOT EXISTS no-ops and the SCHEMAFULL table silently
-- drops the field on write. OVERWRITE force-redefines it to the correct shape
-- (idempotent). The authoritative fix runs pre-loop in scripts/init-database.ts
-- (also OVERWRITE); this file is the matching sql/ change that makes
-- substrate-pull-sync (which scans src+sql) mirror that init-database change and
-- restart activity-api to run it.

DEFINE FIELD OVERWRITE expected_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Planned terminal output shapes (goal target set) from the goal-host walk. Sibling of endpoint_output_shapes.";

DEFINE INDEX IF NOT EXISTS idx_goal_paths_expected_shapes
  ON goal_execution_paths FIELDS expected_output_shapes;
