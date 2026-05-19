-- Migration 131: Test-Audit Loop storage tables
--
-- Spec: openspec/changes/2026-05-18-test-audit-loop/ (Phase A)
-- Creates four tables for the new write resolvers introduced by this change:
--
--   test_registration         — registration block per test (perturbation schedule,
--                               goal alignment, witness types). Stored separately
--                               from activity_template so the audit loop can scan
--                               registrations without trawling the template
--                               catalogue; design.md §E.1 anticipates eventual
--                               folding into activity_template, but a dedicated
--                               table keeps the schema discriminated for now.
--   test_audit_report         — audit outcome per (test_registration, test_report)
--                               pair; pass/fail per criterion + failed_evidence
--                               subtype.
--   sensitivity_evidence      — one row per (test, perturbation, run) emitted by
--                               run-sensitivity-probe; consumed by
--                               audit-test-report's check_sensitivity_evidence
--                               task over a ≥7-day, ≥3-run window.
--   code_modification_proposal — output of debug-failing-audit; carries diff +
--                               risk_tier + supersedes chain so auto-merge can
--                               pick the newest non-superseded proposal.
--
-- All tables are SCHEMAFULL on the structured fields the audit loop reads, with
-- DEFINE FIELD OVERWRITE on the body-payload slot so resolvers can extend
-- without re-migrating. PERMISSIONS use $token.org_id per the RBAC convention
-- (docs/RBAC_GUIDE.md). FOR update/delete is NONE — these impulses are
-- append-only history, edits would invalidate the audit chain.

-- =============================================================================
-- test_registration
-- =============================================================================

DEFINE TABLE OVERWRITE test_registration SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id                 ON test_registration TYPE string;
DEFINE FIELD OVERWRITE test_id                ON test_registration TYPE string;
DEFINE FIELD OVERWRITE inputs_schema          ON test_registration FLEXIBLE TYPE object DEFAULT {};
DEFINE FIELD OVERWRITE perturbation_schedule  ON test_registration FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE perturbation_cadence   ON test_registration TYPE option<string>
  ASSERT $value = NONE OR $value IN ['daily', 'weekly', 'monthly'];
DEFINE FIELD OVERWRITE goal_alignment         ON test_registration FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE discrimination_claim   ON test_registration TYPE option<string>;
DEFINE FIELD OVERWRITE witness_types          ON test_registration FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE audit_depth_cap        ON test_registration TYPE option<int>
  ASSERT $value = NONE OR ($value > 0 AND $value <= 4);
DEFINE FIELD OVERWRITE created_at             ON test_registration TYPE datetime DEFAULT time::now();
DEFINE FIELD OVERWRITE updated_at             ON test_registration TYPE option<datetime>;

DEFINE INDEX OVERWRITE idx_test_registration_org_test
  ON test_registration FIELDS org_id, test_id UNIQUE;

-- =============================================================================
-- test_report — OUTPUT of a test run (INPUT to audit-test-report)
-- Added 2026-05-18 (Phase E wiring): tests emit their outcomes here so the
-- audit machinery has a persistent surface to read from. Body fields are
-- mostly FLEXIBLE since each test_id can carry different per-pass / witness /
-- failure shapes — the audit only needs the structural fields (test_id,
-- registration link, passed, witnesses, caveats) to compute its verdict.
-- =============================================================================

DEFINE TABLE OVERWRITE test_report SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id                 ON test_report TYPE string;
DEFINE FIELD OVERWRITE test_id                ON test_report TYPE string;
DEFINE FIELD OVERWRITE run_id                 ON test_report TYPE string;
DEFINE FIELD OVERWRITE test_registration_id   ON test_report TYPE option<string>;
DEFINE FIELD OVERWRITE passed                 ON test_report TYPE bool;
DEFINE FIELD OVERWRITE passes                 ON test_report FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE witnesses              ON test_report FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE failure_mode           ON test_report FLEXIBLE TYPE option<object>;
DEFINE FIELD OVERWRITE caveats                ON test_report FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE duration_ms            ON test_report TYPE option<float>;
DEFINE FIELD OVERWRITE cost_usd               ON test_report TYPE option<float>;
DEFINE FIELD OVERWRITE perturbation_row       ON test_report FLEXIBLE TYPE option<object>;
DEFINE FIELD OVERWRITE details                ON test_report FLEXIBLE TYPE option<object>;
DEFINE FIELD OVERWRITE created_at             ON test_report TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE idx_test_report_org_test_time
  ON test_report FIELDS org_id, test_id, created_at;
DEFINE INDEX OVERWRITE idx_test_report_org_registration
  ON test_report FIELDS org_id, test_registration_id;

-- =============================================================================
-- test_audit_report
-- =============================================================================

DEFINE TABLE OVERWRITE test_audit_report SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id                 ON test_audit_report TYPE string;
DEFINE FIELD OVERWRITE test_registration_id   ON test_audit_report TYPE string;
DEFINE FIELD OVERWRITE test_report_id         ON test_audit_report TYPE string;
DEFINE FIELD OVERWRITE passed                 ON test_audit_report TYPE bool;
DEFINE FIELD OVERWRITE caveats                ON test_audit_report FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE validation_results     ON test_audit_report FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE failed_evidence        ON test_audit_report FLEXIBLE TYPE option<object>;
DEFINE FIELD OVERWRITE composition_chain      ON test_audit_report FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE created_at             ON test_audit_report TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE idx_test_audit_report_org_registration
  ON test_audit_report FIELDS org_id, test_registration_id;
DEFINE INDEX OVERWRITE idx_test_audit_report_org_report
  ON test_audit_report FIELDS org_id, test_report_id;

-- =============================================================================
-- sensitivity_evidence
-- =============================================================================

DEFINE TABLE OVERWRITE sensitivity_evidence SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id                 ON sensitivity_evidence TYPE string;
DEFINE FIELD OVERWRITE test_registration_id   ON sensitivity_evidence TYPE string;
DEFINE FIELD OVERWRITE perturbation_id        ON sensitivity_evidence TYPE string;
DEFINE FIELD OVERWRITE run_id                 ON sensitivity_evidence TYPE string;
DEFINE FIELD OVERWRITE expected_effect        ON sensitivity_evidence TYPE string;
DEFINE FIELD OVERWRITE observed_effect        ON sensitivity_evidence TYPE option<string>;
DEFINE FIELD OVERWRITE expected_delta         ON sensitivity_evidence TYPE option<float>;
DEFINE FIELD OVERWRITE observed_delta         ON sensitivity_evidence TYPE option<float>;
DEFINE FIELD OVERWRITE varied_as_predicted    ON sensitivity_evidence TYPE bool;
DEFINE FIELD OVERWRITE details                ON sensitivity_evidence FLEXIBLE TYPE option<object>;
DEFINE FIELD OVERWRITE created_at             ON sensitivity_evidence TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE idx_sensitivity_evidence_org_registration_time
  ON sensitivity_evidence FIELDS org_id, test_registration_id, created_at;
DEFINE INDEX OVERWRITE idx_sensitivity_evidence_org_perturbation
  ON sensitivity_evidence FIELDS org_id, test_registration_id, perturbation_id;

-- =============================================================================
-- code_modification_proposal
-- =============================================================================

DEFINE TABLE OVERWRITE code_modification_proposal SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $token.org_id
    FOR create WHERE org_id = $token.org_id
    FOR update NONE
    FOR delete NONE;

DEFINE FIELD OVERWRITE org_id                 ON code_modification_proposal TYPE string;
DEFINE FIELD OVERWRITE source_audit_report_id ON code_modification_proposal TYPE option<string>;
DEFINE FIELD OVERWRITE test_registration_id   ON code_modification_proposal TYPE option<string>;
DEFINE FIELD OVERWRITE target_file            ON code_modification_proposal TYPE string;
DEFINE FIELD OVERWRITE diff                   ON code_modification_proposal TYPE string;
DEFINE FIELD OVERWRITE risk_tier              ON code_modification_proposal TYPE string
  ASSERT $value IN ['test_only', 'low', 'medium', 'high'];
DEFINE FIELD OVERWRITE risk_assessment        ON code_modification_proposal TYPE option<string>
  ASSERT $value = NONE OR $value IN ['low', 'medium', 'high'];
DEFINE FIELD OVERWRITE classification         ON code_modification_proposal TYPE option<string>
  ASSERT $value = NONE OR $value IN [
    'audit_insensitive', 'audit_noisy',
    'audit_misaligned', 'audit_record_incomplete'
  ];
DEFINE FIELD OVERWRITE rationale              ON code_modification_proposal TYPE option<string>;
DEFINE FIELD OVERWRITE supersedes             ON code_modification_proposal FLEXIBLE TYPE array DEFAULT [];
DEFINE FIELD OVERWRITE verification_confidence ON code_modification_proposal TYPE option<float>;
DEFINE FIELD OVERWRITE created_at             ON code_modification_proposal TYPE datetime DEFAULT time::now();

DEFINE INDEX OVERWRITE idx_code_mod_proposal_org_source
  ON code_modification_proposal FIELDS org_id, source_audit_report_id;
DEFINE INDEX OVERWRITE idx_code_mod_proposal_org_registration
  ON code_modification_proposal FIELDS org_id, test_registration_id;
