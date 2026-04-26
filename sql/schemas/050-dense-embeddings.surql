-- ============================================================================
-- Dense Embeddings for all-MiniLM-L6-v2 (384-dim) — 050-dense-embeddings
-- ============================================================================
-- Adds name_embedding and description_embedding fields to the activity table
-- for local dense vector search via LocalEmbeddingService (ONNX Runtime).
--
-- These are separate from the existing `embedding` field (schema 041) which
-- targets text-embedding-3-small (1536-dim, external API).
-- Having distinct fields lets both paths coexist without interference.
--
-- Search is done in-process (O(n) cosine scan) for the MVP; an HNSW index
-- can be added later once the volume justifies it.
-- ============================================================================

DEFINE FIELD IF NOT EXISTS name_embedding ON activity
  TYPE option<array<float>>
  COMMENT "all-MiniLM-L6-v2 embedding of the activity name (384-dim, L2-normalised)";

DEFINE FIELD IF NOT EXISTS description_embedding ON activity
  TYPE option<array<float>>
  COMMENT "all-MiniLM-L6-v2 embedding of the activity description (384-dim, L2-normalised)";
