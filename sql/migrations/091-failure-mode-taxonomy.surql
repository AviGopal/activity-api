-- Failure mode taxonomy: structured object recorded on execution traces.
-- Null for legacy traces (pre-2026-04-26). See OpenSpec change
-- 2026-04-26-validators-and-failure-modes.
--
-- The shape is enforced at the API layer by FailureModeSchema (a zod
-- discriminated union over `type`). Stored as `option<object>` here so
-- the database does not constrain future taxonomy evolution and so that
-- legacy rows remain valid (no backfill required).
--
-- Idempotent: SurrealDB's DEFINE FIELD is a no-op when the field is
-- already defined with the same type.

DEFINE FIELD failure_mode ON activity_execution_traces TYPE option<object>
  COMMENT "Structured failure mode taxonomy. Null for legacy traces.";
