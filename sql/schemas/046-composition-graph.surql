-- Schema 046: Composition Graph for Activity Orchestration
-- Date: 2026-04-12
-- Purpose: Track activity composition patterns and Thompson Sampling at edge level
--
-- SPEC: openspec/changes/vessel-integration-standardization/specs/minibob-goal-orchestrators/spec.md

-- ============================================================================
-- composition_node: Activity nodes in the composition graph
-- ============================================================================

DEFINE TABLE composition_node SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id OR public = true
    FOR create WHERE $auth != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id;

-- Activity identity
DEFINE FIELD activity_id ON composition_node TYPE string
  ASSERT $value != NONE
  COMMENT "Activity template ID";

-- Shape information
DEFINE FIELD input_shapes ON composition_node TYPE array<string>
  DEFAULT []
  COMMENT "Required input shapes for this activity";

DEFINE FIELD output_shapes ON composition_node TYPE array<string>
  DEFAULT []
  COMMENT "Shapes produced by this activity";

-- Performance metrics
DEFINE FIELD success_rate ON composition_node TYPE float
  DEFAULT 0.0
  ASSERT $value >= 0.0 AND $value <= 1.0
  COMMENT "Success rate for this activity (0.0-1.0)";

DEFINE FIELD avg_duration_ms ON composition_node TYPE int
  DEFAULT 0
  COMMENT "Average execution duration in milliseconds";

DEFINE FIELD total_executions ON composition_node TYPE int
  DEFAULT 0
  COMMENT "Total number of executions";

-- Metadata
DEFINE FIELD org_id ON composition_node TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID";

DEFINE FIELD public ON composition_node TYPE bool
  DEFAULT false
  COMMENT "If true, visible to all organizations";

DEFINE FIELD updated_at ON composition_node TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- ============================================================================
-- composition_edge: Transitions between activities with Thompson Sampling
-- ============================================================================

DEFINE TABLE composition_edge SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id OR public = true
    FOR create WHERE $auth != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id;

-- Edge definition
DEFINE FIELD from_activity ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "Source activity ID";

DEFINE FIELD to_activity ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "Target activity ID";

DEFINE FIELD shape_produced ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "Shape that enables this transition";

-- Thompson Sampling parameters
DEFINE FIELD alpha ON composition_edge TYPE float
  DEFAULT 1.0
  ASSERT $value >= 0.0
  COMMENT "Thompson Sampling alpha parameter (success count + 1)";

DEFINE FIELD beta ON composition_edge TYPE float
  DEFAULT 1.0
  ASSERT $value >= 0.0
  COMMENT "Thompson Sampling beta parameter (failure count + 1)";

DEFINE FIELD weight ON composition_edge TYPE float
  DEFAULT 0.5
  ASSERT $value >= 0.0 AND $value <= 1.0
  COMMENT "Current Thompson Sampling score (sampled from Beta distribution)";

-- Execution counts
DEFINE FIELD success_count ON composition_edge TYPE int
  DEFAULT 0
  COMMENT "Number of successful traversals";

DEFINE FIELD failure_count ON composition_edge TYPE int
  DEFAULT 0
  COMMENT "Number of failed traversals";

DEFINE FIELD total_count ON composition_edge TYPE int
  DEFAULT 0
  COMMENT "Total traversals (success + failure)";

-- Metadata
DEFINE FIELD org_id ON composition_edge TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID";

DEFINE FIELD public ON composition_edge TYPE bool
  DEFAULT false
  COMMENT "If true, visible to all organizations";

DEFINE FIELD updated_at ON composition_edge TYPE datetime
  VALUE time::now()
  COMMENT "Last update timestamp";

-- ============================================================================
-- composition_chain: Recorded activity sequences from successful orchestrations
-- ============================================================================

DEFINE TABLE composition_chain SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth != NONE
    FOR update WHERE org_id = $auth.org_id
    FOR delete WHERE org_id = $auth.org_id;

-- Chain identification
DEFINE FIELD orchestrator_id ON composition_chain TYPE string
  ASSERT $value != NONE
  COMMENT "Orchestrator activity that executed this chain";

DEFINE FIELD execution_id ON composition_chain TYPE string
  ASSERT $value != NONE
  COMMENT "Execution trace ID";

-- Chain structure
DEFINE FIELD activity_sequence ON composition_chain TYPE array<string>
  DEFAULT []
  COMMENT "Ordered list of activity IDs in the chain";

DEFINE FIELD shape_sequence ON composition_chain TYPE array<string>
  DEFAULT []
  COMMENT "Shapes produced at each step";

-- Outcome
DEFINE FIELD success ON composition_chain TYPE bool
  ASSERT $value != NONE
  COMMENT "Whether the chain achieved its goal";

DEFINE FIELD target_shapes_achieved ON composition_chain TYPE array<string>
  DEFAULT []
  COMMENT "Which target shapes were successfully achieved";

DEFINE FIELD target_shapes_missing ON composition_chain TYPE array<string>
  DEFAULT []
  COMMENT "Which target shapes were not achieved";

-- Performance
DEFINE FIELD total_duration_ms ON composition_chain TYPE int
  DEFAULT 0
  COMMENT "Total chain execution time";

DEFINE FIELD total_cost_usd ON composition_chain TYPE float
  DEFAULT 0.0
  COMMENT "Total cost of all activities in chain";

-- Metadata
DEFINE FIELD org_id ON composition_chain TYPE string
  ASSERT $value != NONE
  COMMENT "Organization ID";

DEFINE FIELD created_at ON composition_chain TYPE datetime
  VALUE time::now()
  COMMENT "When chain was executed";

-- ============================================================================
-- Indexes
-- ============================================================================

-- composition_node indexes
DEFINE INDEX idx_comp_node_activity ON composition_node COLUMNS activity_id;
DEFINE INDEX idx_comp_node_org ON composition_node COLUMNS org_id;
DEFINE INDEX idx_comp_node_public ON composition_node COLUMNS public;
DEFINE INDEX idx_comp_node_success_rate ON composition_node COLUMNS success_rate;

-- composition_edge indexes
DEFINE INDEX idx_comp_edge_from ON composition_edge COLUMNS from_activity;
DEFINE INDEX idx_comp_edge_to ON composition_edge COLUMNS to_activity;
DEFINE INDEX idx_comp_edge_shape ON composition_edge COLUMNS shape_produced;
DEFINE INDEX idx_comp_edge_org ON composition_edge COLUMNS org_id;
DEFINE INDEX idx_comp_edge_weight ON composition_edge COLUMNS weight;

-- Unique index on from+to+shape combination
DEFINE INDEX idx_comp_edge_transition ON composition_edge COLUMNS from_activity, to_activity, shape_produced UNIQUE;

-- composition_chain indexes
DEFINE INDEX idx_comp_chain_orchestrator ON composition_chain COLUMNS orchestrator_id;
DEFINE INDEX idx_comp_chain_execution ON composition_chain COLUMNS execution_id;
DEFINE INDEX idx_comp_chain_org ON composition_chain COLUMNS org_id;
DEFINE INDEX idx_comp_chain_success ON composition_chain COLUMNS success;
DEFINE INDEX idx_comp_chain_created ON composition_chain COLUMNS created_at;

-- ============================================================================
-- Helper Functions
-- ============================================================================

-- Function to update edge after traversal
-- Usage: RETURN fn::update_composition_edge('activity_a', 'activity_b', 'shape_x', true);
DEFINE FUNCTION fn::update_composition_edge($from: string, $to: string, $shape: string, $success: bool) {
  -- Find or create edge
  LET $edge = (SELECT * FROM composition_edge WHERE
    from_activity = $from AND
    to_activity = $to AND
    shape_produced = $shape
    LIMIT 1
  )[0];

  -- Update or create
  IF $edge {
    -- Edge exists, update Thompson Sampling parameters
    UPDATE composition_edge SET
      success_count = IF($success, success_count + 1, success_count),
      failure_count = IF($success, failure_count, failure_count + 1),
      total_count = total_count + 1,
      alpha = IF($success, alpha + 1, alpha),
      beta = IF($success, beta, beta + 1),
      updated_at = time::now()
    WHERE id = $edge.id;
  } ELSE {
    -- Create new edge
    CREATE composition_edge SET
      from_activity = $from,
      to_activity = $to,
      shape_produced = $shape,
      success_count = IF($success, 1, 0),
      failure_count = IF($success, 0, 1),
      total_count = 1,
      alpha = IF($success, 2.0, 1.0),
      beta = IF($success, 1.0, 2.0),
      weight = 0.5,
      org_id = $auth.org_id,
      public = false;
  };

  RETURN true;
};

-- Function to find activity chains between current and target shapes
-- Usage: RETURN fn::find_composition_chains(['error_log'], ['test_result'], 5);
DEFINE FUNCTION fn::find_composition_chains($current_shapes: array<string>, $target_shapes: array<string>, $max_depth: int) {
  -- Find activities that can run with current shapes
  LET $candidates = (SELECT * FROM composition_node WHERE
    array::intersect(input_shapes, $current_shapes) = input_shapes
  );

  -- Filter activities that produce target shapes
  LET $productive = (SELECT * FROM $candidates WHERE
    array::intersect(output_shapes, $target_shapes).len() > 0
  );

  -- Return top candidates by success rate
  RETURN (SELECT * FROM $productive ORDER BY success_rate DESC LIMIT 10);
};

-- ============================================================================
-- Verification
-- ============================================================================

-- Expected: These queries should work after schema application
-- SELECT * FROM composition_node WHERE activity_id = 'context:codebase';
-- SELECT * FROM composition_edge WHERE from_activity = 'context:codebase' AND to_activity = 'generate-tests';
-- SELECT * FROM composition_chain WHERE orchestrator_id = 'orchestrate-test-goal' ORDER BY created_at DESC LIMIT 5;
