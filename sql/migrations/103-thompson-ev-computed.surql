-- Phase 10 P3 of 2026-04-26-impulse-activity-loop: COMPUTED `ev` field on
-- every α/β posterior table.
--
-- `ev` = α / (α + β) — the Beta-distribution mean, i.e. Thompson posterior
-- expected value. Defining it as a SurrealDB VALUE field means it
-- re-evaluates on every CREATE/UPDATE that touches the underlying α/β
-- pair, so a single atomic SET clause that bumps thompson_alpha bumps ev
-- in the same statement. No JS-side aggregation, no stale-cache window.
--
-- Two field-name conventions in the schema, hence two stanzas:
--   thompson_alpha / thompson_beta family: activity_template,
--     goal_execution_paths, variant_performance_metrics, activity,
--     prerequisite_patterns, goal_paths
--   alpha / beta family: impulse_shape_activity_score, composition_edge,
--     context_thompson_scores, discovered_state_pattern,
--     activity_state_affinity, thompson_selection_log
--
-- The `?? 1` fallback keeps ev=0.5 (uniform Beta(1,1)) on rows with no
-- prior writes rather than dividing by zero. Idempotent: SurrealDB's
-- DEFINE FIELD is a no-op when the definition is unchanged.

-- ── thompson_alpha / thompson_beta family ─────────────────────────────

DEFINE FIELD IF NOT EXISTS ev ON activity_template
  VALUE (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean = α/(α+β). Computed by SurrealDB on every UPDATE that touches thompson_alpha or thompson_beta. Replaces JS-side EV aggregation; see ORDER BY ev DESC in recommend route.";

DEFINE FIELD IF NOT EXISTS ev ON goal_execution_paths
  VALUE (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for goal-path Thompson posterior. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON variant_performance_metrics
  VALUE (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for variant-level Thompson posterior. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON activity
  VALUE (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean on the paradigm activity table. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON prerequisite_patterns
  VALUE (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for prerequisite-pattern Thompson posterior. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON goal_paths
  VALUE (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1))
  COMMENT "Beta posterior mean for legacy goal_paths table. See activity_template.ev.";

-- ── alpha / beta family ──────────────────────────────────────────────

DEFINE FIELD IF NOT EXISTS ev ON impulse_shape_activity_score
  VALUE (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for shape-conditioned activity scoring. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON composition_edge
  VALUE (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for composition-edge transition success. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON context_thompson_scores
  VALUE (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for context-bucketed Thompson scores. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON discovered_state_pattern
  VALUE (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for discovered state-transition pattern. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON activity_state_affinity
  VALUE (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean for activity-state affinity. See activity_template.ev.";

DEFINE FIELD IF NOT EXISTS ev ON thompson_selection_log
  VALUE (alpha ?? 1) / ((alpha ?? 1) + (beta ?? 1))
  COMMENT "Beta posterior mean snapshot at the moment of selection. See activity_template.ev.";

-- ── Indexes for ORDER BY ev DESC paths ───────────────────────────────
-- Recommend endpoints sort templates by ev. The activity_template index
-- is the hot path; others are added pre-emptively for forthcoming
-- shape-conditioned and goal-path recommend variants.

DEFINE INDEX IF NOT EXISTS idx_activity_template_ev
  ON activity_template FIELDS ev;

DEFINE INDEX IF NOT EXISTS idx_goal_execution_paths_ev
  ON goal_execution_paths FIELDS ev;

DEFINE INDEX IF NOT EXISTS idx_variant_performance_metrics_ev
  ON variant_performance_metrics FIELDS ev;

DEFINE INDEX IF NOT EXISTS idx_impulse_shape_activity_score_ev
  ON impulse_shape_activity_score FIELDS ev;
