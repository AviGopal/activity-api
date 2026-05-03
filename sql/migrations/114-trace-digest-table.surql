-- Migration 114: trace_digest table
-- Slim per-execution summary for fast exemplar recall and binding-layer recommendation.
-- Rows are co-written with activity_execution_traces by storeExecutionTrace (Phase B dual-write).
-- output_impulse_shapes kept inline (small, <10 strings) to avoid join on hot recall path.
-- impulse_resolutions and full task payloads live in execution_trace_content (migration 115).
-- Reversible: REMOVE TABLE trace_digest

USE NS `activity-system` DB `learning_loop`;

DEFINE TABLE IF NOT EXISTS trace_digest SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id AND $auth.role = 'admin'
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD execution_id          ON trace_digest TYPE string ASSERT $value != NONE;
DEFINE FIELD activity_id           ON trace_digest TYPE string ASSERT $value != NONE;
DEFINE FIELD success               ON trace_digest TYPE bool   ASSERT $value != NONE;
DEFINE FIELD duration_ms           ON trace_digest TYPE int    VALUE $value OR 0;
DEFINE FIELD cost_usd              ON trace_digest TYPE float  VALUE $value OR 0.0;
DEFINE FIELD failure_mode_type     ON trace_digest TYPE option<string>
  COMMENT "verifier_negative | budget_exhausted | safety_breach | cascading | user_abort";
DEFINE FIELD output_impulse_shapes ON trace_digest TYPE option<array<string>>;
DEFINE FIELD task_summaries        ON trace_digest TYPE option<array<object>> FLEXIBLE
  COMMENT "Per-task micro-tuple: {id, status, duration_ms, resolver_tier}";
DEFINE FIELD task_summaries.*      ON trace_digest TYPE object FLEXIBLE;
DEFINE FIELD org_id                ON trace_digest TYPE string
  ASSERT $value != NONE VALUE $value OR <string>$auth.org_id;
DEFINE FIELD project_id            ON trace_digest TYPE option<record<projects>>
  VALUE $value OR $auth.project_id;
DEFINE FIELD executed_at           ON trace_digest TYPE datetime VALUE $value OR time::now();

DEFINE INDEX idx_trace_digest_execution_id
  ON trace_digest FIELDS execution_id UNIQUE;
DEFINE INDEX idx_trace_digest_activity_success_time
  ON trace_digest FIELDS activity_id, success, executed_at;
DEFINE INDEX idx_trace_digest_org_activity_time
  ON trace_digest FIELDS org_id, activity_id, executed_at;
