-- =============================================================================
-- Full-Text Search for Activity Recommendation
-- =============================================================================
-- Enables semantic search on activity name and description fields for
-- improved activity discovery and recommendation.
--
-- SurrealDB 3.x uses analyzers with tokenizers and filters to process text
-- for full-text indexing. This schema defines an analyzer optimized for
-- activity search and creates a BM25-scored FULLTEXT index.
-- =============================================================================

-- =============================================================================
-- Analyzer: activity_analyzer
-- =============================================================================
-- Purpose: Text analysis pipeline for activity name/description search
--
-- TOKENIZERS:
--   - blank:  Splits on whitespace (handles "fix bug" -> ["fix", "bug"])
--   - class:  Splits on character class boundaries (handles "fix_bug" -> ["fix", "bug"])
--   - camel:  Splits on camelCase boundaries (handles "fixBug" -> ["fix", "Bug"])
--
-- FILTERS:
--   - lowercase:        Normalizes to lowercase ("Bug" -> "bug")
--   - ascii:            Converts unicode to ASCII ("cafe" remains "cafe")
--   - snowball(english): Applies English stemming ("running" -> "run")
--
-- This combination handles:
--   - Natural language descriptions ("Fix authentication bug")
--   - Snake_case identifiers ("fix_auth_bug")
--   - CamelCase identifiers ("fixAuthBug")
--   - Mixed formats common in code/activity naming
-- =============================================================================

DEFINE ANALYZER IF NOT EXISTS activity_analyzer
  TOKENIZERS blank, class, camel
  FILTERS lowercase, ascii, snowball(english);

-- =============================================================================
-- Indexes: idx_activity_name_fts and idx_activity_description_fts
-- =============================================================================
-- Purpose: Full-text search indexes on activity name and description
--
-- NOTE: SurrealDB requires separate indexes per field for FULLTEXT indexes.
--       Multi-field FULLTEXT indexes are not supported.
--
-- FIELDS (separate indexes):
--   - name:        Activity name (e.g., "Fix TypeScript Compilation Error")
--   - description: Activity description (optional, can be NONE)
--
-- SCORING: BM25(k1=1.2, b=0.75)
--   - k1=1.2: Term frequency saturation (higher = more weight on term frequency)
--   - b=0.75: Document length normalization (0=no penalty, 1=full penalty)
--   - These are the standard/default BM25 parameters from academic literature
--
-- USAGE PATTERNS:
--
-- 1. Basic search (returns activities matching "fix error"):
--    SELECT * FROM activity
--    WHERE name @@ 'fix error' OR description @@ 'fix error';
--
-- 2. Search with BM25 score on name (ranked by relevance):
--    SELECT *, search::score(0) AS relevance FROM activity
--    WHERE name @0@@ 'typescript compilation'
--    ORDER BY relevance DESC;
--
-- 3. Combined name + description search with weighted scores:
--    -- Use @0@@ for name index (score index 0), @1@@ for description index (score index 1)
--    SELECT *,
--      search::score(0) * 2 + search::score(1) AS relevance
--    FROM activity
--    WHERE name @0@@ 'fix bug' OR description @1@@ 'fix bug'
--    ORDER BY relevance DESC;
--
-- 4. FTS combined with other filters (org scoping, execution type):
--    SELECT * FROM activity
--    WHERE org_id = $auth.org_id
--      AND execution_type = 'template'
--      AND (name @@ 'database migration' OR description @@ 'database migration');
--
-- 5. Autocomplete/prefix search (partial word matching):
--    SELECT * FROM activity
--    WHERE name @@ 'auth*'
--    LIMIT 10;
--
-- NOTES:
--   - The @@ operator performs full-text matching using the analyzer
--   - The @N@@ operator binds a score index (N) for use with search::score(N)
--   - When using multiple indexes, assign different score indices (@0@@, @1@@)
--   - Description field can be NONE; FTS handles this gracefully
--   - Index respects PERMISSIONS defined on the activity table
-- =============================================================================

DEFINE INDEX IF NOT EXISTS idx_activity_name_fts
  ON activity
  FIELDS name
  FULLTEXT ANALYZER activity_analyzer BM25(1.2, 0.75);

DEFINE INDEX IF NOT EXISTS idx_activity_description_fts
  ON activity
  FIELDS description
  FULLTEXT ANALYZER activity_analyzer BM25(1.2, 0.75);

-- =============================================================================
-- Performance Considerations
-- =============================================================================
--
-- 1. Index Size:
--    - FTS indexes are larger than standard B-tree indexes
--    - Size grows with vocabulary and document count
--    - Monitor with: INFO FOR INDEX idx_activity_name_fts ON activity;
--                    INFO FOR INDEX idx_activity_description_fts ON activity;
--
-- 2. Write Performance:
--    - INSERT/UPDATE on activity table will update FTS index
--    - For bulk imports, consider batch operations
--
-- 3. Query Performance:
--    - FTS queries are optimized for relevance, not exact matching
--    - Combine with standard indexes (org_id, execution_type) for filtering
--    - Use LIMIT to bound result sets for autocomplete scenarios
--
-- 4. Memory Usage:
--    - FTS index is partially loaded into memory for fast queries
--    - Ensure sufficient memory for production workloads
-- =============================================================================
