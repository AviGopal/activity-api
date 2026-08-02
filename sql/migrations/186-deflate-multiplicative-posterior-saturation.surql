-- 186: Deflate Beta posteriors that were inflated by the multiplicative update,
-- and repair the rows that saturated int64.
--
-- The feedback route in src/routes/activities.ts updated posteriors
-- MULTIPLICATIVELY:
--     positive: SET alpha = math::ceil((alpha ?? 1) * $multiplier)
--     negative: SET beta  = math::ceil((beta  ?? 1) * $multiplier)
-- with a multiplier around 2.5. Two consequences, both observed live:
--
--   1) SATURATION. 2.5^48 exceeds int64, so an activity that accumulates ~48
--      verdicts of one sign pins that parameter at 9223372036854775807. Every
--      subsequent feedback POST for that activity then 500s with
--      "Cannot perform addition with '1' and '9223372036854775807'" — the hub
--      logged 29 such failures in a six-hour window, all for
--      activity:<learned-detect-classifier-distribution-skew-1jb2k9x>. Once a
--      row saturates, that activity can never be graded again.
--
--   2) VARIANCE COLLAPSE, which is the worse of the two. A Beta posterior's
--      concentration (alpha + beta) is what sets its variance, and Thompson
--      sampling explores in proportion to that variance. Under multiplication
--      the concentration grows EXPONENTIALLY in the number of observations, so
--      after a handful of verdicts the posterior is effectively a point mass and
--      the selector stops exploring the activity entirely — it is either always
--      picked or never picked. That is a structural cause of low reuse and
--      composition, not merely a numeric wart.
--
-- The write path is corrected separately to the additive Beta-Bernoulli form
-- (alpha += 1 on success, beta += 1 on failure). This migration converts the
-- historical rows so the corrected write path continues from a sane state.
--
-- RECONSTRUCTION. A value produced by repeated multiplication carries its own
-- observation count: v = m^n implies n = ln(v)/ln(m). So the additive-equivalent
-- parameter is 1 + ln(v)/ln(2.5) — for a saturated int64 that is ~1 + 47.6, i.e.
-- roughly 49 observations, which is a plausible history rather than an invented
-- one. This PRESERVES the ordering and rough evidence-weight of every row while
-- restoring usable variance. 2.5 is the nominal multiplier; feedback intensity
-- varied it somewhat, so the reconstructed counts are approximate — they are a
-- far better starting point than either the saturated value or a blanket reset,
-- both of which discard real learning.
--
-- THRESHOLD. Only rows above 1000 are touched. Under the corrected additive rule
-- 1000 would require a thousand graded executions, which no activity in this
-- system has; so any value above it is necessarily multiplicative residue and
-- there is no risk of deflating a legitimately-earned additive posterior.
--
-- SAFE + IDEMPOTENT: after deflation every value is well under 1000, so the
-- WHERE clause stops matching and re-running is a no-op. Only alpha and beta on
-- impulse_shape_activity_score are written — activity rows, provenance, metrics
-- and composition edges are untouched. math::ln is already used elsewhere in
-- this codebase and is available in SurrealDB 2.x.
-- (2026-08-02, multiplicative-posterior-saturation)

UPDATE impulse_shape_activity_score
  SET alpha = IF (alpha ?? 1) > 1000
        THEN math::ceil(1 + math::ln(alpha) / math::ln(2.5))
        ELSE (alpha ?? 1)
      END,
      beta = IF (beta ?? 1) > 1000
        THEN math::ceil(1 + math::ln(beta) / math::ln(2.5))
        ELSE (beta ?? 1)
      END,
      updated_at = time::now()
  WHERE (alpha ?? 1) > 1000 OR (beta ?? 1) > 1000;
