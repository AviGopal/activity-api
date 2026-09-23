-- Rebuild the non-unique expected_output_shapes index: a dangling entry made every CREATE with memoryNote_write fail as a phantom uniqueness violation (2026-09-23).
REMOVE INDEX IF EXISTS idx_goal_paths_expected_shapes ON TABLE goal_execution_paths;
DEFINE INDEX idx_goal_paths_expected_shapes ON goal_execution_paths FIELDS expected_output_shapes;
