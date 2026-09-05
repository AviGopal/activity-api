-- Migration 210: declare execution_traces.org_id and .ci_status
--
-- `execution_traces` is SCHEMAFULL and carries 12 live fields. Two more are declared in older
-- migrations but do not exist in the live schema, so any write to them is DISCARDED silently —
-- SurrealDB returns success:true and HTTP 200 and drops the value:
--
--     org_id     declared in 068-complete-permissions-coverage.surql
--     ci_status  declared in 005-ci-integration.surql
--
-- Both source migrations are already recorded in init_migrations, so they will never run
-- again; the declarations have to be reissued under a new filename. Found by the
-- declaration-drift scan (schema_assert_drift_scan.declaration_drift), which diffs every
-- DEFINE FIELD in sql/ against INFO FOR TABLE.
--
-- Currently inert: execution_traces has zero rows, so nothing has been lost. This is latent
-- drift, fixed before it matters rather than after.
--
-- BOTH FIELDS ARE option<>, DELIBERATELY. A bare non-optional field with no DEFAULT on a
-- SCHEMAFULL table makes SurrealDB reject every write that omits it. That is not hypothetical:
-- migration 205 did exactly this to `activity` earlier today and took the trace store offline
-- for 35 minutes and 156 validation errors.
--
-- REWRITTEN BY OPERATOR. The composed version of this file was:
--
--     DEFINE FIELD org_id OPTION STRING IF NOT EXISTS ON execution_traces;
--
-- which is not SurrealDB — `OPTION STRING` appears in zero of the 217 .surql files in this
-- tree, `IF NOT EXISTS` belongs before the name, and `ON <table>` before the TYPE clause. It
-- could not have executed. The gate that should have refused it abstained, and has been fixed
-- to fail closed on a DEFINE FIELD that does not parse as one (development-vessel 9dbdd58).

DEFINE FIELD IF NOT EXISTS org_id ON execution_traces TYPE option<string>
  COMMENT "Owning organisation; declared in 068 but absent from the live schema until now";

DEFINE FIELD IF NOT EXISTS ci_status ON execution_traces TYPE option<string>
  COMMENT "CI status for the trace; declared in 005 but absent from the live schema until now";
