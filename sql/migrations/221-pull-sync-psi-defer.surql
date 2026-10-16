-- Migration 221: pull_sync.testgate_psi_defer_pct — the host-contention admission threshold for pull-sync's test gate.
--
-- The nodes of one substrate can share a host; each node's pull-sync gates its candidates on its own timer, so one
-- push ran three whole suites at once on one host (load 35.8), a protected positive control passed its per-test timeout
-- and a node refused to converge a correct commit. pull-sync (scripts/substrate/substrate-pull-sync.sh host_contended)
-- now defers a suite or protected-alone run while the host's CPU pressure (/proc/pressure/cpu, the worse of avg10 and
-- avg60) is at or above this percentage, through its existing deferral/starvation path. With NO row the admission is
-- off, so this seed is what turns it on. 30 is the rhythm conductor's middle cpu bucket (rhythmPacing psi thresholds
-- 15/30/50). Read at use time through GET /v2/tuning-params/<name>; author or clear it through POST /v2/tuning-params.
-- Seed ONLY if the row is absent: never overwrite an authored value. CHEAP ON BOOT: at most one row created.

IF array::len((SELECT id FROM substrate_tuning_param WHERE name = 'pull_sync.testgate_psi_defer_pct')) = 0 {
  CREATE substrate_tuning_param SET
    name = 'pull_sync.testgate_psi_defer_pct',
    `value` = 30,
    updated_at = time::now(),
    updated_by = 'migration-221',
    evidence = 'one push ran 3 co-located whole suites at once (host load 35.8); 11 of 13 suite kills in 50 h overlapped another node gate';
};
