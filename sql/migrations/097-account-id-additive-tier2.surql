-- =============================================================================
-- Migration 097: Phase A2 — account_id additive backfill, tier 2
-- =============================================================================
-- Created: 2026-04-28
-- Related OpenSpec: activity-api-account-id-migration-2026-04-28
-- Depends on:        migration 095 (sets the additive precedent + intent)
--
-- PURPOSE
-- -------
-- Phase A landed `account_id option<string>` + `account_id_version int default
-- 0` on 32 paradigm/bookkeeping tables (migration 095). Phases B1-B4b uncovered
-- 7 additional multi-tenant tables that ARE referenced by route/service code
-- but were NOT in the 095 list, leaving them out of the dual-write rollout.
-- This migration extends the additive schema scaffolding to those tables so
-- B3b/B4-cont (deferred routes) and any future code can dual-write here too.
--
-- WHAT THIS MIGRATION DOES (NOT)
-- ------------------------------
-- This is purely additive — it does NOT remove `org_id`, change PERMISSIONS
-- clauses, rewrite handler code, or backfill existing rows. See migration 095
-- for the full Phase-A rationale and conventions; this file follows them
-- exactly.
--
-- TABLES TOUCHED (7, alphabetical)
-- --------------------------------
--   composition_chain                  -- src/schemas/046-composition-graph.surql
--   composition_node                   -- src/schemas/046-composition-graph.surql
--   impulse_shape_activity_score       -- src/schemas/043-impulse-shape-scoring.surql
--   tool_argument_pattern              -- src/schemas/029-tool-argument-patterns.surql
--   tool_usage_patterns                -- src/002-learning-system-phase1.surql
--                                         (no org_id field today; account_id
--                                          becomes its first multi-tenant key)
--   vessel_circuit_breaker             -- src/schemas/030-circuit-breaker-health.surql
--   vessel_health_metrics              -- src/schemas/030-circuit-breaker-health.surql
--
-- NOTE: `impulse_relevance_metrics` was named in the Phase B audit but is
-- already covered by migration 095 (see line 256 there); deliberately not
-- re-listed here to avoid duplicate field definitions.
--
-- TABLES INVESTIGATED AND SKIPPED (PHANTOMS — 4)
-- ----------------------------------------------
-- The following table names appear in code (queries, type maps, comments) but
-- have NO `DEFINE TABLE` statement in any sql/*.surql or sql/migrations/*.surql
-- file. Code referencing them either targets dead paths or queries that match
-- nothing — adding `account_id` would create a phantom DEFINE FIELD against a
-- table that has never been declared. Skipped here; the audit is captured in
-- the test file alongside this migration.
--
--   activity_metrics                   -- src/routes/activities.ts:8184 references
--                                         FROM activity_metrics; no schema. Likely
--                                         legacy alias for variant_performance_metrics.
--   activity_templates (with 's')      -- src/routes/ribosome.ts:580, code-variants.ts
--                                         INSERT INTO activity_templates; typo or
--                                         legacy alias for `activity` paradigm
--                                         table (already covered by 095).
--   connection                         -- not present in any code path; appears
--                                         only in comments and Redis/SurrealDB
--                                         connection objects. Phantom.
--   org_members                        -- src/routes/auth.ts:99 SELECT FROM
--                                         org_members; no schema. Either dead
--                                         path or expects an externally-defined
--                                         table (e.g., identity-vessel side).
--                                         Out of activity-api scope.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Composition graph tables (sql/schemas/046-composition-graph.surql)
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE composition_chain TYPE option<string>
  COMMENT "Phase A2: account_id for multi-tenant isolation. See migration 097.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE composition_chain TYPE int DEFAULT 0
  COMMENT "Phase A2: cohort marker. 0=legacy (org_id only), 1=Phase B dual-write, 2=Phase D account-only.";
DEFINE INDEX OVERWRITE idx_composition_chain_account_id
  ON composition_chain FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE composition_node TYPE option<string>
  COMMENT "Phase A2: account_id for multi-tenant isolation. See migration 097.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE composition_node TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_composition_node_account_id
  ON composition_node FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Impulse-shape scoring (sql/schemas/043-impulse-shape-scoring.surql)
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE impulse_shape_activity_score TYPE option<string>
  COMMENT "Phase A2: account_id for multi-tenant isolation. See migration 097.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE impulse_shape_activity_score TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_impulse_shape_activity_score_account_id
  ON impulse_shape_activity_score FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Tool patterns (sql/schemas/029-tool-argument-patterns.surql,
--                sql/002-learning-system-phase1.surql)
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE tool_argument_pattern TYPE option<string>
  COMMENT "Phase A2: account_id for multi-tenant isolation. See migration 097.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE tool_argument_pattern TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_tool_argument_pattern_account_id
  ON tool_argument_pattern FIELDS account_id;

-- tool_usage_patterns has no org_id today (the table predates the multi-tenant
-- conversion). To keep the view contract uniform — every back-compat view
-- computes `account_id ?? org_id` — we add org_id as an option<string> here
-- as well. Legacy rows resolve to NONE; Phase B handlers populate either
-- field on dual-write. This is the only schema-additive concession in 097;
-- everywhere else 097 is purely an account_id overlay on top of an existing
-- org_id-scoped table.
DEFINE FIELD OVERWRITE org_id ON TABLE tool_usage_patterns TYPE option<string>
  COMMENT "Phase A2: backfill so back-compat view (migration 098) can compute the (account_id ?? org_id) fallback uniformly.";
DEFINE FIELD OVERWRITE account_id ON TABLE tool_usage_patterns TYPE option<string>
  COMMENT "Phase A2: account_id for multi-tenant isolation. See migration 097.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE tool_usage_patterns TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_tool_usage_patterns_account_id
  ON tool_usage_patterns FIELDS account_id;

-- -----------------------------------------------------------------------------
-- Vessel health/circuit-breaker (sql/schemas/030-circuit-breaker-health.surql)
-- -----------------------------------------------------------------------------

DEFINE FIELD OVERWRITE account_id ON TABLE vessel_circuit_breaker TYPE option<string>
  COMMENT "Phase A2: account_id for multi-tenant isolation. See migration 097.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE vessel_circuit_breaker TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_vessel_circuit_breaker_account_id
  ON vessel_circuit_breaker FIELDS account_id;

DEFINE FIELD OVERWRITE account_id ON TABLE vessel_health_metrics TYPE option<string>
  COMMENT "Phase A2: account_id for multi-tenant isolation. See migration 097.";
DEFINE FIELD OVERWRITE account_id_version ON TABLE vessel_health_metrics TYPE int DEFAULT 0;
DEFINE INDEX OVERWRITE idx_vessel_health_metrics_account_id
  ON vessel_health_metrics FIELDS account_id;

-- =============================================================================
-- End of migration 097. Total: 7 tables touched (14 new fields + 7 indexes).
--
-- Combined with migration 095 (32 tables), the additive scaffolding now covers
-- 39 multi-tenant tables. Phase B3b/B4-cont route handlers can dual-write here
-- without further schema work.
-- =============================================================================
