-- Migration 217: declare the fields coherence-recover writes on activity.
--
-- activity is SCHEMAFULL. scripts/substrate/coherence-recover.ts demotes a duplicate with
--   UPDATE activity:... SET proposed = true, deduped_into = <canonical id>, deduped_at = time::now()
-- and SurrealDB silently drops fields a SCHEMAFULL table does not declare (the UPDATE still returns OK). Neither field
-- existed, so on node 1 (2026-10-07) 813 live runs and 20,871 demotions persisted only proposed=true: no demotion recorded
-- which canonical it was folded into or when, which also hid a promote/demote loop from any audit.
-- Both are optional (existing rows have neither). IF NOT EXISTS: idempotent on every start.

DEFINE FIELD IF NOT EXISTS deduped_into ON activity TYPE option<string> PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS deduped_at ON activity TYPE option<datetime> PERMISSIONS FULL;
