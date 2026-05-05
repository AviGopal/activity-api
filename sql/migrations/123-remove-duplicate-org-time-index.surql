USE NS `activity-system` DB `learning_loop`;

-- Remove idx_aet_org_time: exact duplicate of idx_aet_org_id_executed_at (both index
-- activity_execution_traces FIELDS org_id, executed_at). Two identical indexes on the
-- same table double write overhead with no read benefit — the query planner uses either
-- index equivalently. The pre-existing idx_aet_org_id_executed_at is retained.
-- F-129, 2026-05-05.
REMOVE INDEX IF EXISTS idx_aet_org_time ON activity_execution_traces;
