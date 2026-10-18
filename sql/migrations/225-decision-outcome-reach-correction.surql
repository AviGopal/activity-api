-- Migration 225: decision_outcome.reach_correction — the provenance of a retracted reach.
--
-- A recorded correction (src/lib/reach-correction.ts) retracts a latched reach:false to ungraded; the
-- decision_outcome row the verdict fed is cleared through the same writer (lib/decision-credit.ts,
-- correctExecutionDecisionOutcome): `reached` -> NONE, and this field records why, so the clear is
-- never anonymous and its inverse can restore exactly what was there:
--   { correction_of, list_sha, rule, commit, prior_reached, at, inverse?, restored_at? }
-- decision_outcome is SCHEMAFULL (migration 201), so an undeclared field would be dropped silently.
-- Idempotent: OVERWRITE, safe to re-run on every unit start.
DEFINE FIELD OVERWRITE reach_correction ON decision_outcome TYPE option<object> FLEXIBLE;
