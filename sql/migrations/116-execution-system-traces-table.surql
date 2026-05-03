-- Migration 116: execution_system_traces table
-- Lightweight landing table for traces from templates on the 'system' learning_track.
-- System-track templates are classified by the learning-track-classifier job (src/jobs/)
-- based on observed signals (avg_task_count, avg_output_shape_count, declared_output_shapes).
-- These traces are excluded from Thompson posterior updates structurally — routing is a
-- property of the template's learning_track field, not a hardcoded id list.
-- Reversible: REMOVE TABLE execution_system_traces

USE NS `activity-system` DB `learning_loop`;

DEFINE TABLE IF NOT EXISTS execution_system_traces SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id AND $auth.role = 'admin'
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD execution_id        ON execution_system_traces TYPE string ASSERT $value != NONE;
DEFINE FIELD activity_id         ON execution_system_traces TYPE string ASSERT $value != NONE;
DEFINE FIELD success             ON execution_system_traces TYPE bool   ASSERT $value != NONE;
DEFINE FIELD duration_ms         ON execution_system_traces TYPE int    VALUE $value OR 0;
DEFINE FIELD cost_usd            ON execution_system_traces TYPE float  VALUE $value OR 0.0;
DEFINE FIELD parent_execution_id ON execution_system_traces TYPE option<string>;
DEFINE FIELD org_id              ON execution_system_traces TYPE string
  ASSERT $value != NONE VALUE $value OR <string>$auth.org_id;
DEFINE FIELD executed_at         ON execution_system_traces TYPE datetime VALUE $value OR time::now();

DEFINE INDEX idx_est_execution_id        ON execution_system_traces FIELDS execution_id UNIQUE;
DEFINE INDEX idx_est_activity_time       ON execution_system_traces FIELDS activity_id, executed_at;
DEFINE INDEX idx_est_parent_execution_id ON execution_system_traces FIELDS parent_execution_id;
