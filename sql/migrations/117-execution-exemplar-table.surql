-- Migration 117: execution_exemplar table
-- Adaptive per-activity exemplar selections produced by the exemplar-selector service.
-- The selector balances n_success and n_failure based on activity_template.ev (COMPUTED field
-- deployed by surrealdb-rl-layer migration 103). Higher ev → more failure exemplars captured.
-- The table is cleared and repopulated per activity on each selection cycle (nightly + burst).
-- execution_id UNIQUE prevents duplicate selection within a cycle.
-- digest_id points to the corresponding trace_digest row for fast slim-field recall.
-- Recall API: GET /v2/activities/exemplars?activity_id=<id> reads here, falls back to trace_digest.
-- Reversible: REMOVE TABLE execution_exemplar

USE NS `activity-system` DB `learning_loop`;

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
