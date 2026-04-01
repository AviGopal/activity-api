-- =============================================================================
-- Vessel Registry Schema (SPEC-004)
--
-- Centralized discovery and health tracking for all vessels.
-- Vessels register themselves, advertise capabilities, and heartbeat to maintain
-- active status. Expired vessels are cleaned up periodically.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- vessel table
--
-- Stores vessel registrations with TTL-based expiry.
-- Vessels heartbeat every TTL/2 to remain active.
-- -----------------------------------------------------------------------------
DEFINE TABLE vessel SCHEMAFULL;

-- Identity
DEFINE FIELD id ON vessel TYPE string;
DEFINE FIELD name ON vessel TYPE string;
DEFINE FIELD endpoint ON vessel TYPE string;

-- Capabilities
DEFINE FIELD shapes ON vessel TYPE array<string>;
DEFINE FIELD capabilities ON vessel TYPE array<object>;

-- Metadata
DEFINE FIELD metadata ON vessel TYPE option<object>;
DEFINE FIELD version ON vessel TYPE option<string>;
DEFINE FIELD environment ON vessel TYPE option<string>;

-- Lifecycle
DEFINE FIELD ttl ON vessel TYPE int DEFAULT 300;
DEFINE FIELD registered_at ON vessel TYPE datetime DEFAULT time::now();
DEFINE FIELD last_heartbeat ON vessel TYPE datetime DEFAULT time::now();
DEFINE FIELD expires_at ON vessel TYPE datetime;

-- Multi-tenancy
DEFINE FIELD org_id ON vessel TYPE string;

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Index on id for fast lookups
DEFINE INDEX idx_vessel_id ON vessel COLUMNS id UNIQUE;

-- Index on shapes for discovery queries
DEFINE INDEX idx_vessel_shapes ON vessel COLUMNS shapes;

-- Index on expires_at for cleanup queries
DEFINE INDEX idx_vessel_expires ON vessel COLUMNS expires_at;

-- Index on org_id for multi-tenant isolation
DEFINE INDEX idx_vessel_org ON vessel COLUMNS org_id;

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------

-- Vessels are scoped to organizations
-- Only vessels from same org can discover each other
DEFINE TABLE vessel PERMISSIONS
  FOR select WHERE org_id = $auth.org_id
  FOR create, update WHERE org_id = $auth.org_id
  FOR delete WHERE org_id = $auth.org_id;
