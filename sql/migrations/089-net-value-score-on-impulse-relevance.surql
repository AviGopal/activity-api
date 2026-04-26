-- Migration 089: Add net_value_score to impulse_relevance_metrics
--
-- net_value_score = relevance_score - irrelevance_score * 0.5
-- clamped to [-1, 1]. Replaces raw relevance_score - irrelevance_score
-- as the ranking signal used by discoverMissingImpulses and the skip gate.
-- Stored so queries can ORDER BY without recomputing.

DEFINE FIELD IF NOT EXISTS net_value_score ON impulse_relevance_metrics TYPE option<float>;
