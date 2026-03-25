-- =============================================================================
-- Impulse Data Storage
-- =============================================================================
-- Stores impulse data with project-scoped isolation
-- =============================================================================

-- =============================================================================
-- Table: impulse_data
-- =============================================================================
-- Multi-tenant impulse storage with composite key (api_key, project_id, impulse_id)
-- =============================================================================

DEFINE TABLE impulse_data SCHEMAFULL;

DEFINE FIELD impulse_id ON impulse_data TYPE string
  ASSERT $value != NONE
  COMMENT "Unique impulse identifier within project";

DEFINE FIELD api_key ON impulse_data TYPE string
  ASSERT $value != NONE
  COMMENT "API key for tenant isolation";

DEFINE FIELD project_id ON impulse_data TYPE string
  ASSERT $value != NONE
  COMMENT "Project ID for scoping";

DEFINE FIELD impulse_data ON impulse_data TYPE object
  ASSERT $value != NONE
  COMMENT "Full impulse data blob";

DEFINE FIELD created_at ON impulse_data TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Creation timestamp";

DEFINE FIELD updated_at ON impulse_data TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last update timestamp";

-- Composite unique index for multi-tenant isolation
DEFINE INDEX idx_impulse_data_composite
  ON impulse_data FIELDS api_key, project_id, impulse_id UNIQUE;

-- Index for listing impulses by project
DEFINE INDEX idx_impulse_data_project
  ON impulse_data FIELDS api_key, project_id;
