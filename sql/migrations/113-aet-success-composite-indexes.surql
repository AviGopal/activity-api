-- Migration 113: Composite success indexes on activity_execution_traces and execution
-- Motivation: WHERE success = true ORDER BY executed_at DESC triggers TableScan on AET
-- because migration 102 indexes do not cover `success`. The `execution` table already has
-- idx_execution_success and idx_execution_org_success_time but lacks the activity_id-leading
-- composite needed for per-template exemplar recall.
-- Reversible: REMOVE INDEX idx_aet_activity_success_time ON activity_execution_traces
--             REMOVE INDEX idx_aet_org_activity_success_time ON activity_execution_traces
--             REMOVE INDEX idx_execution_activity_success_time ON execution

USE NS `activity-system` DB `learning_loop`;

DEFINE INDEX OVERWRITE idx_aet_activity_success_time
  ON activity_execution_traces
  FIELDS activity_id, success, executed_at;

DEFINE INDEX OVERWRITE idx_aet_org_activity_success_time
  ON activity_execution_traces
  FIELDS org_id, activity_id, success, executed_at;

DEFINE INDEX OVERWRITE idx_execution_activity_success_time
  ON execution
  FIELDS activity_id, success, executed_at;
