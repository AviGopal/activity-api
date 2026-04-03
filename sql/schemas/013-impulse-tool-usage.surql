-- =============================================================================
-- Impulse Data and Tool Usage with RBAC Multi-Tenancy
-- =============================================================================
-- Merges: 005-impulse-data.surql + tool_usage (from 002-learning-system-phase1.surql)
-- Tracks impulse storage and tool invocation patterns with org/project isolation
-- =============================================================================

-- =============================================================================
-- ██████╗ ███████╗██████╗ ██████╗ ███████╗ ██████╗ █████╗ ████████╗███████╗██████╗
-- ██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝██╔════╝██╔══██╗╚══██╔══╝██╔════╝██╔══██╗
-- ██║  ██║█████╗  ██████╔╝██████╔╝█████╗  ██║     ███████║   ██║   █████╗  ██║  ██║
-- ██║  ██║██╔══╝  ██╔═══╝ ██╔══██╗██╔══╝  ██║     ██╔══██║   ██║   ██╔══╝  ██║  ██║
-- ██████╔╝███████╗██║     ██║  ██║███████╗╚██████╗██║  ██║   ██║   ███████╗██████╔╝
-- ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═════╝
-- =============================================================================
-- Table: impulse_data [DEPRECATED - R004]
-- =============================================================================
--
-- ⚠️  THIS TABLE IS DEPRECATED ⚠️
--
-- New code should use the `impulse` table defined in:
--   020-paradigm-core-tables.surql
--
-- The `impulse` table is the canonical paradigm-aligned schema that:
--   - Uses `id` instead of `impulse_id` for record identity
--   - Uses `pointer` object for data location (consistent with activity paradigm)
--   - Uses `shape` field for activity matching (replaces impulse_type)
--   - Removes redundant fields (loaded is derived from content != null)
--   - Integrates with activity/execution/vessel tables
--
-- Migration Guide: See repos/metabob-activity-api/sql/migrations/IMPULSE_DATA_DEPRECATION.md
--
-- FIELD MAPPING (impulse_data → impulse):
--   impulse_id        → id
--   impulse_data      → pointer + content + metadata
--   impulse_type      → pointer.type / shape
--   budget            → (tracked in impulse_usage_history or activity config)
--   priority          → (tracked in impulse_usage_history or activity config)
--   loaded            → (derived: content != null)
--   size_bytes        → (can be computed or stored in metadata)
--   token_count       → token_estimate
--   usage_count       → (query impulse_usage_history)
--   last_used_at      → (query impulse_usage_history)
--   expires_at        → expires_at (same)
--   created_at        → created_at (same)
--   org_id            → org_id (same)
--   project_id        → project_id (same)
--   created_by        → created_by (same)
--   api_key           → (REMOVED - use org_id)
--
-- This table will be removed in a future release after migration is complete.
-- =============================================================================
-- Multi-tenant impulse storage with org/project scoping
-- RBAC: Users can only access impulses in their org/projects
-- Note: api_key field deprecated in favor of org_id for consistency
-- =============================================================================

-- =============================================================================
-- REMOVED: impulse_data table
-- =============================================================================
-- The impulse_data table has been removed as part of R004 schema migration.
-- All impulse storage now uses the canonical `impulse` table from:
--   020-paradigm-core-tables.surql
--
-- If you need to restore this table for data migration, see:
--   repos/metabob-activity-api/sql/migrations/IMPULSE_DATA_DEPRECATION.md
-- =============================================================================

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

-- Budget learning fields (impulse-budget-learning enhancement)
-- These fields enable learning optimal budget allocation per (activity, impulse_type) pair
DEFINE FIELD IF NOT EXISTS budget_requested ON impulse_usage_history TYPE option<int>
  COMMENT "Original budget requested for this impulse";

DEFINE FIELD IF NOT EXISTS was_truncated ON impulse_usage_history TYPE option<bool>
  COMMENT "Whether content was truncated to fit budget";

DEFINE FIELD IF NOT EXISTS priority_level ON impulse_usage_history TYPE option<string>
  COMMENT "Impulse priority: critical, high, medium, low";

DEFINE FIELD IF NOT EXISTS truncation_ratio ON impulse_usage_history TYPE option<float>
  COMMENT "original_tokens / budget_requested (>1.0 means truncation needed)";

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
