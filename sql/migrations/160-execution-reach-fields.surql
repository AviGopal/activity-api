-- Migration 160: add the post-insert patch fields to `execution` so it is a
-- lossless canonical store ahead of the write-flip. The reach gate, deliberation
-- append, and composition-chain backfill run AFTER trace insert and previously
-- patched only activity_execution_traces; once `execution` is authoritative and
-- readers read the execution-backed view, these must land on `execution` too.
--
-- `reached` is the honest completion verdict (the load-bearing learning signal) —
-- execution cannot be canonical without it.
USE NS `activity-system` DB `learning_loop`;

DEFINE FIELD IF NOT EXISTS reached ON execution TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS completion_shapes ON execution TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS impulse_resolutions ON execution TYPE option<array<object>> FLEXIBLE;
