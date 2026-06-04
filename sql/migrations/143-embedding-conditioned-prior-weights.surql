-- =============================================================================
-- Migration 143: embedding_prior_weights table (M1 — embedding-conditioned
-- Thompson posterior, MVP STARTER)
-- =============================================================================
--
-- Citations:
--   concept_vugylIHzIMvk (embedding_conditioned_thompson_posterior, mechanism)
--   concept_TbN0eSf7U_hM (parent — Thompson learning-rate program)
--   concept_7mzv7SQN_7JB (discipline gate)
--
-- Stores the trained ridge-regression θ weight vectors for embedding-
-- conditioned Beta prior heads f_α(e; θ_α), f_β(e; θ_β) where e is the
-- per-cell dense embedding (MiniLM-L6-v2, 384-dim INT8) already maintained
-- in concept-db. Replaces the independent Beta(α, β) per (signature,
-- template) cell with a parametric model that shares statistical strength
-- across cells; brings sample complexity from O(|C|/ε²) down to O(d/ε²).
--
-- This MVP ships SCHEMA + read service + tests only. The training pipeline
-- that produces rows in this table is deferred to a follow-up (offline
-- script that fits θ from variant_performance_metrics joined to concept-db
-- embeddings).
--
-- SCHEMAFULL on the structural fields (model_version, feature_dim, theta_*,
-- trained_at, n_training_samples, org_id). Append-only history; updates and
-- deletes restricted to admin so a misbehaving training run cannot silently
-- replace a working model. The read path always selects the latest row by
-- trained_at for the requested (model_version, org_id).
--
-- PERMISSIONS: per-org scoped reads (org_id = $token.org_id) so each tenant
-- gets its own model; admin-only writes so the offline training pipeline
-- (which authenticates with admin scope) is the sole producer.
-- =============================================================================

DEFINE TABLE OVERWRITE embedding_prior_weights SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id OR $token.role = 'admin'
    FOR create WHERE $token.role = 'admin'
    FOR update WHERE $token.role = 'admin'
    FOR delete WHERE $token.role = 'admin';

DEFINE FIELD OVERWRITE org_id              ON embedding_prior_weights TYPE string DEFAULT 'default';
DEFINE FIELD OVERWRITE model_version       ON embedding_prior_weights TYPE string;
DEFINE FIELD OVERWRITE feature_dim         ON embedding_prior_weights TYPE int
  ASSERT $value > 0 AND $value <= 4096;
DEFINE FIELD OVERWRITE theta_alpha         ON embedding_prior_weights TYPE array<float>;
DEFINE FIELD OVERWRITE theta_beta          ON embedding_prior_weights TYPE array<float>;
DEFINE FIELD OVERWRITE trained_at          ON embedding_prior_weights TYPE datetime
  DEFAULT time::now();
DEFINE FIELD OVERWRITE n_training_samples  ON embedding_prior_weights TYPE int DEFAULT 0;

-- Unique index on (model_version, org_id) — a given model_version is unique
-- per tenant. Re-training the same version replaces the row via UPSERT.
DEFINE INDEX OVERWRITE embedding_prior_weights_version_org
  ON embedding_prior_weights
  FIELDS model_version, org_id
  UNIQUE;

-- Read-path index: latest trained_at per org (the service queries
-- ORDER BY trained_at DESC LIMIT 1).
DEFINE INDEX OVERWRITE embedding_prior_weights_trained_at
  ON embedding_prior_weights
  FIELDS org_id, trained_at;
