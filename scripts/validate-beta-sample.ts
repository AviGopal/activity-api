#!/usr/bin/env bun
/**
 * Validate Phase 10 P5A acceptance criterion 10.S3:
 *
 *   "fn::beta_sample KS test p-value > 0.05 against Beta(2,5) CDF
 *    over 1000 samples"
 *
 * Pulls 1000 samples from the live `fn::beta_sample(2, 5)` function on
 * the canary or production DB, computes the Kolmogorov-Smirnov D
 * statistic against the analytic Beta(2, 5) CDF (regularised
 * incomplete-beta), and prints the p-value. Exit 0 if p > 0.05.
 *
 * Usage:
 *   SURREALDB_URL=https://surql.metabob.com \
 *   SURREALDB_USERNAME=root \
 *   SURREALDB_PASSWORD=… \
 *   bun run scripts/validate-beta-sample.ts [alpha=2] [beta=5] [n=1000]
 *
 * Connects via the configured root creds (admin-scope required to call
 * fn::* functions). Read-only — does not write to any table.
 */

import { Surreal } from "surrealdb";

const ALPHA = Number(process.argv[2] ?? "2");
const BETA = Number(process.argv[3] ?? "5");
const N = Number(process.argv[4] ?? "1000");

const url = process.env.SURREALDB_URL ?? "http://localhost:8000";
const username = process.env.SURREALDB_USERNAME ?? "root";
const password = process.env.SURREALDB_PASSWORD ?? "root";
const namespace = process.env.SURREALDB_NAMESPACE ?? "activity-system";
const database = process.env.SURREALDB_DATABASE ?? "learning_loop";

/** Lanczos approximation for ln Γ(z), valid for z > 0 with small error. */
function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Regularised incomplete beta I_x(a, b) via Lentz's continued-fraction
 * (Numerical Recipes §6.4). Returns the Beta(a, b) CDF at x.
 */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront =
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) +
    a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  // Recurrence is more efficient when x < (a+1)/(a+b+2).
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(x, a, b)) / a;
  }
  return 1 - (front * betacf(1 - x, b, a)) / b;
}

function betacf(x: number, a: number, b: number): number {
  const MAX_ITER = 200;
  const EPS = 3e-7;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  return h;
}

/**
 * Two-sided KS p-value approximation for one-sample test (Marsaglia,
 * Tsang & Wang 2003 closed-form upper bound).
 */
function ksPValue(d: number, n: number): number {
  const en = Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n);
  const x = en * d;
  // Q_KS(x) = 2 * sum_{j=1..∞} (-1)^(j-1) * exp(-2 * j^2 * x^2)
  let sum = 0;
  let prev = 0;
  let term = 0;
  for (let j = 1; j <= 100; j++) {
    term = 2 * (j % 2 === 1 ? 1 : -1) * Math.exp(-2 * j * j * x * x);
    sum += term;
    if (Math.abs(term) <= 1e-8 * Math.abs(prev) || Math.abs(term) <= 1e-12) {
      return Math.min(1, Math.max(0, sum));
    }
    prev = term;
  }
  return Math.min(1, Math.max(0, sum));
}

async function main() {
  console.log(
    `[validate-beta-sample] Beta(${ALPHA}, ${BETA}), N=${N}, target=${url}`,
  );
  const db = new Surreal();
  await db.connect(url, { auth: { username, password }, namespace, database });

  const samples: number[] = [];
  // Pull samples in batches of 100 to keep request payloads small.
  const BATCH = 100;
  for (let offset = 0; offset < N; offset += BATCH) {
    const want = Math.min(BATCH, N - offset);
    const calls = Array.from(
      { length: want },
      () => `fn::beta_sample(${ALPHA}, ${BETA})`,
    ).join(", ");
    const res = await db.query<[number[]]>(`RETURN [${calls}]`);
    const batch = (res?.[0] ?? []) as number[];
    for (const x of batch) {
      if (Number.isFinite(x) && x >= 0 && x <= 1) samples.push(x);
    }
  }
  await db.close();

  if (samples.length < N * 0.9) {
    console.error(
      `[validate-beta-sample] only ${samples.length}/${N} valid samples — likely a function or transport bug`,
    );
    process.exit(2);
  }

  samples.sort((a, b) => a - b);
  let dPlus = -Infinity;
  let dMinus = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    const cdf = incompleteBeta(samples[i], ALPHA, BETA);
    const ecdfHi = (i + 1) / samples.length;
    const ecdfLo = i / samples.length;
    dPlus = Math.max(dPlus, ecdfHi - cdf);
    dMinus = Math.max(dMinus, cdf - ecdfLo);
  }
  const D = Math.max(dPlus, dMinus);
  const p = ksPValue(D, samples.length);
  const passed = p > 0.05;
  console.log(
    `[validate-beta-sample] D=${D.toFixed(5)} p=${p.toFixed(5)} ${passed ? "PASS" : "FAIL"} (threshold 0.05)`,
  );
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("[validate-beta-sample] error", err);
  process.exit(2);
});
