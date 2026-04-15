-- ============================================================================
-- Execution Pattern Learning (Pattern Extraction)
-- ============================================================================
-- Learns common input→output shape transformations from execution traces.
-- Tracks success rate, cost, and duration for each pattern.
-- Enables pattern-based activity selection and recommendation.
-- ============================================================================

DEFINE TABLE IF NOT EXISTS execution_pattern SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Pattern signature (unique identifier)
DEFINE FIELD IF NOT EXISTS input_shapes ON execution_pattern TYPE array<string>
  VALUE $value OR []
  COMMENT "Input impulse shapes for this pattern (sorted)";

DEFINE FIELD IF NOT EXISTS output_shapes ON execution_pattern TYPE array<string>
  VALUE $value OR []
  COMMENT "Output impulse shapes for this pattern (sorted)";

-- Activities that match this pattern
DEFINE FIELD IF NOT EXISTS activity_templates ON execution_pattern TYPE array<string>
  VALUE $value OR []
  COMMENT "Activity IDs that have executed this pattern";

-- Success metrics
DEFINE FIELD IF NOT EXISTS success_rate ON execution_pattern TYPE float
  ASSERT $value >= 0 AND $value <= 1
  VALUE $value OR 0.0
  COMMENT "Success rate for this pattern (successes / total)";

DEFINE FIELD IF NOT EXISTS execution_count ON execution_pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  COMMENT "Total number of executions matching this pattern";

DEFINE FIELD IF NOT EXISTS success_count ON execution_pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  COMMENT "Number of successful executions";

DEFINE FIELD IF NOT EXISTS failure_count ON execution_pattern TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  COMMENT "Number of failed executions";

-- Performance metrics (rolling averages)
DEFINE FIELD IF NOT EXISTS avg_cost_usd ON execution_pattern TYPE float
  ASSERT $value >= 0
  VALUE $value OR 0.0
  COMMENT "Average cost in USD for this pattern";

DEFINE FIELD IF NOT EXISTS avg_duration_ms ON execution_pattern TYPE float
  ASSERT $value >= 0
  VALUE $value OR 0.0
  COMMENT "Average duration in milliseconds for this pattern";

DEFINE FIELD IF NOT EXISTS avg_tokens_in ON execution_pattern TYPE float
  ASSERT $value >= 0
  VALUE $value OR 0.0
  COMMENT "Average input tokens for this pattern";

DEFINE FIELD IF NOT EXISTS avg_tokens_out ON execution_pattern TYPE float
  ASSERT $value >= 0
  VALUE $value OR 0.0
  COMMENT "Average output tokens for this pattern";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON execution_pattern TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON execution_pattern TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

-- Metadata
DEFINE FIELD IF NOT EXISTS last_executed_at ON execution_pattern TYPE option<datetime>
  COMMENT "Timestamp of last execution matching this pattern";

DEFINE FIELD IF NOT EXISTS created_at ON execution_pattern TYPE datetime
  VALUE $value OR time::now()
  COMMENT "First execution timestamp for this pattern";

DEFINE FIELD IF NOT EXISTS updated_at ON execution_pattern TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_execution_pattern_org
  ON execution_pattern FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_execution_pattern_input_shapes
  ON execution_pattern FIELDS input_shapes;

DEFINE INDEX IF NOT EXISTS idx_execution_pattern_output_shapes
  ON execution_pattern FIELDS output_shapes;

DEFINE INDEX IF NOT EXISTS idx_execution_pattern_success_rate
  ON execution_pattern FIELDS success_rate;

DEFINE INDEX IF NOT EXISTS idx_execution_pattern_execution_count
  ON execution_pattern FIELDS execution_count;

-- Composite index for pattern lookup by shapes
DEFINE INDEX IF NOT EXISTS idx_execution_pattern_org_shapes
  ON execution_pattern FIELDS org_id, input_shapes, output_shapes;
