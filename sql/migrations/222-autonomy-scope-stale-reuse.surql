-- Migration 222: autonomy_scope.stale_reuse_s — how long development-vessel may reuse its LAST GOOD autonomyScope when the
-- live read fails (CHANGE-31).
--
-- User ruling (~2026-10-16T05:57Z), "Full bounded reuse": a stale scope may admit and refuse for a bounded time. The read
-- (development-vessel src/judge/gap-policy.ts autonomyScope) reuses the last good scope only when the live read failed in
-- transport (no discovery answer, no producer, a silent producer), never for an explicit answer (absent, misconfigured),
-- and a live read that succeeds always wins. The last good scope is held in memory only, so a restart fails closed until
-- a good read. With NO row (or an unreadable one) the bound is 0: fail closed, as before, so this seed is what turns the
-- reuse on. 600 s = ten minutes. Read at use time through GET /v2/tuning-params/<name>; author or clear it through
-- POST /v2/tuning-params. Seed ONLY if the row is absent: never overwrite an authored value. CHEAP ON BOOT: at most one
-- row created.

IF array::len((SELECT id FROM substrate_tuning_param WHERE name = 'autonomy_scope.stale_reuse_s')) = 0 {
  CREATE substrate_tuning_param SET
    name = 'autonomy_scope.stale_reuse_s',
    `value` = 600,
    updated_at = time::now(),
    updated_by = 'migration-222',
    evidence = 'a spoke failed its autonomyScope read in transport (discovery timing out, a silent own producer) and excluded every autonomous candidate and withheld a verified compose at the floor; user ruling of ~2026-10-16T05:57Z: full bounded reuse';
};
