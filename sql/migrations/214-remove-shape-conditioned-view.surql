-- Migration 214: remove v_shape_conditioned_score. SEPARABLE: drop this file to keep the view.
--
-- After 213 nothing reads the view: getShapeConditionedScores and getActivityShapePatterns read
-- shape_score_counter, and no code in any repo reads its first_executed_at / last_executed_at
-- (the user-approved time-column drop). REMOVE is instant; redefining the view without the time
-- columns would rebuild it over all of `execution` (measured: a 300k-row build did not finish in
-- 27 min), far beyond this migration's 45 s budget. Removing it also ends the per-delete group
-- recompute that made retention deletes on `execution` cost hundreds of ms per row.
-- Reversible: the definition stays in sql/schemas/023-shape-conditioned-scores.surql (rebuild
-- out of band, as migration 212 documents).

REMOVE TABLE IF EXISTS v_shape_conditioned_score;
