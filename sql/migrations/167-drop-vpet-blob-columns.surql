-- 167-drop-vpet-blob-columns.surql
-- ============================================================================
-- Drop the two blob columns from the v_paradigm_execution_traces compat view.
--
-- WHY (duplication/write-amplification): the materialised view over `execution`
--   copied the full trace blob (`trace AS execution_trace`) plus a redundant
--   tasks copy (`trace.tasks AS tasks`) on every one of its ~110k rows,
--   re-materialised on every execution write — a large per-row duplication of
--   the base execution.trace blob.
--
-- WHY SAFE: all 7 blob-reading consumers now hydrate trace/tasks directly from
--   the canonical `execution` row by record id (activity-api commit 2f61532,
--   across impulses.ts / ribosome.ts / execution-traces.ts /
--   execution-trace-with-signatures.ts). Verified live pre-migration: S6 GET
--   returns execution_trace hydrated; S4 ribosome hydration returns the
--   identical trace.tasks the view aliased (byte-identical source, so extraction
--   output is unchanged). No consumer reads the two columns from the view.
--
-- WHY REMOVE + DEFINE: DEFINE TABLE ... AS SELECT is a no-op on an already
--   defined view, so REMOVE + DEFINE is the forcing mechanism. REMOVE drops the
--   view's indexes, so all four are re-defined below. The body is the live
--   definition (INFO FOR DB, 43 fields) MINUS the two blob projections — every
--   remaining scalar column is byte-identical and in the same order (verified
--   field-by-field). Apply when nothing is mid-flight: the view is briefly
--   absent between REMOVE and DEFINE and the DEFINE re-materialises over the
--   whole execution table.
--
-- REVERSIBILITY: no data loss (the view holds no state; it recomputes from
--   `execution`). To restore migration 158's shape, re-insert the two lines
--   `trace AS execution_trace,` and `trace.tasks AS tasks,` immediately after
--   `output_impulse_shapes,` and re-run the four DEFINE INDEX statements.
-- ============================================================================

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
