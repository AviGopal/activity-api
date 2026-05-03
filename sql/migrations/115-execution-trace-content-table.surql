-- Migration 115: execution_trace_content table
-- Content-only split of activity_execution_traces: tasks, state_snapshot, execution_trace,
-- impulse_resolutions, output_impulses. Joined on execution_id UNIQUE index.
-- Read paths consult this table first; on miss (legacy rows) fall back to AET inline fields.
-- Phase D (migration 118, gated) will drop the duplicate inline fields from AET/execution
-- after the legacy fallback hit-rate reaches zero.
-- Reversible: REMOVE TABLE execution_trace_content

USE NS `activity-system` DB `learning_loop`;

DEFINE TABLE IF NOT EXISTS execution_trace_content SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
      AND (project_id IS NONE OR project_id IN $auth.project_ids)
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id
      AND ($auth.role = 'admin' OR created_by = $auth.id)
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD execution_id        ON execution_trace_content TYPE string ASSERT $value != NONE;
DEFINE FIELD tasks               ON execution_trace_content TYPE option<array<object>> FLEXIBLE;
DEFINE FIELD tasks.*             ON execution_trace_content TYPE object FLEXIBLE;
DEFINE FIELD state_snapshot      ON execution_trace_content TYPE option<object> FLEXIBLE;
DEFINE FIELD execution_trace     ON execution_trace_content TYPE option<object> FLEXIBLE;
DEFINE FIELD impulse_resolutions ON execution_trace_content TYPE option<array<object>> FLEXIBLE;
DEFINE FIELD impulse_resolutions.* ON execution_trace_content TYPE object FLEXIBLE;
DEFINE FIELD output_impulses     ON execution_trace_content TYPE option<array<object>> FLEXIBLE;
DEFINE FIELD output_impulses.*   ON execution_trace_content TYPE object FLEXIBLE;
DEFINE FIELD org_id              ON execution_trace_content TYPE string
  ASSERT $value != NONE VALUE $value OR <string>$auth.org_id;
DEFINE FIELD project_id          ON execution_trace_content TYPE option<record<projects>>
  VALUE $value OR $auth.project_id;
DEFINE FIELD created_at          ON execution_trace_content TYPE datetime VALUE $value OR time::now();

DEFINE INDEX idx_etc_execution_id ON execution_trace_content FIELDS execution_id UNIQUE;
