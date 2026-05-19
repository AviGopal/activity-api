-- =============================================================================
-- Migration 132: FLEXIBLE wildcard on array<object> contents (test-audit-loop)
-- =============================================================================
-- Date: 2026-05-19
-- Spec: openspec/changes/2026-05-18-test-audit-loop/ (Phase A, post-deploy)
-- Related precedent: migration 093 (same pattern for impulse_resolutions on
-- activity_execution_traces).
--
-- Symptom (surfaced by first live run of test-forge-goal-completion.ts on
-- 2026-05-19):
--
--   POST /v2/impulses/resolve {test_report_write, ...witnesses:[{type:..., count:0}]}
--   → 500 "Found field 'witnesses[0].count', but no such field exists for
--      table 'test_report'"
--   POST /v2/impulses/resolve {test_registration_write, ...goal_alignment:[{criterion:..., discrimination_claim:...}]}
--   → 500 "Found field 'goal_alignment[1].criterion', but no such field exists
--      for table 'test_registration'"
--
-- Root cause: migration 131 declared four `array<object> FLEXIBLE` fields
-- (perturbation_schedule, goal_alignment, passes, witnesses, validation_results)
-- but did NOT add the wildcard `<field>.*` sub-field definition that SurrealDB
-- requires before unknown nested keys are accepted on SCHEMAFULL tables.
-- Migration 045/093 codify this two-step pattern: parent FLEXIBLE + element
-- `.*` FLEXIBLE. Migration 131 only did the parent; this migration adds the
-- element wildcards.
--
-- Idempotent: re-running drops any prior definitions and re-asserts the
-- FLEXIBLE element fields.
-- =============================================================================

-- test_registration: perturbation_schedule, goal_alignment
REMOVE FIELD IF EXISTS perturbation_schedule.* ON test_registration;
REMOVE FIELD IF EXISTS goal_alignment.*        ON test_registration;
DEFINE FIELD perturbation_schedule.* ON test_registration TYPE object FLEXIBLE
  COMMENT "Per-perturbation row. FLEXIBLE so the apply/expected_effect/expected_delta shape can evolve without per-field migrations.";
DEFINE FIELD goal_alignment.*        ON test_registration TYPE object FLEXIBLE
  COMMENT "Per-alignment row {criterion, discrimination_claim}. FLEXIBLE so additional alignment evidence (e.g. measured_delta) rides through.";

-- test_report: passes, witnesses
REMOVE FIELD IF EXISTS passes.*    ON test_report;
REMOVE FIELD IF EXISTS witnesses.* ON test_report;
DEFINE FIELD passes.*    ON test_report TYPE object FLEXIBLE
  COMMENT "Per-pass outcome row (e.g. {phase:'pass1', assertions:[...], duration_ms, ...}). FLEXIBLE — schema reads only the top-level outcome.";
DEFINE FIELD witnesses.* ON test_report TYPE object FLEXIBLE
  COMMENT "Per-witness evidence row (type + bespoke fields per witness kind). FLEXIBLE so multi-witness-verification can grow witness kinds without churn.";

-- test_audit_report: validation_results
REMOVE FIELD IF EXISTS validation_results.* ON test_audit_report;
DEFINE FIELD validation_results.*    ON test_audit_report TYPE object FLEXIBLE
  COMMENT "Per-check ValidationResult row (passed/failure_mode/evidence). FLEXIBLE — audit-loop spec §A may grow new check kinds without migration churn.";
