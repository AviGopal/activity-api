-- Migration 201: decision_outcome — persist decision→outcome joins (law 12).
--
-- The Thompson credit path credits an ARM (variant_performance_metrics). It cannot
-- say whether CHOOSING that arm was right, because selections and outcomes were
-- never joined: thompson_selection_log.correlation_id is written at recommendation
-- time but nothing wrote the key back onto the outcome. The ingest fix now lifts
-- the walk's `correlation:<id>` tag onto the execution row, so the join key exists;
-- this table captures the resulting decision→outcome record, keyed on
-- correlation_id, WITHOUT touching posteriors or selection behavior.
--
-- SAFE + ADDITIVE by design: nothing reads this table for credit yet, so it cannot
-- corrupt existing posteriors or the ribosome. An EMPTY table is behavior-preserving.
-- A later, runtime-verifiable step can feed these records into contextual credit;
-- persisting them durably is the precondition and is safe to land now. Written
-- best-effort by lib/decision-credit.ts:recordDecisionOutcome.
--
-- Style mirrors 155-llm-router-decisions: SCHEMAFULL, PERMISSIONS FULL (substrate
-- learning state, root-written, not multi-tenant user data). Idempotent: OVERWRITE
-- on table + fields, safe to re-run on every pod restart.

DEFINE TABLE OVERWRITE decision_outcome SCHEMAFULL PERMISSIONS FULL;

DEFINE FIELD OVERWRITE correlation_id     ON decision_outcome TYPE string;
DEFINE FIELD OVERWRITE activity_id        ON decision_outcome TYPE string;
DEFINE FIELD OVERWRITE predicted_success  ON decision_outcome TYPE option<float>;
DEFINE FIELD OVERWRITE thompson_sample    ON decision_outcome TYPE option<float>;
DEFINE FIELD OVERWRITE outcome_success    ON decision_outcome TYPE bool;
DEFINE FIELD OVERWRITE reached            ON decision_outcome TYPE option<bool>;
-- selected_at/executed_at kept as option<string> (ISO form as read from the
-- source rows) to avoid option<datetime> rejecting a string-typed value — the
-- NULL≠NONE / datetime-coercion trap. This table is observational, not queried
-- by time range, so string form is sufficient.
DEFINE FIELD OVERWRITE selected_at        ON decision_outcome TYPE option<string>;
DEFINE FIELD OVERWRITE executed_at        ON decision_outcome TYPE option<string>;
DEFINE FIELD OVERWRITE created_at         ON decision_outcome TYPE datetime DEFAULT time::now();

-- correlation_id is the natural key: one decision-outcome per Thompson selection.
DEFINE INDEX OVERWRITE idx_decision_outcome_correlation ON decision_outcome FIELDS correlation_id UNIQUE;
DEFINE INDEX OVERWRITE idx_decision_outcome_activity ON decision_outcome FIELDS activity_id;
