-- Migration 218: posterior_compensation_ledger — the idempotency ledger of the β-leak replay.
--
-- One row per compensated (frozen-list) pair, record id = ledger_key, written in the SAME transaction as
-- the variant_performance_metrics write it accounts for (src/lib/posterior-aggregator.ts,
-- COMPENSATION_TXN_SQL). A key already present means the pair was decided: the replay never applies it
-- twice. Statuses: written (β reduced by `applied`), floored (would cross the Beta prior; no write),
-- reset_since_leak (row at its exit counts; no write), dropped_no_row (no row; no write). The row
-- `posterior_compensation_ledger:complete` (ledger_key 'complete') marks the replay INERT: once present the
-- posteriorCompensation resolver refuses every call (src/lib/posterior-compensation.ts).
--
-- before/after are the row's (alpha, beta) around that transaction (after = its own RETURN AFTER).
-- SCHEMAFULL drops undeclared nested keys, so their sub-fields are declared. Numbers are `number`, not
-- `float`: the client encodes an integral value (applied 0, nominal 1) as an int, and a strict field type
-- would cancel the whole transaction. Absent values are omitted (NONE), never NULL.
-- CHEAP ON BOOT: empty table, fields, one UNIQUE index. IF NOT EXISTS: idempotent on every start.

DEFINE TABLE IF NOT EXISTS posterior_compensation_ledger SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS ledger_key     ON posterior_compensation_ledger TYPE string;
DEFINE FIELD IF NOT EXISTS variant_id     ON posterior_compensation_ledger TYPE option<string>;
DEFINE FIELD IF NOT EXISTS org_id         ON posterior_compensation_ledger TYPE option<string>;
DEFINE FIELD IF NOT EXISTS exec_id        ON posterior_compensation_ledger TYPE option<string>;
DEFINE FIELD IF NOT EXISTS list_sha       ON posterior_compensation_ledger TYPE option<string>;
DEFINE FIELD IF NOT EXISTS leak_at        ON posterior_compensation_ledger TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS nominal        ON posterior_compensation_ledger TYPE option<number>;
DEFINE FIELD IF NOT EXISTS factor         ON posterior_compensation_ledger TYPE option<number>;
DEFINE FIELD IF NOT EXISTS applied        ON posterior_compensation_ledger TYPE option<number>;
DEFINE FIELD IF NOT EXISTS status         ON posterior_compensation_ledger TYPE string;
DEFINE FIELD IF NOT EXISTS before         ON posterior_compensation_ledger TYPE option<object>;
DEFINE FIELD IF NOT EXISTS before.alpha   ON posterior_compensation_ledger TYPE option<number>;
DEFINE FIELD IF NOT EXISTS before.beta    ON posterior_compensation_ledger TYPE option<number>;
DEFINE FIELD IF NOT EXISTS after          ON posterior_compensation_ledger TYPE option<object>;
DEFINE FIELD IF NOT EXISTS after.alpha    ON posterior_compensation_ledger TYPE option<number>;
DEFINE FIELD IF NOT EXISTS after.beta     ON posterior_compensation_ledger TYPE option<number>;
DEFINE FIELD IF NOT EXISTS eligible_total ON posterior_compensation_ledger TYPE option<int>;
DEFINE FIELD IF NOT EXISTS at             ON posterior_compensation_ledger TYPE datetime DEFAULT time::now();
DEFINE INDEX IF NOT EXISTS idx_posterior_compensation_ledger_key ON posterior_compensation_ledger FIELDS ledger_key UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_posterior_compensation_ledger_row ON posterior_compensation_ledger FIELDS variant_id, org_id;
