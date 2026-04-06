-- =============================================================================
-- API Key Direct Authentication Schema
-- =============================================================================
-- This schema enables direct API key validation within activity-api without
-- requiring identity-vessel. API keys are stored with SHA-256 hashes for fast
-- lookup (compared to Argon2 which is slow by design).
--
-- Use case: Fallback authentication when identity-vessel is unavailable
-- =============================================================================

-- =============================================================================
-- Table: api_key
-- =============================================================================
-- Stores API keys with SHA-256 hashes for direct validation.
-- This is a lightweight alternative to identity-vessel's HMAC validation.
-- =============================================================================

DEFINE TABLE IF NOT EXISTS api_key SCHEMAFULL
  PERMISSIONS
    -- Only admins can see API keys for their org
    FOR select WHERE org_id = $auth.org_id AND ($auth.role = 'admin' OR $auth.role = 'owner')
    -- Only admins can create/update/delete keys
    FOR create, update, delete WHERE org_id = $auth.org_id AND ($auth.role = 'admin' OR $auth.role = 'owner');

-- Key hash (SHA-256 of the API key)
-- Used for fast O(1) lookup during validation
DEFINE FIELD IF NOT EXISTS key_hash ON api_key TYPE string
  ASSERT $value != NONE
  COMMENT "SHA-256 hash of the API key for fast lookup";

-- Organization ID (multi-tenant isolation)
DEFINE FIELD IF NOT EXISTS org_id ON api_key TYPE string
  ASSERT $value != NONE
  COMMENT "Organization that owns this API key";

-- User ID who created/owns the key
DEFINE FIELD IF NOT EXISTS user_id ON api_key TYPE option<string>
  COMMENT "User ID who owns this API key (optional)";

-- Human-readable name for the key
DEFINE FIELD IF NOT EXISTS name ON api_key TYPE option<string>
  COMMENT "Human-readable name for identifying the key";

-- Key status
DEFINE FIELD IF NOT EXISTS is_active ON api_key TYPE bool
  VALUE $value OR true
  COMMENT "Whether the key is active and can be used for authentication";

-- Scopes/permissions granted to this key
DEFINE FIELD IF NOT EXISTS scopes ON api_key TYPE array<string>
  VALUE $value OR ['read', 'write']
  COMMENT "Array of permission scopes granted to this key";

-- Expiration timestamp
DEFINE FIELD IF NOT EXISTS expires_at ON api_key TYPE option<datetime>
  COMMENT "Optional expiration time. Null means no expiration";

-- Last used timestamp
DEFINE FIELD IF NOT EXISTS last_used_at ON api_key TYPE option<datetime>
  COMMENT "Last time this key was used for authentication";

-- Timestamps
DEFINE FIELD IF NOT EXISTS created_at ON api_key TYPE datetime
  VALUE $value OR time::now()
  COMMENT "When the key was created";

DEFINE FIELD IF NOT EXISTS updated_at ON api_key TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- =============================================================================
-- Indexes
-- =============================================================================

-- Primary lookup index: key_hash must be unique and is used for O(1) lookup
DEFINE INDEX IF NOT EXISTS idx_api_key_hash
  ON api_key FIELDS key_hash UNIQUE;

-- Organization index for listing keys
DEFINE INDEX IF NOT EXISTS idx_api_key_org
  ON api_key FIELDS org_id;

-- Composite index for active key validation
DEFINE INDEX IF NOT EXISTS idx_api_key_hash_active
  ON api_key FIELDS key_hash, is_active;

-- Index for expiration cleanup queries
DEFINE INDEX IF NOT EXISTS idx_api_key_expires
  ON api_key FIELDS expires_at;
