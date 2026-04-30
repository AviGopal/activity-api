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
-- Forcing a touch via `UPDATE … SET <existing-field> = <existing-field>`
-- triggers the VALUE recompute without changing any other state. Each
-- table touched separately so a transient failure on one doesn't block
-- the others. UPDATE returns are RETURN NONE so the migration log
-- doesn't dump the entire registry.
--
-- Idempotent: re-running just retriggers the recompute, which yields
-- the same `ev` for the same α/β.
--
-- For tables that don't carry an `ev` field today (e.g. they only
-- received it via 103) the UPDATE is still safe — the SET clause
-- references a field that exists on the row, and the VALUE clause on
-- ev recomputes implicitly.

UPDATE activity_template SET thompson_alpha = thompson_alpha RETURN NONE;
UPDATE goal_execution_paths SET thompson_alpha = thompson_alpha RETURN NONE;
UPDATE variant_performance_metrics SET thompson_alpha = thompson_alpha RETURN NONE;
UPDATE activity SET thompson_alpha = thompson_alpha RETURN NONE;
UPDATE prerequisite_patterns SET thompson_alpha = thompson_alpha RETURN NONE;
UPDATE goal_paths SET thompson_alpha = thompson_alpha RETURN NONE;

UPDATE impulse_shape_activity_score SET alpha = alpha RETURN NONE;
UPDATE composition_edge SET alpha = alpha RETURN NONE;
UPDATE context_thompson_scores SET alpha = alpha RETURN NONE;
UPDATE discovered_state_pattern SET alpha = alpha RETURN NONE;
UPDATE activity_state_affinity SET alpha = alpha RETURN NONE;
UPDATE thompson_selection_log SET alpha = alpha RETURN NONE;
