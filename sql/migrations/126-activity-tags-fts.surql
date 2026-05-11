-- =============================================================================
-- Migration 126: Full-Text Search index on activity.tags
-- =============================================================================
-- Adds idx_activity_tags_fts to the existing FTS family so that tag tokens
-- participate in the BM25-scored recommendation query alongside name and
-- description. Uses the same activity_analyzer (blank+class+camel tokenizers,
-- lowercase+ascii+snowball filters) for consistent tokenisation.
--
-- Score index assignment:
--   @0@ → idx_activity_name_fts        (weight ×2 in query)
--   @1@ → idx_activity_description_fts (weight ×1 in query)
--   @2@ → idx_activity_tags_fts        (weight ×1.5 in query)
--
-- After DEFINE we immediately REBUILD so the index is warm on canary before
-- query traffic arrives. REBUILD is async-safe in SurrealDB 3.x.
-- =============================================================================

DEFINE INDEX OVERWRITE idx_activity_tags_fts
  ON activity
  FIELDS tags
  FULLTEXT ANALYZER activity_analyzer BM25(1.2, 0.75)
  HIGHLIGHTS;

REBUILD INDEX idx_activity_tags_fts ON activity;
