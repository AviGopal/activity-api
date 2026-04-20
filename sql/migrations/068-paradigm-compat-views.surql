-- ============================================================================
-- Migration 068: Apply Paradigm Backward-Compatibility Views
-- ============================================================================
-- Created: 2026-04-20
-- Purpose: Apply paradigm compatibility views from 022-paradigm-compat-views-v3.surql
--          to enable backward-compatible queries during schema migration
-- ============================================================================

-- Remove existing views if they exist
REMOVE TABLE IF EXISTS v_paradigm_execution_traces;
REMOVE TABLE IF EXISTS v_paradigm_activity_template;
REMOVE TABLE IF EXISTS v_paradigm_impulse_data;
REMOVE TABLE IF EXISTS v_paradigm_minibob_instance;
REMOVE TABLE IF EXISTS v_paradigm_performance_metrics;
REMOVE TABLE IF EXISTS v_paradigm_goal_paths;

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

DEFINE TABLE IF NOT EXISTS v_paradigm_execution_traces AS
  SELECT
    id AS execution_id,
    activity_id,
    activity_id AS variant_id,
    activity_id AS template_id,
    success,
    IF success = true { 'success' } ELSE { 'failure' } AS status,
    duration_ms,
    cost_usd,
    tokens_in AS tokens_input,
    tokens_out AS tokens_output,
    tokens_in + tokens_out AS tokens_total,
    error.message AS error_message,
    error.type AS error_type,
    error.task_id AS failed_task_id,
    input_impulses AS impulses_used,
    output_impulses AS impulses_created,
    trace AS execution_trace,
    trace.state_transition.after AS component_changes,
    parent_execution_id,
    org_id,
    project_id,
    vessel_id,
    executed_at,
    created_at,
    created_at AS stored_at,
    created_at AS updated_at
  FROM execution;

-- ============================================================================
-- View: v_paradigm_impulse_data
-- ============================================================================
-- Maps: impulse -> old impulse_data format
-- ============================================================================

DEFINE TABLE IF NOT EXISTS v_paradigm_impulse_data AS
  SELECT
    id AS impulse_id,
    id,
    pointer AS impulse_data,
    pointer.type AS impulse_type,
    pointer,
    content,
    shape,
    summary,
    token_estimate AS budget,
    (content IS NOT NONE) AS loaded,
    org_id,
    project_id,
    vessel_id,
    created_by,
    created_at,
    expires_at
  FROM impulse;

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
