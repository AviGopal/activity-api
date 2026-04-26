-- Denormalized terminal output shapes on goal_execution_paths.
-- Enables shape-keyed lookup ("find a goal whose terminal output is shape X")
-- for the create-shape-provider-goal activity. See OpenSpec change
-- 2026-04-26-shape-provider-goal-creation.
--
-- Previously, terminal shapes for a path were computed on-the-fly in
-- predictEndpointState (src/routes/goal-paths.ts) by joining `activity`
-- records via path_activities and accumulating their output_shapes. This
-- migration denormalises that accumulation onto the row and indexes it.
--
-- Idempotent: SurrealDB's DEFINE FIELD/INDEX are no-ops when the
-- definition is unchanged. The backfill UPDATE filters on
-- `endpoint_output_shapes IS NONE` so re-runs against an already-populated
-- table do nothing.

-- Field
DEFINE FIELD endpoint_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Denormalized terminal output shapes accumulated from path_activities[*].output_shapes. Indexed for shape-keyed lookup. See OpenSpec change 2026-04-26-shape-provider-goal-creation.";

-- Index for shape-keyed lookup
DEFINE INDEX idx_goal_paths_endpoint_shapes
  ON goal_execution_paths FIELDS endpoint_output_shapes;

-- Backfill: for each row with no endpoint_output_shapes, look up the
-- activities referenced by path_activities, pull their output_shapes,
-- flatten and dedupe. Mirrors the in-memory accumulation in
-- predictEndpointState.
UPDATE goal_execution_paths
SET endpoint_output_shapes = array::distinct(array::flatten(
  (SELECT VALUE output_shapes FROM activity WHERE id INSIDE $parent.path_activities)
))
WHERE endpoint_output_shapes IS NONE;
