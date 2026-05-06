-- F-V31 (2026-05-06): Remove HNSW indexes from `activity` table.
--
-- Migration 106 added idx_activity_name_embedding_hnsw and
-- idx_activity_description_embedding_hnsw for the 384-dim
-- all-MiniLM-L6-v2 embeddings. These indexes are maintained even when
-- LocalEmbeddingService is disabled (health: status="disabled"), because
-- SurrealDB's HNSW indexer does not short-circuit on null-embedding rows —
-- it still runs graph-update checks on every INSERT/UPDATE to the `activity`
-- table regardless of whether the new row has name_embedding/description_embedding.
--
-- With ~2336 existing indexed rows (M=16, EFC=128), each auto-create INSERT
-- (triggered by POST /v2/activities/executions for unknown activity IDs) ran
-- HNSW maintenance at 1386m+ CPU sustained, causing 30s timeouts on the
-- execution endpoint and all concurrent SurrealDB queries.
--
-- This migration drops both indexes. They can be re-added when:
--   1. LocalEmbeddingService is re-enabled (config: embedding.enabled=true)
--   2. Cluster is sized to absorb HNSW maintenance overhead under write load
--   3. A separate migration re-runs the DEFINE INDEX with IF NOT EXISTS
--
-- Idempotent: REMOVE INDEX IF EXISTS is a no-op if the index is absent.

USE NS `activity-system` DB learning_loop;

REMOVE INDEX IF EXISTS idx_activity_name_embedding_hnsw ON activity;
REMOVE INDEX IF EXISTS idx_activity_description_embedding_hnsw ON activity;
