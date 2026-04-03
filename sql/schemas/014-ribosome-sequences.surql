-- =============================================================================
-- Ribosome Sequence Extraction Schema
-- =============================================================================
--
-- This schema supports N:1 ribosome pattern extraction where frequent
-- successful activity sequences (e.g., A→B→C) are combined into composite
-- templates. This extends the existing 1:1 ribosome pattern.
--
-- Related tables:
-- - execution_sequences: Records which activities ran together
-- - activity_composition_graph: Records parent→child composition relationships
-- - activity_template: Stores both atomic and composite templates
--
-- =============================================================================

-- Table: composite_sequence_patterns
--
-- Tracks which activity sequence patterns have been extracted into composite
-- templates to prevent duplicate extraction. Each pattern is identified by
-- a hash of its activity_ids array.
--
DEFINE TABLE IF NOT EXISTS composite_sequence_patterns SCHEMAFULL
  COMMENT "Tracks extracted composite sequence patterns to prevent duplicates"
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Pattern signature: Hash of activity_ids for uniqueness check
DEFINE FIELD IF NOT EXISTS pattern_signature ON composite_sequence_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "Hash of activity_ids array for uniqueness (prevents duplicate extraction)";

-- The actual sequence of activity IDs
DEFINE FIELD IF NOT EXISTS activity_ids ON composite_sequence_patterns TYPE array<string>
  ASSERT $value != NONE AND array::len($value) >= 2
  COMMENT "Ordered sequence of activity IDs that were merged (e.g., ['debug-bug', 'implement-fix', 'write-tests'])";

-- Generated composite template ID
DEFINE FIELD IF NOT EXISTS composite_template_id ON composite_sequence_patterns TYPE string
  ASSERT $value != NONE
  COMMENT "ID of the generated composite template (variant_id in activity_template table)";

-- Pattern metrics at extraction time
DEFINE FIELD IF NOT EXISTS frequency ON composite_sequence_patterns TYPE int
  VALUE $value OR 0
  ASSERT $value >= 1
  COMMENT "Number of times this pattern was observed before extraction";

DEFINE FIELD IF NOT EXISTS success_rate ON composite_sequence_patterns TYPE float
  VALUE $value OR 0.0
  ASSERT $value >= 0.0 AND $value <= 1.0
  COMMENT "Success rate of pattern at extraction time (0.0 to 1.0)";

DEFINE FIELD IF NOT EXISTS avg_duration_ms ON composite_sequence_patterns TYPE option<float>
  COMMENT "Average duration of pattern executions in milliseconds";

DEFINE FIELD IF NOT EXISTS avg_cost_usd ON composite_sequence_patterns TYPE option<float>
  COMMENT "Average cost of pattern executions in USD";

DEFINE FIELD IF NOT EXISTS composition_weights ON composite_sequence_patterns TYPE option<array<float>> FLEXIBLE
  COMMENT "Edge weights from composition graph for each transition (e.g., [0.85, 0.92] for A→B→C)";

-- Multi-tenant isolation
DEFINE FIELD IF NOT EXISTS org_id ON composite_sequence_patterns TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON composite_sequence_patterns TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional, for project-scoped patterns)";

-- Timestamps
DEFINE FIELD IF NOT EXISTS extracted_at ON composite_sequence_patterns TYPE datetime
  VALUE $value OR time::now()
  COMMENT "When this pattern was extracted into a composite template";

DEFINE FIELD IF NOT EXISTS created_at ON composite_sequence_patterns TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON composite_sequence_patterns TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record last update timestamp";

-- Indexes for efficient queries
--
-- UNIQUE constraint on pattern signature prevents duplicate extraction
DEFINE INDEX IF NOT EXISTS idx_composite_patterns_signature
  ON composite_sequence_patterns FIELDS pattern_signature UNIQUE
  COMMENT "Prevent duplicate extraction of same pattern";

-- Lookup by template ID
DEFINE INDEX IF NOT EXISTS idx_composite_patterns_template
  ON composite_sequence_patterns FIELDS composite_template_id
  COMMENT "Find pattern by composite template ID";

-- Multi-tenant isolation index
DEFINE INDEX IF NOT EXISTS idx_composite_patterns_org
  ON composite_sequence_patterns FIELDS org_id
  COMMENT "Org-scoped pattern queries";

-- Combined index for org + frequency queries
DEFINE INDEX IF NOT EXISTS idx_composite_patterns_org_frequency
  ON composite_sequence_patterns FIELDS org_id, frequency
  COMMENT "Find most frequent patterns for an org";

-- Combined index for org + success rate queries
DEFINE INDEX IF NOT EXISTS idx_composite_patterns_org_success
  ON composite_sequence_patterns FIELDS org_id, success_rate
  COMMENT "Find highest success patterns for an org";
