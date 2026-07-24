-- Migration 180: created_at index on execution_trace_content.
--
-- WHY: the orphan-content retention reap (src/services/trace-retention.ts:380-445) sweeps
-- `SELECT VALUE execution_id FROM execution_trace_content WHERE execution_id > $cursor
--  AND created_at < $safeCut LIMIT $batch`. The table's only index is idx_etc_execution_id
-- (execution_id UNIQUE), so the created_at predicate is a post-filter and any ordered/bounded
-- access over the 435K-row/22G table triggers SurrealDB 2.3.3 MemoryOrderedLimit (full
-- materialize+sort). Reap sweeps therefore time out (observed 521s-2238s, "operation timed
-- out"), so the ~96%-orphan backlog never drains and the store stays at 22G.
--
-- This index makes the created_at predicate index-resolved and unblocks the reap to reclaim
-- the backlog. CONCURRENTLY builds without blocking writes (same pattern as idx_vpet_variant_time).
--
-- NOTE: this is a STORAGE/retention fix, not the CPU fix. The continuous ~15-core surreal burn
-- is the template-list cache thrash removed in src/routes/execution-traces.ts (redis.del of the
-- template-list SET on every score update), not a created_at scan.

DEFINE INDEX IF NOT EXISTS idx_etc_created_at ON execution_trace_content FIELDS created_at CONCURRENTLY;
