-- Migration 182: solo indexes on the aux-table retention time fields (concurrency-safety).
--
-- The aux-table retention reap (services/trace-retention.ts, migration-era 2026-07-24)
-- filters `WHERE executed_at < cut` (trace_digest) and `WHERE recorded_at < cut`
-- (concept_usage). Those tables only had COMPOSITE indexes leading with org_id
-- (idx_trace_digest_org_time = org_id,executed_at; idx_usage_org etc.), which a
-- solo-field filter CANNOT use — so every reap sweep FULL-SCANNED the 1M+ row table.
-- That O(table)-per-query read cost is the concurrency defect: ~8 concurrent readers
-- summed their full-scan buffers into the 26G cap and thrashed (OOM instead of the
-- correct behaviour, which is queueing/latency). Solo indexes on the raw time field
-- make the reap AND any time-range query O(result), so the store degrades to latency
-- under concurrent load rather than memory-collapsing.
--
-- Applied live 2026-07-24 (verified: `WHERE executed_at < now-3d` 27s->3ms; 8 parallel
-- indexed queries kept RSS bounded). This migration makes them durable across recreate.
DEFINE INDEX IF NOT EXISTS idx_td_executed_at ON trace_digest COLUMNS executed_at CONCURRENTLY;
DEFINE INDEX IF NOT EXISTS idx_cu_recorded_at ON concept_usage COLUMNS recorded_at CONCURRENTLY;
