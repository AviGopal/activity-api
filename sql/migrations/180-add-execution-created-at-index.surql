-- 180-add-execution-created-at-index.surql
-- Perf: execution.created_at was UNINDEXED (only executed_at is), so every
-- created_at-range query (vessel-metrics, trace-aggregate, 1h-count health
-- probes, ribosome windows) did a full "Iterate Table" scan over the execution
-- table (150k+ rows) — a contributor to the sustained SurrealDB CPU behind the
-- host thermal load. This turns those range filters into an index seek.
-- Additive + idempotent (IF NOT EXISTS); no data change. Applied on unit start.
DEFINE INDEX IF NOT EXISTS idx_execution_created_at ON execution FIELDS created_at;
