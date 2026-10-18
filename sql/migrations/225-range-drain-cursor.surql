-- Migration 225: the range drain's persisted lower bound, on the trace store's own counter row.
--
-- trace-retention's range drain started every pass at the floor (1970) and re-read the whole protected head
-- (graded and labelled rows the valve never deletes) before reaching a deletable row: on the hub ~294 s per pass
-- removing 0, on node 1 43-252 s removing 2-116. The cursor must survive a process restart (pull-sync converges
-- restart activity-api), so it lives in the store, on trace_store_counters:execution, which the same sweep already
-- writes (decrementTraceStoreCounter). The table is SCHEMAFULL, so undeclared fields would be dropped silently.
--   drain_floor          executed_at below which the last pass found only graded or protected rows
--   drain_floor_prot     size of the protected list (labels + open evidence refs) when it was stored
--   drain_floor_released trace_evidence_ref rows closed (open = false) when it was stored
--   drain_floor_passes   passes resumed from a stored cursor since the last floor start
--   drain_floor_at       when it was written
-- A shorter protected list or more closed refs (protection released) or policy.rescanPasses resumed passes send the
-- next pass back to the floor (src/services/trace-retention.ts RANGE DRAIN CURSOR). No rows are written here.
DEFINE FIELD IF NOT EXISTS drain_floor          ON trace_store_counters TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS drain_floor_prot     ON trace_store_counters TYPE option<int>;
DEFINE FIELD IF NOT EXISTS drain_floor_released ON trace_store_counters TYPE option<int>;
DEFINE FIELD IF NOT EXISTS drain_floor_passes   ON trace_store_counters TYPE option<int>;
DEFINE FIELD IF NOT EXISTS drain_floor_at       ON trace_store_counters TYPE option<datetime>;
