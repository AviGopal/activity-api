-- Schema 060: Trace storage redesign tables
-- Four new tables introduced by openspec/changes/2026-05-03-trace-storage-redesign:
--   trace_digest           — slim per-execution summary for fast exemplar recall
--   execution_trace_content — content split (tasks, state_snapshot, impulse_resolutions, etc.)
--   execution_system_traces — landing table for system-track template traces
--   execution_exemplar      — adaptive exemplar selections per activity
-- Corresponding migrations: 114, 115, 116, 117
-- The learning_track field on activity_template and activity lives in the existing
-- schema files for those tables; migration 119 adds it.

USE NS `activity-system` DB `learning_loop`;

-- ---------------------------------------------------------------------------
-- trace_digest
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- execution_trace_content
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- execution_system_traces
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- execution_exemplar
-- ---------------------------------------------------------------------------
DEFINE TABLE IF NOT EXISTS execution_exemplar SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create WHERE $auth.org_id != NONE
    FOR update WHERE org_id = $auth.org_id AND $auth.role = 'admin'
    FOR delete WHERE org_id = $auth.org_id AND $auth.role = 'admin';

DEFINE FIELD activity_id  ON execution_exemplar TYPE string ASSERT $value != NONE;
DEFINE FIELD execution_id ON execution_exemplar TYPE string ASSERT $value != NONE;
DEFINE FIELD success      ON execution_exemplar TYPE bool   ASSERT $value != NONE;
DEFINE FIELD digest_id    ON execution_exemplar TYPE string
  COMMENT "trace_digest record id; recall paths read from digest first";
DEFINE FIELD selected_at  ON execution_exemplar TYPE datetime VALUE $value OR time::now();
DEFINE FIELD org_id       ON execution_exemplar TYPE string
  ASSERT $value != NONE VALUE $value OR <string>$auth.org_id;

DEFINE INDEX idx_exemplar_activity_success ON execution_exemplar FIELDS activity_id, success;
DEFINE INDEX idx_exemplar_execution_id     ON execution_exemplar FIELDS execution_id UNIQUE;
