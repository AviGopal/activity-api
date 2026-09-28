-- Restore v_paradigm_execution_traces, defined by 167 (and indexed by 172) but found ABSENT from the
-- database on 2026-09-28 while init_migrations still lists 167 as applied. /v2/activities/execution-traces
-- reads this view, so every trace-listing detector (trace_failure_pattern_report among them) has examined
-- zero traces since ~2026-09-22 07:01, the last gap the failure-pattern reporter filed. Same definition as 167
-- except tokens_total: 167 added tokens_in + tokens_out, which fails the whole DEFINE with "Cannot perform
-- addition with NONE and NONE" once any execution row lacks those fields, so a re-define could not succeed.


REMOVE TABLE IF EXISTS v_paradigm_execution_traces;

DEFINE TABLE v_paradigm_execution_traces TYPE ANY SCHEMALESS AS
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
    (tokens_in ?? 0) + (tokens_out ?? 0) AS tokens_total,
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
    (component_changes ?? trace.state_transition.`after`) AS component_changes,
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

DEFINE INDEX idx_vpet_execution_id ON v_paradigm_execution_traces FIELDS execution_id;
DEFINE INDEX idx_vpet_org_time ON v_paradigm_execution_traces FIELDS org_id, executed_at;
DEFINE INDEX idx_vpet_variant_exec ON v_paradigm_execution_traces FIELDS variant_id, executed_at;
DEFINE INDEX idx_vpet_variant_time ON v_paradigm_execution_traces FIELDS variant_id, created_at;

DEFINE INDEX IF NOT EXISTS idx_vpet_executed_at ON v_paradigm_execution_traces FIELDS executed_at;
