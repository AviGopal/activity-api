-- Migration 229: goal_verification_labels PERMISSIONS accept both org forms of a token session.
--
-- A token session's $token.org_id is a record reference, "organizations:<slug>": identity signs it that way, an
-- on-behalf-of database token copies it, and this repo's own session JWT builds it that way (src/services/auth.ts).
-- The label writer binds the row's org_id from the validated context, which strips the prefix
-- (src/middleware/jwtAuth.ts contextFromSessionClaims), so a row says "<slug>". Migration 101 compared the two
-- forms with plain equality, so every label written through a token session (a person signed in on a surface)
-- was refused by `FOR create`. A refused CREATE returns an empty result and no error (see migration 121).
-- Writes on root credentials (API keys) never evaluate PERMISSIONS, so only token sessions were affected.
--
-- The fix is the prefix-tolerant comparison migration 030 used on other tables: a row matches the token's org
-- in either form. A different org is still refused in both forms. update and delete stay NONE, as in 101.
--
-- Form: this is 101's full table definition with only the PERMISSIONS changed. Fields and indexes are separate
-- definitions and are untouched. Measured on SurrealDB 2.3.10 (the fleet engine) against a table that already
-- has rows and every field and index through 228: all 30 fields, 5 indexes and the row survived, and INFO FOR DB
-- showed the new PERMISSIONS. Migration 121 notes that SurrealDB 3 refuses DEFINE TABLE OVERWRITE on an existing
-- table; a port to 3 would use ALTER TABLE ... PERMISSIONS with the same clauses (also accepted on 2.3.10).
-- CHEAP ON BOOT: a table definition only, no rows rewritten.

DEFINE TABLE OVERWRITE goal_verification_labels SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $token.org_id
      OR org_id = string::replace(type::string($token.org_id), 'organizations:', '')
    FOR create WHERE
      org_id = $token.org_id
      OR org_id = string::replace(type::string($token.org_id), 'organizations:', '')
    FOR update NONE
    FOR delete NONE;
