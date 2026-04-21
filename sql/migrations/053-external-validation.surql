-- Migration 053: External Validation Tracking
-- Adds fields to track external validation outcomes separately from internal validation
-- Enables differentiated Thompson Sampling based on validation type

-- Purpose: Close the external validation feedback loop (25% gap between internal pass and external reality)
-- Design: /tmp/validation-resolver-design.md

-- ============================================================================
-- MODIFY: activity_execution_trace
-- Add external validation tracking fields
-- ============================================================================

-- External validation tracking
DEFINE FIELD internal_validation_passed ON activity_execution_trace TYPE bool DEFAULT true;
DEFINE FIELD external_validation_passed ON activity_execution_trace TYPE bool DEFAULT true;
DEFINE FIELD external_validation_type ON activity_execution_trace TYPE option<string>;
DEFINE FIELD external_error_type ON activity_execution_trace TYPE option<string>;
DEFINE FIELD external_failure_category ON activity_execution_trace TYPE option<string>;
DEFINE FIELD external_retriable ON activity_execution_trace TYPE bool DEFAULT false;

-- Index for querying by external validation status
DEFINE INDEX idx_external_validation_status ON activity_execution_trace
  FIELDS external_validation_passed, external_failure_category;

-- ============================================================================
-- SKIP: activity_execution_task_result
-- This table does not exist. Task-level data is stored in the flexible
-- activity_execution_traces.tasks array field instead.
-- External validation tracking at task level should be added directly
-- to the tasks array objects when needed.
-- ============================================================================

-- ============================================================================
-- MODIFY: activity_metrics
-- Add external validation metrics for Thompson Sampling
-- ============================================================================

-- Differentiated success tracking
DEFINE FIELD internal_validation_successes ON activity_metrics TYPE number DEFAULT 0;
DEFINE FIELD internal_validation_failures ON activity_metrics TYPE number DEFAULT 0;
DEFINE FIELD external_validation_successes ON activity_metrics TYPE number DEFAULT 0;
DEFINE FIELD external_validation_failures ON activity_metrics TYPE number DEFAULT 0;

-- Failure category tracking for weighted Thompson Sampling
DEFINE FIELD failure_categories ON activity_metrics TYPE option<object>;
-- Example structure: { "schema_mismatch": 5, "auth": 2, "timeout": 1 }

-- Computed field: External validation success rate
DEFINE FIELD external_validation_rate ON activity_metrics VALUE
  IF external_validation_successes + external_validation_failures > 0 THEN
    external_validation_successes / (external_validation_successes + external_validation_failures)
  ELSE
    1.0
  END;

-- ============================================================================
-- NEW TABLE: external_validation_history
-- Track all external validation outcomes for analysis
-- ============================================================================

DEFINE TABLE external_validation_history SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create, update, delete WHERE org_id = $auth.org_id;

DEFINE FIELD org_id ON external_validation_history TYPE string;
DEFINE FIELD execution_id ON external_validation_history TYPE record<activity_execution_trace>;
DEFINE FIELD task_id ON external_validation_history TYPE string;
DEFINE FIELD validation_type ON external_validation_history TYPE string
  ASSERT $value IN ['database', 'api', 'test_suite', 'command', 'script'];
DEFINE FIELD passed ON external_validation_history TYPE bool;
DEFINE FIELD error_type ON external_validation_history TYPE option<string>;
DEFINE FIELD error_message ON external_validation_history TYPE option<string>;
DEFINE FIELD failure_category ON external_validation_history TYPE option<string>
  ASSERT $value IN [
    'code_quality',
    'schema_mismatch',
    'auth',
    'resource',
    'rate_limit',
    'timeout',
    'network',
    'external_service',
    'contract_violation',
    'behavior',
    'environment',
    'execution',
    'input',
    'unknown',
    NONE
  ];
DEFINE FIELD retriable ON external_validation_history TYPE bool;
DEFINE FIELD duration_ms ON external_validation_history TYPE number;
DEFINE FIELD timestamp ON external_validation_history TYPE datetime DEFAULT time::now();

-- Indexes for querying validation history
DEFINE INDEX idx_validation_type_outcome ON external_validation_history
  FIELDS validation_type, passed, error_type;

DEFINE INDEX idx_validation_timestamp ON external_validation_history
  FIELDS timestamp;

-- ============================================================================
-- MIGRATION NOTES
-- ============================================================================

-- This migration adds external validation tracking without breaking existing data:
-- - All new fields have DEFAULT values
-- - Existing executions will have internal_validation_passed=true, external_validation_passed=true
-- - No data migration needed - new fields populate on next execution
-- - Thompson Sampling will gradually incorporate external validation signals

-- Expected impact:
-- - 25% gap between internal and external validation becomes visible in metrics
-- - Templates with high external failure rates get lower Thompson Sampling scores
-- - Variant creation triggered by external validation failures
-- - Dashboard shows internal vs external success rates separately

-- Rollback: Simply remove the new fields (data loss acceptable for metrics)
-- REMOVE FIELD internal_validation_passed ON activity_execution_trace;
-- REMOVE FIELD external_validation_passed ON activity_execution_trace;
-- etc.
