-- Migration 118: Drop content fields from activity_execution_traces and execution (GATED)
-- Phase D of trace-storage-redesign. Only run after:
--   1. Phase B dual-write (migration 114-117 + code) has been live in production
--   2. Phase C read-fallback is deployed and content_source="legacy" log volume is zero over 24h
--   3. Operator confirms via runbook in design.md §9
-- This migration is IRREVERSIBLE for pre-Phase-D rows: dropped fields cannot be recovered.
-- The feature_flag check below makes this a no-op until the operator flips the gate.
-- Operator runbook: UPDATE feature_flag SET enabled = true WHERE id = 'phase_d_content_drop'

USE NS `activity-system` DB `learning_loop`;

LET $gate = (SELECT enabled FROM feature_flag WHERE id = 'phase_d_content_drop' LIMIT 1)[0].enabled;

IF $gate = true THEN {
  REMOVE FIELD tasks             ON activity_execution_traces;
  REMOVE FIELD state_snapshot    ON activity_execution_traces;
  REMOVE FIELD execution_trace   ON activity_execution_traces;
  REMOVE FIELD impulse_resolutions ON activity_execution_traces;
  REMOVE FIELD output_impulses   ON activity_execution_traces;

  REMOVE FIELD trace             ON execution;
} END;
