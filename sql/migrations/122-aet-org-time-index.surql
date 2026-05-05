-- Migration 122: Add (org_id, executed_at) index on activity_execution_traces
-- Motivation: GET /v2/activities/execution-traces without activity_id filter does a
-- full table scan for "WHERE org_id = $x AND executed_at >= $t ORDER BY executed_at DESC".
-- The existing idx_aet_org_activity_success_time cannot satisfy this because it requires
-- activity_id after org_id in the prefix. Result: 20s+ response on tables >10k rows,
-- hitting Cloudflare 504. A leading (org_id, executed_at) index allows SurrealDB to
-- do a range scan on the date window and avoid the full scan (F-129).
-- Reversible: REMOVE INDEX idx_aet_org_time ON activity_execution_traces

USE NS `activity-system` DB `learning_loop`;

DEFINE INDEX OVERWRITE idx_aet_org_time
  ON activity_execution_traces
  FIELDS org_id, executed_at;
