-- =============================================================================
-- Tool Argument Pattern Tracking Schema
--
-- Tracks patterns in tool arguments across activity executions for:
-- - Deduplication: Identify repeated argument patterns
-- - Learning: Which argument patterns lead to success
-- - Recommendations: Suggest proven arguments for new executions
-- =============================================================================

-- -----------------------------------------------------------------------------
-- tool_argument_pattern table
--
-- Stores unique argument patterns observed during activity executions
-- Tracks usage frequency, success rate, and execution performance
-- -----------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS tool_argument_pattern SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see patterns in their org
    FOR select WHERE org_id = $auth.org_id

    -- CREATE: Any authenticated user can create patterns
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Users can update patterns in their org
    FOR update WHERE org_id = $auth.org_id

    -- DELETE: Only admins can delete patterns
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Primary identification
DEFINE FIELD IF NOT EXISTS activity_id ON tool_argument_pattern TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that uses this pattern (FK to activity table)";

DEFINE FIELD IF NOT EXISTS tool_name ON tool_argument_pattern TYPE string
  ASSERT $value != NONE
  COMMENT "Tool identifier (bash, read, write, edit, git, etc.)";

DEFINE FIELD IF NOT EXISTS argument_shape ON tool_argument_pattern TYPE string
  ASSERT $value != NONE
  COMMENT "Shape identifier describing argument structure (file_read_args, bash_args, etc.)";

DEFINE FIELD IF NOT EXISTS argument_hash ON tool_argument_pattern TYPE string
  ASSERT $value != NONE
  COMMENT "Stable hash of arguments for deduplication (SHA-256 of normalized args)";

-- The actual argument values (FLEXIBLE to allow arbitrary nested structure)
DEFINE FIELD IF NOT EXISTS arguments ON tool_argument_pattern TYPE object FLEXIBLE
  COMMENT "The actual argument values passed to the tool";

-- Usage and success metrics
DEFINE FIELD IF NOT EXISTS times_used ON tool_argument_pattern TYPE int
  VALUE $value OR 0
  COMMENT "Total number of times this pattern was used";

DEFINE FIELD IF NOT EXISTS times_succeeded ON tool_argument_pattern TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions using this pattern";

DEFINE FIELD IF NOT EXISTS avg_execution_ms ON tool_argument_pattern TYPE float
  VALUE $value OR 0.0
  COMMENT "Rolling average execution time in milliseconds";

DEFINE FIELD IF NOT EXISTS last_used_at ON tool_argument_pattern TYPE option<datetime>
  COMMENT "Timestamp of last usage";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON tool_argument_pattern TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON tool_argument_pattern TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional, inherited from auth context)";

-- created_by can be either a user (dashboard) or a minibob_instance (autonomous vessel)
DEFINE FIELD IF NOT EXISTS created_by ON tool_argument_pattern TYPE option<record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User or MiniBob instance who created this pattern";

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON tool_argument_pattern TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON tool_argument_pattern TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- -----------------------------------------------------------------------------
-- Indexes for tool_argument_pattern
-- -----------------------------------------------------------------------------

-- Primary lookup by activity
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_activity
  ON tool_argument_pattern FIELDS activity_id;

-- Unique constraint on argument hash for deduplication (scoped by org_id to prevent cross-org conflicts)
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_hash
  ON tool_argument_pattern FIELDS org_id, argument_hash UNIQUE;

-- Multi-tenant index (CRITICAL for RBAC performance)
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_org
  ON tool_argument_pattern FIELDS org_id;

-- Composite index for common query pattern: org_id + activity_id
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_org_activity
  ON tool_argument_pattern FIELDS org_id, activity_id;

-- Composite index for common lookup: activity + tool + shape
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_composite
  ON tool_argument_pattern FIELDS activity_id, tool_name, argument_shape;

-- Index for tool-specific queries
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_tool
  ON tool_argument_pattern FIELDS tool_name;

-- Index for finding frequently used patterns
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_usage
  ON tool_argument_pattern FIELDS times_used;

-- Index for finding recent patterns
DEFINE INDEX IF NOT EXISTS idx_tool_arg_pattern_last_used
  ON tool_argument_pattern FIELDS last_used_at;

-- -----------------------------------------------------------------------------
-- v_argument_recommendations computed view
--
-- Surfaces high-quality argument patterns that can be recommended
-- Filters for patterns with sufficient usage (>=3) and high success rate (>=80%)
-- -----------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS v_argument_recommendations AS
SELECT
  activity_id,
  tool_name,
  argument_shape,
  argument_hash,
  arguments,
  (times_succeeded * 1.0 / times_used) as success_rate,
  times_used,
  avg_execution_ms,
  last_used_at,
  org_id
FROM tool_argument_pattern
WHERE times_used >= 3
  AND (times_succeeded * 1.0 / times_used) >= 0.8
PERMISSIONS
  -- SELECT: Users can only see recommendations for their org
  FOR select WHERE org_id = $auth.org_id;

-- -----------------------------------------------------------------------------
-- Migration notes
-- -----------------------------------------------------------------------------
--
-- Usage pattern for recording argument patterns:
--
-- 1. Before tool execution, compute argument_hash from normalized arguments
-- 2. Check if pattern exists: SELECT * FROM tool_argument_pattern WHERE argument_hash = $hash
-- 3. If exists, UPDATE times_used, last_used_at, avg_execution_ms (rolling average)
-- 4. If not exists, CREATE new pattern
-- 5. After execution, UPDATE times_succeeded if successful
--
-- Argument shape conventions:
-- - file_read_args: {path, offset, limit}
-- - file_write_args: {path, content_hash}
-- - bash_args: {command_prefix, flags}
-- - git_args: {operation, target}
-- - edit_args: {path, operation_type}
--
-- Hash computation (pseudo-code):
-- const normalized = JSON.stringify(sortKeys(arguments));
-- const hash = crypto.createHash('sha256').update(normalized).digest('hex');
-- -----------------------------------------------------------------------------
