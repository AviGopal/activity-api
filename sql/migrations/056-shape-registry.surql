-- Migration 056: Shape Registry and Vessel Discovery Enhancement
-- Date: 2026-04-10
-- Purpose: Implement shape registry for versioned shape definitions and vessel discovery
--
-- SPEC: openspec/changes/vessel-integration-standardization/specs/shape-registry/spec.md
-- SPEC: openspec/changes/vessel-integration-standardization/specs/vessel-discovery/spec.md

-- ============================================================================
-- shape_definition: Versioned shape definitions for impulse validation
-- ============================================================================

DEFINE TABLE shape_definition SCHEMAFULL
  PERMISSIONS
    -- Public shapes visible to all orgs, private shapes only to owning org
    FOR select WHERE
      public = true
      OR org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')
    FOR create WHERE $auth != NONE
    FOR update WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')
    FOR delete WHERE
      org_id IS NONE
      OR org_id = $auth.org_id;

-- Identity
DEFINE FIELD name ON shape_definition TYPE string
  ASSERT $value != NONE
  COMMENT "Shape name (e.g., 'file_diff', 'error_log')";

DEFINE FIELD version ON shape_definition TYPE string
  ASSERT $value != NONE AND $value ~ '^\\d+\\.\\d+\\.\\d+$'
  COMMENT "Semantic version (MAJOR.MINOR.PATCH)";

-- Schema definition
DEFINE FIELD schema ON shape_definition TYPE object FLEXIBLE
  ASSERT $value != NONE
  COMMENT "JSON Schema definition for this shape";

DEFINE FIELD description ON shape_definition TYPE string
  ASSERT $value != NONE
  COMMENT "Human-readable description";

DEFINE FIELD example ON shape_definition TYPE object FLEXIBLE
  ASSERT $value != NONE
  COMMENT "Valid example matching schema";

-- Categorization
DEFINE FIELD tags ON shape_definition TYPE array<string>
  DEFAULT []
  COMMENT "Categorization tags (e.g., ['analysis', 'git'])";

-- Visibility
DEFINE FIELD public ON shape_definition TYPE bool
  DEFAULT false
  COMMENT "If true, visible to all organizations";

DEFINE FIELD org_id ON shape_definition TYPE option<string>
  COMMENT "Organization ID (null for global shapes)";

-- Deprecation
DEFINE FIELD deprecated ON shape_definition TYPE bool
  DEFAULT false
  COMMENT "Whether this version is deprecated";

DEFINE FIELD deprecation_reason ON shape_definition TYPE option<string>
  COMMENT "Reason for deprecation";

-- Evolution tracking
DEFINE FIELD migration_from ON shape_definition TYPE option<string>
  COMMENT "Previous version(s) this replaces (e.g., '1.x.x')";

DEFINE FIELD breaking_changes ON shape_definition TYPE array<string>
  DEFAULT []
  COMMENT "List of breaking changes from previous major version";

DEFINE FIELD changelog ON shape_definition TYPE option<string>
  COMMENT "Version-specific changes";

-- Metadata
DEFINE FIELD created_at ON shape_definition TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD created_by ON shape_definition TYPE option<string>
  COMMENT "User ID who registered shape";

-- ============================================================================
-- Indexes
-- ============================================================================

-- Unique index on name+version combination
DEFINE INDEX idx_shape_name_version ON shape_definition COLUMNS name, version UNIQUE;

-- Index on name for version lookups
DEFINE INDEX idx_shape_name ON shape_definition COLUMNS name;

-- Index on tags for filtering
DEFINE INDEX idx_shape_tags ON shape_definition COLUMNS tags;

-- Index on org_id for multi-tenant queries
DEFINE INDEX idx_shape_org ON shape_definition COLUMNS org_id;

-- Index on public flag for visibility queries
DEFINE INDEX idx_shape_public ON shape_definition COLUMNS public;

-- ============================================================================
-- routing_trace: Vessel-to-vessel routing decisions
-- ============================================================================

DEFINE TABLE routing_trace SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id;

-- Request context
DEFINE FIELD shape ON routing_trace TYPE string
  ASSERT $value != NONE
  COMMENT "Shape being resolved";

DEFINE FIELD shape_version ON routing_trace TYPE option<string>
  COMMENT "Requested shape version constraint";

DEFINE FIELD requesting_vessel_id ON routing_trace TYPE option<string>
  COMMENT "Vessel making the request";

-- Routing decision
DEFINE FIELD selected_vessel_id ON routing_trace TYPE option<string>
  COMMENT "Vessel selected to handle request";

DEFINE FIELD selection_reason ON routing_trace TYPE option<string>
  COMMENT "Why this vessel was selected";

DEFINE FIELD candidates ON routing_trace TYPE array<object> FLEXIBLE
  DEFAULT []
  COMMENT "All vessels considered for routing";

-- Outcome
DEFINE FIELD success ON routing_trace TYPE bool
  COMMENT "Whether routing succeeded";

DEFINE FIELD latency_ms ON routing_trace TYPE option<int>
  COMMENT "Time to complete routing decision";

DEFINE FIELD error ON routing_trace TYPE option<string>
  COMMENT "Error message if routing failed";

-- Metadata
DEFINE FIELD org_id ON routing_trace TYPE string
  COMMENT "Organization ID";

DEFINE FIELD timestamp ON routing_trace TYPE datetime
  VALUE $value OR time::now()
  COMMENT "When routing occurred";

-- ============================================================================
-- circuit_breaker_trace: Vessel health and failure tracking
-- ============================================================================

DEFINE TABLE circuit_breaker_trace SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id;

-- Vessel identification
DEFINE FIELD vessel_id ON circuit_breaker_trace TYPE string
  ASSERT $value != NONE
  COMMENT "Vessel being monitored";

DEFINE FIELD shape ON circuit_breaker_trace TYPE option<string>
  COMMENT "Shape involved in the failure (if applicable)";

-- Circuit breaker state
DEFINE FIELD state ON circuit_breaker_trace TYPE string
  ASSERT $value != NONE AND $value INSIDE ['closed', 'open', 'half_open']
  COMMENT "Circuit breaker state: closed (healthy), open (failing), half_open (testing)";

DEFINE FIELD failure_count ON circuit_breaker_trace TYPE int
  DEFAULT 0
  COMMENT "Consecutive failures";

DEFINE FIELD success_count ON circuit_breaker_trace TYPE int
  DEFAULT 0
  COMMENT "Consecutive successes (in half_open state)";

-- Thresholds
DEFINE FIELD failure_threshold ON circuit_breaker_trace TYPE int
  DEFAULT 5
  COMMENT "Failures before opening circuit";

DEFINE FIELD recovery_threshold ON circuit_breaker_trace TYPE int
  DEFAULT 3
  COMMENT "Successes before closing circuit";

-- Failure details
DEFINE FIELD last_failure_reason ON circuit_breaker_trace TYPE option<string>
  COMMENT "Most recent failure message";

DEFINE FIELD last_failure_at ON circuit_breaker_trace TYPE option<datetime>
  COMMENT "When last failure occurred";

-- Recovery
DEFINE FIELD next_retry_at ON circuit_breaker_trace TYPE option<datetime>
  COMMENT "When to attempt recovery (in open state)";

-- Metadata
DEFINE FIELD org_id ON circuit_breaker_trace TYPE string
  COMMENT "Organization ID";

DEFINE FIELD timestamp ON circuit_breaker_trace TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last state change timestamp";

-- ============================================================================
-- Indexes
-- ============================================================================

-- routing_trace indexes
DEFINE INDEX idx_routing_shape ON routing_trace COLUMNS shape;
DEFINE INDEX idx_routing_vessel ON routing_trace COLUMNS selected_vessel_id;
DEFINE INDEX idx_routing_org ON routing_trace COLUMNS org_id;
DEFINE INDEX idx_routing_timestamp ON routing_trace COLUMNS timestamp;

-- circuit_breaker_trace indexes
DEFINE INDEX idx_circuit_vessel ON circuit_breaker_trace COLUMNS vessel_id;
DEFINE INDEX idx_circuit_state ON circuit_breaker_trace COLUMNS state;
DEFINE INDEX idx_circuit_org ON circuit_breaker_trace COLUMNS org_id;
DEFINE INDEX idx_circuit_timestamp ON circuit_breaker_trace COLUMNS timestamp;

-- ============================================================================
-- Verification
-- ============================================================================

-- Expected: These queries should work after migration
-- SELECT * FROM shape_definition WHERE name = 'file_diff' ORDER BY version DESC;
-- SELECT * FROM routing_trace WHERE shape = 'error_log' ORDER BY timestamp DESC LIMIT 10;
-- SELECT * FROM circuit_breaker_trace WHERE state = 'open' AND org_id = $auth.org_id;
