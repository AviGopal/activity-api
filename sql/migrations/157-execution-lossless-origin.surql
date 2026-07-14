-- Migration 157: make the canonical `execution` table lossless + add cross-instance origin/version.
--
-- Part of the intra-identity-group trace-sync / eventual-consistency work
-- (operator law: activity-api stores in one identity group must converge).
-- The write path dual-writes to `execution` (paradigm.ts insertExecution) but
-- LOSSILY — it drops the learning fields every AET reader needs, so `execution`
-- cannot yet become the authoritative table. This migration adds those fields to
-- `execution` so the dual-write can be made lossless (paradigm.ts), the necessary
-- prerequisite before any reader is repointed off the deprecated
-- activity_execution_traces table.
--
-- It also adds provenance columns used by the (upcoming) trace-ledger
-- replication so a trace can be attributed to the instance that produced it and
-- reconciled idempotently across peers:
--   origin_substrate_id — which substrate produced this trace
--   origin_instance     — which activity-api instance wrote it first
--   version             — monotonic per-row bump for last-writer-wins on replicate
--
-- All DEFINE FIELD IF NOT EXISTS → re-run safe (init-database.ts applies this on
-- every unit start). Additive only: no reader/writer behavior changes here.

USE NS `activity-system` DB `learning_loop`;

-- Learning fields AET carries that `execution` was dropping (types mirror AET) --
DEFINE FIELD IF NOT EXISTS variant_id ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS status ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS signature ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS signature_version ON execution TYPE option<int>;
DEFINE FIELD IF NOT EXISTS repair_signature ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS failure_mode ON execution TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS correlation_id ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS component_changes ON execution TYPE option<array<string>> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS improvisation ON execution TYPE option<bool>;
DEFINE FIELD IF NOT EXISTS input_impulse_shapes ON execution TYPE option<array<string>> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS output_impulse_shapes ON execution TYPE option<array<string>> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS metadata ON execution TYPE option<object> FLEXIBLE;
DEFINE FIELD IF NOT EXISTS tags ON execution TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS account_id ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS account_id_version ON execution TYPE option<int>;

-- Cross-instance replication provenance --
DEFINE FIELD IF NOT EXISTS origin_substrate_id ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS origin_instance ON execution TYPE option<string>;
DEFINE FIELD IF NOT EXISTS version ON execution TYPE option<int> DEFAULT 0;
