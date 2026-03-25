-- Migration 007: Control Flow and Data Flow Learning Systems
-- Implements two distinct learning mechanisms:
--   1. Control Flow: Goal → Activity Selection (Thompson Sampling on sequences)
--   2. Data Flow: Activity → Robust Implementation (Ribosome pattern with prerequisites)

-- ============================================================================
-- CONTROL FLOW LEARNING: Goal Paths
-- ============================================================================
-- Tracks which activity sequences achieve which goals
-- Used by Thompson Sampling to recommend activity compositions

DEFINE TABLE IF NOT EXISTS goal_paths SCHEMAFULL;

DEFINE FIELD id ON goal_paths TYPE string ASSERT $value != NONE;
DEFINE FIELD goal_pattern ON goal_paths TYPE string ASSERT $value != NONE;
DEFINE FIELD goal_embedding ON goal_paths TYPE option<array<float>>;  -- For semantic matching
DEFINE FIELD initial_state ON goal_paths TYPE object;
DEFINE FIELD initial_impulses ON goal_paths TYPE array<string>;  -- Impulse types available at start

-- The activity sequence that was executed
DEFINE FIELD activity_sequence ON goal_paths TYPE array<object>;
DEFINE FIELD activity_sequence.*.activity_id ON goal_paths TYPE string;
DEFINE FIELD activity_sequence.*.execution_id ON goal_paths TYPE string;
DEFINE FIELD activity_sequence.*.order ON goal_paths TYPE number;
DEFINE FIELD activity_sequence.*.success ON goal_paths TYPE bool;
DEFINE FIELD activity_sequence.*.duration_ms ON goal_paths TYPE option<number>;

-- Outcome metrics
DEFINE FIELD success ON goal_paths TYPE bool ASSERT $value != NONE;
DEFINE FIELD total_duration_ms ON goal_paths TYPE number;
DEFINE FIELD total_cost ON goal_paths TYPE number;
DEFINE FIELD goal_achieved ON goal_paths TYPE bool;

-- Thompson Sampling metrics
DEFINE FIELD execution_count ON goal_paths TYPE number DEFAULT 0;
DEFINE FIELD success_count ON goal_paths TYPE number DEFAULT 0;
DEFINE FIELD success_rate ON goal_paths TYPE number DEFAULT 0.0;
DEFINE FIELD thompson_alpha ON goal_paths TYPE number DEFAULT 1.0;  -- Success prior
DEFINE FIELD thompson_beta ON goal_paths TYPE number DEFAULT 1.0;   -- Failure prior

-- Metadata
DEFINE FIELD created_at ON goal_paths TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON goal_paths TYPE datetime DEFAULT time::now();

-- Indexes for fast querying
DEFINE INDEX idx_goal_pattern ON goal_paths FIELDS goal_pattern;
DEFINE INDEX idx_success_rate ON goal_paths FIELDS success_rate;
DEFINE INDEX idx_execution_count ON goal_paths FIELDS execution_count;

-- ============================================================================
-- DATA FLOW LEARNING: Activity Prerequisites
-- ============================================================================
-- Activities declare what they need (preconditions) and what they produce (postconditions)
-- Enables automatic composition through prerequisite satisfaction

DEFINE TABLE IF NOT EXISTS activity_prerequisites SCHEMAFULL;

DEFINE FIELD id ON activity_prerequisites TYPE string ASSERT $value != NONE;
DEFINE FIELD template_id ON activity_prerequisites TYPE string ASSERT $value != NONE;
DEFINE FIELD variant_id ON activity_prerequisites TYPE string ASSERT $value != NONE;

-- Preconditions: What this activity REQUIRES to run
DEFINE FIELD required_impulses ON activity_prerequisites TYPE array<object>;
DEFINE FIELD required_impulses.*.type ON activity_prerequisites TYPE string;
DEFINE FIELD required_impulses.*.optional ON activity_prerequisites TYPE bool DEFAULT false;
DEFINE FIELD required_impulses.*.description ON activity_prerequisites TYPE option<string>;

DEFINE FIELD state_requirements ON activity_prerequisites TYPE option<object>;  -- State conditions

-- Postconditions: What this activity GUARANTEES to create
DEFINE FIELD produces_impulses ON activity_prerequisites TYPE array<object>;
DEFINE FIELD produces_impulses.*.type ON activity_prerequisites TYPE string;
DEFINE FIELD produces_impulses.*.reliability ON activity_prerequisites TYPE number DEFAULT 1.0;
DEFINE FIELD produces_impulses.*.description ON activity_prerequisites TYPE option<string>;

DEFINE FIELD state_changes ON activity_prerequisites TYPE option<object>;  -- Expected state delta

-- Metadata
DEFINE FIELD created_at ON activity_prerequisites TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON activity_prerequisites TYPE datetime DEFAULT time::now();

-- Indexes
DEFINE INDEX idx_template ON activity_prerequisites FIELDS template_id;
DEFINE INDEX idx_variant ON activity_prerequisites FIELDS variant_id;

-- ============================================================================
-- COMPOSITION LEARNING: Prerequisite Satisfaction Patterns
-- ============================================================================
-- Tracks which activities successfully satisfy which prerequisites
-- Enables learned composition: "Activity A needs X → Activity B produces X → Compose B→A"

DEFINE TABLE IF NOT EXISTS prerequisite_patterns SCHEMAFULL;

DEFINE FIELD id ON prerequisite_patterns TYPE string ASSERT $value != NONE;

-- What's needed
DEFINE FIELD required_impulse_type ON prerequisite_patterns TYPE string ASSERT $value != NONE;
DEFINE FIELD required_state ON prerequisite_patterns TYPE option<object>;

-- What satisfies it
DEFINE FIELD satisfying_activity_id ON prerequisite_patterns TYPE string ASSERT $value != NONE;
DEFINE FIELD satisfying_variant_id ON prerequisite_patterns TYPE option<string>;

-- How well it works
DEFINE FIELD execution_count ON prerequisite_patterns TYPE number DEFAULT 0;
DEFINE FIELD success_count ON prerequisite_patterns TYPE number DEFAULT 0;
DEFINE FIELD success_rate ON prerequisite_patterns TYPE number DEFAULT 0.0;
DEFINE FIELD avg_duration_ms ON prerequisite_patterns TYPE number DEFAULT 0.0;

-- Thompson Sampling parameters
DEFINE FIELD thompson_alpha ON prerequisite_patterns TYPE number DEFAULT 1.0;
DEFINE FIELD thompson_beta ON prerequisite_patterns TYPE number DEFAULT 1.0;

-- Metadata
DEFINE FIELD created_at ON prerequisite_patterns TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON prerequisite_patterns TYPE datetime DEFAULT time::now();

-- Indexes
DEFINE INDEX idx_required_impulse ON prerequisite_patterns FIELDS required_impulse_type;
DEFINE INDEX idx_satisfying_activity ON prerequisite_patterns FIELDS satisfying_activity_id;
DEFINE INDEX idx_prerequisite_success ON prerequisite_patterns FIELDS required_impulse_type, success_rate;

-- ============================================================================
-- DATA FLOW LEARNING: Execution Step Patterns
-- ============================================================================
-- Extracts proven step sequences from successful executions (Ribosome pattern)
-- Stores: which step patterns work, how data flows between steps, error recovery

DEFINE TABLE IF NOT EXISTS execution_step_patterns SCHEMAFULL;

DEFINE FIELD id ON execution_step_patterns TYPE string ASSERT $value != NONE;
DEFINE FIELD source_execution_id ON execution_step_patterns TYPE string;  -- Where this pattern came from
DEFINE FIELD template_id ON execution_step_patterns TYPE string ASSERT $value != NONE;

-- The proven step sequence
DEFINE FIELD steps ON execution_step_patterns TYPE array<object>;
DEFINE FIELD steps.*.id ON execution_step_patterns TYPE string;
DEFINE FIELD steps.*.description ON execution_step_patterns TYPE string;
DEFINE FIELD steps.*.transformations ON execution_step_patterns TYPE array<object>;  -- Tool calls
DEFINE FIELD steps.*.requires_impulses ON execution_step_patterns TYPE array<string>;  -- Input data
DEFINE FIELD steps.*.produces_impulses ON execution_step_patterns TYPE array<string>;  -- Output data
DEFINE FIELD steps.*.error_recovery ON execution_step_patterns TYPE option<object>;   -- Recovery pattern used

-- Pattern metadata
DEFINE FIELD goal_context ON execution_step_patterns TYPE option<string>;
DEFINE FIELD success_indicators ON execution_step_patterns TYPE array<string>;  -- What made this successful
DEFINE FIELD used_count ON execution_step_patterns TYPE number DEFAULT 0;
DEFINE FIELD success_when_used ON execution_step_patterns TYPE number DEFAULT 0;

-- Metadata
DEFINE FIELD created_at ON execution_step_patterns TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON execution_step_patterns TYPE datetime DEFAULT time::now();

-- Indexes
DEFINE INDEX idx_template_pattern ON execution_step_patterns FIELDS template_id;
DEFINE INDEX idx_source_execution ON execution_step_patterns FIELDS source_execution_id;

-- ============================================================================
-- HELPER FUNCTIONS (for backend routes to use)
-- ============================================================================

-- Function to update Thompson Sampling parameters after execution
DEFINE FUNCTION fn::update_thompson_sampling($table: string, $id: string, $success: bool) {
    LET $record = SELECT * FROM type::table($table) WHERE id = $id;

    IF $success {
        UPDATE type::table($table) SET
            execution_count = execution_count + 1,
            success_count = success_count + 1,
            success_rate = success_count / execution_count,
            thompson_alpha = thompson_alpha + 1,
            updated_at = time::now()
        WHERE id = $id;
    } ELSE {
        UPDATE type::table($table) SET
            execution_count = execution_count + 1,
            success_rate = success_count / execution_count,
            thompson_beta = thompson_beta + 1,
            updated_at = time::now()
        WHERE id = $id;
    };
};

-- ============================================================================
-- MIGRATION VALIDATION
-- ============================================================================

-- Verify tables created
SELECT * FROM information_schema.tables WHERE table_name IN [
    'goal_paths',
    'activity_prerequisites',
    'prerequisite_patterns',
    'execution_step_patterns'
];

-- Insert test data to verify schema
BEGIN TRANSACTION;

-- Test goal path
INSERT INTO goal_paths {
    id: "test_goal_path_1",
    goal_pattern: "fix failing tests",
    initial_state: {test_framework: "jest", failing_count: 3},
    initial_impulses: ["file:package.json"],
    activity_sequence: [
        {activity_id: "analyze-test-failures", execution_id: "exec_001", order: 1, success: true},
        {activity_id: "fix-integration-test", execution_id: "exec_002", order: 2, success: true}
    ],
    success: true,
    total_duration_ms: 45000,
    total_cost: 0.15,
    goal_achieved: true
};

-- Test activity prerequisites
INSERT INTO activity_prerequisites {
    id: "prereq_fix_integration_test",
    template_id: "fix-integration-test",
    variant_id: "v1",
    required_impulses: [
        {type: "test_failure_details", optional: false, description: "Details of failed test"}
    ],
    produces_impulses: [
        {type: "fix_applied", reliability: 0.9, description: "Code fix applied"}
    ]
};

-- Test prerequisite pattern
INSERT INTO prerequisite_patterns {
    id: "pattern_test_failure_details",
    required_impulse_type: "test_failure_details",
    satisfying_activity_id: "analyze-test-failures",
    execution_count: 1,
    success_count: 1,
    success_rate: 1.0
};

-- Test step pattern
INSERT INTO execution_step_patterns {
    id: "pattern_fix_test_v1",
    source_execution_id: "exec_002",
    template_id: "fix-integration-test",
    steps: [
        {
            id: "read_test_file",
            description: "Read failed test file",
            requires_impulses: ["test_failure_details"],
            produces_impulses: ["test_code"]
        },
        {
            id: "identify_cause",
            description: "Identify failure root cause",
            requires_impulses: ["test_code", "test_failure_details"],
            produces_impulses: ["root_cause"]
        }
    ],
    goal_context: "fix failing integration test",
    success_indicators: ["tests_passed", "no_syntax_errors"]
};

COMMIT TRANSACTION;

-- Query test data
SELECT * FROM goal_paths WHERE id = "test_goal_path_1";
SELECT * FROM activity_prerequisites WHERE id = "prereq_fix_integration_test";
SELECT * FROM prerequisite_patterns WHERE id = "pattern_test_failure_details";
SELECT * FROM execution_step_patterns WHERE id = "pattern_fix_test_v1";

-- Clean up test data
DELETE FROM goal_paths WHERE id = "test_goal_path_1";
DELETE FROM activity_prerequisites WHERE id = "prereq_fix_integration_test";
DELETE FROM prerequisite_patterns WHERE id = "pattern_test_failure_details";
DELETE FROM execution_step_patterns WHERE id = "pattern_fix_test_v1";

RETURN "Migration 007 completed successfully: Control Flow and Data Flow learning systems initialized";
