-- =============================================================================
-- Migration 052: Deprecate minibob_instance Table
-- =============================================================================
-- Purpose: Transition to API-key-only authentication
--
-- MiniBob instances now authenticate using standard API keys managed by
-- identity-vessel. The instance_id requirement is removed.
--
-- Authentication flow:
--   1. MiniBob sends: Authorization: ApiKey <key>
--   2. Activity-API validates via identity service
--   3. Identity service returns: org_id, user_id, key_id, scopes
--   4. Activity-API uses key_id for audit trails
--
-- This migration makes the minibob_instance table read-only to prevent
-- new writes while preserving historical data.
-- =============================================================================

-- Make minibob_instance read-only (admin only)
DEFINE TABLE OVERWRITE minibob_instance SCHEMAFULL
  PERMISSIONS
    -- Read-only for admins (data export/audit purposes)
    FOR select WHERE $auth.role = 'admin'
    -- No new writes
    FOR create, update, delete NONE;

-- Keep existing fields for historical data
DEFINE FIELD IF NOT EXISTS instance_id ON minibob_instance TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS org_id ON minibob_instance TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference)";

DEFINE FIELD IF NOT EXISTS project_id ON minibob_instance TYPE option<string>;

DEFINE FIELD IF NOT EXISTS api_key_hash ON minibob_instance TYPE string
  ASSERT $value != NONE
  COMMENT "Argon2 hash of the API key";

DEFINE FIELD IF NOT EXISTS vessel_id ON minibob_instance TYPE string
  ASSERT $value != NONE
  COMMENT "Vessel identifier (e.g., minibob-cli-local, minibob-k8s-prod)";

DEFINE FIELD IF NOT EXISTS is_active ON minibob_instance TYPE bool
  VALUE $value OR true;

DEFINE FIELD IF NOT EXISTS created_at ON minibob_instance TYPE datetime
  VALUE $value OR time::now();

DEFINE FIELD IF NOT EXISTS last_active_at ON minibob_instance TYPE datetime
  VALUE $value OR time::now();

-- Keep index for historical queries
DEFINE INDEX IF NOT EXISTS idx_minibob_instance_id
  ON minibob_instance FIELDS instance_id UNIQUE;

-- =============================================================================
-- ACCESS METHOD: minibob_record (DEPRECATED)
-- =============================================================================
-- This ACCESS method is commented out to prevent new authentication attempts.
-- Existing tokens remain valid until expiry (24h).
-- Uncomment for rollback if needed.
-- =============================================================================

-- DEFINE ACCESS IF NOT EXISTS minibob_record ON DATABASE TYPE RECORD
--   SIGNIN (
--     SELECT * FROM minibob_instance
--     WHERE instance_id = $instance_id
--     AND crypto::argon2::compare(api_key_hash, $api_key)
--   )
--   DURATION FOR TOKEN 24h
--   DURATION FOR SESSION 7d;

-- Remove the ACCESS method completely (prevents new authentications)
REMOVE ACCESS IF EXISTS minibob_record ON DATABASE;
