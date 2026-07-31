-- Relax the goal_verification_labels.labeler assert to admit 'deterministic'.
-- goal-host emits labeler:'deterministic' for the automated reach oracle; the
-- SCHEMAFULL assert (migration 101) rejected it, 500ing every oracle-label write
-- (fire-and-forget on the caller, so the feed silently died since 2026-07-20).
DEFINE FIELD OVERWRITE labeler        ON goal_verification_labels TYPE string
  ASSERT $value IN ['human', 'automated', 'deterministic'];
