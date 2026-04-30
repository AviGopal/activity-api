-- Phase 10 P5B of 2026-04-26-impulse-activity-loop: HNSW indexes for the
-- 384-dim name_embedding / description_embedding fields on `activity`.
--
-- The existing dense-embedding search path (`paradigm.ts:1162-1183`) does
-- an O(n) SELECT-everything-then-cosine-scan in JS — fine when the
-- registry was a few hundred templates, but post the activity-registry-
-- quality-pass we expect 2k+ active rows AFTER the deprecation pass and
-- the JS scan has already shown up as recommend-latency hotspot in
-- canary trace-tail samples.
--
-- HNSW (Hierarchical Navigable Small World) gets us approximate-nearest-
-- neighbour in O(log n) with tunable accuracy/speed trade-off. The
-- `<|k,ef|>` KNN operator landed in SurrealDB 2.0; we add the index
-- here, leave it dormant behind a feature flag (10.27 wires the operator
-- once the index is materialised), and promote per 10.29 after a canary
-- benchmark proves out the latency/accuracy improvement.
--
-- Parameters: M=16, EFC=128 are SurrealDB's recommended defaults for
-- vectors in the 256–1024-dim range with up to ~1M rows. DIMENSION=384
-- matches all-MiniLM-L6-v2 from LocalEmbeddingService. DIST=COSINE
-- because both fields are L2-normalised at write time and the existing
-- in-process scorer uses cosine.
--
-- TYPE option<array<float>>: SurrealDB's HNSW indexer skips rows whose
-- field is NONE / null, so we don't need to backfill rows that haven't
-- yet had embeddings produced — the index naturally tracks the subset
-- with vectors materialised.
--
-- Idempotent via DEFINE INDEX IF NOT EXISTS.

DEFINE INDEX IF NOT EXISTS idx_activity_name_embedding_hnsw
  ON activity
  FIELDS name_embedding
  HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 128 M 16;

DEFINE INDEX IF NOT EXISTS idx_activity_description_embedding_hnsw
  ON activity
  FIELDS description_embedding
  HNSW DIMENSION 384 DIST COSINE TYPE F32 EFC 128 M 16;
