-- 188: Expected (planned) terminal output shapes on goal_execution_paths — the
-- sibling of endpoint_output_shapes, which carries the OBSERVED produced shapes.
-- Together they make the plan-vs-observed reconciliation a durable query instead
-- of a re-derivation from the pruning goal-host journal.
--
-- WHY a new field instead of repairing the endpoint_output_shapes join:
-- endpoint_output_shapes is populated by joining path_activities against the
-- `activity` table (JS accumulateEndpointShapes at read-time, and the mig-092
-- backfill UPDATE at write-time). Measured on the live hub (400 rows): ~62% of
-- path_activities entries are `satisfier:*` / resolver tokens that have NO row in
-- `activity`, so both joins match nothing. The mig-092 backfill therefore set
-- every row to [] (not NONE), and its `WHERE ... IS NONE` guard means a re-run
-- never repairs them — the field is frozen empty on 100% of rows. The join cannot
-- see satisfier picks by construction. The walk (goal-host) already holds the
-- produced AND expected shape sets for every pick type at record time, so the
-- producer sends them forward — no table join can recover what is not there.
--
-- There is intentionally NO backfill: the expected shapes for historical paths
-- lived only in the pruned journal and cannot be reconstructed. New rows written
-- after goal-host starts sending the field carry it; historical rows stay unset.
--
-- Idempotent: DEFINE FIELD/INDEX are no-ops when the definition is unchanged.

-- Field: expected/planned terminal shapes (the goal's target shape set, expanded
-- with walked input dependencies), as sent by goal-host recordGoalPath.
DEFINE FIELD expected_output_shapes ON goal_execution_paths TYPE option<array<string>>
  COMMENT "Planned terminal output shapes (goal target set) supplied by the goal-host walk at record time. Sibling of endpoint_output_shapes (observed produced shapes); together they make plan-vs-observed reconciliation a durable query. No backfill — historical values lived only in the pruned journal.";

-- Index for shape-keyed lookup, mirroring idx_goal_paths_endpoint_shapes.
DEFINE INDEX idx_goal_paths_expected_shapes
  ON goal_execution_paths FIELDS expected_output_shapes;
