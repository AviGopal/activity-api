-- Migration 213: shape_score_counter — the durable, reach-graded, shape-conditioned outcome counter.
--
-- Replaces v_shape_conditioned_score as the source of the shape-conditioned Thompson posterior
-- (src/lib/shape-score-counter.ts). The view counted EXIT STATUS (`execution.success`), which the
-- learner deliberately does not use (classifyReach grades by reach), and SurrealDB 2.3.3
-- mis-maintained it (alpha/beta columns wrong; whole groups dropped when a delete zeroed one count).
-- It is incremented exactly where applyOutcomeToPosteriors applies a variant_performance_metrics
-- delta (same guard, same classifyReach verdict, same deltas in alpha_sum/beta_sum) and is never
-- decremented.
--
--   shape_score_counter       one row per [activity_id, org_id, shape_signature] (record id)
--   shape_score_counted       one marker per counted execution (record id = execution id): the
--                             occasions counted (insert / reach / seed) — the idempotency key, written
--                             in the same transaction as the increment; deleted with its execution
--   shape_score_counter_seed  the seed job's progress/completion record (src/jobs/shape-score-counter-seed.ts)
--
-- CHEAP ON BOOT: empty tables, fields, indexes; no backfill (the seed is a bounded background job).
-- IF NOT EXISTS, never OVERWRITE/REMOVE, so a re-run cannot touch accumulated counts.

DEFINE TABLE IF NOT EXISTS shape_score_counter SCHEMAFULL
  PERMISSIONS FOR select WHERE org_id = $auth.org_id, FOR create, update, delete NONE;
DEFINE FIELD IF NOT EXISTS activity_id     ON shape_score_counter TYPE string;
DEFINE FIELD IF NOT EXISTS org_id          ON shape_score_counter TYPE string;
DEFINE FIELD IF NOT EXISTS shape_signature ON shape_score_counter TYPE array<string>;
DEFINE FIELD IF NOT EXISTS graded          ON shape_score_counter TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS reached         ON shape_score_counter TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS not_reached     ON shape_score_counter TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS alpha_sum       ON shape_score_counter TYPE float DEFAULT 0;
DEFINE FIELD IF NOT EXISTS beta_sum        ON shape_score_counter TYPE float DEFAULT 0;
DEFINE FIELD IF NOT EXISTS updated_at      ON shape_score_counter TYPE option<datetime>;
DEFINE INDEX IF NOT EXISTS idx_shape_score_counter_org_activity ON shape_score_counter FIELDS org_id, activity_id;
DEFINE INDEX IF NOT EXISTS idx_shape_score_counter_signature    ON shape_score_counter FIELDS shape_signature;

DEFINE TABLE IF NOT EXISTS shape_score_counted SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS eid          ON shape_score_counted TYPE string;
DEFINE FIELD IF NOT EXISTS occasions    ON shape_score_counted TYPE array<string>;
DEFINE FIELD IF NOT EXISTS occasions[*] ON shape_score_counted TYPE string;
DEFINE FIELD IF NOT EXISTS verdicts     ON shape_score_counted TYPE array<string>;
DEFINE FIELD IF NOT EXISTS verdicts[*]  ON shape_score_counted TYPE string;
DEFINE FIELD IF NOT EXISTS counted_at   ON shape_score_counted TYPE datetime;

DEFINE TABLE IF NOT EXISTS shape_score_counter_seed SCHEMALESS PERMISSIONS NONE;
