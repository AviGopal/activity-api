-- Phase 10 P5A of 2026-04-26-impulse-activity-loop: server-side Beta sampler
--
-- `fn::beta_sample($a, $b)` returns one draw from the Beta(α, β) distribution.
--
-- Pure SurrealQL implementation. The earlier draft used a JavaScript
-- `function() { ... }` body, which the canary SurrealDB rejects with
-- "Scripting functions are not allowed" — the deployment has its
-- scripting feature disabled, and we want to avoid widening the
-- security surface to enable it just for this one function.
--
-- Strategy:
--   1. For α, β ≥ 1 we use Johnk's algorithm:
--        U1, U2 ~ Uniform(0,1)
--        V1 = U1^(1/α),  V2 = U2^(1/β)
--        If V1 + V2 ≤ 1: return V1 / (V1 + V2)
--        Else: retry (recursion).
--      Convergence is fast for moderate α + β (< 50). For high
--      α + β the acceptance rate drops; we cap recursion depth and
--      fall back to the normal approximation.
--
--   2. For high α + β (≥ 50, where Beta is well-approximated by
--      a normal) we use a Box-Muller-style construction:
--        mean = α / (α + β)
--        var  = α β / ((α + β)² (α + β + 1))
--        sample = clamp(mean + √var · Z, 0, 1)
--      where Z is a standard normal generated from two uniforms.
--      This sidesteps Johnk's high-rejection regime.
--
-- Acceptance: `KS test p > 0.05 against Beta(2,5) CDF over 1000
-- samples` (task 10.S3). The validation script
-- `scripts/validate-beta-sample.ts` runs the regression against the
-- live function once deployed. Note: at moderate α+β this matches
-- exactly; at high α+β the normal approximation has bounded total
-- variation distance ≈ O(1/√(α+β)) which the K-S test tolerates well.
--
-- Idempotent via `DEFINE FUNCTION OVERWRITE`.

-- Internal: Johnk acceptance step + bounded recursion.
DEFINE FUNCTION OVERWRITE fn::_beta_johnk($a: number, $b: number, $depth: int) {
  IF $depth >= 32 {
    -- Pathological — fall through to the normal-approx sampler.
    RETURN fn::_beta_normal_approx($a, $b);
  };
  LET $u1 = rand::float();
  LET $u2 = rand::float();
  -- log(0) guard: rand::float can return 0; nudge to a tiny positive.
  LET $u1s = IF $u1 <= 0 THEN 0.0000001 ELSE $u1 END;
  LET $u2s = IF $u2 <= 0 THEN 0.0000001 ELSE $u2 END;
  LET $v1 = math::pow($u1s, 1.0 / $a);
  LET $v2 = math::pow($u2s, 1.0 / $b);
  LET $sum = $v1 + $v2;
  IF $sum <= 1.0 AND $sum > 0.0 {
    RETURN $v1 / $sum;
  };
  RETURN fn::_beta_johnk($a, $b, $depth + 1);
};

-- Internal: Beta normal approximation (mean + √variance · Z), clamped
-- to (0, 1). Uses Box-Muller to derive Z from two uniforms, sidestepping
-- any need for rand::guass which may not exist on every SurrealDB build.
DEFINE FUNCTION OVERWRITE fn::_beta_normal_approx($a: number, $b: number) {
  LET $mean = $a / ($a + $b);
  LET $var = ($a * $b) / (($a + $b) * ($a + $b) * ($a + $b + 1.0));
  LET $std = math::sqrt($var);
  LET $u1 = rand::float();
  LET $u2 = rand::float();
  LET $u1s = IF $u1 <= 0 THEN 0.0000001 ELSE $u1 END;
  LET $z = math::sqrt(-2.0 * math::ln($u1s)) * math::cos(2.0 * 3.14159265358979 * $u2);
  LET $sample = $mean + $std * $z;
  -- Clamp to (epsilon, 1 - epsilon) so downstream log/quantile ops
  -- never see exactly 0 or 1 from a clamped tail draw.
  IF $sample < 0.0000001 { RETURN 0.0000001 };
  IF $sample > 0.9999999 { RETURN 0.9999999 };
  RETURN $sample;
};

-- Public: Beta(α, β) sampler. Routes to Johnk or normal-approx based on
-- α + β concentration. Clamps degenerate inputs to a safe lower bound.
DEFINE FUNCTION OVERWRITE fn::beta_sample($a: number, $b: number) {
  LET $aSafe = IF $a > 0.000001 THEN $a ELSE 1.0 END;
  LET $bSafe = IF $b > 0.000001 THEN $b ELSE 1.0 END;
  -- For low concentration Johnk is exact and fast (typical Thompson
  -- posteriors with 0–50 observations). For high concentration the
  -- normal approximation is accurate to O(1/√(α+β)) and avoids
  -- exponential-rejection overhead.
  IF $aSafe + $bSafe < 50.0 {
    RETURN fn::_beta_johnk($aSafe, $bSafe, 0);
  };
  RETURN fn::_beta_normal_approx($aSafe, $bSafe);
};

-- Smoke RETURN: produces a single sample at α=2, β=5 so init-db sees a
-- non-error result for this migration. Discarded.
RETURN fn::beta_sample(2, 5);
