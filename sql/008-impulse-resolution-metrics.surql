-- Migration 008: Impulse Resolution Metrics
-- Phase 2 of comprehensive impulse state space learning tracking
-- Stores detailed metrics about impulse resolution attempts to enable learning

-- Impulse resolution metrics table
-- Tracks every impulse resolution attempt with timing, cost, and success data
DEFINE TABLE impulse_resolution_metrics SCHEMAFULL
  PERMISSIONS
    FOR select WHERE org_id = $auth.org_id
    FOR create, update WHERE org_id = $auth.org_id;

-- Core identification
DEFINE FIELD impulse_id ON impulse_resolution_metrics TYPE string;
DEFINE FIELD impulse_type ON impulse_resolution_metrics TYPE string;
DEFINE FIELD execution_id ON impulse_resolution_metrics TYPE option<string>;

-- Resolution details
DEFINE FIELD resolver_id ON impulse_resolution_metrics TYPE string;
DEFINE FIELD resolver_tier ON impulse_resolution_metrics TYPE string;
DEFINE FIELD vessel_id ON impulse_resolution_metrics TYPE string;

-- Outcome
DEFINE FIELD success ON impulse_resolution_metrics TYPE bool;
DEFINE FIELD error_reason ON impulse_resolution_metrics TYPE option<string>;

-- Performance
DEFINE FIELD latency_ms ON impulse_resolution_metrics TYPE number;
DEFINE FIELD cost_usd ON impulse_resolution_metrics TYPE number;

-- Discovery-specific
DEFINE FIELD discovery_failure ON impulse_resolution_metrics TYPE option<bool>;
DEFINE FIELD requested_shape ON impulse_resolution_metrics TYPE option<string>;

-- Metadata
DEFINE FIELD timestamp ON impulse_resolution_metrics TYPE datetime DEFAULT time::now();
DEFINE FIELD org_id ON impulse_resolution_metrics TYPE string;

-- Indexes for common queries
DEFINE INDEX idx_resolution_impulse_type ON impulse_resolution_metrics COLUMNS impulse_type;
DEFINE INDEX idx_resolution_resolver ON impulse_resolution_metrics COLUMNS resolver_id, resolver_tier;
DEFINE INDEX idx_resolution_vessel ON impulse_resolution_metrics COLUMNS vessel_id;
DEFINE INDEX idx_resolution_success ON impulse_resolution_metrics COLUMNS success;
DEFINE INDEX idx_resolution_timestamp ON impulse_resolution_metrics COLUMNS timestamp;
DEFINE INDEX idx_resolution_org ON impulse_resolution_metrics COLUMNS org_id;
DEFINE INDEX idx_resolution_execution ON impulse_resolution_metrics COLUMNS execution_id;

-- Composite index for Thompson Sampling queries (impulse_type + resolver)
DEFINE INDEX idx_resolution_type_resolver ON impulse_resolution_metrics COLUMNS impulse_type, resolver_id, success;

-- Composite index for shape discovery failures
-- NO PARTIAL INDEXES IN SURREALDB. `DEFINE INDEX ... WHERE <pred>` is a PostgreSQL partial
-- index; SurrealDB's parser stops at the WHERE:
--     Parse error: Unexpected token `WHERE`, expected Eof
--       --> [51:117]
-- So this statement failed on every run, the migration was never marked applied, and it
-- re-ran on EVERY boot of activity-api (~7 starts/hour on the hub, observed 2026-08-18).
--
-- Dropping the predicate loses nothing: the index already leads with `requested_shape` and
-- includes `discovery_failure`, so a query filtering `discovery_failure = true` uses it. A
-- partial index would only have made it smaller, and SurrealDB has no such feature to fall
-- back to.
DEFINE INDEX idx_resolution_shape_failures ON impulse_resolution_metrics COLUMNS requested_shape, discovery_failure;
