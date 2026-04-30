-- Phase 10 P3 follow-up #3: force redefinition of ev with OVERWRITE.
--
-- Migration 108's DEFINE FIELD statements were skipped by the
-- init-db runner ("12 statements already exist (skipped)") because
-- the runner detects the field already exists and treats the
-- statement as applied. SurrealDB's `DEFINE FIELD` without
-- OVERWRITE is silently a no-op when the field is already defined,
-- so the integer-division VALUE clause from migration 103 remained
-- active.
--
-- `DEFINE FIELD OVERWRITE` forces redefinition. The trailing
-- updated_at touches re-trigger the (now-correct, float-promoted)
-- VALUE expression on existing rows, producing the expected
-- α/(α+β) mean.

DEFINE FIELD OVERWRITE ev ON activity_template
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1));
DEFINE FIELD OVERWRITE ev ON goal_execution_paths
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1));
DEFINE FIELD OVERWRITE ev ON variant_performance_metrics
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1));
DEFINE FIELD OVERWRITE ev ON activity
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1));
DEFINE FIELD OVERWRITE ev ON prerequisite_patterns
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1));
DEFINE FIELD OVERWRITE ev ON goal_paths
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1));

DEFINE FIELD OVERWRITE ev ON impulse_shape_activity_score
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1));
DEFINE FIELD OVERWRITE ev ON composition_edge
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1));
DEFINE FIELD OVERWRITE ev ON context_thompson_scores
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1));
DEFINE FIELD OVERWRITE ev ON discovered_state_pattern
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1));
DEFINE FIELD OVERWRITE ev ON activity_state_affinity
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1));
DEFINE FIELD OVERWRITE ev ON thompson_selection_log
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1));

UPDATE activity_template SET updated_at = time::now() RETURN NONE;
UPDATE goal_execution_paths SET updated_at = time::now() RETURN NONE;
UPDATE variant_performance_metrics SET updated_at = time::now() RETURN NONE;
UPDATE activity SET updated_at = time::now() RETURN NONE;
UPDATE prerequisite_patterns SET updated_at = time::now() RETURN NONE;
UPDATE goal_paths SET updated_at = time::now() RETURN NONE;
UPDATE impulse_shape_activity_score SET updated_at = time::now() RETURN NONE;
