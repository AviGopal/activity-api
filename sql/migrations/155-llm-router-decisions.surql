-- Migration 155: llm_router_decisions — per-(task_type × llm-vessel) Thompson cell.
--
-- The goal-host LLM router selects WHICH llm-resolver vessel (== which model)
-- serves each internal reasoning call, per TASK TYPE (goal_target_inference,
-- reach_verification, action_shape_selection, …). This table is the learning
-- state it selects over: one row per (task_type, vessel_id) holding a Beta(α,β)
-- posterior plus cumulative cost/latency. The router samples α/β at selection
-- time and, at dispatch end, credits the reached verdict back here (α+1 reached,
-- β+1 hollow); it accumulates sums (not averages) so concurrent += UPSERTs never
-- read-modify-write a mean.
--
-- Style mirrors 152-substrate-tuning-param / 151-activity-proposed-default:
-- SCHEMAFULL, PERMISSIONS FULL (substrate learning state, root-written, not
-- multi-tenant user data). An EMPTY table is behavior-preserving — with no rows,
-- every arm reads as the uniform Beta(1,1) prior and the router falls back to a
-- uniform pick (or the LLM_VESSEL_ENDPOINT default when activity-api is down).
--
-- Idempotent: OVERWRITE on table + fields, safe to re-run on every pod restart.

DEFINE TABLE OVERWRITE llm_router_decisions SCHEMAFULL PERMISSIONS FULL;

DEFINE FIELD OVERWRITE task_type      ON llm_router_decisions TYPE string;
DEFINE FIELD OVERWRITE vessel_id      ON llm_router_decisions TYPE string;
DEFINE FIELD OVERWRITE alpha          ON llm_router_decisions TYPE float DEFAULT 1.0;
DEFINE FIELD OVERWRITE beta           ON llm_router_decisions TYPE float DEFAULT 1.0;
DEFINE FIELD OVERWRITE sample_count   ON llm_router_decisions TYPE int   DEFAULT 0;
DEFINE FIELD OVERWRITE sum_latency_ms ON llm_router_decisions TYPE float DEFAULT 0.0;
DEFINE FIELD OVERWRITE sum_cost_usd   ON llm_router_decisions TYPE float DEFAULT 0.0;
DEFINE FIELD OVERWRITE updated_at     ON llm_router_decisions TYPE option<datetime> DEFAULT time::now();

-- (task_type, vessel_id) is the natural key for the per-arm lookup/UPSERT.
DEFINE INDEX OVERWRITE idx_llm_router_decisions_key ON llm_router_decisions FIELDS task_type, vessel_id UNIQUE;
