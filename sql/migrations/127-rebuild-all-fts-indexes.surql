-- =============================================================================
-- Migration 127: Rebuild all FTS indexes after HNSW removal
-- =============================================================================
-- Migration 125 removed the HNSW indexes (idx_activity_name_embedding_hnsw
-- and idx_activity_description_embedding_hnsw) from the activity table.
-- In SurrealDB 3.0.0, removing an index from a table invalidates the
-- in-memory BM25 scoring state for co-resident FTS indexes on the same table:
-- index structure (status=ready) remains, but search::score(N) returns 0.
--
-- Root cause: SurrealDB 3.0.0 stores per-table BM25 scorer state in a shared
-- structure that is invalidated when any index is removed from the table.
-- The only recovery is REBUILD on each affected FTS index.
--
-- Migration 111 previously REBUILT idx_activity_name_fts and
-- idx_activity_description_fts when it added HIGHLIGHTS. Migration 126 added
-- idx_activity_tags_fts with its own REBUILD. But after migration 125's REMOVE
-- INDEX operations in the same deployment, all three FTS scoring states were
-- reset to zero. This migration ensures all three are rebuilt in a single pass
-- so that the ordering guarantee holds regardless of future index removals.
--
-- Safe to re-run: REBUILD INDEX is idempotent.
-- =============================================================================

REBUILD INDEX idx_activity_name_fts ON activity;
REBUILD INDEX idx_activity_description_fts ON activity;
REBUILD INDEX idx_activity_tags_fts ON activity;
