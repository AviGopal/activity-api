-- =============================================================================
-- Migration 061: Add State Signature and Git State to Execution Table
-- =============================================================================
-- Purpose: Enable state-based similarity matching and git-aware activity selection
-- Related: State-aware Thompson Sampling and execution context matching
-- =============================================================================

-- Add state_signature field for fast exact matching
-- SHA-256 hash of state (shapes + git + env) enables fast similarity queries
DEFINE FIELD IF NOT EXISTS state_signature ON execution TYPE option<string>
  COMMENT "SHA-256 hash of state (shapes + git + env) for similarity matching";

-- Index for fast state signature lookups
DEFINE INDEX IF NOT EXISTS idx_execution_state_sig ON execution FIELDS state_signature;

-- Add git_state field for branch-aware queries
-- Captures complete git repository state at execution time
DEFINE FIELD IF NOT EXISTS git_state ON execution TYPE option<object> FLEXIBLE
  COMMENT "Git repository state: {branch, commit, dirty, changedFiles, stagedFiles, unstagedFiles, ahead, behind}";

-- Indexes for git-based queries
DEFINE INDEX IF NOT EXISTS idx_execution_git_branch ON execution FIELDS git_state.branch;
DEFINE INDEX IF NOT EXISTS idx_execution_git_dirty ON execution FIELDS git_state.dirty;

-- =============================================================================
-- Usage Notes:
--
-- 1. State Signature Matching:
--    SELECT * FROM execution WHERE state_signature = $sig ORDER BY created_at DESC LIMIT 10;
--
-- 2. Branch-aware Queries:
--    SELECT * FROM execution WHERE git_state.branch = "main" AND git_state.dirty = false;
--
-- 3. Similar State Queries (application-level):
--    - Compute state signature from current state
--    - Query by state_signature for exact matches
--    - Fall back to shape-based similarity if no exact match
--
-- =============================================================================
-- Verification query (run after migration):
-- INFO FOR TABLE execution;
-- =============================================================================
