-- =============================================================================
-- Migration 032: Fix org_id VALUE clause to prevent type coercion
-- =============================================================================
-- Problem: When using RECORD authentication, $auth.org_id may be coerced to
-- a record ID (organizations:metabob_internal) instead of staying as string
-- Solution: Explicitly cast $auth.org_id to string in VALUE clauses
-- =============================================================================

-- Phase 1: Core paradigm tables (020-paradigm-core-tables.surql)
-- ===============================================================

DEFINE FIELD IF NOT EXISTS org_id ON impulse TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON activity TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON execution TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Note: vessel table does not have VALUE clause, requires explicit org_id

-- Phase 2: Activity registry tables (010-activity-registry.surql)
-- ================================================================

DEFINE FIELD IF NOT EXISTS org_id ON activity_registry TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON variant_performance_metrics TYPE option<string>
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 3: Execution tables (011-executions.surql)
-- =================================================

DEFINE FIELD IF NOT EXISTS org_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON impulse_relevance_metrics TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON tool_usage TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON thompson_selection_log TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 4: Composition tables (012-composition.surql)
-- ====================================================

DEFINE FIELD IF NOT EXISTS org_id ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON activity_prerequisites TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON prerequisite_patterns TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON execution_sequences TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 5: Impulse tables (013-impulse-tool-usage.surql)
-- =======================================================

DEFINE FIELD IF NOT EXISTS org_id ON impulse_data TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON impulse_usage_history TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON ci_runs TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON code_variants TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 6: Ribosome sequences (014-ribosome-sequences.surql)
-- ===========================================================

DEFINE FIELD IF NOT EXISTS org_id ON composite_sequence_patterns TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 7: LLM resolution (017-llm-resolution.surql)
-- ===================================================

DEFINE FIELD IF NOT EXISTS org_id ON llm_resolution_log TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 8: Patterns (018-patterns.surql)
-- =======================================

DEFINE FIELD IF NOT EXISTS org_id ON pattern TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 9: Resolver architecture (028-resolver-architecture.surql)
-- =================================================================

DEFINE FIELD IF NOT EXISTS org_id ON state_transition TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS org_id ON impulse_state_pattern TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

-- =============================================================================
-- Verification Queries
-- =============================================================================

-- Check that all tables with org_id VALUE clauses are using <string> cast
-- SELECT name, fields.org_id.value FROM INFORMATION_SCHEMA.TABLES
-- WHERE fields.org_id IS NOT NONE AND fields.org_id.value CONTAINS '$auth.org_id';
