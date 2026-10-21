-- Migration 226: principal_kind and principal_key_id on goal_verification_labels.
--
-- A label is oracle corpus, and only a human label named its writer (labeled_by_principal, migration
-- 219); an automated or deterministic row carried no credential at all, and `labeler` is caller-
-- declared. The label writer (src/routes/goal-verification-label-write.ts) now refuses a credential
-- without the write scope and stamps EVERY label it writes with who wrote it, built from the
-- server-validated caller, never from the request body:
--
-- principal_kind    'obo' | 'admin' | 'key' | 'session' (else the auth type)
-- principal_key_id  identity's key id masked to "key_" plus the next 8 characters
--
-- The table is SCHEMAFULL, so undeclared fields would be dropped silently. Both are option<> with
-- NO ASSERT, deliberately: migration 101's ASSERT on labeler made every write from a new labeler
-- 500, and label writers are fire-and-forget, so the corpus died silently. Rows written before this
-- migration keep no value for either (NONE): unattributed, not attributed to anyone.
-- CHEAP ON BOOT: field definitions only, no rows rewritten.

DEFINE FIELD OVERWRITE principal_kind ON goal_verification_labels TYPE option<string>;
DEFINE FIELD OVERWRITE principal_key_id ON goal_verification_labels TYPE option<string>;
