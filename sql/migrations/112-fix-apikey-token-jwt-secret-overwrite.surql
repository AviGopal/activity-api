-- Phase 12 follow-up: re-define apikey_token ACCESS with current JWT_SECRET.
--
-- Live probe (2026-05-01): activity-api's own freshly-minted JWT — signed
-- with the runtime JWT_SECRET that env and src/config.ts agree on —
-- fails `db.authenticate(jwt)` against the canary SurrealDB with "The
-- access method cannot be used in the requested operation". JWT shape
-- is correct (HS512, AC=apikey_token, NS+DB set), so the only remaining
-- mismatch is the signing secret: the persisted ACCESS schema still
-- carries a KEY substituted from an earlier deployment's JWT_SECRET.
--
-- DEFINE ACCESS in 000-auth-schema.surql uses IF NOT EXISTS, which is a
-- no-op on subsequent deploys — the KEY never refreshes even when the
-- env-var-driven JWT_SECRET rotates. Migrations 069 and 079 hit similar
-- patches but landed before the persistence drift was fully understood.
--
-- DEFINE ACCESS OVERWRITE forces re-definition. The init-database.ts
-- runner substitutes `__JWT_SECRET__` with the current `process.env
-- .JWT_SECRET` at apply time, so this migration always installs the
-- live secret. Idempotent: re-running just rewrites the same KEY value
-- against the same schema row.
--
-- Re-aligning the apikey_token KEY unblocks Phase 12 pool activation
-- (queryWithAuth via authenticated sessions) and the recommend
-- relevance fix's FTS+dense blend (currently bypassing JWT auth via
-- the null-jwtToken workaround in commit b9cdbc2). Once this lands the
-- workaround can be reverted.

DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT
  ALGORITHM HS512
  KEY '__JWT_SECRET__'
  DURATION FOR TOKEN 15m, FOR SESSION 1h;
