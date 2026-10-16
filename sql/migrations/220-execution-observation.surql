-- Migration 220: execution_observation and trace_evidence_ref, the evidence retention keeps.
--
-- Retention may let a graded or labelled execution's trace BODY go, but its observation record is
-- written first, in the same transaction as the delete (src/services/trace-retention.ts, EVIDENCE):
--
--   execution_observation  one row per compacted execution (record id = the execution id):
--                          {execution_id, observation, instrument, horizon, code_version,
--                           code_version_status, at}
--   trace_evidence_ref     an in-store address for executions cited outside the store (the gap store
--                          and the attempt ledger live on development-vessel as files):
--                          {execution_id, source: 'gap' | 'attempt_ledger', ref, open}
--
-- WHY NEW TABLES (law 3; REALIGNMENT 13.4): trace_digest is reaped by the same retention, carries no
-- observation fields, and is written before the reach verdict exists; goal_verification_labels is the
-- oracle corpus that calibration reads; execution_trace_content is the body being deleted.
--
-- SCHEMALESS on purpose: a SCHEMAFULL table drops an undeclared field silently (e.g. code_version_status),
-- and these records are small and written by one code path. Not tenant data: read and written by the
-- retention sweep (root); PERMISSIONS NONE for record users.
-- IF NOT EXISTS, never OVERWRITE/REMOVE: a re-run cannot touch kept evidence.

DEFINE TABLE IF NOT EXISTS execution_observation SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS idx_execution_observation_execution_id ON execution_observation FIELDS execution_id;

DEFINE TABLE IF NOT EXISTS trace_evidence_ref SCHEMALESS PERMISSIONS NONE;
DEFINE INDEX IF NOT EXISTS idx_trace_evidence_ref_execution_id ON trace_evidence_ref FIELDS execution_id;
