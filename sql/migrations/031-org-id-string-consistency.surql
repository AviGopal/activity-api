-- =============================================================================
-- Migration 031: Standardize org_id to TYPE string
-- =============================================================================
-- Convert all org_id fields from TYPE record<organizations> to TYPE string
-- This aligns with schema-migration.md and removes RECORD type dependencies
-- =============================================================================

-- Phase 1: Update core paradigm tables
-- =====================================

-- impulse table
DEFINE FIELD IF NOT EXISTS org_id ON impulse TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- activity table
DEFINE FIELD IF NOT EXISTS org_id ON activity TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- execution table
DEFINE FIELD IF NOT EXISTS org_id ON execution TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- vessel table
DEFINE FIELD IF NOT EXISTS org_id ON vessel TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 2: Update legacy activity tables
-- ========================================

-- activity_registry
DEFINE FIELD IF NOT EXISTS org_id ON activity_registry TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- activity_execution_traces
DEFINE FIELD IF NOT EXISTS org_id ON activity_execution_traces TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- activity_composition_graph
DEFINE FIELD IF NOT EXISTS org_id ON activity_composition_graph TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 3: Update impulse tables
-- ===============================

-- impulse_data
DEFINE FIELD IF NOT EXISTS org_id ON impulse_data TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- impulse_usage_history
DEFINE FIELD IF NOT EXISTS org_id ON impulse_usage_history TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- impulse_relevance_metrics
DEFINE FIELD IF NOT EXISTS org_id ON impulse_relevance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 4: Update tool/pattern tables
-- ====================================

-- tool_usage
DEFINE FIELD IF NOT EXISTS org_id ON tool_usage TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- pattern
DEFINE FIELD IF NOT EXISTS org_id ON pattern TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- thompson_selection_log
DEFINE FIELD IF NOT EXISTS org_id ON thompson_selection_log TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 5: Update composition tables
-- ===================================

-- goal_execution_paths
DEFINE FIELD IF NOT EXISTS org_id ON goal_execution_paths TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- activity_dataflows
DEFINE FIELD IF NOT EXISTS org_id ON activity_dataflows TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- activity_prerequisites
DEFINE FIELD IF NOT EXISTS org_id ON activity_prerequisites TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- prerequisite_patterns
DEFINE FIELD IF NOT EXISTS org_id ON prerequisite_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- execution_sequences
DEFINE FIELD IF NOT EXISTS org_id ON execution_sequences TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- composite_sequence_patterns
DEFINE FIELD IF NOT EXISTS org_id ON composite_sequence_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- Phase 6: Update CI/variant tables
-- ==================================

-- ci_runs
DEFINE FIELD IF NOT EXISTS org_id ON ci_runs TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- code_variants
DEFINE FIELD IF NOT EXISTS org_id ON code_variants TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- llm_resolution_log
DEFINE FIELD IF NOT EXISTS org_id ON llm_resolution_log TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

-- =============================================================================
-- Verification Queries
-- =============================================================================

-- Show all tables with org_id field and their types
-- Run after migration to verify all are TYPE string
-- SELECT name, fields.org_id.type FROM INFORMATION_SCHEMA.TABLES WHERE fields.org_id IS NOT NONE;
