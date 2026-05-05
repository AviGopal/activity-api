-- Migration 124: Add (org_id, executed_at) index to trace_digest
--
-- Problem: The existing idx_trace_digest_org_activity_time index is (org_id, activity_id, executed_at).
-- For time-range queries WHERE org_id = X AND executed_at > Y (without activity_id), the planner
-- must scan all rows for the org, then filter by executed_at. Under compaction load this is 800ms-3.8s
-- for 2,538 rows. A dedicated (org_id, executed_at) index allows the planner to use the executed_at
-- range as part of the index scan, expected improvement to <100ms.
--
-- Also adds (org_id, executed_at) to execution_exemplar for future org-scoped exemplar queries
-- (currently all exemplars are org_id='public' but this guards future changes).

USE NS `activity-system`;
USE DB `learning_loop`;

-- trace_digest: org + time index for dashboard recency and time-range queries
DEFINE INDEX OVERWRITE idx_trace_digest_org_time
  ON trace_digest
  FIELDS org_id, executed_at;

-- execution_exemplar: org + time index (defensive; exemplars currently all org_id='public')
DEFINE INDEX OVERWRITE idx_exemplar_org_time
  ON execution_exemplar
  FIELDS org_id, selected_at;
