-- Migration 136: Add BM25 full-text search indexes on the activity table
-- Without these, queryActivitiesByFTS uses @N@ SurrealDB search operators that
-- silently return 0 results (FTS operators require SEARCH ANALYZER BM25 indexes).
-- This migration adds name + tags FTS indexes so Tier 3 recommendation fallback
-- and GET /v2/activities/templates?q= produce relevant results.

DEFINE ANALYZER OVERWRITE analyzer_activity TOKENIZERS class FILTERS lowercase, snowball(english);

DEFINE INDEX OVERWRITE idx_activity_fts_name
  ON activity FIELDS name
  SEARCH ANALYZER analyzer_activity BM25 HIGHLIGHTS;

DEFINE INDEX OVERWRITE idx_activity_fts_tags
  ON activity FIELDS tags
  SEARCH ANALYZER analyzer_activity BM25 HIGHLIGHTS;
