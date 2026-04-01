-- =============================================================================
-- Impulse Data and Tool Usage with RBAC Multi-Tenancy
-- =============================================================================
-- Merges: 005-impulse-data.surql + tool_usage (from 002-learning-system-phase1.surql)
-- Tracks impulse storage and tool invocation patterns with org/project isolation
-- =============================================================================

-- =============================================================================
-- Table: impulse_data
-- =============================================================================
-- Multi-tenant impulse storage with org/project scoping
-- RBAC: Users can only access impulses in their org/projects
-- Note: api_key field deprecated in favor of org_id for consistency
-- =============================================================================

-- OVERWRITE ensures PERMISSIONS are always applied (critical for MiniBob RBAC)
DEFINE TABLE OVERWRITE impulse_data SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see impulses in their org and assigned projects
    -- Note: When $auth.project_ids IS NONE, user has full org access (no project restriction)
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR $auth.project_ids IS NONE OR project_id IN $auth.project_ids)

    -- CREATE: Any authenticated user can create impulses
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Users can update impulses they created or admins in their org
    FOR update WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)

    -- DELETE: Users can delete their own impulses, admins can delete any in org
    FOR delete WHERE
      org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id);

DEFINE FIELD IF NOT EXISTS impulse_id ON impulse_data TYPE string
  ASSERT $value != NONE
  COMMENT "Unique impulse identifier within organization";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON impulse_data TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON impulse_data TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID for project-scoped impulses";

-- created_by can be either a user (dashboard) or a minibob_instance (autonomous vessel)
DEFINE FIELD IF NOT EXISTS created_by ON impulse_data TYPE option<record<users> | record<minibob_instance>>
  VALUE $value OR $auth.id
  COMMENT "User or MiniBob instance who created this impulse";

-- Legacy field for backward compatibility (DEPRECATED)
DEFINE FIELD IF NOT EXISTS api_key ON impulse_data TYPE option<string>
  COMMENT "DEPRECATED: API key for tenant isolation (use org_id instead)";

-- Impulse content and metadata
DEFINE FIELD IF NOT EXISTS impulse_data ON impulse_data TYPE object FLEXIBLE
  ASSERT $value != NONE
  COMMENT "Full impulse data blob (pointer, content, metadata)";

DEFINE FIELD IF NOT EXISTS impulse_type ON impulse_data TYPE option<string>
  COMMENT "Impulse type (file, memo, activityExecutionTrace, etc.)";

DEFINE FIELD IF NOT EXISTS pointer ON impulse_data TYPE option<object> FLEXIBLE
  COMMENT "Impulse pointer metadata (type, path, offset, limit)";

DEFINE FIELD IF NOT EXISTS content ON impulse_data TYPE option<string>
  COMMENT "Loaded impulse content (if materialized)";

DEFINE FIELD IF NOT EXISTS budget ON impulse_data TYPE option<int>
  COMMENT "Token budget for this impulse";

DEFINE FIELD IF NOT EXISTS priority ON impulse_data TYPE option<string>
  COMMENT "Impulse priority (high, medium, low)";

DEFINE FIELD IF NOT EXISTS loaded ON impulse_data TYPE option<bool>
  VALUE $value OR false
  COMMENT "Whether impulse content is loaded";

DEFINE FIELD IF NOT EXISTS size_bytes ON impulse_data TYPE option<int>
  COMMENT "Size of impulse content in bytes";

DEFINE FIELD IF NOT EXISTS token_count ON impulse_data TYPE option<int>
  COMMENT "Estimated token count of content";

-- Usage tracking
DEFINE FIELD IF NOT EXISTS usage_count ON impulse_data TYPE int
  VALUE $value OR 0
  COMMENT "Number of times impulse was used";

DEFINE FIELD IF NOT EXISTS last_used_at ON impulse_data TYPE option<datetime>
  COMMENT "Last time impulse was used";

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON impulse_data TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON impulse_data TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

DEFINE FIELD IF NOT EXISTS expires_at ON impulse_data TYPE option<datetime>
  COMMENT "Expiration timestamp (for temporary impulses)";

-- Indexes
-- Multi-tenant composite index (CRITICAL for RBAC performance)
DEFINE INDEX IF NOT EXISTS idx_impulse_data_org_project_id
  ON impulse_data FIELDS org_id, project_id, impulse_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_impulse_data_org
  ON impulse_data FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_data_project
  ON impulse_data FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_data_impulse_id
  ON impulse_data FIELDS impulse_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_data_type
  ON impulse_data FIELDS impulse_type;

DEFINE INDEX IF NOT EXISTS idx_impulse_data_created_by
  ON impulse_data FIELDS created_by;

-- Legacy index for backward compatibility (DEPRECATED)
DEFINE INDEX IF NOT EXISTS idx_impulse_data_api_key_project
  ON impulse_data FIELDS api_key, project_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_data_expires
  ON impulse_data FIELDS expires_at;

-- =============================================================================
-- Table: impulse_usage_history
-- =============================================================================
-- Tracks impulse usage history over time
-- Enables usage analytics and cleanup of unused impulses
-- RBAC: Scoped by organization and project
-- =============================================================================

DEFINE TABLE IF NOT EXISTS impulse_usage_history SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS impulse_id ON impulse_usage_history TYPE string
  ASSERT $value != NONE
  COMMENT "Impulse identifier (FK to impulse_data)";

DEFINE FIELD IF NOT EXISTS activity_id ON impulse_usage_history TYPE string
  ASSERT $value != NONE
  COMMENT "Activity that used this impulse";

DEFINE FIELD IF NOT EXISTS execution_id ON impulse_usage_history TYPE string
  ASSERT $value != NONE
  COMMENT "Execution trace ID";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON impulse_usage_history TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON impulse_usage_history TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS task_id ON impulse_usage_history TYPE option<string>
  COMMENT "Task ID where impulse was used";

DEFINE FIELD IF NOT EXISTS success ON impulse_usage_history TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether execution using impulse succeeded";

DEFINE FIELD IF NOT EXISTS tokens_consumed ON impulse_usage_history TYPE option<int>
  COMMENT "Tokens consumed from this impulse";

DEFINE FIELD IF NOT EXISTS used_at ON impulse_usage_history TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Usage timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_impulse_usage_impulse
  ON impulse_usage_history FIELDS impulse_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_usage_activity
  ON impulse_usage_history FIELDS activity_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_usage_execution
  ON impulse_usage_history FIELDS execution_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_usage_org
  ON impulse_usage_history FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_usage_project
  ON impulse_usage_history FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_impulse_usage_used_at
  ON impulse_usage_history FIELDS used_at;

-- =============================================================================
-- Additional CI Integration Tables (from 005-ci-integration.surql)
-- =============================================================================
-- Note: These tables are included here as they're related to execution data
-- =============================================================================

-- =============================================================================
-- Table: ci_runs
-- =============================================================================
-- Tracks CI/CD pipeline runs
-- RBAC: Scoped by organization and project
-- =============================================================================

DEFINE TABLE IF NOT EXISTS ci_runs SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS run_id ON ci_runs TYPE string
  ASSERT $value != NONE
  COMMENT "Unique CI run identifier";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON ci_runs TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON ci_runs TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS repository ON ci_runs TYPE string
  ASSERT $value != NONE
  COMMENT "Repository identifier";

DEFINE FIELD IF NOT EXISTS branch ON ci_runs TYPE string
  ASSERT $value != NONE
  COMMENT "Git branch";

DEFINE FIELD IF NOT EXISTS commit_sha ON ci_runs TYPE string
  ASSERT $value != NONE
  COMMENT "Git commit SHA";

DEFINE FIELD IF NOT EXISTS status ON ci_runs TYPE string
  ASSERT $value IN ['pending', 'running', 'success', 'failure', 'cancelled']
  COMMENT "CI run status";

DEFINE FIELD IF NOT EXISTS started_at ON ci_runs TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Run start timestamp";

DEFINE FIELD IF NOT EXISTS completed_at ON ci_runs TYPE option<datetime>
  COMMENT "Run completion timestamp";

DEFINE FIELD IF NOT EXISTS duration_ms ON ci_runs TYPE option<int>
  COMMENT "Run duration in milliseconds";

DEFINE FIELD IF NOT EXISTS test_results ON ci_runs TYPE option<object> FLEXIBLE
  COMMENT "Test results summary";

DEFINE FIELD IF NOT EXISTS created_at ON ci_runs TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_ci_runs_run_id
  ON ci_runs FIELDS run_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_ci_runs_org
  ON ci_runs FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_ci_runs_project
  ON ci_runs FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_ci_runs_repository
  ON ci_runs FIELDS repository;

DEFINE INDEX IF NOT EXISTS idx_ci_runs_status
  ON ci_runs FIELDS status;

DEFINE INDEX IF NOT EXISTS idx_ci_runs_org_project_status
  ON ci_runs FIELDS org_id, project_id, status;

-- =============================================================================
-- Table: code_variants
-- =============================================================================
-- Tracks code variant attempts (test-driven development)
-- RBAC: Scoped by organization and project
-- =============================================================================

DEFINE TABLE IF NOT EXISTS code_variants SCHEMAFULL
  PERMISSIONS
    FOR select WHERE
      org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD IF NOT EXISTS variant_id ON code_variants TYPE string
  ASSERT $value != NONE
  COMMENT "Unique variant identifier";

-- Multi-tenancy (REQUIRED for RBAC)
DEFINE FIELD IF NOT EXISTS org_id ON code_variants TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS project_id ON code_variants TYPE option<record<projects>>
  VALUE $value OR $auth.project_id
  COMMENT "Project ID (optional)";

DEFINE FIELD IF NOT EXISTS file_path ON code_variants TYPE string
  ASSERT $value != NONE
  COMMENT "File path for this variant";

DEFINE FIELD IF NOT EXISTS variant_code ON code_variants TYPE string
  ASSERT $value != NONE
  COMMENT "Code content of variant";

DEFINE FIELD IF NOT EXISTS parent_variant_id ON code_variants TYPE option<string>
  COMMENT "Parent variant (for genealogy)";

DEFINE FIELD IF NOT EXISTS test_status ON code_variants TYPE option<string>
  COMMENT "Test execution status";

DEFINE FIELD IF NOT EXISTS test_results ON code_variants TYPE option<object> FLEXIBLE
  COMMENT "Test results data";

DEFINE FIELD IF NOT EXISTS ci_run_id ON code_variants TYPE option<string>
  COMMENT "Associated CI run ID";

DEFINE FIELD IF NOT EXISTS created_at ON code_variants TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Variant creation timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_code_variants_variant_id
  ON code_variants FIELDS variant_id UNIQUE;

DEFINE INDEX IF NOT EXISTS idx_code_variants_org
  ON code_variants FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_code_variants_project
  ON code_variants FIELDS project_id;

DEFINE INDEX IF NOT EXISTS idx_code_variants_file
  ON code_variants FIELDS file_path;

DEFINE INDEX IF NOT EXISTS idx_code_variants_ci_run
  ON code_variants FIELDS ci_run_id;

DEFINE INDEX IF NOT EXISTS idx_code_variants_org_project_file
  ON code_variants FIELDS org_id, project_id, file_path;
