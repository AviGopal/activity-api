-- Migration 130: state-space-signature substrate for context_thompson_scores
-- Adds signature_version field (0 = legacy context-bucket, 1 = shape+provenance hash)
-- and a versioned index so the read path can filter by version without a full scan.
-- No REBUILD INDEX needed — additive index on a ~3k-row table.

DEFINE FIELD IF NOT EXISTS signature_version ON context_thompson_scores TYPE int DEFAULT 0;

DEFINE INDEX IF NOT EXISTS idx_ctx_ts_versioned ON context_thompson_scores
  FIELDS org_id, template_id, signature_version, context_bucket;
