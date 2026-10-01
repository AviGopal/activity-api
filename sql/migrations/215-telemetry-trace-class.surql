-- Migration 215: TRACE_RETENTION_TELEMETRY_ACTIVITIES — the telemetry trace class, as data.
--
-- The trace store is for gradable executions; some emitters write telemetry into it. On the hub,
-- activity_id 'auth_resolve_v1' (identity-vessel credential resolves, tagged `telemetry:auth`, no
-- activity record — "not a selectable activity") is ~68% of `execution` (1.44M of ~2.11M rows) and
-- 93% of the last day's executions. Trace retention drains the activity ids named in this tuning
-- row FIRST, before its age-ordered path (src/services/trace-retention.ts drainTelemetryClass), and
-- the reach-graded shape counter never counts them (src/lib/posterior-update.ts). Read at use time
-- through getTuningParamList; author or clear it through POST /v2/tuning-params, no code edit.
--
-- (1) `value` must accept a string list. The statement is byte-identical to the one in the in-flight
--     migration 203-tuning-param-string-values, so the END STATE IS ORDER-INDEPENDENT: verified on
--     SurrealDB 2.3.3 for 203→215→215, 215→203→203 and 215 alone (field `float | string`, numeric rows
--     intact, string rows writable, seed present once). It cannot be made conditional in SurrealQL:
--     2.3.3 does not allow INFO FOR … inside an expression. Residual risk, shared with 203: a re-run of
--     152 (DEFINE FIELD OVERWRITE value TYPE float) after either narrows the type again; existing string
--     rows still READ, but any write to them then fails (verified). Numeric readers (getTuningParam)
--     and list readers (getTuningParamList) each refuse the other type with a logged line.
-- (2) Seed ONLY if the row is absent: never overwrite an authored value (verified: an operator-authored
--     value survives 215). The declaration is VETTED at use time (src/lib/telemetry-class.ts): an id
--     with reach-graded evidence is refused with a logged line, never drained first. auth_resolve_v1 only:
--     validator-dispatch was checked and is NOT telemetry-class (it has an activity record, global
--     scope, not retired; its executions are goal-host dispatches, ungraded, no VPM row) — it stays
--     with the stratified/age-ordered paths until someone declares otherwise in this row.
-- CHEAP ON BOOT: one field redefinition (no rows rewritten) and at most one row created.

DEFINE FIELD OVERWRITE value ON substrate_tuning_param TYPE float | string;

IF array::len((SELECT id FROM substrate_tuning_param WHERE name = 'TRACE_RETENTION_TELEMETRY_ACTIVITIES')) = 0 {
  CREATE substrate_tuning_param SET
    name = 'TRACE_RETENTION_TELEMETRY_ACTIVITIES',
    `value` = 'auth_resolve_v1',
    updated_at = time::now(),
    updated_by = 'migration-215',
    evidence = 'auth_resolve_v1: 1,438,336 of ~2,114,000 hub execution rows (68%), 93% of the last 24h; telemetry:auth tag; no activity record';
};
