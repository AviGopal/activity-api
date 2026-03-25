-- ============================================================================
-- CI/CD Integration Schema Migration
-- ============================================================================
-- Adds CI/CD result tracking to execution traces
-- Adds CI-specific metrics to variant_performance_metrics

-- Phase: CI/CD Integration
-- Purpose: Track CI/CD pipeline results and correlate with activity execution success
-- Dependencies: 001-init-schema.surql (execution_traces table)

-- ============================================================================
-- Update execution_traces schema to include CI status
-- ============================================================================

-- Note: SurrealDB is schemaless, so we just document the structure here
-- The actual fields are added dynamically when data is inserted

-- New fields added to execution_traces:
-- {
--   execution_id: string
--   template_id: string
--   status: "success" | "failure" | "partial"
--   duration_ms: number
--   cost_usd: number
--   execution_trace: { ... }
--   created_at: datetime
--   updated_at: datetime
--
--   // NEW: CI/CD Status
--   ci_status: {
--     success: bool
--     duration_ms: number
--     provider: "github_actions" | "gitlab_ci" | "jenkins" | "circleci" | "other"
--     workflow_name: string?
--     run_id: string?
--     run_url: string?
--     branch: string
--     commit: string
--     stages: {
--       build: { success: bool, duration_ms: number?, error: string? }?
--       typecheck: { success: bool, duration_ms: number?, error: string? }?
--       test: {
--         success: bool
--         duration_ms: number?
--         tests_passed: number?
--         tests_failed: number?
--         coverage_percent: number?
--         error: string?
--       }?
--       lint: {
--         success: bool
--         duration_ms: number?
--         errors: number?
--         warnings: number?
--         error: string?
--       }?
--     }
--     artifacts: [
--       {
--         name: string
--         type: "docker_image" | "npm_package" | "binary" | "coverage_report" | "test_report" | "other"
--         url: string?
--         size_bytes: number?
--         metadata: object?
--       }
--     ]
--     completed_at: datetime
--     metadata: object?
--   }?
-- }

-- ============================================================================
-- Update variant_performance_metrics schema to include CI metrics
-- ============================================================================

-- New fields added to variant_performance_metrics:
-- {
--   variant_id: string
--   activity_id: string
--   total_executions: number
--   successful_executions: number
--   failed_executions: number
--   success_rate: number
--   avg_duration_ms: number
--   avg_cost_usd: number
--   thompson_alpha: number
--   thompson_beta: number
--   created_at: datetime
--   updated_at: datetime
--
--   // NEW: CI/CD Metrics
--   ci_pass_count: number (default: 0)
--   ci_fail_count: number (default: 0)
--   ci_success_rate: number (default: 0.0)
-- }

-- ============================================================================
-- Index for efficient CI result queries
-- ============================================================================

-- Index on ci_status.success for filtering by CI pass/fail
DEFINE INDEX ci_status_success_idx ON TABLE execution_traces COLUMNS ci_status.success;

-- Index on ci_status.branch for filtering by branch
DEFINE INDEX ci_status_branch_idx ON TABLE execution_traces COLUMNS ci_status.branch;

-- Index on ci_status.completed_at for chronological ordering
DEFINE INDEX ci_status_completed_idx ON TABLE execution_traces COLUMNS ci_status.completed_at;

-- Composite index for common queries (template + CI success)
DEFINE INDEX template_ci_success_idx ON TABLE execution_traces COLUMNS template_id, ci_status.success;

-- ============================================================================
-- Sample data for testing (optional, can be removed in production)
-- ============================================================================

-- Example: Add CI status to an existing execution trace
-- UPDATE execution_traces:example
-- SET ci_status = {
--   success: true,
--   duration_ms: 125000,
--   provider: "github_actions",
--   workflow_name: "CI with Webhook Integration",
--   run_id: "12345678",
--   run_url: "https://github.com/org/repo/actions/runs/12345678",
--   branch: "feature/new-endpoint",
--   commit: "abc123def456",
--   stages: {
--     build: { success: true, duration_ms: 15000 },
--     typecheck: { success: true, duration_ms: 8000 },
--     test: { success: true, duration_ms: 45000, tests_passed: 42, tests_failed: 0, coverage_percent: 87.5 },
--     lint: { success: true, duration_ms: 3000, errors: 0, warnings: 2 }
--   },
--   artifacts: [
--     {
--       name: "docker-image-abc123",
--       type: "docker_image",
--       url: "https://github.com/org/repo/actions/runs/12345678",
--       size_bytes: 45678900,
--       metadata: { image_tag: "metabob-activity-api:abc123" }
--     }
--   ],
--   completed_at: time::now(),
--   metadata: { repository: "org/repo", actor: "bot" }
-- };

-- ============================================================================
-- Migration Notes
-- ============================================================================

-- 1. This migration adds CI/CD tracking without requiring schema changes
--    to existing data (SurrealDB is schemaless)
--
-- 2. Indexes improve query performance for common CI result queries
--
-- 3. The ci_status field is optional (nullable) - existing traces without
--    CI results will have ci_status = NONE
--
-- 4. CI success/failure affects Thompson Sampling parameters:
--    - CI success: thompson_alpha += 0.5 (small boost to success probability)
--    - CI failure: thompson_beta += 0.5 (small penalty)
--
-- 5. The webhook endpoint (/v2/activities/ci-result) populates these fields
--    automatically when called by CI/CD pipelines
--
-- 6. Deployment tasks are auto-enqueued to boredom queue on CI success

-- ============================================================================
-- End of migration
-- ============================================================================
