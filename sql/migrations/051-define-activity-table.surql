-- =============================================================================
-- Migration 051: Define activity table
-- =============================================================================
-- The code uses 'activity' table but schema only defines 'activity_template'.
-- This migration creates the activity table with required fields.
-- =============================================================================

-- Define the activity table as SCHEMALESS to allow flexible fields
-- but define the commonly used fields for schema hints
DEFINE TABLE IF NOT EXISTS activity SCHEMALESS
  PERMISSIONS
    FOR select WHERE
      scope = 'global'
      OR org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')
    FOR create WHERE $auth != NONE
    FOR update WHERE
      org_id IS NONE
      OR org_id = $auth.org_id
      OR org_id = string::replace(type::string($auth.org_id), 'organizations:', '')
    FOR delete WHERE
      org_id IS NONE
      OR org_id = $auth.org_id;

-- Define commonly used fields
DEFINE FIELD IF NOT EXISTS name ON activity TYPE string;
DEFINE FIELD IF NOT EXISTS description ON activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS execution_type ON activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tags ON activity TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS tag_prefixes ON activity TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS category ON activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS scope ON activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS org_id ON activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS project_id ON activity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tasks ON activity TYPE option<array>;
DEFINE FIELD IF NOT EXISTS input_shapes ON activity TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS output_shapes ON activity TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS input_schema ON activity TYPE option<object>;
DEFINE FIELD IF NOT EXISTS output_schema ON activity TYPE option<object>;
DEFINE FIELD IF NOT EXISTS created_at ON activity TYPE datetime VALUE $value OR time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON activity TYPE datetime VALUE $value OR time::now();

-- Add index for common queries
DEFINE INDEX IF NOT EXISTS idx_activity_org_id ON activity FIELDS org_id;
DEFINE INDEX IF NOT EXISTS idx_activity_scope ON activity FIELDS scope;
DEFINE INDEX IF NOT EXISTS idx_activity_category ON activity FIELDS category;
