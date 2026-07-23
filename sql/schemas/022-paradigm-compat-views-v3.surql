-- ============================================================================
-- Paradigm Backward-Compatibility Views - SurrealDB 3.0 Compatible
-- ============================================================================
-- Views that map the new unified schema to old API expectations.
-- These allow existing queries to work unchanged during migration.
--
-- SurrealDB 3.0 Compatibility Notes:
-- - Uses IF condition { value } ELSE { value } block syntax instead of IF/THEN/ELSE/END
-- ============================================================================

-- ============================================================================
-- View: v_paradigm_activity_template
-- ============================================================================
-- Maps: activity -> old activity_template/activity_registry format
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_paradigm_activity_template AS
  SELECT
    id,
    id AS variant_id,
    id AS activity_id,
    name,
    name AS variant_name,
    description,
    category,
    execution_type AS execution_format,
    tasks AS task_steps,
    input_shapes AS typical_inputs,
    output_shapes AS typical_outputs,
    input_shapes,
    output_shapes,
    scope,
    public,
    org_id,
    project_id,
    variant_of AS genealogy,
    created_by,
    created_at,
    updated_at
  FROM activity
  WHERE execution_type = 'template';

-- ============================================================================
-- View: v_paradigm_execution_traces
-- ============================================================================
-- Maps: execution -> old activity_execution_traces format
-- SurrealDB 3.0: Uses block syntax for conditionals
-- ============================================================================

-- LOSSLESS UNION (migration 158): projects every AET column from `execution`.
-- variant_id/status/component_changes fall back to the legacy surrogate for
-- pre-157 rows (real column NONE) so both old and new rows read losslessly.
--
-- NARROW (migration 167): the two trace-blob projections (`trace AS
-- execution_trace`, `trace.tasks AS tasks`) were dropped from the live view on
-- 2026-07-22 to stop the full-view scan balloon (SurrealDB 2.3.3 loads the FULL
-- row even for a narrow projection, so a fat view makes every Iterate-Table
-- read materialise the trace blob → single-query spikes to tens of GB). This
-- SEED must match that intent so any fresh deploy or runtime view re-creation
-- produces the NARROW view, not the pre-167 fat one — otherwise 167 (marked
-- applied) never re-runs and the blob columns silently resurrect. The 5
-- idx_vpet_* indexes below (migrations 162/167/172) are re-declared here with
-- CONCURRENTLY + IF NOT EXISTS so re-creation restores index parity without a
-- blocking build. Keep BYTE-IDENTICAL to 022-paradigm-compat-views.surql.
DEFINE TABLE IF NOT EXISTS v_paradigm_execution_traces AS
  SELECT
    meta::id(id) AS execution_id,
    activity_id,
    (variant_id ?? activity_id) AS variant_id,
    activity_id AS template_id,
    success,
    (status ?? (IF success = true { 'success' } ELSE { 'failure' })) AS status,
    duration_ms,
    cost_usd,
    tokens_in AS tokens_input,
    tokens_out AS tokens_output,
    tokens_in + tokens_out AS tokens_total,
    signature,
    signature_version,
    repair_signature,
    failure_mode,
    correlation_id,
    error.message AS error_message,
    error.type AS error_type,
    error.task_id AS failed_task_id,
    input_impulses AS impulses_used,
    output_impulses AS impulses_created,
    input_impulse_shapes,
    output_impulse_shapes,
    (component_changes ?? trace.state_transition.after) AS component_changes,
    improvisation,
    metadata,
    tags,
    account_id,
    parent_execution_id,
    composition_chain,
    org_id,
    project_id,
    vessel_id,
    vessel_version,
    origin_substrate_id,
    origin_instance,
    version,
    executed_at,
    created_at,
    created_at AS stored_at,
    created_at AS updated_at
  FROM execution;

-- Read-path indexes on the narrow view (migrations 162/167/172). CONCURRENTLY so
-- a re-creation build over a populated view is non-blocking; IF NOT EXISTS so a
-- normal restart is a no-op. idx_vpet_executed_at is the one that flips the
-- unscoped `ORDER BY executed_at DESC LIMIT` hot list from Iterate Table (full
-- scan) to Iterate Index ReverseOrder (top-N).
DEFINE INDEX IF NOT EXISTS idx_vpet_execution_id ON v_paradigm_execution_traces FIELDS execution_id CONCURRENTLY;
DEFINE INDEX IF NOT EXISTS idx_vpet_org_time ON v_paradigm_execution_traces FIELDS org_id, executed_at CONCURRENTLY;
DEFINE INDEX IF NOT EXISTS idx_vpet_variant_exec ON v_paradigm_execution_traces FIELDS variant_id, executed_at CONCURRENTLY;
DEFINE INDEX IF NOT EXISTS idx_vpet_variant_time ON v_paradigm_execution_traces FIELDS variant_id, created_at CONCURRENTLY;
DEFINE INDEX IF NOT EXISTS idx_vpet_executed_at ON v_paradigm_execution_traces FIELDS executed_at CONCURRENTLY;

-- ============================================================================
-- View: v_paradigm_impulse_data
-- ============================================================================
-- Maps: impulse -> old impulse_data format
-- ============================================================================

-- RETIRED (churn: recomputes on every impulse write; 0 runtime FROM-readers). Was DEFINE TABLE v_paradigm_impulse_data AS SELECT ... — converted to REMOVE so the db-maintenance reconcile retires it durably.
REMOVE TABLE IF EXISTS v_paradigm_impulse_data;

-- ============================================================================
-- View: v_paradigm_minibob_instance
-- ============================================================================
-- Maps: vessel -> old minibob_instance format
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_paradigm_minibob_instance AS
  SELECT
    id,
    id AS instance_id,
    name,
    resolves,
    api_key_hash,
    is_active,
    org_id,
    project_id,
    created_at,
    last_active_at,
    expires_at
  FROM vessel;

-- ============================================================================
-- View: v_paradigm_performance_metrics
-- ============================================================================
-- Maps: v_activity_score -> old variant_performance_metrics format
-- SurrealDB 3.0: Uses block syntax for conditionals
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_paradigm_performance_metrics AS
  SELECT
    activity_id,
    activity_id AS variant_id,
    org_id,
    total_executions,
    successes AS successful_executions,
    failures AS failed_executions,
    alpha AS thompson_alpha,
    beta AS thompson_beta,
    IF total_executions > 0 { <float> successes / <float> total_executions } ELSE { NONE } AS success_rate,
    avg_duration_ms,
    avg_cost_usd,
    0 AS total_selections,
    last_executed_at,
    first_executed_at AS created_at,
    last_executed_at AS updated_at
  FROM v_activity_score;

-- ============================================================================
-- View: v_paradigm_goal_paths
-- ============================================================================
-- Maps: activity (compositions) -> old goal_execution_paths format
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_paradigm_goal_paths AS
  SELECT
    id,
    id AS path_id,
    name AS goal_pattern,
    child_activities AS activity_sequence,
    input_shapes AS initial_impulses,
    output_shapes,
    org_id,
    project_id,
    public,
    created_at,
    updated_at
  FROM activity
  WHERE execution_type = 'composition'
    AND 'goal' INSIDE input_shapes;
