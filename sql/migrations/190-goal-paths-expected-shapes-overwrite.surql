-- 190: Non-destructive idempotent (re)assert of expected_output_shapes.
--
-- SUPERSEDED DIAGNOSIS: this file originally ran `REMOVE FIELD ... ; DEFINE FIELD`
-- to "cleanly recreate" the field, on the false belief that it was defined in a
-- broken form. A credential-free `INFO FOR TABLE` probe proved endpoint_output_shapes
-- and expected_output_shapes are defined identically and correctly; the real
-- null-on-write cause was an UNBOUND $expected_output_shapes param in the API
-- CREATE (fixed in the goal-paths route handler, commit 4d0f627). REMOVE FIELD is
-- destructive on a SCHEMAFULL table, so it is removed here — 188/189 already define
-- the field and this is a harmless re-assert kept only so the filename stays valid
-- in the migration sequence.

DEFINE FIELD IF NOT EXISTS expected_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Planned terminal output shapes (goal target set) from the goal-host walk. Sibling of endpoint_output_shapes.";

DEFINE INDEX IF NOT EXISTS idx_goal_paths_expected_shapes
  ON goal_execution_paths FIELDS expected_output_shapes;
