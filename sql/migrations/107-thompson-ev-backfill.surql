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
-- Prior versions:
--   v1: `UPDATE … SET <field> = <field>` triggered SCHEMAFULL re-validation
--       which caught NONE values on the account_id_version field and
--       failed for variant_performance_metrics, activity, and
--       impulse_shape_activity_score.
--   v2: added `account_id_version = account_id_version ?? 1` to coerce
--       legacy NONE values, but failed on tables that don't carry the
--       account_id_version field at all (activity_template, etc).
--
-- v3 (current): use `updated_at = time::now()` as the universal touch.
-- Every posterior table has updated_at as a datetime field; setting it
-- to time::now() triggers the row-level UPDATE that makes the VALUE
-- clause on `ev` recompute. This avoids referencing tenancy fields
-- whose presence varies by table.
--
-- For composition_edge / context_thompson_scores etc that also lack
-- updated_at, fall back to a self-assignment of one of their declared
-- fields. Each statement runs independently so a failure on one
-- doesn't block the others. RETURN NONE keeps the migration log
-- compact.
--
-- Idempotent: re-running just sets updated_at to a new time::now() and
-- recomputes ev to the same value.

-- thompson_alpha/thompson_beta family (all have updated_at).
UPDATE activity_template SET updated_at = time::now() RETURN NONE;
UPDATE goal_execution_paths SET updated_at = time::now() RETURN NONE;
UPDATE variant_performance_metrics SET updated_at = time::now() RETURN NONE;
UPDATE activity SET updated_at = time::now() RETURN NONE;
UPDATE prerequisite_patterns SET updated_at = time::now() RETURN NONE;
UPDATE goal_paths SET updated_at = time::now() RETURN NONE;

-- alpha/beta family. impulse_shape_activity_score has updated_at;
-- the others may not — fall back to self-assignment of `alpha`. If
-- a particular table also enforces account_id_version: int, those
-- rows will need a manual operator pass. For the immediate 10.S2
-- acceptance the activity_template + goal_execution_paths +
-- variant_performance_metrics paths above are the hot ones.
UPDATE impulse_shape_activity_score SET updated_at = time::now() RETURN NONE;
UPDATE composition_edge SET alpha = alpha RETURN NONE;
UPDATE context_thompson_scores SET alpha = alpha RETURN NONE;
UPDATE discovered_state_pattern SET alpha = alpha RETURN NONE;
UPDATE activity_state_affinity SET alpha = alpha RETURN NONE;
UPDATE thompson_selection_log SET alpha = alpha RETURN NONE;
