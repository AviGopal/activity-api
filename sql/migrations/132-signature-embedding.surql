-- Migration 132: signature_embedding — dense (MiniLM, 384-dim) embeddings of
-- state-space signatures.
--
-- Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
--       (task D1.1)
--
-- Stores one embedding per (signature_version, signature). The clustering pass
-- (D3) reads these rows; the embedding pipeline (D2) writes them. Additive
-- schema only — no behaviour change, no selector/posterior wiring here.
--
-- `embedding` is declared `array<float>` (matching the existing dense-embedding
-- convention at sql/schemas/050-dense-embeddings.surql — SurrealDB has no fixed-
-- length array type in use here; the 384-dim contract is enforced by an ASSERT
-- and by the consuming cosine scan's length guard). PERMISSIONS mirror migration
-- 130/131: org-scoped select/create via $token.org_id, append-only (no
-- update/delete) — re-embedding upserts a fresh row via the pipeline.

DEFINE TABLE OVERWRITE signature_embedding SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id            ON signature_embedding TYPE string;
DEFINE FIELD OVERWRITE signature         ON signature_embedding TYPE string;
DEFINE FIELD OVERWRITE signature_version ON signature_embedding TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE embedding         ON signature_embedding TYPE array<float>
  ASSERT array::len($value) = 384
  COMMENT "all-MiniLM-L6-v2 embedding of the state-space signature (384-dim, L2-normalised)";
DEFINE FIELD OVERWRITE embedded_at       ON signature_embedding TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE idx_signature_embedding_version_signature
  ON signature_embedding FIELDS signature_version, signature;
