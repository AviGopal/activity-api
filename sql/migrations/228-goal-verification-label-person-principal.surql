-- Migration 228: the person fields of labeled_by_principal on goal_verification_labels.
--
-- Migration 219 stamps a human label with the KEY that wrote it. A person signed in on a surface
-- writes through an on-behalf-of token instead: identity validated the person's login token as the
-- caller and the surface's key as the actor, so there is no caller key to name. The label writer
-- (src/routes/goal-verification-label-write.ts, isPersonSessionPrincipal) stamps such a label with
-- the person, derived from the validated credential only:
--
-- labeled_by_principal.user_id       the signed-in person's user id
-- labeled_by_principal.caller_type   'session' (the credential kind identity validated)
-- labeled_by_principal.actor_key_id  the key of the surface that wrote on the person's behalf
-- labeled_by_principal.aud           '<node>/<shape>' the on-behalf-of token was bound to
--
-- The table is SCHEMAFULL, so undeclared subfields would be dropped silently. Every subfield is
-- option<> with NO ASSERT, for the reason 219 gives; the writer THROWs (rolled back) a person label
-- whose user_id or caller_type did not land, instead of relying on the schema to.
-- CHEAP ON BOOT: field definitions only, no rows rewritten.

DEFINE FIELD OVERWRITE labeled_by_principal.user_id ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE labeled_by_principal.caller_type ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE labeled_by_principal.actor_key_id ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE labeled_by_principal.aud ON goal_verification_labels TYPE option<string>;
