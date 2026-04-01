-- =============================================================================
-- Activity Registry with RBAC Multi-Tenancy
-- =============================================================================
-- Unified registry for ALL activities (templates AND vessel functions)
-- Merges: 001-init-schema.surql (activity_template) + 008-unified-activity-model.surql
-- =============================================================================

-- =============================================================================
-- Table: activity_registry
-- =============================================================================
-- Unified registry for ALL activities (templates AND vessel functions)
-- RBAC: Scope-aware permissions (global/org/project)
-- =============================================================================

DEFINE TABLE IF NOT EXISTS activity_registry SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see:
    --   1. Global public activities (marketplace)
    --   2. Activities in their organization
    --   3. Activities in their projects
    FOR select WHERE
      (scope = 'global' AND public = true)
      OR (org_id = $auth.org_id)
      OR (scope = 'project' AND project_id IN $auth.project_ids)

    -- CREATE: Users can create activities in their org
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Users can update their own activities
    --   Admins can update any activity in their org
    FOR update WHERE
      (org_id = $auth.org_id AND $auth.role = 'admin')
      OR (org_id = $auth.org_id AND created_by = $auth.id)

    -- DELETE: Only admins can delete activities in their org
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Identity
DEFINE FIELD IF NOT EXISTS id ON activity_registry TYPE string
  ASSERT $value != NONE
  COMMENT "Unique activity ID (template: variant_id, vessel: {vessel}:{function})";

DEFINE FIELD IF NOT EXISTS name ON activity_registry TYPE string
  ASSERT $value != NONE
  COMMENT "Human-readable activity name";

DEFINE FIELD IF NOT EXISTS description ON activity_registry TYPE string
  ASSERT $value != NONE
  COMMENT "What this activity does";

-- DEPRECATED: Use tags field instead. Kept for backward compatibility.
DEFINE FIELD IF NOT EXISTS category ON activity_registry TYPE option<string>
  COMMENT "DEPRECATED: Activity category. Use tags field for hierarchical classification.";

-- Hierarchical tags using dot-notation (e.g., feature.vessel.state.communication)
DEFINE FIELD IF NOT EXISTS tags ON activity_registry TYPE array<string>
  DEFAULT []
  COMMENT "Hierarchical tags using dot-notation (e.g., feature.vessel.state, utility.code.trace)";

-- Computed tag prefixes for efficient prefix queries
-- Extracts all prefixes from tags: ["feature.vessel.state"] -> ["feature", "feature.vessel", "feature.vessel.state"]
DEFINE FIELD IF NOT EXISTS tag_prefixes ON activity_registry TYPE array<string>
  DEFAULT []
  COMMENT "Auto-computed tag prefixes for hierarchical queries";

-- Execution format (how to invoke this activity)
DEFINE FIELD IF NOT EXISTS execution_format ON activity_registry TYPE string
  ASSERT $value IN ['template', 'vessel-function', 'native-binary', 'mcp-tool']
  COMMENT "How to execute this activity";

-- Template-based activities (execution_format = 'template')
DEFINE FIELD IF NOT EXISTS task_steps ON activity_registry TYPE option<array>
  COMMENT "Task steps for template-based activities";

-- Vessel function activities (execution_format = 'vessel-function')
DEFINE FIELD IF NOT EXISTS source_location ON activity_registry TYPE option<object>
  COMMENT "Source location for vessel functions: { vesselId, file, line, functionName, className }";

DEFINE FIELD IF NOT EXISTS intent ON activity_registry TYPE option<object>
  COMMENT "Inferred intent: { purpose, confidence, source, rationale }";

-- Learned data (populated from runtime observations)
DEFINE FIELD IF NOT EXISTS impulses ON activity_registry TYPE array
  VALUE $value OR []
  COMMENT "Impulses used by this activity (learned from executions)";

DEFINE FIELD IF NOT EXISTS tools ON activity_registry TYPE array
  VALUE $value OR []
  COMMENT "Tools called by this activity (learned from executions)";

DEFINE FIELD IF NOT EXISTS typical_inputs ON activity_registry TYPE option<object>
  COMMENT "Typical input shape (learned from executions)";

DEFINE FIELD IF NOT EXISTS typical_outputs ON activity_registry TYPE option<object>
  COMMENT "Typical output shape (learned from executions)";

-- Schema-based activity matching (self-development loop)
DEFINE FIELD IF NOT EXISTS input_schema ON activity_registry TYPE option<object>
  COMMENT "Input schema: { required: ImpulseShape[], optional?: ImpulseShape[] }";

DEFINE FIELD IF NOT EXISTS output_schema ON activity_registry TYPE option<object>
  COMMENT "Output schema: { produces: ImpulseShape[] }";

-- Thompson Sampling (shared across all activity formats)
DEFINE FIELD IF NOT EXISTS executions ON activity_registry TYPE int
  VALUE $value OR 0
  COMMENT "Total execution count";

DEFINE FIELD IF NOT EXISTS successes ON activity_registry TYPE int
  VALUE $value OR 0
  COMMENT "Successful execution count";

DEFINE FIELD IF NOT EXISTS failures ON activity_registry TYPE int
  VALUE $value OR 0
  COMMENT "Failed execution count";

DEFINE FIELD IF NOT EXISTS alpha ON activity_registry TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling alpha (successes + 1)";

DEFINE FIELD IF NOT EXISTS beta ON activity_registry TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling beta (failures + 1)";

DEFINE FIELD IF NOT EXISTS avg_duration_ms ON activity_registry TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution duration in milliseconds";

DEFINE FIELD IF NOT EXISTS avg_cost_usd ON activity_registry TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution cost in USD";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS scope ON activity_registry TYPE string
  ASSERT $value IN ['global', 'org', 'project', 'vessel']
  VALUE $value OR 'org'
  COMMENT "Scope: global (marketplace), org (private), project (project-scoped), vessel (vessel-local)";

DEFINE FIELD IF NOT EXISTS public ON activity_registry TYPE bool
  VALUE $value OR false
  COMMENT "Whether activity is public in global marketplace";

DEFINE FIELD IF NOT EXISTS org_id ON activity_registry TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON activity_registry TYPE option<record<projects>>
  COMMENT "Project ID (for project-scoped activities)";

DEFINE FIELD IF NOT EXISTS vessel_id ON activity_registry TYPE option<string>
  COMMENT "Vessel ID (for vessel-function activities)";

-- created_by can be either a user (dashboard) or a minibob_instance (autonomous vessel)
DEFINE FIELD IF NOT EXISTS created_by ON activity_registry TYPE option<record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User or MiniBob instance who created this activity";

-- Metadata
DEFINE FIELD IF NOT EXISTS genealogy ON activity_registry TYPE option<object>
  COMMENT "Activity genealogy (extracted_from, variant_of, etc.)";

-- Note: tags field is now defined earlier with full type specification

DEFINE FIELD IF NOT EXISTS created_at ON activity_registry TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON activity_registry TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

DEFINE FIELD IF NOT EXISTS last_executed_at ON activity_registry TYPE option<datetime>
  COMMENT "Last execution timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_activity_id ON activity_registry FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_activity_format ON activity_registry FIELDS execution_format;
DEFINE INDEX IF NOT EXISTS idx_activity_category ON activity_registry FIELDS category;
DEFINE INDEX IF NOT EXISTS idx_activity_scope ON activity_registry FIELDS scope;

-- Multi-tenant indexes (CRITICAL for RBAC performance)
DEFINE INDEX IF NOT EXISTS idx_activity_org ON activity_registry FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_activity_org_scope ON activity_registry FIELDS org_id, scope;
DEFINE INDEX IF NOT EXISTS idx_activity_project ON activity_registry FIELDS project_id;
DEFINE INDEX IF NOT EXISTS idx_activity_created_by ON activity_registry FIELDS created_by;

-- Composite indexes for common queries
DEFINE INDEX IF NOT EXISTS idx_activity_vessel ON activity_registry FIELDS vessel_id;
DEFINE INDEX IF NOT EXISTS idx_activity_vessel_format
  ON activity_registry FIELDS vessel_id, execution_format;
DEFINE INDEX IF NOT EXISTS idx_activity_scope_category
  ON activity_registry FIELDS scope, category;
DEFINE INDEX IF NOT EXISTS idx_activity_public_global
  ON activity_registry FIELDS public, scope;

-- Tag indexes for hierarchical queries
DEFINE INDEX IF NOT EXISTS idx_activity_tags ON activity_registry FIELDS tags;
DEFINE INDEX IF NOT EXISTS idx_activity_tag_prefixes ON activity_registry FIELDS tag_prefixes;
DEFINE INDEX IF NOT EXISTS idx_activity_org_tags ON activity_registry FIELDS org_id, tags;

-- =============================================================================
-- Table: variant_performance_metrics
-- =============================================================================
-- Stores aggregated performance metrics for template variants
-- NOTE: This table is DEPRECATED - metrics moved to activity_registry
-- Kept for backward compatibility during migration
-- =============================================================================

DEFINE TABLE IF NOT EXISTS variant_performance_metrics SCHEMAFULL
  PERMISSIONS
    -- Same permissions as activity_registry
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS variant_id ON variant_performance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Template variant identifier (FK to activity_registry)";

DEFINE FIELD IF NOT EXISTS activity_id ON variant_performance_metrics TYPE string
  ASSERT $value != NONE
  COMMENT "Base activity identifier";

DEFINE FIELD IF NOT EXISTS org_id ON variant_performance_metrics TYPE option<string>
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string identifier)";

DEFINE FIELD IF NOT EXISTS project_id ON variant_performance_metrics TYPE option<string>
  COMMENT "Project ID (string identifier, optional)";

DEFINE FIELD IF NOT EXISTS total_executions ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Total number of executions";

DEFINE FIELD IF NOT EXISTS successful_executions ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of successful executions";

DEFINE FIELD IF NOT EXISTS failed_executions ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of failed executions";

DEFINE FIELD IF NOT EXISTS success_rate ON variant_performance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Success rate (0.0 to 1.0)";

DEFINE FIELD IF NOT EXISTS avg_duration_ms ON variant_performance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution duration in milliseconds";

DEFINE FIELD IF NOT EXISTS avg_cost_usd ON variant_performance_metrics TYPE float
  VALUE $value OR 0.0
  COMMENT "Average execution cost in USD";

DEFINE FIELD IF NOT EXISTS thompson_alpha ON variant_performance_metrics TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling alpha parameter (successes + 1)";

DEFINE FIELD IF NOT EXISTS thompson_beta ON variant_performance_metrics TYPE float
  VALUE $value OR 1.0
  COMMENT "Thompson Sampling beta parameter (failures + 1)";

DEFINE FIELD IF NOT EXISTS total_selections ON variant_performance_metrics TYPE int
  VALUE $value OR 0
  COMMENT "Number of times template was selected";

DEFINE FIELD IF NOT EXISTS last_executed_at ON variant_performance_metrics TYPE option<datetime>
  COMMENT "Timestamp of last execution";

DEFINE FIELD IF NOT EXISTS created_at ON variant_performance_metrics TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON variant_performance_metrics TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_variant_performance_variant_id
  ON variant_performance_metrics FIELDS variant_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_variant_performance_activity_id
  ON variant_performance_metrics FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_variant_performance_org
  ON variant_performance_metrics FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_variant_performance_project
  ON variant_performance_metrics FIELDS project_id;

-- Index for Thompson Sampling belief queries (dashboard convergence metrics)
DEFINE INDEX IF NOT EXISTS idx_variant_performance_thompson
  ON variant_performance_metrics FIELDS thompson_alpha, thompson_beta;

-- Composite index for success rate filtering
DEFINE INDEX IF NOT EXISTS idx_variant_performance_success_rate
  ON variant_performance_metrics FIELDS org_id, success_rate;

-- =============================================================================
-- Table: activity_template (DEPRECATED)
-- =============================================================================
-- Legacy table name - replaced by activity_registry
-- Kept as VIEW for backward compatibility
-- =============================================================================

DEFINE TABLE IF NOT EXISTS view_activity_template AS
  SELECT
    id,                    -- CRITICAL: Must include 'id' for SurrealDB 3.x view compatibility
    id AS variant_id,
    id AS activity_id,
    name AS variant_name,
    description,
    category,
    tags,
    tag_prefixes,
    task_steps,
    scope,
    org_id,
    project_id,
    genealogy,
    created_at,
    updated_at
  FROM activity_registry
  WHERE execution_format = 'template';
