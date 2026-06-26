-- 147-aet-reached-fields.surql
--
-- Define the reach-gate verdict fields on activity_execution_traces so the
-- goal-host reach gate (verifyGoalReached) can persist its outcome back onto
-- the trace row. activity_execution_traces is SCHEMAFULL, so an undeclared
-- `reached`/`completion_shapes` UPDATE is SILENTLY DROPPED (same failure class
-- migration 145 fixed for `signature`, and 128 for `times_failed`).
--
-- WHY (2026-06-26): the verdict was computed in goal-host and used to mint /
-- β-penalise / record goal-paths, but never written to the AET — so the trace
-- carried only `status` (exit cleanliness), not `reached` (goal actually met).
-- Defining + writing it lets per-signature reach-rate be measured (join
-- `reached` against `signature`), which is the C6 selection-quality metric.
DEFINE FIELD OVERWRITE reached ON activity_execution_traces TYPE option<bool>;
DEFINE FIELD OVERWRITE completion_shapes ON activity_execution_traces TYPE option<array<string>>;
RETURN "Migration 147-aet-reached-fields completed";
