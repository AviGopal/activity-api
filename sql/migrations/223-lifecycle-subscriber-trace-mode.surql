-- Migration 223: lifecycle.subscriber_trace_mode — whether goal-host writes a FULL execution trace for every lifecycle
-- subscriber run (0) or counts normal runs and traces only anomalous ones (1) (CHANGE DB1).
--
-- Measured on node1 (2 h to 2026-10-16T07:54Z): 32.1 lifecycle trace writes per run-goal start. In mode 1,
-- ias-executor-ts counts a normal subscriber run (validator-dispatch, slot-binding, ribosome-extract, audit-test-report,
-- debug-failing-audit) and flushes the counts about once a minute to POST /v2/activities/execution-traces/subscriber-counts,
-- which feeds the subscriber's own posterior and hub edges (src/lib/subscriber-run-counts.ts); a failed run, or one
-- with a task that did not succeed, still writes its full trace. Read at use time through GET /v2/tuning-params/<name>
-- (30 s cache), fail-open to 0. Seeded 0 = today's behaviour: the flip to 1 is ONE recorded act after activity-api,
-- development-vessel and the rebuilt ias-executor-ts dist are all live (it is the intervention the DB1 window
-- measures). Seed ONLY if the row is absent: never overwrite an authored value. CHEAP ON BOOT: at most one row created.

IF array::len((SELECT id FROM substrate_tuning_param WHERE name = 'lifecycle.subscriber_trace_mode')) = 0 {
  CREATE substrate_tuning_param SET
    name = 'lifecycle.subscriber_trace_mode',
    `value` = 0,
    updated_at = time::now(),
    updated_by = 'migration-223',
    evidence = 'node1 2026-10-16: 32.1 lifecycle subscriber trace writes per run-goal start; seeded 0 (full traces, as before); the flip to 1 is a recorded act once activity-api, development-vessel and the ias-executor-ts dist are live';
};
