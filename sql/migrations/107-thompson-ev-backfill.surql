-- Phase 10 P3 follow-up: backfill the COMPUTED `ev` field on existing rows.
--
-- Migration 103 added `DEFINE FIELD ev ON <table> VALUE α/(α+β)` clauses
-- on 12 posterior tables. SurrealDB's VALUE expression only fires on
-- CREATE / UPDATE, so rows that already existed at migration time still
-- carry whatever `ev` was (default 0 for SCHEMAFULL tables) until they
-- get touched again. Acceptance probe 10.S2 caught this:
-- /v2/activities/templates returns `ev: 0` for α=1, β=1 rows where the
-- expected mean is 0.5.
--
-- A naive `UPDATE … SET <field> = <field>` triggers SCHEMAFULL re-
-- validation of ALL fields on the row — and on legacy pre-Phase-B
-- rows the `account_id_version` field is NONE while the schema
-- requires `int`. The first attempt at this migration got rejected
-- with "Expected `int` but found `NONE`" on 3 tables. We coerce
-- `account_id_version` to 1 in the same SET clause so the
-- validation passes; rows that already have a version keep theirs
-- via the `?? account_id_version` fallback.
--
-- Each table runs as its own statement so a failure on one (e.g. a
-- table that doesn't carry account_id_version) doesn't block the
-- others. RETURN NONE so the migration log stays compact.
--
-- Idempotent: re-running re-touches every row, recomputes ev to the
-- same value, and converges account_id_version to 1 where it was
-- still NONE.

UPDATE activity_template SET thompson_alpha = thompson_alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE goal_execution_paths SET thompson_alpha = thompson_alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE variant_performance_metrics SET thompson_alpha = thompson_alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE activity SET thompson_alpha = thompson_alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE prerequisite_patterns SET thompson_alpha = thompson_alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE goal_paths SET thompson_alpha = thompson_alpha, account_id_version = account_id_version ?? 1 RETURN NONE;

UPDATE impulse_shape_activity_score SET alpha = alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE composition_edge SET alpha = alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE context_thompson_scores SET alpha = alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE discovered_state_pattern SET alpha = alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE activity_state_affinity SET alpha = alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
UPDATE thompson_selection_log SET alpha = alpha, account_id_version = account_id_version ?? 1 RETURN NONE;
