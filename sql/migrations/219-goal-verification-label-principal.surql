-- Migration 219: labeled_by_principal on goal_verification_labels.
--
-- goal-host's oracle-label consumer turns a labeler "human" row into a reach override and a
-- human_reported disagreement gap. The labeler string was caller-supplied, so any authenticated key
-- (a goal walk using goal-host's fleet key included) could write one. The label writer
-- (src/routes/goal-verification-label-write.ts) now accepts labeler "human" only from a credential
-- whose SERVER-VALIDATED scopes carry "verdict:human" (or "admin"), and stamps that credential here.
-- The consumer acts on a human row only when this stamp carries one of those scopes, so a row
-- without it (every row written before this migration) is ignored.
--
-- labeled_by_principal.key_id    identity's id for the validated key (never derived from the secret)
-- labeled_by_principal.auth_type 'apikey' | 'jwt' | 'minibob_token'
-- labeled_by_principal.scopes    the scopes the credential was validated with
--
-- Written only on human labels. Every subfield is option<> and there is NO ASSERT, deliberately:
-- migration 101's ASSERT on labeler made every write from a new labeler 500, and label writers are
-- fire-and-forget, so the corpus died silently. The writer refuses (THROW, rolled back) a human
-- label whose principal did not land, instead of relying on the schema to.
-- CHEAP ON BOOT: field definitions only, no rows rewritten.

DEFINE FIELD OVERWRITE labeled_by_principal ON goal_verification_labels TYPE option<object>;
DEFINE FIELD OVERWRITE labeled_by_principal.key_id ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE labeled_by_principal.auth_type ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE labeled_by_principal.scopes ON goal_verification_labels TYPE option<array<string>>;
