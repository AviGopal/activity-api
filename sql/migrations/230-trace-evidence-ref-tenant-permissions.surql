-- Migration 230: trace_evidence_ref is written by callers, so its rows are tenant-scoped.
--
-- Migration 220 defined trace_evidence_ref PERMISSIONS NONE with no writer: retention (root) reads it to keep the
-- executions an open reference cites. Its first writer is trace_evidence_ref_write (routes/trace-evidence-ref-write.ts,
-- a person-verdict deferral protecting its run). A caller-written row that keeps another org's executions from
-- pruning is a cross-tenant retention effect, so a token session may now select, create and update only rows of its
-- own org. The writer stamps org_id from the validated context and refuses a reference to an execution that is not
-- the caller's org (checked as the caller); writes on root credentials (API keys) never evaluate PERMISSIONS, so that
-- ownership check is what binds them.
--
-- Same prefix-tolerant comparison as migration 229: a token's org_id is "organizations:<slug>", the validated
-- context strips the prefix. delete stays NONE (a reference is closed with open = false, never deleted by a caller).
-- Retention reads with root credentials, so its read is unaffected.
--
-- Form: 220's table definition with only the PERMISSIONS changed; SCHEMALESS is kept and the index is a separate
-- definition, untouched. A table definition only, no rows rewritten (cheap on boot; rows survive, as 229 measured
-- for OVERWRITE on 2.3.10).

DEFINE TABLE OVERWRITE trace_evidence_ref SCHEMALESS
  PERMISSIONS
    FOR select, create, update WHERE
      org_id = $token.org_id
      OR org_id = string::replace(type::string($token.org_id), 'organizations:', '')
    FOR delete NONE;
