-- Migration 206: repair the six field types 205 created as NON-OPTIONAL
--
-- URGENT — 205 broke every write to `activity`.
--
-- At 2026-09-05T10:02:25 an intermediate draft of 205 was applied
-- ("[Migration] ✓ 205-restore-fields-lost-to-unapplied-migrations.surql applied
-- successfully (6 statements)") and created six fields with NON-OPTIONAL types:
--
--     retired_at        TYPE datetime   (055 declares option<datetime>)
--     retired_reason    TYPE string     (055 declares option<string>)
--     variant_reason    TYPE string     (055 declares option<string>)
--     input_schema      TYPE object     (048 declares option<object> FLEXIBLE)
--     output_schema     TYPE object     (048 declares option<object> FLEXIBLE)
--     schema_confidence TYPE float      (048 declares option<float>)
--
-- `activity` is SCHEMAFULL and holds 3,886 rows in which all six are NONE. A
-- non-option field with no DEFAULT makes SurrealDB reject any write to a record
-- that does not supply it, so EVERY update now fails:
--
--     UPDATE activity SET updated_at = time::now() WHERE ...
--     -> "Found NONE for field `input_schema`, with record `activity:⟨...⟩`,
--         but expected a object"
--
-- Measured: 156 validation errors in 35 minutes; the classifier fails on every
-- template it touches ("[classifier] classifyOneTemplate failed; skipping").
-- This is the trace store's core table, so the learning loop cannot record arm
-- updates while it persists.
--
-- WHY A NEW FILE. 205 is recorded in init_migrations (applied_at 10:02:25), so
-- init-database logs "⏭ Skipping 205-... (already applied)" and will never run
-- any content under that filename again — including the corrected body pushed as
-- 41266ae. A new number is the only way a repair can execute.
--
-- WHY OVERWRITE RATHER THAN IF NOT EXISTS. The six fields already exist with the
-- wrong types. IF NOT EXISTS would be a no-op. OVERWRITE replaces the definition
-- in place; it does not touch row data and drops nothing.
--
-- Types below match the original declarations in migrations/055-variant-tracking
-- and schemas/048-goal-execution-alignment.
--
-- Falsifier: after this applies, `UPDATE activity SET updated_at = time::now()`
-- on any row must return status OK, and an activityTemplate_deprecate must
-- persist retired_reason='deprecate_impulse' instead of null.

DEFINE FIELD OVERWRITE variant_reason ON activity TYPE option<string>
  COMMENT "Reason this variant was created (e.g., 'consecutive_failures', 'manual_improvement')";

DEFINE FIELD OVERWRITE retired_at ON activity TYPE option<datetime>
  COMMENT "When this template was retired";

DEFINE FIELD OVERWRITE retired_reason ON activity TYPE option<string>
  COMMENT "Reason for retirement (e.g., 'poor_performance', 'superseded_by_variant')";

DEFINE FIELD OVERWRITE input_schema ON activity TYPE option<object> FLEXIBLE
  COMMENT "Structured input schema: {required: ImpulseShape[], optional?: ImpulseShape[]}";

DEFINE FIELD OVERWRITE output_schema ON activity TYPE option<object> FLEXIBLE
  COMMENT "Structured output schema: {produces: ImpulseShape[]}";

DEFINE FIELD OVERWRITE schema_confidence ON activity TYPE option<float>
  COMMENT "Confidence score (0.0-1.0) for extracted schemas. <0.5 triggers warning, <0.7 treated as hints.";
