-- Migration 159: replication_state — per-peer pull watermark for
-- intra-identity-group trace replication (src/jobs/trace-replication-tick.ts).
-- One row per peer vessel: last_pulled_at is the executed_at high-water mark of
-- rows already pulled from that peer. Written via the root path (internal
-- plumbing), so PERMISSIONS are not load-bearing here.
USE NS `activity-system` DB `learning_loop`;

DEFINE TABLE IF NOT EXISTS replication_state SCHEMAFULL PERMISSIONS FULL;
DEFINE FIELD IF NOT EXISTS peer_id ON replication_state TYPE string;
DEFINE FIELD IF NOT EXISTS last_pulled_at ON replication_state TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_at ON replication_state TYPE option<datetime>;
