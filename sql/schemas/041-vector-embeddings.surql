-- ============================================================================
-- Vector Embeddings Schema (041-vector-embeddings)
-- ============================================================================
-- Adds vector embedding support to the activity table for semantic search.
-- Uses OpenAI text-embedding-3-small (1536 dimensions) with HNSW index.
--
-- Enables:
-- - Semantic similarity search for activities
-- - Finding related activities based on description/name
-- - Activity recommendations based on content similarity
-- ============================================================================

-- -----------------------------------------------------------------------------
-- Embedding fields on activity table
-- -----------------------------------------------------------------------------

-- Vector embedding (1536 dimensions for text-embedding-3-small)
DEFINE FIELD IF NOT EXISTS embedding ON activity TYPE option<array<float>>
  COMMENT "OpenAI embedding vector (1536 dimensions for text-embedding-3-small)";

-- Embedding model used (for future model upgrades)
DEFINE FIELD IF NOT EXISTS embedding_model ON activity TYPE option<string>
  VALUE $value OR 'text-embedding-3-small'
  COMMENT "Embedding model used to generate the vector";

-- Timestamp of embedding generation (for staleness detection)
DEFINE FIELD IF NOT EXISTS embedding_generated_at ON activity TYPE option<datetime>
  COMMENT "When the embedding was generated (null if not yet generated)";

-- -----------------------------------------------------------------------------
-- HNSW Vector Index
-- -----------------------------------------------------------------------------
-- HNSW (Hierarchical Navigable Small World) index for efficient approximate
-- nearest neighbor search. Cosine distance is appropriate for normalized
-- text embeddings.
-- -----------------------------------------------------------------------------

DEFINE INDEX IF NOT EXISTS idx_activity_embedding_hnsw ON activity
  FIELDS embedding
  HNSW DIMENSION 1536 DIST COSINE;

-- ============================================================================
-- Query Examples
-- ============================================================================
--
-- 1. Find activities similar to a given embedding vector:
--
--    LET $query_embedding = [0.123, -0.456, ...]; -- 1536 floats
--    SELECT
--      id,
--      name,
--      description,
--      vector::similarity::cosine(embedding, $query_embedding) AS similarity
--    FROM activity
--    WHERE embedding IS NOT NONE
--      AND org_id = $auth.org_id
--    ORDER BY similarity DESC
--    LIMIT 10;
--
-- 2. Find activities similar to an existing activity:
--
--    LET $source = (SELECT embedding FROM activity WHERE id = 'activity-123');
--    SELECT
--      id,
--      name,
--      vector::similarity::cosine(embedding, $source.embedding) AS similarity
--    FROM activity
--    WHERE id != 'activity-123'
--      AND embedding IS NOT NONE
--      AND org_id = $auth.org_id
--    ORDER BY similarity DESC
--    LIMIT 5;
--
-- 3. Find activities needing embeddings (for batch processing):
--
--    SELECT id, name, description
--    FROM activity
--    WHERE embedding IS NONE
--      AND org_id = $auth.org_id
--    LIMIT 100;
--
-- 4. Check embedding freshness (re-embed if description changed):
--
--    SELECT id, name, updated_at, embedding_generated_at
--    FROM activity
--    WHERE embedding_generated_at < updated_at
--      AND org_id = $auth.org_id;
--
-- 5. Using the HNSW index with KNN operator (SurrealDB 3.x):
--
--    The KNN operator <|K,EF|> finds K nearest neighbors with optional EF (effort)
--    parameter. The distance metric (COSINE) is defined in the index, not the query.
--
--    LET $query_embedding = [0.123, -0.456, ...];
--
--    -- Basic KNN search (10 nearest neighbors):
--    SELECT id, name, description, vector::distance::knn() AS distance
--    FROM activity
--    WHERE embedding <|10|> $query_embedding
--      AND org_id = $auth.org_id
--    ORDER BY distance;
--
--    -- KNN with explicit effort parameter (higher = more accurate, slower):
--    SELECT id, name, description, vector::distance::knn() AS distance
--    FROM activity
--    WHERE embedding <|10,40|> $query_embedding
--      AND org_id = $auth.org_id
--    ORDER BY distance;
--
-- ============================================================================
