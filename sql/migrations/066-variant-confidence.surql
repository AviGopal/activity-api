-- ============================================================================
-- Migration 066: Variant Confidence Tracking (Sequence 4 Requirement)
-- ============================================================================
-- Purpose: Add statistical confidence tracking for variant lifecycle management
-- Related: docs/architecture/sequences/04-improvisation-trailblazing.md
-- Date: 2026-04-16
-- ============================================================================
--
-- Enables variant retirement based on statistical significance:
-- - Confidence intervals track reliability of success rate estimates
-- - Sample size determines when confidence is meaningful
-- - Deprecation fields manage variant lifecycle
-- - Last execution tracking for recency analysis
--
-- Deprecation Criteria (application logic):
-- - success_rate < 0.3 AND sample_size >= 10 → Low performance with confidence
-- - success_rate < 0.2 AND sample_size >= 5 → Very low performance
-- - No executions in 90 days AND sample_size < 3 → Untested/abandoned
-- - Superseded by better variant in same family
-- ============================================================================

-- Add confidence interval field
-- Represents statistical confidence in success_rate estimate (0.0 to 1.0)
-- Computed using Wilson score interval or similar method
-- Higher sample_size → narrower confidence interval
DEFINE FIELD IF NOT EXISTS confidence_interval ON variant_performance_metrics TYPE float
  ASSERT $value >= 0.0 AND $value <= 1.0
  VALUE $value OR 0.0
  COMMENT "Statistical confidence in success rate (0.0-1.0). Low values indicate high uncertainty. Computed using Wilson score interval based on sample_size and success_rate.";

-- Add sample size field
-- Total number of executions used for statistical analysis
-- Matches total_executions but explicitly for confidence calculation
-- Minimum threshold for confidence: 10 executions recommended
DEFINE FIELD IF NOT EXISTS sample_size ON variant_performance_metrics TYPE int
  ASSERT $value >= 0
  VALUE $value OR 0
  COMMENT "Number of executions for statistical significance. Recommended minimum: 10 for meaningful confidence intervals. Used for Thompson Sampling and deprecation decisions.";

-- Add deprecation flag
-- Marks variants that should no longer be recommended
-- Does not delete variant (preserves history for analysis)
-- Thompson Sampling should exclude deprecated variants
DEFINE FIELD IF NOT EXISTS is_deprecated ON variant_performance_metrics TYPE bool
  VALUE $value OR false
  COMMENT "Whether this variant has been deprecated and should not be recommended. Reasons tracked in deprecation_reason. Deprecated variants remain in database for historical analysis.";

-- Add deprecation reason field
-- Documents why variant was retired for audit trail
-- Common reasons: poor_performance, superseded, untested, manual_deprecation
-- Optional field (NULL when variant is active)
DEFINE FIELD IF NOT EXISTS deprecation_reason ON variant_performance_metrics TYPE option<string>
  COMMENT "Reason for deprecation. Examples: 'poor_performance: success_rate=0.15 over 12 executions', 'superseded_by: variant-7f4a9e', 'untested: no executions in 90 days', 'manual_deprecation: security_issue'.";

-- Add deprecation timestamp
-- Records when variant was deprecated for lifecycle analysis
-- Enables queries like "variants deprecated in last 30 days"
-- NULL when variant is active
DEFINE FIELD IF NOT EXISTS deprecated_at ON variant_performance_metrics TYPE option<datetime>
  COMMENT "Timestamp when variant was deprecated. NULL for active variants. Used for deprecation lifecycle analysis and cleanup queries.";

-- Update last_executed_at to track recency
-- Already exists in table, adding comment for clarity
-- Used for identifying stale/untested variants
-- Combined with sample_size for deprecation decisions
DEFINE FIELD IF NOT EXISTS last_executed_at ON variant_performance_metrics TYPE option<datetime>
  COMMENT "Timestamp of most recent execution. Used to identify stale variants (no recent activity). Combined with sample_size to detect untested/abandoned variants.";

-- ============================================================================
-- INDEXES FOR VARIANT LIFECYCLE QUERIES
-- ============================================================================

-- Index on deprecation flag for filtering active variants
-- Primary query: "SELECT * FROM variant_performance_metrics WHERE is_deprecated = false"
-- Thompson Sampling should only consider active variants
DEFINE INDEX IF NOT EXISTS idx_variant_performance_is_deprecated
  ON variant_performance_metrics FIELDS is_deprecated;

-- Composite index for recency-based queries
-- Query: Find variants not executed recently with low sample size
-- Used for identifying stale/untested variants for deprecation
DEFINE INDEX IF NOT EXISTS idx_variant_performance_last_executed
  ON variant_performance_metrics FIELDS last_executed_at, sample_size;

-- Composite index for confidence-based filtering
-- Query: Find variants with low confidence and low success rate
-- Used for identifying candidates for deprecation
DEFINE INDEX IF NOT EXISTS idx_variant_performance_confidence
  ON variant_performance_metrics FIELDS confidence_interval, success_rate, sample_size;

-- Composite index for active variant queries
-- Query: Thompson Sampling selection (non-deprecated + activity filters)
-- Optimizes the most common query path
DEFINE INDEX IF NOT EXISTS idx_variant_performance_active_selection
  ON variant_performance_metrics FIELDS is_deprecated, activity_id, success_rate;

-- ============================================================================
-- USAGE EXAMPLES
-- ============================================================================
--
-- 1. COMPUTE CONFIDENCE INTERVAL (Wilson Score Interval)
--    Application logic computes confidence using:
--
--    function computeConfidenceInterval(successes, total, confidence = 0.95) {
--      const z = 1.96; // 95% confidence
--      const phat = successes / total;
--      const denominator = 1 + (z * z) / total;
--      const center = phat + (z * z) / (2 * total);
--      const margin = z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
--      return (margin / denominator); // Return interval width (0.0 to 1.0)
--    }
--
--    UPDATE variant_performance_metrics
--    SET confidence_interval = $computed_interval,
--        sample_size = total_executions
--    WHERE variant_id = $variant_id;
--
-- 2. DEPRECATE LOW-PERFORMING VARIANT
--
--    UPDATE variant_performance_metrics
--    SET is_deprecated = true,
--        deprecation_reason = "poor_performance: success_rate=0.18 over 15 executions",
--        deprecated_at = time::now()
--    WHERE variant_id = $variant_id
--      AND success_rate < 0.3
--      AND sample_size >= 10
--      AND is_deprecated = false;
--
-- 3. FIND ACTIVE VARIANTS FOR THOMPSON SAMPLING
--
--    SELECT variant_id, activity_id, thompson_alpha, thompson_beta, success_rate
--    FROM variant_performance_metrics
--    WHERE is_deprecated = false
--      AND activity_id = $activity_id
--      AND sample_size >= 3
--    ORDER BY success_rate DESC;
--
-- 4. IDENTIFY STALE VARIANTS FOR DEPRECATION
--
--    SELECT variant_id, activity_id, last_executed_at, sample_size
--    FROM variant_performance_metrics
--    WHERE is_deprecated = false
--      AND sample_size < 3
--      AND (last_executed_at IS NONE
--           OR last_executed_at < time::now() - 90d);
--
-- 5. VARIANT FAMILY PERFORMANCE COMPARISON
--
--    SELECT activity_id,
--           count() AS total_variants,
--           math::sum(is_deprecated::int) AS deprecated_count,
--           math::avg(success_rate) AS avg_success_rate,
--           math::avg(confidence_interval) AS avg_confidence
--    FROM variant_performance_metrics
--    GROUP BY activity_id
--    ORDER BY avg_success_rate DESC;
--
-- 6. AUDIT RECENT DEPRECATIONS
--
--    SELECT variant_id, activity_id, deprecation_reason, deprecated_at,
--           success_rate, sample_size, confidence_interval
--    FROM variant_performance_metrics
--    WHERE is_deprecated = true
--      AND deprecated_at > time::now() - 7d
--    ORDER BY deprecated_at DESC;
--
-- ============================================================================
-- VERIFICATION QUERIES (run after migration)
-- ============================================================================
--
-- Verify all fields exist:
-- INFO FOR TABLE variant_performance_metrics;
--
-- Verify indexes exist:
-- INFO FOR INDEX idx_variant_performance_is_deprecated ON variant_performance_metrics;
-- INFO FOR INDEX idx_variant_performance_last_executed ON variant_performance_metrics;
-- INFO FOR INDEX idx_variant_performance_confidence ON variant_performance_metrics;
-- INFO FOR INDEX idx_variant_performance_active_selection ON variant_performance_metrics;
--
-- Check for null/default values on existing records:
-- SELECT variant_id, confidence_interval, sample_size, is_deprecated
-- FROM variant_performance_metrics
-- LIMIT 10;
-- ============================================================================
