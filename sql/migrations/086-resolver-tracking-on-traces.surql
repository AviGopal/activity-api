-- ============================================================================
-- Migration 086: Persist resolver tracking + vessel attribution on legacy traces
-- ============================================================================
-- Purpose: The legacy `activity_execution_traces` table is SCHEMAFULL and was
--          missing fields that minibob now sends on every trace:
--            - vessel_id                  (which vessel ran the activity)
--            - resolved_by_vessel_id      (which vessel resolved its impulses)
--            - impulse_resolutions[]      (per-impulse resolver attribution)
--          End-to-end validation showed these fields silently dropped on write
--          (visible as `null` on a subsequent GET of the L2 trace).
--
-- Background: Per `docs/architecture/RESOLVER_TRACKING.md` and the root
--             CLAUDE.md "New Fields (April 2026)" section, these fields are
--             part of the canonical execution trace shape. The paradigm
--             `execution` table (020-paradigm-core-tables.surql) already has
--             `vessel_id`. This migration brings the legacy trace table — the
--             primary write path in `routes/execution-traces.ts` — into
--             alignment.
--
-- Per-task resolver fields (`resolver_id`, `resolver_tier`, `success`,
-- `cost_usd`): The `tasks` column on `activity_execution_traces` is already
-- declared `option<array<object>> FLEXIBLE` with `tasks.* TYPE object FLEXIBLE`
-- (see schemas/011-executions.surql lines 159-164). FLEXIBLE allows arbitrary
-- nested keys without explicit DEFINE FIELD, so per-task additions need only a
-- route-handler change, not a schema change.
--
-- `composition_chain`: Already added in migration 081, no change needed here.
--
-- Date: 2026-04-22
-- Related: minibob 6f8c727 (canonical wire shape), root CLAUDE.md
--          "Execution Trace Model > New Fields (April 2026)"
-- ============================================================================

-- 1. Vessel attribution
DEFINE FIELD IF NOT EXISTS vessel_id ON activity_execution_traces
  TYPE option<string>
  COMMENT "Vessel that executed this activity (sender of the trace).";

DEFINE FIELD IF NOT EXISTS resolved_by_vessel_id ON activity_execution_traces
  TYPE option<string>
  COMMENT "Vessel that resolved this execution's impulses (typically same as vessel_id for self-contained executions).";

DEFINE FIELD IF NOT EXISTS vessel_version ON activity_execution_traces
  TYPE option<string>
  COMMENT "Vessel version (semver-sha7, e.g., 0.3.3-f24a329) for learning correlation.";

-- 2. Per-impulse resolver attribution.
--    Stored as an array of objects with FLEXIBLE inner shape so backends can
--    evolve the entry shape (currently 6 fields: impulse_id, resolver_id,
--    resolver_tier, vessel_id, latency_ms, cost_usd) without a schema bump.
DEFINE FIELD IF NOT EXISTS impulse_resolutions ON activity_execution_traces
  TYPE option<array<object>> FLEXIBLE
  COMMENT "Per-impulse resolution detail: [{impulse_id, resolver_id, resolver_tier, vessel_id, latency_ms, cost_usd}]. Drives resolver-selection learning.";

DEFINE FIELD IF NOT EXISTS impulse_resolutions.* ON activity_execution_traces
  TYPE object FLEXIBLE
  COMMENT "Individual impulse resolution entry with arbitrary nested fields.";

-- 3. Indexes for vessel-scoped queries (vessel performance metrics, dashboards)
DEFINE INDEX IF NOT EXISTS idx_activity_execution_traces_vessel_id
  ON activity_execution_traces FIELDS vessel_id;

DEFINE INDEX IF NOT EXISTS idx_activity_execution_traces_resolved_by_vessel_id
  ON activity_execution_traces FIELDS resolved_by_vessel_id;
