-- Migration 144: Add (activity_id, status) index on activity_execution_traces
-- Motivation: the trace-retention sweep (src/services/trace-retention.ts) filters
-- "WHERE activity_id = $a AND status = $s AND created_at < $cut" per stratum, and the
-- batched reservoir SELECT repeats that filter every batch. Without a leading
-- activity_id index every such query is a full table scan (~4s on a 100k-row table).
-- The existing idx_aet_org_activity_success_time leads with org_id, so it cannot
-- satisfy an activity_id-first predicate.
--
-- We deliberately index ONLY (activity_id, status), NOT created_at: activity_id+status
-- has tiny cardinality (a handful of ids x 2 statuses), so the index builds in
-- milliseconds and is safe to (re)apply on every deploy. Adding the high-cardinality
-- created_at datetime as a third field makes the build minutes-long and re-triggers the
-- "index build blocks the /sql endpoint -> helm --atomic rollback timeout" hazard
-- (see init_migrations rationale + the 27-min REBUILD INDEX incidents). The index
-- narrows each query to one small stratum; the residual created_at range filter then
-- scans only that stratum, which is cheap.
-- Reversible: REMOVE INDEX idx_aet_activity_status ON activity_execution_traces

USE NS `activity-system` DB `learning_loop`;

DEFINE INDEX OVERWRITE idx_aet_activity_status
  ON activity_execution_traces
  FIELDS activity_id, status;
