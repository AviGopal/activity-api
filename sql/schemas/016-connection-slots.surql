-- =============================================================================
-- Connection Slots Schema
-- =============================================================================
-- Manages active connection slots for API key-based billing model.
-- Each API key has a limited number of concurrent connection slots.
--
-- State machine: active -> grace -> disconnected
--
-- Used by:
--   - src/routes/connections.ts (acquire, heartbeat, reconnect, release)
--   - src/workers/heartbeat.ts (stale connection detection, grace period management)
-- =============================================================================

-- =============================================================================
-- Table: active_connections
-- =============================================================================
-- Tracks active connection slots per API key
-- RBAC: Scoped by organization via api_key_id
-- =============================================================================

DEFINE TABLE IF NOT EXISTS active_connections SCHEMAFULL
  PERMISSIONS
    -- SELECT: Users can see their own org's connections
    FOR select WHERE
      org_id = $auth.org_id

    -- CREATE: System can create connections (via API key auth flow)
    FOR create WHERE $auth.org_id != NONE

    -- UPDATE: Users can update connections in their org
    FOR update WHERE org_id = $auth.org_id

    -- DELETE: Admins can delete connections, system cleanup also allowed
    FOR delete WHERE org_id = $auth.org_id;

-- Primary identification (record ID format: connection:{uuid})
DEFINE FIELD IF NOT EXISTS api_key_id ON active_connections TYPE string
  ASSERT $value != NONE
  COMMENT "API key ID that owns this connection slot";

DEFINE FIELD IF NOT EXISTS org_id ON active_connections TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID (string reference to identity-vessel)";

DEFINE FIELD IF NOT EXISTS instance_name ON active_connections TYPE option<string>
  COMMENT "Human-readable name for this connection instance";

-- Session management
DEFINE FIELD IF NOT EXISTS session_token ON active_connections TYPE string
  ASSERT $value != NONE
  COMMENT "Cryptographic session token for reconnection";

DEFINE FIELD IF NOT EXISTS status ON active_connections TYPE string
  ASSERT $value IN ['active', 'grace', 'disconnected']
  VALUE $value OR 'active'
  COMMENT "Connection status state machine: active -> grace -> disconnected";

-- Timestamps
DEFINE FIELD IF NOT EXISTS connected_at ON active_connections TYPE datetime
  VALUE $value OR time::now()
  COMMENT "When the connection was established";

DEFINE FIELD IF NOT EXISTS last_heartbeat ON active_connections TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Last heartbeat timestamp (used for stale detection)";

DEFINE FIELD IF NOT EXISTS grace_until ON active_connections TYPE option<datetime>
  COMMENT "Grace period expiry (set when entering grace status)";

DEFINE FIELD IF NOT EXISTS disconnected_at ON active_connections TYPE option<datetime>
  COMMENT "When the connection was disconnected";

-- Execution tracking (for grace period calculation)
DEFINE FIELD IF NOT EXISTS current_execution ON active_connections TYPE option<string>
  COMMENT "Current execution ID if activity is in progress";

DEFINE FIELD IF NOT EXISTS execution_started_at ON active_connections TYPE option<datetime>
  COMMENT "When the current execution started";

DEFINE FIELD IF NOT EXISTS estimated_duration_ms ON active_connections TYPE option<int>
  COMMENT "Estimated duration of current execution for grace period calculation";

-- JWT token storage (for reconnection without API key)
DEFINE FIELD IF NOT EXISTS jwt_token ON active_connections TYPE option<string>
  COMMENT "Cached JWT token for reconnection";

DEFINE FIELD IF NOT EXISTS jwt_expires_at ON active_connections TYPE option<datetime>
  COMMENT "JWT token expiry timestamp";

-- Audit timestamps
DEFINE FIELD IF NOT EXISTS created_at ON active_connections TYPE datetime
  VALUE $value OR time::now()
  COMMENT "Record creation timestamp";

DEFINE FIELD IF NOT EXISTS updated_at ON active_connections TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_active_connections_api_key
  ON active_connections FIELDS api_key_id;

DEFINE INDEX IF NOT EXISTS idx_active_connections_org
  ON active_connections FIELDS org_id;

DEFINE INDEX IF NOT EXISTS idx_active_connections_status
  ON active_connections FIELDS status;

DEFINE INDEX IF NOT EXISTS idx_active_connections_session_token
  ON active_connections FIELDS session_token;

DEFINE INDEX IF NOT EXISTS idx_active_connections_last_heartbeat
  ON active_connections FIELDS last_heartbeat;

-- Composite indexes for common queries
DEFINE INDEX IF NOT EXISTS idx_active_connections_api_key_status
  ON active_connections FIELDS api_key_id, status;

DEFINE INDEX IF NOT EXISTS idx_active_connections_status_grace
  ON active_connections FIELDS status, grace_until;

DEFINE INDEX IF NOT EXISTS idx_active_connections_status_disconnected
  ON active_connections FIELDS status, disconnected_at;
