-- Migration 205: restore six fields that were recorded as applied but never created
-- Purpose: `activity` is SCHEMAFULL, so a write to an undeclared field is DISCARDED
--          SILENTLY — SurrealDB returns success:true and HTTP 200 and drops the value.
-- Date: 2026-09-05
--
-- MEASURED, not assumed. Diffing every `DEFINE FIELD ... ON activity` in sql/ against
-- `INFO FOR TABLE activity` on the live store:
--
--     declared: 51    live: 54    MISSING: 6
--
-- The six cluster into exactly two source migrations, each missing ALL of its own fields:
--
--     migrations/055-variant-tracking.surql       retired_at, retired_reason, variant_reason
--     schemas/048-goal-execution-alignment.surql  input_schema, output_schema, schema_confidence
--
-- Both files are recorded in `init_migrations` at 2026-06-28T07:59:20.240Z and .244Z —
-- inside a single second that contains 37 rows. A genuine apply of 37 migrations cannot
-- finish in under a second; init-database.ts's own comment states that 048's aggregation
-- alone takes ~4s. The bootstrap path in init-database.ts pre-populates init_migrations
-- with every filename and returns true so the caller SKIPS applying them:
--
--     '[Init] ✓ init_migrations bootstrapped — this run will skip all existing migrations.'
--
-- So 048 and 055 are marked applied forever and will never run again, even though every
-- statement in them is IF NOT EXISTS and therefore safe to re-run.
--
-- OBSERVED CONSEQUENCE. Commit cc81c2d correctly added
-- `retired_at = time::now(), retired_reason = 'deprecate_impulse'` to the deprecate UPDATE.
-- A deprecate re-run at 09:37:31 on a binary verified to contain that literal moved
-- `updated_at` to 09:37:31 and left BOTH fields null. The commit is correct in source,
-- typechecked, deployed, and passing its own structural test — and inert in production,
-- because the destination columns do not exist. Retirement consequently cannot record WHY
-- an arm left the candidate pool, and retirement is the only brake on arm growth.
--
-- WHY A NEW FILE RATHER THAN RE-RUNNING 048/055: a new filename is absent from
-- init_migrations, so the runner applies it. Re-running the originals would require
-- deleting ledger rows, and 048 additionally contains DEFINE TABLE ... AS views whose
-- backfill has timed out the 45s startup budget before (see applySQLFile's comment on the
-- 300s revert and the resulting restart loop). This migration therefore restores ONLY the
-- field definitions — no indexes, no views — so it cannot hang a boot.
--
-- The definitions below are copied verbatim from 048 and 055. All are additive and
-- IF NOT EXISTS: no drops, no data change, idempotent on re-run.
--
-- Related gap: migrations-recorded-as-applied-without-running-so-schemafull-writes-vanish

-- ── from 055-variant-tracking.surql ──────────────────────────────────────────
DEFINE FIELD IF NOT EXISTS variant_reason ON activity TYPE option<string>
  COMMENT "Reason this variant was created (e.g., 'consecutive_failures', 'manual_improvement')";

DEFINE FIELD IF NOT EXISTS retired_at ON activity TYPE option<datetime>
  COMMENT "When this template was retired";

DEFINE FIELD IF NOT EXISTS retired_reason ON activity TYPE option<string>
  COMMENT "Reason for retirement (e.g., 'poor_performance', 'superseded_by_variant')";

-- ── from schemas/048-goal-execution-alignment.surql ──────────────────────────
DEFINE FIELD IF NOT EXISTS input_schema ON activity TYPE option<object> FLEXIBLE
  COMMENT "Structured input schema: {required: ImpulseShape[], optional?: ImpulseShape[]}";

DEFINE FIELD IF NOT EXISTS output_schema ON activity TYPE option<object> FLEXIBLE
  COMMENT "Structured output schema: {produces: ImpulseShape[]}";

DEFINE FIELD IF NOT EXISTS schema_confidence ON activity TYPE option<float>
  COMMENT "Confidence score (0.0-1.0) for extracted schemas. <0.5 triggers warning, <0.7 treated as hints.";
