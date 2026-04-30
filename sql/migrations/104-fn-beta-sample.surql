-- Phase 10 P5A of 2026-04-26-impulse-activity-loop: server-side Beta sampler
--
-- `fn::beta_sample($a, $b)` returns one draw from the Beta(α, β) distribution
-- using the Marsaglia & Tsang (2000) gamma sampling method composed via
--   Beta(α, β) = G(α, 1) / (G(α, 1) + G(β, 1))
-- where G(k, 1) is a Gamma(shape=k, scale=1) sample.
--
-- Rationale: dual-compute path at `activities.ts:4416` currently calls
-- `@stdlib/random-base-beta` from JS for every Thompson sample, costing
-- one process round-trip + a heap allocation per draw. A SurrealDB
-- embedded function lets recommend / discover-by-shapes generate the
-- random draw in the same query that fetches α/β, eliminating the
-- network hop. App-side JS sampler stays as fallback (logged via
-- `sample_source: "db" | "app_fallback"` per task 10.14) until 10.15
-- promotes DB-only.
--
-- Acceptance: `KS test p > 0.05 against Beta(2,5) CDF over 1000
-- samples` (task 10.S3). Validation script lives at
-- `scripts/validate-beta-sample.ts`; not in this migration since it's
-- a regression check, not schema state.
--
-- Idempotent via `DEFINE FUNCTION OVERWRITE`.

DEFINE FUNCTION OVERWRITE fn::beta_sample($a: number, $b: number) {
  RETURN function($a, $b) {
    // Clamp to a safe lower bound so the gamma sampler can't divide by
    // zero or take log of zero on a malformed posterior.
    const aRaw = Number(arguments[0]);
    const bRaw = Number(arguments[1]);
    const aSafe = Number.isFinite(aRaw) && aRaw > 1e-6 ? aRaw : 1;
    const bSafe = Number.isFinite(bRaw) && bRaw > 1e-6 ? bRaw : 1;

    // Marsaglia & Tsang (2000) gamma sampler. For shape ≥ 1, the
    // squeeze accepts ~96 % of proposals on the first try. For shape
    // < 1, boost to (shape+1) and scale by U^(1/shape).
    function gammaSample(shape) {
      if (shape < 1) {
        const u = Math.random();
        return gammaSample(shape + 1) * Math.pow(u, 1 / shape);
      }
      const d = shape - 1 / 3;
      const c = 1 / Math.sqrt(9 * d);
      // Bounded retry: at typical Thompson α/β (1..1000), the squeeze
      // converges in < 5 iterations. 64 caps pathological cases without
      // letting the function diverge.
      for (let i = 0; i < 64; i++) {
        let x, v;
        // Generate N(0,1) via Box-Muller (cosine variant).
        do {
          const u1 = Math.random();
          const u2 = Math.random();
          // log(0) guard.
          const safeU1 = u1 > 0 ? u1 : 1e-12;
          x = Math.sqrt(-2 * Math.log(safeU1)) * Math.cos(2 * Math.PI * u2);
          v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = Math.random();
        // Squeeze test (cheap path).
        if (u < 1 - 0.0331 * x * x * x * x) return d * v;
        // Full log-acceptance.
        const safeV = v > 0 ? v : 1e-12;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(safeV))) {
          return d * v;
        }
      }
      // Pathological — fall back to the mode E[G] = shape so callers
      // never see NaN. Caller can detect by comparing against the
      // posterior mean if precision matters.
      return shape;
    }

    const ga = gammaSample(aSafe);
    const gb = gammaSample(bSafe);
    const denom = ga + gb;
    return denom > 0 ? ga / denom : aSafe / (aSafe + bSafe);
  };
};

-- Smoke-test self-evaluation: produces a single sample at α=2, β=5.
-- Deliberately not asserting a distribution here — the K-S regression
-- runs against the live deployed function via scripts/validate-beta-
-- sample.ts. This RETURN keeps `bun run init-db` from raising on the
-- migration; the value is discarded.
RETURN fn::beta_sample(2, 5);
