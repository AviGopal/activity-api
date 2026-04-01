-- =============================================================================
-- Resolver Architecture Schema
--
-- Extends core tables to support impulse-resolver architecture where:
-- - Every task specifies which resolver transforms its input impulses
-- - Resolvers (llm, git, file, mcp, bash, validation) are registered capabilities
-- - State transitions track impulse state evolution
-- - Learning maps impulse state space to activity recommendations
-- =============================================================================

-- -----------------------------------------------------------------------------
-- resolver table
--
-- Registry of all resolvers (vessels, built-in tools, remote services)
-- Each resolver advertises which impulse types it can consume/produce
-- -----------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS resolver SCHEMAFULL
  PERMISSIONS
    FOR select WHERE true  -- Public discovery
    FOR create, update WHERE $auth.org_id != NONE  -- Authenticated create
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Identity
DEFINE FIELD IF NOT EXISTS id ON resolver TYPE string
  ASSERT $value != NONE
  COMMENT "Unique resolver identifier (e.g., 'llm', 'git', 'file', 'mcp', 'bash')";

DEFINE FIELD IF NOT EXISTS name ON resolver TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS description ON resolver TYPE option<string>;

-- Resolver type
DEFINE FIELD IF NOT EXISTS resolver_type ON resolver TYPE string
  ASSERT $value IN ['built-in', 'vessel', 'remote_service', 'mcp_server']
  COMMENT "Type of resolver: built-in (bash, git), vessel (MiniBob), remote (LLM), MCP server";

-- Capabilities: What impulse types can this resolver handle?
DEFINE FIELD IF NOT EXISTS can_consume ON resolver TYPE array<string>
  VALUE $value OR []
  COMMENT "Impulse shapes/types this resolver can consume as input";

DEFINE FIELD IF NOT EXISTS can_produce ON resolver TYPE array<string>
  VALUE $value OR []
  COMMENT "Impulse shapes/types this resolver can produce as output";

-- Location: Where to find this resolver
DEFINE FIELD IF NOT EXISTS endpoint ON resolver TYPE option<string>
  COMMENT "HTTP endpoint for remote resolvers (null for built-in)";

DEFINE FIELD IF NOT EXISTS vessel_id ON resolver TYPE option<string>
  COMMENT "Vessel ID if resolver_type = 'vessel'";

-- Performance characteristics
DEFINE FIELD IF NOT EXISTS avg_latency_ms ON resolver TYPE option<float>
  COMMENT "Average resolution latency (learned from executions)";

DEFINE FIELD IF NOT EXISTS avg_cost_usd ON resolver TYPE option<float>
  COMMENT "Average cost per resolution (learned from executions)";

DEFINE FIELD IF NOT EXISTS success_rate ON resolver TYPE option<float>
  COMMENT "Success rate (learned from executions)";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON resolver TYPE option<string>
  COMMENT "Organization ID (null for global resolvers like 'git', 'bash')";

DEFINE FIELD IF NOT EXISTS scope ON resolver TYPE string
  ASSERT $value IN ['global', 'org', 'project']
  VALUE $value OR 'global';

-- Lifecycle
DEFINE FIELD IF NOT EXISTS created_at ON resolver TYPE datetime
  VALUE $value OR time::now();

DEFINE FIELD IF NOT EXISTS last_used_at ON resolver TYPE option<datetime>;

DEFINE FIELD IF NOT EXISTS is_active ON resolver TYPE bool
  VALUE $value OR true;

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_resolver_id ON resolver FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_resolver_type ON resolver FIELDS resolver_type;
DEFINE INDEX IF NOT EXISTS idx_resolver_consume ON resolver FIELDS can_consume;
DEFINE INDEX IF NOT EXISTS idx_resolver_produce ON resolver FIELDS can_produce;
DEFINE INDEX IF NOT EXISTS idx_resolver_vessel ON resolver FIELDS vessel_id;
DEFINE INDEX IF NOT EXISTS idx_resolver_active ON resolver FIELDS is_active, scope;

-- -----------------------------------------------------------------------------
-- state_transition table
--
-- Tracks impulse state evolution through activity execution
-- Enables learning: given impulse_state + activity → new_impulse_state
-- -----------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS state_transition SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update, delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Identity
DEFINE FIELD IF NOT EXISTS id ON state_transition TYPE string
  ASSERT $value != NONE;

DEFINE FIELD IF NOT EXISTS execution_id ON state_transition TYPE string
  ASSERT $value != NONE
  COMMENT "Execution that caused this state transition";

-- State snapshots
DEFINE FIELD IF NOT EXISTS before_state ON state_transition TYPE object
  COMMENT "Impulse state before execution: {impulses: [{id, shape, metadata}], state_vector}";

DEFINE FIELD IF NOT EXISTS after_state ON state_transition TYPE object
  COMMENT "Impulse state after execution: {impulses: [{id, shape, metadata}], state_vector}";

-- Transition details
DEFINE FIELD IF NOT EXISTS activity_id ON state_transition TYPE string;

DEFINE FIELD IF NOT EXISTS resolvers_used ON state_transition TYPE array<string>
  VALUE $value OR []
  COMMENT "Resolvers used in this transition";

DEFINE FIELD IF NOT EXISTS success ON state_transition TYPE bool;

DEFINE FIELD IF NOT EXISTS duration_ms ON state_transition TYPE int;

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON state_transition TYPE string
  ASSERT $value != NONE
  VALUE $value OR <string>$auth.org_id;

DEFINE FIELD IF NOT EXISTS created_at ON state_transition TYPE datetime
  VALUE $value OR time::now();

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_state_transition_id ON state_transition FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_state_transition_execution ON state_transition FIELDS execution_id;
DEFINE INDEX IF NOT EXISTS idx_state_transition_activity ON state_transition FIELDS activity_id;
DEFINE INDEX IF NOT EXISTS idx_state_transition_success ON state_transition FIELDS success;
DEFINE INDEX IF NOT EXISTS idx_state_transition_org ON state_transition FIELDS org_id;

-- -----------------------------------------------------------------------------
-- impulse_state_pattern table
--
-- Learned patterns: "When impulse state looks like X, activity Y succeeds"
-- Enables state-space based activity recommendations
-- -----------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS impulse_state_pattern SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id OR scope = 'global'
    FOR create WHERE $auth.org_id != NONE
    FOR update, delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

-- Identity
DEFINE FIELD IF NOT EXISTS id ON impulse_state_pattern TYPE string
  ASSERT $value != NONE;

-- Pattern description
DEFINE FIELD IF NOT EXISTS pattern_type ON impulse_state_pattern TYPE string
  ASSERT $value IN ['shape_combination', 'state_vector_cluster', 'metadata_condition']
  COMMENT "Type of pattern: shapes present, embedding cluster, metadata filters";

DEFINE FIELD IF NOT EXISTS pattern ON impulse_state_pattern TYPE object
  COMMENT "Pattern definition (varies by type)";

-- What activity works with this pattern?
DEFINE FIELD IF NOT EXISTS recommended_activity_id ON impulse_state_pattern TYPE string;

-- Learning metrics
DEFINE FIELD IF NOT EXISTS confidence ON impulse_state_pattern TYPE float
  ASSERT $value >= 0 AND $value <= 1
  VALUE $value OR 0.5;

DEFINE FIELD IF NOT EXISTS support_count ON impulse_state_pattern TYPE int
  VALUE $value OR 1
  COMMENT "Number of executions supporting this pattern";

DEFINE FIELD IF NOT EXISTS success_rate ON impulse_state_pattern TYPE float
  COMMENT "Success rate when this pattern matched";

-- Multi-tenancy
DEFINE FIELD IF NOT EXISTS org_id ON impulse_state_pattern TYPE string
  VALUE $value OR <string>$auth.org_id;

DEFINE FIELD IF NOT EXISTS scope ON impulse_state_pattern TYPE string
  ASSERT $value IN ['global', 'org', 'project']
  VALUE $value OR 'org';

-- Lifecycle
DEFINE FIELD IF NOT EXISTS learned_at ON impulse_state_pattern TYPE datetime
  VALUE $value OR time::now();

DEFINE FIELD IF NOT EXISTS last_matched_at ON impulse_state_pattern TYPE option<datetime>;

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_impulse_state_pattern_id ON impulse_state_pattern FIELDS id UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_impulse_state_pattern_type ON impulse_state_pattern FIELDS pattern_type;
DEFINE INDEX IF NOT EXISTS idx_impulse_state_pattern_activity ON impulse_state_pattern FIELDS recommended_activity_id;
DEFINE INDEX IF NOT EXISTS idx_impulse_state_pattern_confidence ON impulse_state_pattern FIELDS confidence;
DEFINE INDEX IF NOT EXISTS idx_impulse_state_pattern_org ON impulse_state_pattern FIELDS org_id, scope;

-- -----------------------------------------------------------------------------
-- Migration notes
-- -----------------------------------------------------------------------------
--
-- The `activity` table already has flexible task schema (FLEXIBLE object type)
-- No migration needed - just start storing tasks with resolver field:
--
-- tasks: [
--   {
--     id: "checkpoint",
--     resolver: "git",
--     inputImpulses: ["checkpointMessage"],
--     outputImpulses: ["stashId", "commitHash"]
--   },
--   {
--     id: "execute",
--     resolver: "llm",
--     inputImpulses: ["activityTemplate", "context"],
--     outputImpulses: ["executionResult"]
--   }
-- ]
--
-- The `execution` table already tracks input_impulses and output_impulses
-- Can compute state transitions retroactively from existing data
-- -----------------------------------------------------------------------------
