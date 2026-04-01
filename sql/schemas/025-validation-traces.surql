-- =============================================================================
-- API Validation Traces for Pattern Detection
-- =============================================================================
-- Captures validation errors at API boundaries to detect schema drift,
-- field naming mismatches, and other recurring validation issues.
-- Enables self-healing through pattern detection and auto-remediation.
-- =============================================================================
-- NOTE: Using TYPE ANY SCHEMALESS to allow flexible nested objects in
-- validation_errors array. SCHEMAFULL with FLEXIBLE arrays doesn't work
-- well in SurrealDB 3.x for deeply nested structures.
-- =============================================================================

DEFINE TABLE OVERWRITE api_validation_trace TYPE ANY SCHEMALESS
  PERMISSIONS
    -- Allow select and create for authenticated users
    FOR select, create FULL
    -- No updates or deletes (traces are immutable)
    FOR update, delete NONE;

-- Indexes for pattern detection queries
DEFINE INDEX idx_validation_trace_id
  ON api_validation_trace FIELDS trace_id UNIQUE;

DEFINE INDEX idx_validation_trace_endpoint
  ON api_validation_trace FIELDS endpoint;

DEFINE INDEX idx_validation_trace_timestamp
  ON api_validation_trace FIELDS timestamp;

DEFINE INDEX idx_validation_trace_caller
  ON api_validation_trace FIELDS caller_id;

DEFINE INDEX idx_validation_trace_org
  ON api_validation_trace FIELDS org_id;

-- Composite index for pattern queries
DEFINE INDEX idx_validation_trace_pattern
  ON api_validation_trace FIELDS endpoint, timestamp;

-- =============================================================================
-- Validation Pattern Detection (Materialized View Concept)
-- =============================================================================
-- This would be a computed view in future SurrealDB versions
-- For now, pattern detection is done via queries in validation-traces.ts
-- =============================================================================

-- Example pattern detection query (for documentation):
-- SELECT
--   string::join('.', validation_errors[0].field_path) as field_path,
--   validation_errors[0].code as error_code,
--   count() as frequency,
--   math::min(timestamp) as first_seen,
--   math::max(timestamp) as last_seen
-- FROM api_validation_trace
-- WHERE timestamp > time::now() - 24h
-- GROUP BY field_path, error_code
-- HAVING frequency >= 3
-- ORDER BY frequency DESC
