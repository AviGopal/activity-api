-- Migration 140: durable refusal_events table for §27.S.6 push-away measurement.
--
-- Per audit investigation-053 (2026-05-27T10:35Z): the bus emit of
-- intervention.refused (iter 8, commit eee8b67) only gave a hot signal.
-- §27.S.6 requires measurement over "sustained adversarial exposure" —
-- which means refusals must be queryable post-hoc, not just received by
-- live WS subscribers at emission time.
--
-- This table accumulates one row per refusal. Both the bus emit AND the
-- DB write happen on the same refusal event. Subscribers reading the bus
-- get the hot signal; auditors reading this table get the sustained-window
-- aggregate.

DEFINE TABLE OVERWRITE refusal_events SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $token.org_id = NONE OR org_id = $token.org_id OR org_id IS NONE
    FOR create WHERE $auth != NONE OR $token != NONE
    FOR update, delete NONE;

-- Identifying fields
DEFINE FIELD OVERWRITE id ON refusal_events TYPE record<refusal_events>;
DEFINE FIELD OVERWRITE org_id ON refusal_events TYPE option<string>;
DEFINE FIELD OVERWRITE account_id ON refusal_events TYPE option<string>;

-- Refusal payload (cited evidence per F-129 audit framing)
DEFINE FIELD OVERWRITE refusal_type ON refusal_events TYPE string;
DEFINE FIELD OVERWRITE source_vessel_id ON refusal_events TYPE string VALUE $value OR 'metabob-activity-api';
DEFINE FIELD OVERWRITE expected_output_shapes ON refusal_events TYPE array<string>;
DEFINE FIELD OVERWRITE candidates_examined ON refusal_events TYPE int;
DEFINE FIELD OVERWRITE task_description ON refusal_events TYPE option<string>;
DEFINE FIELD OVERWRITE reason ON refusal_events TYPE option<string>;
DEFINE FIELD OVERWRITE suggestion ON refusal_events TYPE option<string>;

-- Temporal
DEFINE FIELD OVERWRITE refused_at ON refusal_events TYPE datetime VALUE $value OR time::now();
DEFINE FIELD OVERWRITE created_at ON refusal_events TYPE datetime VALUE time::now() READONLY;

-- Indexes for the query patterns auditors run:
--   - count refusals over a time window:                    refused_at index
--   - count refusals by type within a window:              (refusal_type, refused_at)
--   - count refusals per org / per shape:                  org_id, expected_output_shapes
DEFINE INDEX OVERWRITE refusal_events_refused_at ON refusal_events FIELDS refused_at;
DEFINE INDEX OVERWRITE refusal_events_type_refused_at ON refusal_events FIELDS refusal_type, refused_at;
DEFINE INDEX OVERWRITE refusal_events_org ON refusal_events FIELDS org_id;
