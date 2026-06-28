-- Migration 133: signature_cluster_assignment — HDBSCAN cluster label per
-- state-space signature.
--
-- Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
--       (task D1.2)
--
-- One row per (signature_version, signature). The clustering tick (D3) UPSERTs
-- these from a periodic HDBSCAN pass over signature_embedding rows. The selector
-- (D5) reads cluster_id to choose the cluster-level Thompson posterior when a
-- leaf signature is under-sampled. `contaminated` flags a cluster whose member
-- signatures have divergent empirical success rates (D3.3) — the selector
-- ignores the cluster posterior for contaminated clusters.
--
-- Additive schema only — no behaviour change here. PERMISSIONS mirror migration
-- 130/131: org-scoped select/create via $token.org_id, append-only (no
-- update/delete); the cluster tick re-UPSERTs assignments each pass.

DEFINE TABLE OVERWRITE signature_cluster_assignment SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id            ON signature_cluster_assignment TYPE string;
DEFINE FIELD OVERWRITE signature         ON signature_cluster_assignment TYPE string;
DEFINE FIELD OVERWRITE signature_version ON signature_cluster_assignment TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE cluster_id        ON signature_cluster_assignment TYPE string;
DEFINE FIELD OVERWRITE assigned_at       ON signature_cluster_assignment TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE contaminated      ON signature_cluster_assignment TYPE bool DEFAULT false;

DEFINE INDEX OVERWRITE idx_signature_cluster_assignment_version_signature
  ON signature_cluster_assignment FIELDS signature_version, signature;
DEFINE INDEX OVERWRITE idx_signature_cluster_assignment_version_cluster
  ON signature_cluster_assignment FIELDS signature_version, cluster_id;
