-- Migration 152: substrate_tuning_param — a runtime-consumable learning-policy table.
--
-- Consumption seam 3a: the Thompson learner's hyperparameters (TD_LAMBDA and the
-- graded-yield references YIELD_FLOOR / YIELD_COST_REF / YIELD_PROD_REF) were frozen
-- at process start from env vars / hardcoded literals. This table lets the substrate
-- CONSUME those tunables as data: a row per named parameter that getTuningParam()
-- (src/lib/tuning-params.ts) reads with a short TTL cache, falling back to the env
-- value, then to the in-code default. An EMPTY table is therefore fully
-- behavior-preserving — every read resolves to exactly today's env/default value.
--
-- Schema mirrors the lightweight single-purpose style of 151-activity-proposed-default
-- and 150-db-admin-audit: SCHEMAFULL with explicit field types, FULL permissions
-- (root-written; this is operator/substrate tuning state, not multi-tenant user data).
--
-- Idempotent: OVERWRITE on table + fields, safe to re-run on every pod restart.

DEFINE TABLE OVERWRITE substrate_tuning_param SCHEMAFULL PERMISSIONS FULL;

DEFINE FIELD OVERWRITE name       ON substrate_tuning_param TYPE string;
DEFINE FIELD OVERWRITE value      ON substrate_tuning_param TYPE float;
DEFINE FIELD OVERWRITE updated_at ON substrate_tuning_param TYPE option<datetime> DEFAULT time::now();
DEFINE FIELD OVERWRITE updated_by ON substrate_tuning_param TYPE option<string>;
DEFINE FIELD OVERWRITE evidence   ON substrate_tuning_param TYPE option<string>;

-- One row per parameter name; name is the natural key for the getTuningParam lookup.
DEFINE INDEX OVERWRITE idx_substrate_tuning_param_name ON substrate_tuning_param FIELDS name UNIQUE;
