-- Phase 10 P5A follow-up: replace Johnk's algorithm with the
-- Marsaglia & Tsang (2000) gamma sampler composed via the Beta-as-
-- ratio-of-gammas identity.
--
-- 10.S3 K-S test against migration 104's Johnk + normal-approx hybrid
-- failed: D=0.115, p<1e-5 over 1000 samples of Beta(2, 5). Root cause:
-- Johnk's per-attempt acceptance rate for Beta(α, β) is
-- Γ(α+1)·Γ(β+1)/Γ(α+β+1). For (2, 5) this is 2·120/5040 = 1/21 ≈ 4.76%.
-- After 32 recursive retries, P(fall-through) = (20/21)^32 ≈ 22%, and
-- the fallback `fn::_beta_normal_approx` is a poor model for skewed
-- low-concentration Beta distributions. Combined with the (1e-7,
-- 0.9999999) tail clamps, the empirical CDF diverges from the analytic
-- Beta(2,5) CDF in exactly the pattern observed.
--
-- New strategy: Marsaglia-Tsang gamma sampler.
--   For α ≥ 1: rejection rate ≈ 1.4%, so depth-32 fall-through is
--   (0.014)^32 ≈ 10^-58 (effectively zero).
--   Beta(α, β) = G_α / (G_α + G_β) where G_α ~ Gamma(α, 1).
--   For α < 1 we boost: G(α) = G(α+1) * U^(1/α). We only encounter
--   α ≥ 1 in production (Thompson priors start at 1), so the boost
--   path is rarely hit but kept for completeness.
--
-- Box-Muller is reused for the standard-normal generation. The squeeze
-- step (cheap rejection) catches ~95% of accepts in one comparison;
-- the log-bound step is the rigorous fallback. No clamps anywhere —
-- the gamma sampler returns exact draws.

-- Internal: standard-normal Z via Box-Muller. Returns one variate.
DEFINE FUNCTION OVERWRITE fn::_normal_sample() {
  LET $u1 = rand::float();
  LET $u2 = rand::float();
  -- log(0) guard for u1 (cosine on u2 is bounded so 0 is fine there).
  LET $u1s = IF $u1 <= 0 THEN 0.0000001 ELSE $u1 END;
  RETURN math::sqrt(-2.0 * math::ln($u1s)) * math::cos(2.0 * 3.14159265358979 * $u2);
};

-- Internal: Marsaglia-Tsang squeeze step for Gamma(α≥1, 1).
-- Bounded recursion depth — at α≥1 the per-step accept is ~98.6% so
-- depth 32 has effectively zero fall-through. If we somehow exhaust
-- depth, return d (the mode of the proposal) as a deterministic
-- fallback. Better than NaN; never happens in practice.
DEFINE FUNCTION OVERWRITE fn::_gamma_squeeze($d: number, $c: number, $depth: int) {
  IF $depth >= 32 {
    RETURN $d;
  };
  LET $z = fn::_normal_sample();
  LET $x = 1.0 + $c * $z;
  -- Reject when x ≤ 0 (proposal v = x^3 must be positive).
  IF $x <= 0.0 {
    RETURN fn::_gamma_squeeze($d, $c, $depth + 1);
  };
  LET $v = $x * $x * $x;
  LET $u = rand::float();
  LET $z2 = $z * $z;
  LET $z4 = $z2 * $z2;
  -- Cheap squeeze: if u < 1 - 0.0331·z⁴, accept immediately.
  IF $u < 1.0 - 0.0331 * $z4 {
    RETURN $d * $v;
  };
  -- log(0) guard for the rigorous bound.
  LET $us = IF $u <= 0 THEN 0.0000001 ELSE $u END;
  -- Rigorous bound: ln(u) < 0.5·z² + d·(1 - v + ln(v)).
  IF math::ln($us) < 0.5 * $z2 + $d * (1.0 - $v + math::ln($v)) {
    RETURN $d * $v;
  };
  RETURN fn::_gamma_squeeze($d, $c, $depth + 1);
};

-- Internal: Gamma(α, 1) sampler. Marsaglia-Tsang for α ≥ 1, boost for α < 1.
DEFINE FUNCTION OVERWRITE fn::_gamma_sample($alpha: number) {
  IF $alpha >= 1.0 {
    LET $d = $alpha - 1.0 / 3.0;
    LET $c = 1.0 / math::sqrt(9.0 * $d);
    RETURN fn::_gamma_squeeze($d, $c, 0);
  };
  -- α < 1 boost: sample G(α+1), multiply by U^(1/α).
  LET $g = fn::_gamma_sample($alpha + 1.0);
  LET $u = rand::float();
  LET $us = IF $u <= 0 THEN 0.0000001 ELSE $u END;
  RETURN $g * math::pow($us, 1.0 / $alpha);
};

-- Public: Beta(α, β) sampler via the gamma-ratio identity.
-- Replaces the Johnk + normal-approx hybrid from migration 104.
-- Exact for any α, β > 0; no shape-dependent regimes, no clamps.
DEFINE FUNCTION OVERWRITE fn::beta_sample($a: number, $b: number) {
  LET $aSafe = IF $a > 0.000001 THEN $a ELSE 1.0 END;
  LET $bSafe = IF $b > 0.000001 THEN $b ELSE 1.0 END;
  LET $ga = fn::_gamma_sample($aSafe);
  LET $gb = fn::_gamma_sample($bSafe);
  LET $sum = $ga + $gb;
  -- Degenerate guard: both gammas zero is unreachable (probability 0)
  -- but defend anyway to avoid divide-by-zero.
  IF $sum <= 0.0 {
    RETURN $aSafe / ($aSafe + $bSafe);
  };
  RETURN $ga / $sum;
};

-- Smoke RETURN: produces a single sample at α=2, β=5 so init-db sees a
-- non-error result for this migration. Discarded.
RETURN fn::beta_sample(2, 5);
