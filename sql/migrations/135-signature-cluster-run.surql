-- Migration 135: signature_cluster_run — per-pass run log for the clustering
-- tick (D3).
--
-- Spec: openspec/changes/2026-06-04-learning-rate-8-hierarchical-signature-clustering/
--       (task D3.2 — "Records a signature_cluster_run log row")
--
-- One row per clustering-tick execution. Read by GET /v2/cluster/status (D3.4)
-- to surface last-run timestamp + counts. The clustering tick (D3) INSERTs these.
--
-- Additive schema only — no behaviour change here. PERMISSIONS mirror migration
-- 132/133: org-scoped select/create via $token.org_id, append-only. Run rows are
-- written by the in-process tick under the root connection (org_id stamped
-- explicitly), and read back by the org-scoped status route.

DEFINE TABLE OVERWRITE signature_cluster_run SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id          ON signature_cluster_run TYPE string;
DEFINE FIELD OVERWRITE n_signatures    ON signature_cluster_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE n_clusters      ON signature_cluster_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE n_noise         ON signature_cluster_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE n_contaminated  ON signature_cluster_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE duration_ms     ON signature_cluster_run TYPE int DEFAULT 0;
DEFINE FIELD OVERWRITE ran_at          ON signature_cluster_run TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE idx_signature_cluster_run_org_ran
  ON signature_cluster_run FIELDS org_id, ran_at;
