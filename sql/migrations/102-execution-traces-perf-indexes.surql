-- Migration 102: Performance indexes for activity_execution_traces
-- The list endpoint queries:
--   WHERE (account_id = $account_id OR (account_id IS NONE AND org_id = $org_id)) OR org_id = NULL
--   ORDER BY executed_at DESC LIMIT N
-- Without indexes on (org_id, executed_at) this becomes a full table scan + sort,
-- causing timeouts as the table grows (observed: >8s on canary as of 2026-04-29).

-- Composite index: org-scoped time-ordered lookups (the common case for API-key auth)
DEFINE INDEX OVERWRITE idx_aet_org_id_executed_at
  ON activity_execution_traces
  FIELDS org_id, executed_at;

-- Composite index: account-scoped time-ordered lookups (dashboard users)
DEFINE INDEX OVERWRITE idx_aet_account_id_executed_at
  ON activity_execution_traces
  FIELDS account_id, executed_at;

-- Cover the parent_execution_id filter used by NestedTrajectoryNode
DEFINE INDEX OVERWRITE idx_aet_parent_execution_id
  ON activity_execution_traces
  FIELDS parent_execution_id;

-- Cover activity_id + executed_at for template-scoped history views
-- (field is activity_id in this table, not activity_template_id)
DEFINE INDEX OVERWRITE idx_aet_activity_id_executed_at
  ON activity_execution_traces
  FIELDS activity_id, executed_at;
