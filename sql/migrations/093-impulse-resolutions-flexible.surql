-- =============================================================================
-- Migration 093: Re-assert impulse_resolutions[*] is FLEXIBLE
-- =============================================================================
-- Date: 2026-04-26
-- Related: F-51, migrations 045 (precedent), 084 (table OVERWRITE), 086 (origin)
--
-- Symptom: Every POST /v2/activities/execution-traces returned 500 with:
--   "Found field 'impulse_resolutions[N].cost_usd', but no such field
--    exists for table 'activity_execution_traces'"
-- Learning signals from minibob were never persisting, blocking
-- ribosome convergence (Phase 8 criterion 4).
--
-- Root cause: minibob's per-impulse-resolution wire shape grew over time
-- (currently 6 fields per the SerializedImpulseResolution interface in
-- repos/minibob/src/mcp.ts: impulse_id, resolver_id, resolver_tier,
-- vessel_id, latency_ms, cost_usd). The schema-level FLEXIBLE declaration
-- introduced in migration 086 SHOULD permit any nested key, but on the
-- deployed canary the table rejected `cost_usd` — most likely because:
--   1. Migration 084 (DEFINE TABLE activity_execution_traces OVERWRITE
--      SCHEMAFULL ... PERMISSIONS ...) ran AFTER 086 in some path; in
--      SurrealDB, DEFINE TABLE OVERWRITE drops the previously-declared
--      field set, dropping the FLEXIBLE clause along with it.
--   2. Or migrations were silently skipped pre-F-35 fix on this instance,
--      so 086's FLEXIBLE never landed on the live table.
--
-- Either way: a tracking-metadata array whose nested shape evolves with
-- new resolver tiers (output-shape inference scores, success flags,
-- error reasons — see ImpulseResolution interface in
-- repos/minibob/src/resolution-tracker.ts which already has more fields
-- than the wire serializer currently sends) does not belong in a
-- per-key SCHEMAFULL contract. Per-field migrations don't scale.
--
-- Fix: re-assert the FLEXIBLE declarations against whatever state is on
-- the deployed table. Use REMOVE FIELD IF EXISTS + DEFINE FIELD (vs the
-- simpler IF NOT EXISTS) precisely because we want to correct any
-- divergent state, not skip when "something" is defined.
--
-- Idempotent: re-running drops any prior definition (FLEXIBLE or not)
-- and re-asserts the FLEXIBLE one. This mirrors migration 045's pattern
-- (the original FLEXIBLE-fix precedent for the `tasks.*` and
-- `output_impulses.*` arrays on this same table).
--
-- Per migration 045's precedent: when a FLEXIBLE parent is paired with
-- a FLEXIBLE TYPE object `.*` sub-field, both must be present and
-- FLEXIBLE for nested keys to be accepted. Both are re-asserted below.
-- =============================================================================

-- Drop any prior definitions so DEFINE FIELD below is unambiguous.
-- This is the same idempotency pattern as migration 045 used for the
-- tasks.* and output_impulses.* fields.
REMOVE FIELD IF EXISTS impulse_resolutions.* ON activity_execution_traces;
REMOVE FIELD IF EXISTS impulse_resolutions ON activity_execution_traces;

-- 1. Parent: array of objects, FLEXIBLE so unknown nested keys are accepted.
DEFINE FIELD impulse_resolutions ON activity_execution_traces
  TYPE option<array<object>> FLEXIBLE
  COMMENT "Per-impulse resolution detail (resolver tracking metadata). FLEXIBLE so the wire shape can evolve without per-field migrations. Currently 6 fields: impulse_id, resolver_id, resolver_tier, vessel_id, latency_ms, cost_usd. Future fields (success, error_reason, output_shape_inference_score, etc.) ride through automatically.";

-- 2. Element: object, FLEXIBLE so SurrealDB does not reject unknown nested keys.
DEFINE FIELD impulse_resolutions.* ON activity_execution_traces
  TYPE object FLEXIBLE
  COMMENT "Individual resolution entry. FLEXIBLE allows the bag of resolver-tracking fields to grow with the wire contract.";
