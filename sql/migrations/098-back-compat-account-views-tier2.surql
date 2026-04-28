-- =============================================================================
-- Migration 098: Phase A2 — Back-compat account-scoped alias views, tier 2
-- =============================================================================
-- Created: 2026-04-28
-- Related OpenSpec: activity-api-account-id-migration-2026-04-28
-- Depends on:        migration 097 (must run first — adds the account_id field)
--
-- PURPOSE
-- -------
-- Mirror the back-compat alias views introduced in migration 096, but for the
-- 7 tables added in migration 097. One read-only view per table, derived as
-- `effective_account_id = account_id ?? org_id` so Phase B handlers can query
-- account-scoped without inline NONE-handling. See migration 096 for the full
-- contract — this file is a pure extension of that pattern, no new semantics.
--
-- One implementation note: tool_usage_patterns had no `org_id` field before
-- migration 097; that migration adds org_id as option<string> alongside
-- account_id specifically so the view can compute the standard
-- `(account_id ?? org_id)` fallback uniformly. Legacy rows resolve to NONE
-- on both fields until Phase F backfills them. Other tables follow the
-- normal dual-fallback contract.
--
-- IDEMPOTENCY: DEFINE TABLE OVERWRITE — safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Composition graph
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_composition_chain_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM composition_chain;

DEFINE TABLE OVERWRITE v_composition_node_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM composition_node;

-- -----------------------------------------------------------------------------
-- Impulse-shape scoring
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_impulse_shape_activity_score_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM impulse_shape_activity_score;

-- -----------------------------------------------------------------------------
-- Tool patterns
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_tool_argument_pattern_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM tool_argument_pattern;

-- tool_usage_patterns has no org_id today; the fallback resolves to NONE on
-- legacy rows (see migration 097 header note).
DEFINE TABLE OVERWRITE v_tool_usage_patterns_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM tool_usage_patterns;

-- -----------------------------------------------------------------------------
-- Vessel health/circuit-breaker
-- -----------------------------------------------------------------------------

DEFINE TABLE OVERWRITE v_vessel_circuit_breaker_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM vessel_circuit_breaker;

DEFINE TABLE OVERWRITE v_vessel_health_metrics_by_account AS
  SELECT *, (account_id ?? org_id) AS effective_account_id FROM vessel_health_metrics;

-- =============================================================================
-- End of migration 098. Total: 7 views (one per migration-097 table).
-- =============================================================================
