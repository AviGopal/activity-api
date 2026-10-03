-- Migration 216: calibration fields on goal_verification_labels.
--
-- A blind calibration sheet (human-surface) asks a human to judge sealed runs so the judge's
-- accuracy can be measured. Those verdicts land in this table like any other human label, but
-- they must INFLUENCE NOTHING: readers that turn labels into overrides, gaps or credit (goal-host's
-- oracle-label consumer) skip rows whose purpose is 'calibration'. That works only if the purpose
-- reaches the row, and this table is SCHEMAFULL, so an undefined field is never stored.
--
-- purpose        — 'calibration' for a blind-calibration verdict; absent for an ordinary label.
-- window_id      — the calibration window the sample was drawn in.
-- sample_draw_id — the draw that selected this sealed run.
--
-- option<string> and NO ASSERT, deliberately: migration 101's ASSERT on labeler made every write
-- from a new labeler 500, and because label writers are fire-and-forget the corpus died silently.
-- An unrecognised purpose is stored; readers decide what it means.
-- CHEAP ON BOOT: three field definitions and one index, no rows rewritten.

DEFINE FIELD OVERWRITE purpose ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE window_id ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE sample_draw_id ON goal_verification_labels TYPE option<string>;

DEFINE INDEX IF NOT EXISTS gvl_purpose_idx ON goal_verification_labels FIELDS purpose;
