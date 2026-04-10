-- =============================================================================
-- Circuit Breaker & Health Scoring Schema
--
-- Implements circuit breaker state machine and health scoring for vessel routing.
-- Spec: openspec/changes/vessel-integration-standardization/specs/execution-tracing-integration/spec.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- vessel_circuit_breaker table
--
-- Tracks circuit breaker state per vessel for fault tolerance.
-- State transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
-- -----------------------------------------------------------------------------
DEFINE TABLE vessel_circuit_breaker SCHEMAFULL;

-- Identity
DEFINE FIELD vessel_id ON vessel_circuit_breaker TYPE string;
DEFINE FIELD org_id ON vessel_circuit_breaker TYPE string;

-- Circuit state
DEFINE FIELD state ON vessel_circuit_breaker TYPE string
  ASSERT $value IN ['closed', 'open', 'half_open'];
DEFINE FIELD state_changed_at ON vessel_circuit_breaker TYPE datetime DEFAULT time::now();

-- Failure tracking
DEFINE FIELD consecutive_failures ON vessel_circuit_breaker TYPE int DEFAULT 0;
DEFINE FIELD total_requests ON vessel_circuit_breaker TYPE int DEFAULT 0;
DEFINE FIELD failed_requests ON vessel_circuit_breaker TYPE int DEFAULT 0;
DEFINE FIELD failure_window_start ON vessel_circuit_breaker TYPE datetime DEFAULT time::now();

-- Thresholds (5 consecutive failures OR ≥50% failure rate over 60s)
DEFINE FIELD max_consecutive_failures ON vessel_circuit_breaker TYPE int DEFAULT 5;
DEFINE FIELD failure_rate_threshold ON vessel_circuit_breaker TYPE float DEFAULT 0.5;
DEFINE FIELD failure_window_seconds ON vessel_circuit_breaker TYPE int DEFAULT 60;

-- Recovery settings
DEFINE FIELD cooldown_period_ms ON vessel_circuit_breaker TYPE int DEFAULT 30000;
DEFINE FIELD next_probe_at ON vessel_circuit_breaker TYPE option<datetime>;

-- Last error
DEFINE FIELD last_error_code ON vessel_circuit_breaker TYPE option<string>;
DEFINE FIELD last_error_message ON vessel_circuit_breaker TYPE option<string>;
DEFINE FIELD last_error_at ON vessel_circuit_breaker TYPE option<datetime>;

-- Timestamps
DEFINE FIELD created_at ON vessel_circuit_breaker TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON vessel_circuit_breaker TYPE datetime DEFAULT time::now();

-- -----------------------------------------------------------------------------
-- vessel_health_metrics table
--
-- Stores health metrics for each vessel.
-- Health score = (success_rate × 0.5) + (latency_factor × 0.3) + (availability_factor × 0.2)
-- -----------------------------------------------------------------------------
DEFINE TABLE vessel_health_metrics SCHEMAFULL;

-- Identity
DEFINE FIELD vessel_id ON vessel_health_metrics TYPE string;
DEFINE FIELD org_id ON vessel_health_metrics TYPE string;

-- Success rate (last 100 requests)
DEFINE FIELD success_count ON vessel_health_metrics TYPE int DEFAULT 0;
DEFINE FIELD total_count ON vessel_health_metrics TYPE int DEFAULT 0;
DEFINE FIELD success_rate ON vessel_health_metrics TYPE float DEFAULT 1.0;

-- Latency tracking (exponential moving average)
DEFINE FIELD p95_latency_ms ON vessel_health_metrics TYPE float DEFAULT 0.0;
DEFINE FIELD avg_latency_ms ON vessel_health_metrics TYPE float DEFAULT 0.0;
DEFINE FIELD latency_ema_alpha ON vessel_health_metrics TYPE float DEFAULT 0.2;

-- Availability (heartbeats received / expected in last 10 periods)
DEFINE FIELD heartbeats_received ON vessel_health_metrics TYPE int DEFAULT 0;
DEFINE FIELD heartbeats_expected ON vessel_health_metrics TYPE int DEFAULT 0;
DEFINE FIELD availability ON vessel_health_metrics TYPE float DEFAULT 1.0;
DEFINE FIELD last_heartbeat_at ON vessel_health_metrics TYPE option<datetime>;

-- Computed health score [0.0, 1.0]
DEFINE FIELD health_score ON vessel_health_metrics TYPE float DEFAULT 1.0;
DEFINE FIELD eligible_for_routing ON vessel_health_metrics TYPE bool DEFAULT true;

-- Sliding window for metrics
DEFINE FIELD window_start ON vessel_health_metrics TYPE datetime DEFAULT time::now();
DEFINE FIELD window_size_seconds ON vessel_health_metrics TYPE int DEFAULT 300;

-- Timestamps
DEFINE FIELD created_at ON vessel_health_metrics TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON vessel_health_metrics TYPE datetime DEFAULT time::now();

-- -----------------------------------------------------------------------------
-- routing_trace table
--
-- Records all routing decisions for learning and optimization.
-- Sampled: 100% failures, 10% successes
-- TTL: 30 days
-- -----------------------------------------------------------------------------
DEFINE TABLE routing_trace SCHEMAFULL;

-- Identity
DEFINE FIELD trace_id ON routing_trace TYPE string;
DEFINE FIELD trace_type ON routing_trace TYPE string DEFAULT 'routing';
DEFINE FIELD correlation_id ON routing_trace TYPE option<string>;
DEFINE FIELD activity_execution_id ON routing_trace TYPE option<string>;
DEFINE FIELD org_id ON routing_trace TYPE string;

-- Routing context
DEFINE FIELD impulse_id ON routing_trace TYPE string;
DEFINE FIELD shape ON routing_trace TYPE string;
DEFINE FIELD discovery_query_duration_ms ON routing_trace TYPE float;

-- Candidate vessels
DEFINE FIELD candidates ON routing_trace TYPE array<string> DEFAULT [];
DEFINE FIELD health_scores ON routing_trace TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD circuit_states ON routing_trace TYPE object FLEXIBLE DEFAULT {};
DEFINE FIELD excluded_vessels ON routing_trace TYPE array<object> FLEXIBLE DEFAULT [];

-- Selection
DEFINE FIELD selected_vessel_id ON routing_trace TYPE option<string>;
DEFINE FIELD selection_algorithm ON routing_trace TYPE string DEFAULT 'health_weighted';
DEFINE FIELD selection_probability ON routing_trace TYPE option<float>;
DEFINE FIELD selection_reason ON routing_trace TYPE option<string>;

-- Outcome
DEFINE FIELD outcome ON routing_trace TYPE string
  ASSERT $value IN ['success', 'failure', 'timeout', 'circuit_open', 'fallback', 'no_candidates'];
DEFINE FIELD latency_ms ON routing_trace TYPE option<float>;

-- Fallback handling
DEFINE FIELD direct_attempt_failed ON routing_trace TYPE bool DEFAULT false;
DEFINE FIELD direct_failure_reason ON routing_trace TYPE option<string>;
DEFINE FIELD fallback_tier_used ON routing_trace TYPE option<string>;
DEFINE FIELD fallback_vessel_id ON routing_trace TYPE option<string>;
DEFINE FIELD fallback_success ON routing_trace TYPE option<bool>;

-- Sampling metadata
DEFINE FIELD sampled ON routing_trace TYPE bool DEFAULT false;

-- Timestamps
DEFINE FIELD timestamp ON routing_trace TYPE datetime DEFAULT time::now();
DEFINE FIELD expires_at ON routing_trace TYPE datetime;

-- -----------------------------------------------------------------------------
-- circuit_breaker_trace table
--
-- Records circuit breaker state transitions for debugging and learning.
-- -----------------------------------------------------------------------------
DEFINE TABLE circuit_breaker_trace SCHEMAFULL;

-- Identity
DEFINE FIELD trace_id ON circuit_breaker_trace TYPE string;
DEFINE FIELD trace_type ON circuit_breaker_trace TYPE string DEFAULT 'circuit_breaker';
DEFINE FIELD correlation_id ON circuit_breaker_trace TYPE option<string>;
DEFINE FIELD org_id ON circuit_breaker_trace TYPE string;

-- Circuit details
DEFINE FIELD vessel_id ON circuit_breaker_trace TYPE string;
DEFINE FIELD event ON circuit_breaker_trace TYPE string
  ASSERT $value IN ['opened', 'half_open', 'closed', 'reopened'];
DEFINE FIELD previous_state ON circuit_breaker_trace TYPE string;

-- Trigger details
DEFINE FIELD trigger_type ON circuit_breaker_trace TYPE option<string>
  ASSERT $value IN ['consecutive_failures', 'failure_rate_threshold'] OR $value = NONE;
DEFINE FIELD consecutive_failures ON circuit_breaker_trace TYPE option<int>;
DEFINE FIELD failure_rate ON circuit_breaker_trace TYPE option<float>;
DEFINE FIELD failure_window_ms ON circuit_breaker_trace TYPE option<int>;

-- Health impact
DEFINE FIELD health_score_before ON circuit_breaker_trace TYPE option<float>;
DEFINE FIELD health_score_after ON circuit_breaker_trace TYPE option<float>;

-- Recovery details
DEFINE FIELD cooldown_period_ms ON circuit_breaker_trace TYPE option<int>;
DEFINE FIELD probe_request_succeeded ON circuit_breaker_trace TYPE option<bool>;
DEFINE FIELD probe_request_failed ON circuit_breaker_trace TYPE option<bool>;
DEFINE FIELD probe_error_code ON circuit_breaker_trace TYPE option<string>;

-- Context
DEFINE FIELD caused_by_activity_id ON circuit_breaker_trace TYPE option<string>;
DEFINE FIELD vessel_eligible_for_routing ON circuit_breaker_trace TYPE bool DEFAULT true;

-- Timestamps
DEFINE FIELD timestamp ON circuit_breaker_trace TYPE datetime DEFAULT time::now();

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

-- vessel_circuit_breaker indexes
DEFINE INDEX idx_circuit_breaker_vessel ON vessel_circuit_breaker COLUMNS vessel_id UNIQUE;
DEFINE INDEX idx_circuit_breaker_org ON vessel_circuit_breaker COLUMNS org_id;
DEFINE INDEX idx_circuit_breaker_state ON vessel_circuit_breaker COLUMNS state;

-- vessel_health_metrics indexes
DEFINE INDEX idx_health_metrics_vessel ON vessel_health_metrics COLUMNS vessel_id UNIQUE;
DEFINE INDEX idx_health_metrics_org ON vessel_health_metrics COLUMNS org_id;
DEFINE INDEX idx_health_metrics_score ON vessel_health_metrics COLUMNS health_score;
DEFINE INDEX idx_health_metrics_eligible ON vessel_health_metrics COLUMNS eligible_for_routing;

-- routing_trace indexes
DEFINE INDEX idx_routing_trace_id ON routing_trace COLUMNS trace_id UNIQUE;
DEFINE INDEX idx_routing_trace_shape ON routing_trace COLUMNS shape;
DEFINE INDEX idx_routing_trace_timestamp ON routing_trace COLUMNS timestamp;
DEFINE INDEX idx_routing_trace_outcome ON routing_trace COLUMNS outcome;
DEFINE INDEX idx_routing_trace_activity ON routing_trace COLUMNS activity_execution_id;

-- circuit_breaker_trace indexes
DEFINE INDEX idx_cb_trace_id ON circuit_breaker_trace COLUMNS trace_id UNIQUE;
DEFINE INDEX idx_cb_trace_vessel ON circuit_breaker_trace COLUMNS vessel_id;
DEFINE INDEX idx_cb_trace_timestamp ON circuit_breaker_trace COLUMNS timestamp;
DEFINE INDEX idx_cb_trace_event ON circuit_breaker_trace COLUMNS event;

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------

-- Circuit breaker records scoped to org
DEFINE TABLE vessel_circuit_breaker PERMISSIONS
  FOR select WHERE org_id = $auth.org_id
  FOR create, update WHERE org_id = $auth.org_id
  FOR delete WHERE org_id = $auth.org_id;

-- Health metrics scoped to org
DEFINE TABLE vessel_health_metrics PERMISSIONS
  FOR select WHERE org_id = $auth.org_id
  FOR create, update WHERE org_id = $auth.org_id
  FOR delete WHERE org_id = $auth.org_id;

-- Routing traces scoped to org
DEFINE TABLE routing_trace PERMISSIONS
  FOR select WHERE org_id = $auth.org_id
  FOR create WHERE org_id = $auth.org_id
  FOR update, delete NONE;

-- Circuit breaker traces scoped to org
DEFINE TABLE circuit_breaker_trace PERMISSIONS
  FOR select WHERE org_id = $auth.org_id
  FOR create WHERE org_id = $auth.org_id
  FOR update, delete NONE;
