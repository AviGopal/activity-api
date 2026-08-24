-- Migration 202: decision_outcome — universal per-execution capture (law 12).
--
-- Migration 201 captured a decision→outcome row ONLY when the execution carried a
-- `correlation:<id>` tag joinable to thompson_selection_log — i.e. only for the
-- /recommend-driven draw path. But the substrate executes goals PREDOMINANTLY via
-- shape-graph WALKS and PATHWAY-REUSE, which select producers through
-- discover-by-shapes (which does NOT write thompson_selection_log) — so those
-- executions had no selection row to join and decision_outcome stayed effectively
-- empty (measured 2026-08-24: 0 organic rows). The join mechanism was correct but
-- attributed a model — one recommend draw per execution — that is now a minority of
-- how the substrate runs.
--
-- This migration makes capture UNIVERSAL: every reach-graded execution is itself a
-- decision (run activity A) with a prediction (A's posterior mean at outcome time)
-- and an outcome (reached?). recordExecutionDecisionOutcome writes one such row keyed
-- on execution_id. `source` distinguishes the two capture paths; `execution_id`
-- carries the natural key for the execution-sourced rows. Additive + observational —
-- still nothing reads this table for credit, so an empty or mixed table is
-- behavior-preserving.
--
-- For execution-sourced rows the required-string correlation_id field holds the
-- execution_id (globally unique, format `exec_*` — never collides with a `sel_*`
-- selection correlation), so the existing UNIQUE index needs no change.

DEFINE FIELD OVERWRITE source        ON decision_outcome TYPE option<string>;
DEFINE FIELD OVERWRITE execution_id  ON decision_outcome TYPE option<string>;

DEFINE INDEX OVERWRITE idx_decision_outcome_execution ON decision_outcome FIELDS execution_id;
DEFINE INDEX OVERWRITE idx_decision_outcome_source ON decision_outcome FIELDS source;
