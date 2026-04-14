-- =============================================================================
-- Migration 060: Add missing fields to tool_argument_pattern
--
-- MiniBob sends failure_type, failure_reason, and tool_succeeded fields
-- that weren't defined in the original schema.
-- =============================================================================

-- Add failure_type field (e.g., "validation_error", "execution_error", "timeout")
DEFINE FIELD IF NOT EXISTS failure_type ON tool_argument_pattern TYPE option<string>
  COMMENT "Type of failure if tool execution failed";

-- Add failure_reason field (detailed error message)
DEFINE FIELD IF NOT EXISTS failure_reason ON tool_argument_pattern TYPE option<string>
  COMMENT "Detailed failure reason/error message if tool execution failed";

-- Add tool_succeeded field (explicit success/failure flag)
DEFINE FIELD IF NOT EXISTS tool_succeeded ON tool_argument_pattern TYPE option<bool>
  COMMENT "Whether the tool execution succeeded (true/false/null for unknown)";

-- Add execution_ms field for individual execution timing (separate from rolling avg)
DEFINE FIELD IF NOT EXISTS execution_ms ON tool_argument_pattern TYPE option<float>
  COMMENT "Execution time in milliseconds for this specific invocation";

-- =============================================================================
-- Verification query (run after migration):
-- INFO FOR TABLE tool_argument_pattern;
-- =============================================================================
