-- Migration 158: extend v_paradigm_execution_traces with the full lossless AET
-- column set so the remaining activity_execution_traces readers can be repointed
-- to the compat view (part of the AET -> canonical `execution` migration).
--
-- WHY a migration and not just the schema-file edit: `DEFINE TABLE IF NOT EXISTS`
-- is a no-op on an already-defined view, so a live DB never picks up the new
-- projection from 022-*.surql alone. REMOVE + DEFINE is the forcing mechanism.
-- The view is momentarily absent between REMOVE and DEFINE — apply in a brief
-- maintenance window. Defining the view materializes it over `execution`, so the
-- DEFINE can take a while on a large store; that is expected.
--
-- Keep this DEFINE body BYTE-IDENTICAL to the view block in
-- sql/schemas/022-paradigm-compat-views.surql and 022-paradigm-compat-views-v3.surql.
USE NS `activity-system` DB `learning_loop`;

REMOVE TABLE IF EXISTS v_paradigm_execution_traces;

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
    trace AS execution_trace,
    trace.tasks AS tasks,
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
