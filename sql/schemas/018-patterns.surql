-- =============================================================================
-- Patterns: Extracted Deterministic Resolvers
-- =============================================================================
-- Patterns are deterministic resolvers extracted from successful LLM resolutions.
-- They enable Tier 1 (exact match) and Tier 2 (interpolation) resolution.
-- This is where the learning flywheel converts expensive LLM calls to free patterns.
-- RBAC: Patterns can be org-scoped or global (public=true).
-- =============================================================================

-- =============================================================================
-- Table: pattern
-- =============================================================================
-- Stores extracted patterns with their templates and performance metrics.
-- Pattern matching is the first tier checked in the resolver router.
-- =============================================================================

DEFINE TABLE IF NOT EXISTS pattern SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see patterns in their org OR public patterns
    FOR select WHERE org_id = $auth.org_id OR public = true

    -- CREATE: Any authenticated user/instance can create patterns
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Users can update their own patterns or admins can update any
    FOR update WHERE
      org_id = $auth.org_id
      AND (created_by = $auth.id OR $auth.role = 'admin')

    -- DELETE: Only admins can delete patterns
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Unique pattern identifier
DEFINE FIELD IF NOT EXISTS pattern_id ON pattern TYPE string
  ASSERT $value != NONE
  COMMENT "Unique pattern identifier (e.g., pattern-{hash}-{timestamp})";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON pattern TYPE record<organizations>
  ASSERT $value != NONE
  VALUE $value OR $auth.org_id
  COMMENT "Organization ID (required for all patterns)";

DEFINE FIELD IF NOT EXISTS project_id ON pattern TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional, for project-specific patterns)";

DEFINE FIELD IF NOT EXISTS created_by ON pattern TYPE option<record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User or MiniBob instance who created/extracted this pattern";

-- Public patterns visible to all organizations
DEFINE FIELD IF NOT EXISTS public ON pattern TYPE bool
  VALUE $value OR false
  DEFAULT false
  COMMENT "Whether this pattern is visible to all organizations";

-- =============================================================================
-- Pattern Matching
-- =============================================================================

-- Hash of the impulse shape this pattern matches
DEFINE FIELD IF NOT EXISTS impulse_hash ON pattern TYPE string
  ASSERT $value != NONE
  COMMENT "SHA-256 hash of impulse shape for exact matching";

-- Shape descriptor for debugging/display
DEFINE FIELD IF NOT EXISTS impulse_shape ON pattern TYPE option<object> FLEXIBLE
  COMMENT "Original impulse shape metadata (for inspection)";

-- Similarity threshold for interpolation matches
DEFINE FIELD IF NOT EXISTS similarity_threshold ON pattern TYPE float
  ASSERT $value >= 0 AND $value <= 1
  VALUE $value OR 0.85
  DEFAULT 0.85
  COMMENT "Minimum similarity for interpolation matches (default 0.85)";

-- =============================================================================
-- Pattern Template
-- =============================================================================

-- The deterministic template that produces the result
DEFINE FIELD IF NOT EXISTS template ON pattern TYPE object FLEXIBLE
  ASSERT $value != NONE
  COMMENT "Pattern template with placeholders for variable content";

-- Template type for different resolution strategies
DEFINE FIELD IF NOT EXISTS template_type ON pattern TYPE string
  ASSERT $value IN ['exact', 'interpolate', 'parametric']
  VALUE $value OR 'exact'
  DEFAULT 'exact'
  COMMENT "Template type: exact (1:1), interpolate (similar), parametric (computed)";

-- Variables/parameters the template accepts
DEFINE FIELD IF NOT EXISTS template_variables ON pattern TYPE option<array<object>> FLEXIBLE
  COMMENT "Array of variable definitions the template can accept";

-- =============================================================================
-- Performance Metrics
-- =============================================================================

-- Success tracking
DEFINE FIELD IF NOT EXISTS executions ON pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Total times this pattern was used";

DEFINE FIELD IF NOT EXISTS successes ON pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Successful pattern matches";

DEFINE FIELD IF NOT EXISTS failures ON pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Failed pattern matches";

-- Success rate (computed from successes/executions)
DEFINE FIELD IF NOT EXISTS success_rate ON pattern TYPE float
  ASSERT $value >= 0 AND $value <= 1
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Success rate (successes / executions)";

-- Result consistency across uses
DEFINE FIELD IF NOT EXISTS result_consistency ON pattern TYPE float
  ASSERT $value >= 0 AND $value <= 1
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Consistency of results when pattern is used";

-- Cost savings
DEFINE FIELD IF NOT EXISTS cost_savings_usd ON pattern TYPE float
  ASSERT $value >= 0
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Total USD saved by using this pattern instead of LLM";

-- =============================================================================
-- Extraction Provenance
-- =============================================================================

-- Source resolutions that led to this pattern
DEFINE FIELD IF NOT EXISTS source_resolution_count ON pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Number of LLM resolutions used to extract this pattern";

DEFINE FIELD IF NOT EXISTS source_resolutions ON pattern TYPE option<array<record<llm_resolution_log>>>
  COMMENT "References to source LLM resolutions";

-- Extraction metadata
DEFINE FIELD IF NOT EXISTS extracted_at ON pattern TYPE datetime
  VALUE $value OR time::now()
  DEFAULT time::now()
  COMMENT "When this pattern was extracted";

DEFINE FIELD IF NOT EXISTS extraction_method ON pattern TYPE string
  ASSERT $value IN ['ribosome', 'manual', 'imported']
  VALUE $value OR 'ribosome'
  DEFAULT 'ribosome'
  COMMENT "How pattern was created: ribosome (auto), manual, imported";

-- =============================================================================
-- Status and Lifecycle
-- =============================================================================

DEFINE FIELD IF NOT EXISTS status ON pattern TYPE string
  ASSERT $value IN ['active', 'deprecated', 'testing']
  VALUE $value OR 'active'
  DEFAULT 'active'
  COMMENT "Pattern status: active (in use), deprecated (being phased out), testing (not yet promoted)";

-- Minimum metrics to be used in production
DEFINE FIELD IF NOT EXISTS min_executions_for_tier1 ON pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 10
  DEFAULT 10
  COMMENT "Minimum executions before pattern qualifies for Tier 1";

DEFINE FIELD IF NOT EXISTS min_success_rate_for_tier1 ON pattern TYPE float
  ASSERT $value >= 0 AND $value <= 1
  VALUE $value OR 0.90
  DEFAULT 0.90
  COMMENT "Minimum success rate for Tier 1 (default 90%)";

-- Version tracking
DEFINE FIELD IF NOT EXISTS version ON pattern TYPE int
  ASSERT $value >= 1
  VALUE $value OR 1
  DEFAULT 1
  COMMENT "Pattern version (incremented on updates)";

DEFINE FIELD IF NOT EXISTS previous_version ON pattern TYPE option<record<pattern>>
  COMMENT "Reference to previous version of this pattern";

-- =============================================================================
-- Timestamps
-- =============================================================================

DEFINE FIELD IF NOT EXISTS last_used_at ON pattern TYPE option<datetime>
  COMMENT "Last time this pattern was used for resolution";

DEFINE FIELD IF NOT EXISTS created_at ON pattern TYPE datetime
  VALUE $value OR time::now()
  DEFAULT time::now()
  COMMENT "Record creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON pattern TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- =============================================================================
-- Indexes
-- =============================================================================

-- Unique pattern ID
DEFINE INDEX IF NOT EXISTS idx_pattern_id
  ON pattern FIELDS pattern_id UNIQUE;

-- Impulse hash for fast pattern lookup
DEFINE INDEX IF NOT EXISTS idx_pattern_impulse_hash
  ON pattern FIELDS impulse_hash;

-- Multi-tenant indexes (CRITICAL for RBAC performance)
DEFINE INDEX IF NOT EXISTS idx_pattern_org
  ON pattern FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_pattern_project
  ON pattern FIELDS project_id;

-- Public patterns
DEFINE INDEX IF NOT EXISTS idx_pattern_public
  ON pattern FIELDS public;

-- Status filtering
DEFINE INDEX IF NOT EXISTS idx_pattern_status
  ON pattern FIELDS status;

-- Success rate for tier selection
DEFINE INDEX IF NOT EXISTS idx_pattern_success_rate
  ON pattern FIELDS success_rate;

-- Composite indexes for tier selection queries
DEFINE INDEX IF NOT EXISTS idx_pattern_tier1_eligible
  ON pattern FIELDS impulse_hash, status, success_rate, executions;

DEFINE INDEX IF NOT EXISTS idx_pattern_org_status
  ON pattern FIELDS org_id, status;

-- Last used for cache warming
DEFINE INDEX IF NOT EXISTS idx_pattern_last_used
  ON pattern FIELDS last_used_at;
