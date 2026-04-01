-- =============================================================================
-- LLM Resolution Log: Full Trace Capture for Learning
-- =============================================================================
-- Records every resolution attempt through the tiered resolver system.
-- Captures full request/response for LLM calls to enable pattern extraction.
-- This is the raw material for the learning flywheel.
-- RBAC: Scoped by organization.
-- =============================================================================

-- =============================================================================
-- Table: llm_resolution_log
-- =============================================================================
-- Records individual resolution attempts with full trace data.
-- Pattern matches (Tier 1-2) and LLM calls (Tier 3-5) are both logged.
-- =============================================================================

DEFINE TABLE IF NOT EXISTS llm_resolution_log SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see resolutions in their organization
    FOR select WHERE org_id = $auth.org_id

    -- CREATE: Any authenticated user/instance can create resolution logs
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Users can update their own resolutions or admins can update any
    FOR update WHERE
      org_id = $auth.org_id
      AND (created_by = $auth.id OR $auth.role = 'admin')

    -- DELETE: Only admins can delete resolution logs
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON llm_resolution_log TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON llm_resolution_log TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional, inherited from auth context)";

DEFINE FIELD IF NOT EXISTS created_by ON llm_resolution_log TYPE option<record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User or MiniBob instance who initiated this resolution";

-- Connection context
DEFINE FIELD IF NOT EXISTS connection_id ON llm_resolution_log TYPE option<record<connection>>
  COMMENT "Connection that made this resolution request";

DEFINE FIELD IF NOT EXISTS execution_id ON llm_resolution_log TYPE option<record<activity_execution_traces>>
  COMMENT "Execution trace this resolution is part of";

-- =============================================================================
-- Resolver Selection
-- =============================================================================

DEFINE FIELD IF NOT EXISTS resolver_tier ON llm_resolution_log TYPE string
  ASSERT $value IN ['pattern', 'interpolate', 'haiku', 'sonnet', 'opus']
  COMMENT "Tier used for resolution: pattern (1), interpolate (2), haiku (3), sonnet (4), opus (5)";

DEFINE FIELD IF NOT EXISTS resolver_confidence ON llm_resolution_log TYPE float
  ASSERT $value >= 0 AND $value <= 1
  COMMENT "Confidence score for resolver selection (0-1)";

DEFINE FIELD IF NOT EXISTS resolver_reasoning ON llm_resolution_log TYPE option<string>
  COMMENT "Explanation of why this resolver tier was selected";

DEFINE FIELD IF NOT EXISTS prefer_tier ON llm_resolution_log TYPE option<string>
  ASSERT $value IS NONE OR $value IN ['pattern', 'haiku', 'sonnet', 'opus']
  COMMENT "Client-requested tier preference (hint, not guarantee)";

-- =============================================================================
-- Pattern Match Fields (Tier 1-2)
-- =============================================================================

DEFINE FIELD IF NOT EXISTS pattern_id ON llm_resolution_log TYPE option<string>
  COMMENT "Pattern ID if resolved via pattern match";

DEFINE FIELD IF NOT EXISTS pattern_success_rate ON llm_resolution_log TYPE option<float>
  COMMENT "Success rate of matched pattern at time of resolution";

DEFINE FIELD IF NOT EXISTS pattern_similarity ON llm_resolution_log TYPE option<float>
  COMMENT "Similarity score for interpolation matches (Tier 2)";

-- =============================================================================
-- LLM Request/Response (Tier 3-5)
-- =============================================================================

DEFINE FIELD IF NOT EXISTS llm_model ON llm_resolution_log TYPE option<string>
  COMMENT "Model used: claude-3-haiku, claude-sonnet-4, claude-opus-4-5";

DEFINE FIELD IF NOT EXISTS llm_request ON llm_resolution_log TYPE option<object> FLEXIBLE
  COMMENT "Full LLM request (system, messages, tools, etc.)";

DEFINE FIELD IF NOT EXISTS llm_response ON llm_resolution_log TYPE option<object> FLEXIBLE
  COMMENT "Full LLM response (content, stop_reason, usage, etc.)";

DEFINE FIELD IF NOT EXISTS thinking ON llm_resolution_log TYPE option<string>
  COMMENT "Extended thinking content if available";

-- Token usage
DEFINE FIELD IF NOT EXISTS tokens_input ON llm_resolution_log TYPE option<int>
  ASSERT $value IS NONE OR $value >= 0
  COMMENT "Input tokens consumed";

DEFINE FIELD IF NOT EXISTS tokens_output ON llm_resolution_log TYPE option<int>
  ASSERT $value IS NONE OR $value >= 0
  COMMENT "Output tokens generated";

DEFINE FIELD IF NOT EXISTS tokens_cache ON llm_resolution_log TYPE option<int>
  ASSERT $value IS NONE OR $value >= 0
  COMMENT "Cache tokens reused";

-- Performance
DEFINE FIELD IF NOT EXISTS latency_ms ON llm_resolution_log TYPE option<int>
  ASSERT $value IS NONE OR $value >= 0
  COMMENT "Resolution latency in milliseconds";

-- =============================================================================
-- Outcome
-- =============================================================================

DEFINE FIELD IF NOT EXISTS success ON llm_resolution_log TYPE bool
  VALUE $value OR false
  DEFAULT false
  COMMENT "Whether the resolution succeeded";

DEFINE FIELD IF NOT EXISTS result ON llm_resolution_log TYPE option<object> FLEXIBLE
  COMMENT "Resolution result (format varies by resolver type)";

DEFINE FIELD IF NOT EXISTS error_message ON llm_resolution_log TYPE option<string>
  COMMENT "Error message if resolution failed";

DEFINE FIELD IF NOT EXISTS error_type ON llm_resolution_log TYPE option<string>
  COMMENT "Error category: budget_exceeded, rate_limited, timeout, etc.";

-- Cost tracking
DEFINE FIELD IF NOT EXISTS cost_usd ON llm_resolution_log TYPE float
  ASSERT $value >= 0
  VALUE $value OR 0
  DEFAULT 0
  COMMENT "Resolution cost in USD (0 for pattern matches)";

-- =============================================================================
-- Pattern Extraction Fields (Ribosome Integration)
-- =============================================================================

DEFINE FIELD IF NOT EXISTS impulse_hash ON llm_resolution_log TYPE option<string>
  COMMENT "Hash of impulse shape for pattern matching";

DEFINE FIELD IF NOT EXISTS impulse_metadata ON llm_resolution_log TYPE option<object> FLEXIBLE
  COMMENT "Impulse metadata used for pattern extraction";

DEFINE FIELD IF NOT EXISTS pattern_extracted ON llm_resolution_log TYPE bool
  VALUE $value OR false
  DEFAULT false
  COMMENT "Whether a pattern was extracted from this resolution";

DEFINE FIELD IF NOT EXISTS extracted_pattern_id ON llm_resolution_log TYPE option<string>
  COMMENT "ID of pattern extracted from this resolution";

-- =============================================================================
-- Timestamps
-- =============================================================================

DEFINE FIELD IF NOT EXISTS resolved_at ON llm_resolution_log TYPE datetime
  VALUE $value OR time::now()
  DEFAULT time::now()
  COMMENT "When resolution completed";

DEFINE FIELD IF NOT EXISTS created_at ON llm_resolution_log TYPE datetime
  VALUE $value OR time::now()
  DEFAULT time::now()
  COMMENT "Record creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON llm_resolution_log TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- =============================================================================
-- Indexes
-- =============================================================================

-- Multi-tenant indexes (CRITICAL for RBAC performance)
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_org
  ON llm_resolution_log FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_llm_resolution_project
  ON llm_resolution_log FIELDS project_id;

-- Resolver tier analytics
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_tier
  ON llm_resolution_log FIELDS resolver_tier;

-- Impulse hash for pattern matching
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_impulse_hash
  ON llm_resolution_log FIELDS impulse_hash;

-- Connection tracking
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_connection
  ON llm_resolution_log FIELDS connection_id;

-- Execution tracking
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_execution
  ON llm_resolution_log FIELDS execution_id;

-- Pattern extraction queries
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_pattern_extracted
  ON llm_resolution_log FIELDS pattern_extracted;

-- Composite indexes for common queries
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_org_tier
  ON llm_resolution_log FIELDS org_id, resolver_tier;

DEFINE INDEX IF NOT EXISTS idx_llm_resolution_hash_success
  ON llm_resolution_log FIELDS impulse_hash, success;

-- Time-based queries
DEFINE INDEX IF NOT EXISTS idx_llm_resolution_created_at
  ON llm_resolution_log FIELDS created_at;
