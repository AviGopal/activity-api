-- Migration 141: durable promote_gate_evaluations table for inv-030 §calibration.
--
-- iter 20 added bus-emission of promote_gate.evaluated on every promote attempt
-- (allow AND refuse paths). The audit's inv-030 §calibration experiment requires
-- subscribers to accumulate decisions over a sustained window, then post-hoc-join
-- against variant_performance_metrics to compute the gate's calibration table.
--
-- Bus-only emission means a subscriber must be live during every promote attempt.
-- That's brittle for week-long calibration windows. This migration adds a durable
-- mirror — same pattern as iter 13's refusal_events table for intervention.refused.
--
-- Stored on every promote attempt, allow or refuse. Refuse paths still write
-- their entry to refusal_events ALSO (joining the two by template_id + refused_at
-- gives the full refusal context including the projection).

DEFINE TABLE OVERWRITE promote_gate_evaluations SCHEMAFULL
  PERMISSIONS
    FOR select WHERE $token.org_id = NONE OR org_id = $token.org_id OR org_id IS NONE
    FOR create WHERE $auth != NONE OR $token != NONE
    FOR update, delete NONE;

-- Identifying fields
DEFINE FIELD OVERWRITE id ON promote_gate_evaluations TYPE record<promote_gate_evaluations>;
DEFINE FIELD OVERWRITE template_id ON promote_gate_evaluations TYPE string;
DEFINE FIELD OVERWRITE org_id ON promote_gate_evaluations TYPE option<string>;

-- Decision
DEFINE FIELD OVERWRITE decision ON promote_gate_evaluations TYPE string ASSERT $value IN ['promote', 'refused'];
DEFINE FIELD OVERWRITE reason ON promote_gate_evaluations TYPE option<string>;

-- Projection (flattened for easy aggregation)
DEFINE FIELD OVERWRITE alpha_hat ON promote_gate_evaluations TYPE float;
DEFINE FIELD OVERWRITE beta_hat ON promote_gate_evaluations TYPE float;
DEFINE FIELD OVERWRITE projected_mean ON promote_gate_evaluations TYPE float;
DEFINE FIELD OVERWRITE total_samples ON promote_gate_evaluations TYPE int;
DEFINE FIELD OVERWRITE k_neighbors ON promote_gate_evaluations TYPE int;

-- Thresholds at evaluation time (so we can compute calibration even if defaults change)
DEFINE FIELD OVERWRITE threshold_mean ON promote_gate_evaluations TYPE float;
DEFINE FIELD OVERWRITE threshold_samples ON promote_gate_evaluations TYPE int;

-- Neighbor IDs as a string array — preserves the audit-trail per audit §7 minimum
-- (the full neighbor records with similarities + α/β live on the bus event; the
-- durable record keeps the ids for joinability with variant_performance_metrics).
DEFINE FIELD OVERWRITE neighbor_template_ids ON promote_gate_evaluations TYPE array<string>;

-- Source vessel (always 'metabob-activity-api' today; future-proofing)
DEFINE FIELD OVERWRITE source_vessel_id ON promote_gate_evaluations TYPE string VALUE $value OR 'metabob-activity-api';

-- Temporal
DEFINE FIELD OVERWRITE evaluated_at ON promote_gate_evaluations TYPE datetime VALUE $value OR time::now();
DEFINE FIELD OVERWRITE created_at ON promote_gate_evaluations TYPE datetime VALUE time::now() READONLY;

-- Indexes for the audit's calibration queries:
--   - count evaluations in a window:                              evaluated_at
--   - count by decision (promote vs refused):                    (decision, evaluated_at)
--   - per-template attribution (lookup by promoted template):    template_id
--   - org-scoped queries:                                         org_id
DEFINE INDEX OVERWRITE promote_gate_evaluations_at ON promote_gate_evaluations FIELDS evaluated_at;
DEFINE INDEX OVERWRITE promote_gate_evaluations_decision_at ON promote_gate_evaluations FIELDS decision, evaluated_at;
DEFINE INDEX OVERWRITE promote_gate_evaluations_template ON promote_gate_evaluations FIELDS template_id;
DEFINE INDEX OVERWRITE promote_gate_evaluations_org ON promote_gate_evaluations FIELDS org_id;
