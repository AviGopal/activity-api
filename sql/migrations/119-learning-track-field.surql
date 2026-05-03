-- Migration 119: learning_track and last_classified_at fields on activity_template and activity
-- The learning-track-classifier job (src/jobs/learning-track-classifier.ts) assigns one of:
--   unclassified — default; classifier has not yet seen enough samples
--   learning     — template produces tasks/shapes; traces feed Thompson posteriors as normal
--   system       — template is bookkeeping (zero tasks, zero shapes); traces route to
--                  execution_system_traces and are excluded from posterior updates structurally
-- Numbered 119 (not 118) to reserve 118 for the gated Phase D content-field drop.
-- Uses DEFINE FIELD OVERWRITE for idempotent reruns (migration 102 / 093/094 pattern).
-- Reversible: REMOVE FIELD learning_track ON activity_template (and activity)
--             REMOVE FIELD last_classified_at ON activity_template (and activity)

USE NS `activity-system` DB `learning_loop`;

DEFINE FIELD OVERWRITE learning_track ON activity_template
  TYPE string
  VALUE $value OR 'unclassified'
  ASSERT $value IN ['unclassified', 'learning', 'system'];

DEFINE FIELD OVERWRITE last_classified_at ON activity_template
  TYPE option<datetime>;

DEFINE FIELD OVERWRITE learning_track ON activity
  TYPE string
  VALUE $value OR 'unclassified'
  ASSERT $value IN ['unclassified', 'learning', 'system'];

DEFINE FIELD OVERWRITE last_classified_at ON activity
  TYPE option<datetime>;
