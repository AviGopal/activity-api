-- Migration 156: trace_store_counters — O(1) row-count for activity_execution_traces.
--
-- Part of openspec/changes/2026-07-08-substrate-self-managed-db-reconciliation.
-- activity_execution_traces (AET) has no cheap way to know "how big am I" —
-- `SELECT count() ... GROUP ALL` over 218K+ rows took 86.5s in the pre-window
-- measurement (see design.md). This table is the substitute: a single-row-per-
-- table counter incremented at both AET insert sites (execution-traces.ts,
-- activities.ts) instead of counted at read time. The `db_admin
-- reconcile_trace_store` operation resets it after a swap; the trace-store
-- health observer (development-vessel) reads it (never counts AET) to decide
-- whether to emit a `trace_store_reconciliation` gap.
--
-- One row expected: trace_store_counters:activity_execution_traces. The
-- operator initializes it post-swap (this migration deliberately does NOT
-- seed a row — see design.md "the operator initializes it post-swap").
--
-- IF NOT EXISTS throughout so this migration is re-run safe.

DEFINE TABLE IF NOT EXISTS trace_store_counters SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS table_name          ON trace_store_counters TYPE string;
DEFINE FIELD IF NOT EXISTS row_count           ON trace_store_counters TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS cap                 ON trace_store_counters TYPE option<int>;
DEFINE FIELD IF NOT EXISTS last_reconciled_at  ON trace_store_counters TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS updated_at          ON trace_store_counters TYPE datetime VALUE time::now();
