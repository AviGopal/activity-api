-- Migration 051: Add net_value_score to impulse_relevance_metrics
-- net_value_score = relevance_score - irrelevance_score * 0.5, clamped to [-1, 1]
-- Stored on every write so discoverMissingImpulses can rank without recomputing.

DEFINE FIELD IF NOT EXISTS net_value_score ON impulse_relevance_metrics TYPE option<float>;
