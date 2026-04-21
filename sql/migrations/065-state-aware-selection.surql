-- Migration 065: State-Aware Activity Selection
-- Enables MiniBob to learn which activities work best given specific impulse states
-- Date: 2026-04-18

-- ============================================================================
-- Execution State Snapshots
-- ============================================================================
-- Captures the complete state at the moment of activity recommendation

DEFINE TABLE execution_state_snapshot SCHEMAFULL;

DEFINE FIELD execution_id ON execution_state_snapshot TYPE string;
DEFINE FIELD trace_id ON execution_state_snapshot TYPE string;
DEFINE FIELD timestamp ON execution_state_snapshot TYPE datetime DEFAULT time::now();
DEFINE FIELD org_id ON execution_state_snapshot TYPE string;

-- Impulse state space at recommendation time
DEFINE FIELD impulse_state ON execution_state_snapshot TYPE object;
DEFINE FIELD impulse_state.total_impulses ON execution_state_snapshot TYPE int;
DEFINE FIELD impulse_state.loaded_impulses ON execution_state_snapshot TYPE int;
DEFINE FIELD impulse_state.total_budget ON execution_state_snapshot TYPE int;
DEFINE FIELD impulse_state.budget_consumed ON execution_state_snapshot TYPE int;
DEFINE FIELD impulse_state.impulse_types ON execution_state_snapshot TYPE object; -- type -> count
DEFINE FIELD impulse_state.impulses ON execution_state_snapshot TYPE array;

-- Recent activity history
DEFINE FIELD activity_history ON execution_state_snapshot TYPE object;
DEFINE FIELD activity_history.last_activity_id ON execution_state_snapshot TYPE string;
DEFINE FIELD activity_history.last_activity_name ON execution_state_snapshot TYPE string;
DEFINE FIELD activity_history.last_success ON execution_state_snapshot TYPE bool;
DEFINE FIELD activity_history.minutes_since_last ON execution_state_snapshot TYPE int;
DEFINE FIELD activity_history.activities_last_hour ON execution_state_snapshot TYPE array<string>;
DEFINE FIELD activity_history.activities_last_day ON execution_state_snapshot TYPE array<string>;

-- Changes in flight (git status)
DEFINE FIELD git_state ON execution_state_snapshot TYPE object;
DEFINE FIELD git_state.branch ON execution_state_snapshot TYPE string;
DEFINE FIELD git_state.total_changes ON execution_state_snapshot TYPE int;
DEFINE FIELD git_state.has_staged ON execution_state_snapshot TYPE bool;
DEFINE FIELD git_state.has_code_changes ON execution_state_snapshot TYPE bool;
DEFINE FIELD git_state.has_test_changes ON execution_state_snapshot TYPE bool;
DEFINE FIELD git_state.has_activity_changes ON execution_state_snapshot TYPE bool;

-- Goal context
DEFINE FIELD goal_context ON execution_state_snapshot TYPE object;
DEFINE FIELD goal_context.goal_description ON execution_state_snapshot TYPE string;
DEFINE FIELD goal_context.goal_type ON execution_state_snapshot TYPE string;
DEFINE FIELD goal_context.implied_shapes ON execution_state_snapshot TYPE array<string>;

-- Selected activity and outcome
DEFINE FIELD selected_activity_id ON execution_state_snapshot TYPE string;
DEFINE FIELD selected_activity_name ON execution_state_snapshot TYPE string;
DEFINE FIELD selection_method ON execution_state_snapshot TYPE string; -- 'thompson', 'state_aware', 'manual'
DEFINE FIELD thompson_score ON execution_state_snapshot TYPE float;
DEFINE FIELD state_bonus ON execution_state_snapshot TYPE float;
DEFINE FIELD final_score ON execution_state_snapshot TYPE float;

-- Outcome (filled in after execution)
DEFINE FIELD outcome_success ON execution_state_snapshot TYPE bool;
DEFINE FIELD outcome_duration_ms ON execution_state_snapshot TYPE int;
DEFINE FIELD outcome_cost_usd ON execution_state_snapshot TYPE float;
DEFINE FIELD outcome_summary ON execution_state_snapshot TYPE string;

-- Indexes
DEFINE INDEX execution_id_idx ON execution_state_snapshot COLUMNS execution_id UNIQUE;
DEFINE INDEX trace_id_idx ON execution_state_snapshot COLUMNS trace_id;
DEFINE INDEX org_timestamp_idx ON execution_state_snapshot COLUMNS org_id, timestamp;
DEFINE INDEX selected_activity_idx ON execution_state_snapshot COLUMNS selected_activity_id, timestamp;

-- Permissions (multi-tenant)
DEFINE FIELD org_id ON execution_state_snapshot PERMISSIONS FOR
  select WHERE org_id = $auth.org_id,
  create WHERE org_id = $auth.org_id,
  update WHERE org_id = $auth.org_id,
  delete WHERE org_id = $auth.org_id;

-- ============================================================================
-- State Pattern Discovery
-- ============================================================================
-- Automatically discovered patterns from state→activity→outcome correlations

DEFINE TABLE discovered_state_pattern SCHEMAFULL;

DEFINE FIELD pattern_id ON discovered_state_pattern TYPE string;
DEFINE FIELD pattern_hash ON discovered_state_pattern TYPE string; -- Hash of state signature
DEFINE FIELD org_id ON discovered_state_pattern TYPE string;
DEFINE FIELD created_at ON discovered_state_pattern TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON discovered_state_pattern TYPE datetime DEFAULT time::now();

-- State signature (what makes this pattern unique)
DEFINE FIELD state_signature ON discovered_state_pattern TYPE object;
DEFINE FIELD state_signature.impulse_types_present ON discovered_state_pattern TYPE array<string>;
DEFINE FIELD state_signature.last_activity_id ON discovered_state_pattern TYPE string;
DEFINE FIELD state_signature.has_git_changes ON discovered_state_pattern TYPE bool;
DEFINE FIELD state_signature.minutes_since_last_min ON discovered_state_pattern TYPE int;
DEFINE FIELD state_signature.minutes_since_last_max ON discovered_state_pattern TYPE int;
DEFINE FIELD state_signature.goal_type ON discovered_state_pattern TYPE string;

-- Activity that performed best in this state
DEFINE FIELD best_activity_id ON discovered_state_pattern TYPE string;
DEFINE FIELD best_activity_name ON discovered_state_pattern TYPE string;

-- Learning statistics
DEFINE FIELD observations ON discovered_state_pattern TYPE int DEFAULT 0;
DEFINE FIELD recommendations ON discovered_state_pattern TYPE int DEFAULT 0;
DEFINE FIELD successes ON discovered_state_pattern TYPE int DEFAULT 0;
DEFINE FIELD failures ON discovered_state_pattern TYPE int DEFAULT 0;
DEFINE FIELD alpha ON discovered_state_pattern TYPE float DEFAULT 1.0;
DEFINE FIELD beta ON discovered_state_pattern TYPE float DEFAULT 1.0;
DEFINE FIELD success_rate ON discovered_state_pattern TYPE float DEFAULT 0.0;
DEFINE FIELD avg_duration_ms ON discovered_state_pattern TYPE int;
DEFINE FIELD avg_cost_usd ON discovered_state_pattern TYPE float;

-- Confidence and validity
DEFINE FIELD confidence ON discovered_state_pattern TYPE float DEFAULT 0.0; -- Based on observations
DEFINE FIELD enabled ON discovered_state_pattern TYPE bool DEFAULT true;
DEFINE FIELD last_observed ON discovered_state_pattern TYPE datetime;

-- Indexes
DEFINE INDEX pattern_hash_idx ON discovered_state_pattern COLUMNS pattern_hash, org_id UNIQUE;
DEFINE INDEX best_activity_idx ON discovered_state_pattern COLUMNS best_activity_id;
DEFINE INDEX org_confidence_idx ON discovered_state_pattern COLUMNS org_id, confidence;

-- Permissions (multi-tenant)
DEFINE FIELD org_id ON discovered_state_pattern PERMISSIONS FOR
  select WHERE org_id = $auth.org_id,
  create WHERE org_id = $auth.org_id,
  update WHERE org_id = $auth.org_id,
  delete WHERE org_id = $auth.org_id;

-- ============================================================================
-- State Feature Importance
-- ============================================================================
-- Tracks which state features are most predictive of activity success

DEFINE TABLE state_feature_importance SCHEMAFULL;

DEFINE FIELD feature_name ON state_feature_importance TYPE string;
DEFINE FIELD feature_type ON state_feature_importance TYPE string; -- 'impulse_type', 'recent_activity', 'git_state', 'goal_type'
DEFINE FIELD org_id ON state_feature_importance TYPE string;
DEFINE FIELD created_at ON state_feature_importance TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON state_feature_importance TYPE datetime DEFAULT time::now();

-- Importance metrics
DEFINE FIELD correlation_score ON state_feature_importance TYPE float DEFAULT 0.0;
DEFINE FIELD observations ON state_feature_importance TYPE int DEFAULT 0;
DEFINE FIELD success_when_present ON state_feature_importance TYPE int DEFAULT 0;
DEFINE FIELD failure_when_present ON state_feature_importance TYPE int DEFAULT 0;

-- Indexes
DEFINE INDEX feature_org_idx ON state_feature_importance COLUMNS feature_name, org_id UNIQUE;
DEFINE INDEX correlation_idx ON state_feature_importance COLUMNS org_id, correlation_score;

-- Permissions
DEFINE FIELD org_id ON state_feature_importance PERMISSIONS FOR
  select WHERE org_id = $auth.org_id,
  create WHERE org_id = $auth.org_id,
  update WHERE org_id = $auth.org_id,
  delete WHERE org_id = $auth.org_id;

-- ============================================================================
-- Activity State Affinity
-- ============================================================================
-- Tracks which activities perform best in which states

DEFINE TABLE activity_state_affinity SCHEMAFULL;

DEFINE FIELD activity_id ON activity_state_affinity TYPE string;
DEFINE FIELD state_hash ON activity_state_affinity TYPE string; -- Hash of state features
DEFINE FIELD org_id ON activity_state_affinity TYPE string;
DEFINE FIELD created_at ON activity_state_affinity TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON activity_state_affinity TYPE datetime DEFAULT time::now();

-- State conditions
DEFINE FIELD state_conditions ON activity_state_affinity TYPE object;

-- Performance in this state
DEFINE FIELD executions ON activity_state_affinity TYPE int DEFAULT 0;
DEFINE FIELD successes ON activity_state_affinity TYPE int DEFAULT 0;
DEFINE FIELD failures ON activity_state_affinity TYPE int DEFAULT 0;
DEFINE FIELD success_rate ON activity_state_affinity TYPE float DEFAULT 0.0;
DEFINE FIELD avg_duration_ms ON activity_state_affinity TYPE int;
DEFINE FIELD avg_cost_usd ON activity_state_affinity TYPE float;

-- Thompson Sampling priors for this (activity, state) pair
DEFINE FIELD alpha ON activity_state_affinity TYPE float DEFAULT 1.0;
DEFINE FIELD beta ON activity_state_affinity TYPE float DEFAULT 1.0;

-- Indexes
DEFINE INDEX activity_state_idx ON activity_state_affinity COLUMNS activity_id, state_hash, org_id UNIQUE;
DEFINE INDEX success_rate_idx ON activity_state_affinity COLUMNS org_id, success_rate;

-- Permissions
DEFINE FIELD org_id ON activity_state_affinity PERMISSIONS FOR
  select WHERE org_id = $auth.org_id,
  create WHERE org_id = $auth.org_id,
  update WHERE org_id = $auth.org_id,
  delete WHERE org_id = $auth.org_id;

-- ============================================================================
-- Views for Analysis
-- ============================================================================

-- Recent state snapshots with outcomes
DEFINE TABLE state_snapshot_with_outcome AS
  SELECT
    execution_id,
    trace_id,
    timestamp,
    impulse_state,
    activity_history,
    git_state,
    goal_context,
    selected_activity_id,
    selected_activity_name,
    outcome_success,
    outcome_duration_ms,
    outcome_cost_usd
  FROM execution_state_snapshot
  WHERE outcome_success IS NOT NULL
  ORDER BY timestamp DESC;

-- Pattern performance summary
DEFINE TABLE pattern_performance_summary AS
  SELECT
    pattern_id,
    best_activity_id,
    best_activity_name,
    observations,
    recommendations,
    success_rate,
    confidence,
    alpha,
    beta
  FROM discovered_state_pattern
  WHERE enabled = true AND confidence > 0.5
  ORDER BY success_rate DESC, observations DESC;
