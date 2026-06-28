-- 149-successor-features.surql
--
-- Successor features ψ(s,a) — learning-rate mechanism #7.
-- OpenSpec: 2026-06-04-learning-rate-7-successor-features.
-- Concept anchor: concept_49XNzJTL7E8V (successor_feature_decomposition_of_q).
--
-- Q(s,a) = ⟨ψ(s,a), R⟩. This table stores the TRANSITION side ψ — the expected
-- DISCOUNTED SHAPE-OCCUPANCY of the trace continuation rooted at the
-- (signature, template) cell — as a sparse map {shape_id: discounted_count}.
-- The Beta posterior on R (success/failure) on variant_performance_metrics /
-- context_thompson_scores is UNCHANGED; ψ is a SIBLING statistic, not a
-- replacement. One row per (signature, template_id, scope) — one-to-one with
-- the conditional Thompson cell cardinality.
--
-- Written by lib/successor-features.ts (Robbins-Monro running mean) on every
-- trace ingest where a signature + produced shapes are present; read at the
-- discover-by-shapes candidates_with_scores selection path to expose
-- successor_value = ⟨ψ, completion_shapes⟩. Both paths are env-flagged
-- (SUCCESSOR_FEATURES, default ON) and fire-and-forget — additive, reversible.
--
-- The writer uses the root surrealDB connection, so PERMISSIONS do not block
-- it; the clause is defensive for any future $token-scoped read path and
-- mirrors context_thompson_scores.

DEFINE TABLE IF NOT EXISTS successor_features SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create, update WHERE $token.org_id IS NOT NONE
    FOR delete NONE;

DEFINE FIELD IF NOT EXISTS signature ON successor_features TYPE string;
DEFINE FIELD IF NOT EXISTS template_id ON successor_features TYPE string;
DEFINE FIELD IF NOT EXISTS scope ON successor_features TYPE string DEFAULT 'org';
DEFINE FIELD IF NOT EXISTS org_id ON successor_features TYPE option<string>;
DEFINE FIELD IF NOT EXISTS account_id ON successor_features TYPE option<string>;
DEFINE FIELD IF NOT EXISTS discount ON successor_features TYPE float DEFAULT 0.9;
-- Sparse {shape_id: discounted_count} map. FLEXIBLE so arbitrary shape ids
-- ride through without per-shape field declarations.
DEFINE FIELD IF NOT EXISTS vector ON successor_features FLEXIBLE TYPE object DEFAULT {};
DEFINE FIELD IF NOT EXISTS sample_count ON successor_features TYPE int DEFAULT 0;
DEFINE FIELD IF NOT EXISTS variance_estimate ON successor_features TYPE option<float>;
DEFINE FIELD IF NOT EXISTS updated_at ON successor_features TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS created_at ON successor_features TYPE datetime DEFAULT time::now();

-- One cell per (signature, template, scope).
DEFINE INDEX IF NOT EXISTS sf_cell_idx ON successor_features
  FIELDS signature, template_id, scope UNIQUE;
DEFINE INDEX IF NOT EXISTS sf_sig_scope_idx ON successor_features
  FIELDS signature, scope;
