-- Migration 110: Drop HNSW embedding indexes (F-V8 remediation, 2026-05-02)
--
-- Migration 106 defined two HNSW indexes on `activity` for approximate-nearest-
-- neighbour embedding search. The indexes are correct in principle but were
-- added while (a) the embedding backfill is still 0% complete, and (b) migrations
-- 107-109 each run `UPDATE activity SET updated_at = time::now()` on all rows,
-- forcing SurrealDB to re-evaluate both HNSW graphs for 2,500+ rows on every
-- restart. The sustained memory + CPU burst from this combination exceeds the 8Gi
-- pod limit before the liveness probe can return, creating a self-reinforcing
-- OOMKill loop (exit 137, 14+ restarts in 14h as of 2026-05-02).
--
-- This migration drops both indexes to stop the restart loop. Re-introduce them
-- as migration 111+ once:
--   1. The embedding backfill has run (at least 80% of activity rows have
--      non-null name_embedding / description_embedding).
--   2. A benchmark on a representative dataset confirms the working-set peak
--      stays below the pod memory limit with 2x headroom.
--   3. Migrations 107-109 no longer run full-table UPDATE on restart (or are
--      guarded by an idempotency check that truly skips the UPDATE).
--
-- Idempotent: REMOVE INDEX IF EXISTS is safe to re-run.

REMOVE INDEX IF EXISTS idx_activity_name_embedding_hnsw ON activity;
REMOVE INDEX IF EXISTS idx_activity_description_embedding_hnsw ON activity;
