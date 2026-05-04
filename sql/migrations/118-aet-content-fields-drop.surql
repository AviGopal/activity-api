-- Migration 118: Drop content fields from activity_execution_traces and execution (GATED)
-- Phase D of trace-storage-redesign. Only run after:
--   1. Phase B dual-write (migration 114-117 + code) has been live in production
--   2. Phase C read-fallback is deployed and content_source="legacy" log volume is zero over 24h
--   3. Operator confirms via runbook in design.md §9
-- This migration is IRREVERSIBLE for pre-Phase-D rows: dropped fields cannot be recovered.
-- The feature_flag check below makes this a no-op until the operator flips the gate.
-- Operator runbook: INSERT INTO feature_flag { id: 'phase_d_content_drop', enabled: true }
--   (note: SurrealDB 3.x auto-types the id as a record reference; use INSERT not UPDATE)

USE NS `activity-system` DB `learning_loop`;

-- SurrealDB 3.x: record IDs are typed references, not strings.
-- Compare against the full record reference feature_flag:phase_d_content_drop, not 'phase_d_content_drop'.
LET $gate = (SELECT enabled FROM feature_flag WHERE id = feature_flag:phase_d_content_drop LIMIT 1)[0].enabled;

-- Per-field existence guard makes this idempotent on re-runs.
-- Migration 094 (DEFINE FIELD OVERWRITE impulse_resolutions) re-adds that field on every
-- startup before this migration runs; the guard removes it cleanly on each run.
IF $gate = true THEN {
  LET $aet = (INFO FOR TABLE activity_execution_traces).fields;
  IF $aet.tasks              IS NOT NONE THEN REMOVE FIELD tasks              ON activity_execution_traces END;
  IF $aet.state_snapshot     IS NOT NONE THEN REMOVE FIELD state_snapshot     ON activity_execution_traces END;
  IF $aet.execution_trace    IS NOT NONE THEN REMOVE FIELD execution_trace    ON activity_execution_traces END;
  IF $aet.impulse_resolutions IS NOT NONE THEN REMOVE FIELD impulse_resolutions ON activity_execution_traces END;
  IF $aet.output_impulses    IS NOT NONE THEN REMOVE FIELD output_impulses    ON activity_execution_traces END;

  LET $exec = (INFO FOR TABLE execution).fields;
  IF $exec.trace IS NOT NONE THEN REMOVE FIELD trace ON execution END;
} END;
