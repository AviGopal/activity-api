-- =============================================================================
-- Vessel Capabilities Schema
--
-- Stores vessel capability registrations for vessel discovery.
-- Vessels advertise what impulse shapes they can resolve and their endpoints.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- vessel_capabilities table
--
-- Stores vessel registrations with their advertised capabilities.
-- Used by MiniBob's VesselDiscoveryClient to route impulse resolution.
-- -----------------------------------------------------------------------------
DEFINE TABLE vessel_capabilities SCHEMALESS;

-- vessel_id: Unique identifier for this vessel instance
DEFINE FIELD vessel_id ON vessel_capabilities TYPE string;

-- vessel_name: Human-readable vessel name
DEFINE FIELD vessel_name ON vessel_capabilities TYPE string;

-- endpoint: HTTP endpoint where vessel can be reached for impulse resolution
-- Example: "http://localhost:9090" or "https://terminal.metabob.local"
DEFINE FIELD endpoint ON vessel_capabilities TYPE string;

-- shapes: Array of impulse shape names this vessel can resolve
-- Example: ["terminalState", "terminalCommand", "terminalOutput"]
DEFINE FIELD shapes ON vessel_capabilities TYPE array;

-- metadata: Optional vessel metadata (version, capabilities, environment, etc.)
DEFINE FIELD metadata ON vessel_capabilities TYPE object DEFAULT {} FLEXIBLE;

-- registered_at: When the vessel first registered
DEFINE FIELD registered_at ON vessel_capabilities TYPE datetime;

-- last_seen: Last time vessel sent registration (used for TTL/health)
DEFINE FIELD last_seen ON vessel_capabilities TYPE datetime;

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- Index on vessel_id for fast lookups
DEFINE INDEX vessel_id_idx ON vessel_capabilities FIELDS vessel_id UNIQUE;

-- Index on shapes for discovery queries
-- This allows fast "which vessels can resolve shape X?" queries
DEFINE INDEX shapes_idx ON vessel_capabilities FIELDS shapes;

-- Index on last_seen for TTL queries (remove stale vessels)
DEFINE INDEX last_seen_idx ON vessel_capabilities FIELDS last_seen;

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------

-- Vessels can register themselves (no org_id needed for vessel-to-vessel communication)
-- Discovery is read-only for authenticated users
DEFINE TABLE vessel_capabilities PERMISSIONS
  FOR select WHERE true  -- Anyone can discover vessels
  FOR create, update WHERE true  -- Vessels can register
  FOR delete WHERE true;  -- Allow cleanup of stale vessels
