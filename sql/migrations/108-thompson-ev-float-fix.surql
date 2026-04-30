-- Phase 10 P3 follow-up #2: redefine `ev` with float arithmetic.
--
-- 10.S2 acceptance probe (after migration 107 backfill) still showed
-- ev=0 for α=1, β=1 rows. Root cause: SurrealDB does INTEGER division
-- when both operands are int (1 / 2 = 0). The VALUE clause from
-- migration 103 was `(thompson_alpha ?? 1) / ((thompson_alpha ?? 1) +
-- (thompson_beta ?? 1))` — α and β are stored as `option<number>`
-- which surfaces as int when the original write was 1, so the divide
-- truncates to 0.
--
-- Fix: multiply by 1.0 inside the VALUE expression to force float
-- arithmetic. SurrealDB's number coercion promotes int to float when
-- either operand is float, so `1.0 * α / (α + β)` yields the correct
-- mean.
--
-- DEFINE FIELD with the same name overwrites the prior VALUE clause
-- (SurrealDB does not require DROP FIELD first). Re-running migration
-- 107's UPDATE-touch immediately after each redefinition forces the
-- new VALUE to evaluate against existing rows.

-- thompson_alpha/thompson_beta family
DEFINE FIELD ev ON activity_template
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean = α/(α+β). Float-promoted via *1.0 to avoid integer division.";
DEFINE FIELD ev ON goal_execution_paths
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for goal-path Thompson posterior.";
DEFINE FIELD ev ON variant_performance_metrics
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for variant-level Thompson posterior.";
DEFINE FIELD ev ON activity
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean on the paradigm activity table.";
DEFINE FIELD ev ON prerequisite_patterns
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for prerequisite-pattern Thompson posterior.";
DEFINE FIELD ev ON goal_paths
  VALUE 1.0 * (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for legacy goal_paths table.";

-- alpha/beta family
DEFINE FIELD ev ON impulse_shape_activity_score
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for shape-conditioned activity scoring.";
DEFINE FIELD ev ON composition_edge
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for composition-edge transition success.";
DEFINE FIELD ev ON context_thompson_scores
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for context-bucketed Thompson scores.";
DEFINE FIELD ev ON discovered_state_pattern
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for discovered state-transition pattern.";
DEFINE FIELD ev ON activity_state_affinity
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for activity-state affinity.";
DEFINE FIELD ev ON thompson_selection_log
  VALUE 1.0 * (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean snapshot at the moment of selection.";

-- Re-touch the hot-path tables so the new float VALUE expression
-- evaluates and overwrites the integer-divided ev=0 from 103.
UPDATE activity_template SET updated_at = time::now() RETURN NONE;
UPDATE goal_execution_paths SET updated_at = time::now() RETURN NONE;
UPDATE variant_performance_metrics SET updated_at = time::now() RETURN NONE;
UPDATE activity SET updated_at = time::now() RETURN NONE;
UPDATE prerequisite_patterns SET updated_at = time::now() RETURN NONE;
UPDATE goal_paths SET updated_at = time::now() RETURN NONE;
UPDATE impulse_shape_activity_score SET updated_at = time::now() RETURN NONE;
