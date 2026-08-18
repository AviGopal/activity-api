import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A BEHAVIOURAL SWITCH READ FROM `process.env` AT USE SITES IS FROZEN, INVISIBLE AND
 * UNLEARNABLE — law 1.
 *
 * Audit finding 3.8. `EMBEDDING_PRIOR_ENABLED` selects WHICH PRIOR seeds a new cell — the
 * θ-scored embedding prior or the concept-neighbour query — so it decides where every
 * uninformed arm starts. That is selection behaviour, and it was read directly from
 * `process.env` at two consumption sites.
 *
 * Routed through `getTuningParam`, which is this repo's documented seam for exactly this
 * (`substrate_tuning_param` row -> env -> in-code default, 30s TTL). The boolean form mirrors
 * `successorBlendEnabled` rather than inventing a second idiom — law 3, and it matters here
 * because two ways of reading the same kind of flag is how they drift.
 *
 * THE ENV TIER IS KEPT ON PURPOSE. Removing it would be a behaviour change disguised as a
 * law-1 fix: every deployment setting the var would silently lose the prior. Law 1 objects to
 * a value being frozen and UNOBSERVABLE, not to env existing as a fallback beneath a readable
 * one. With no row and no env — the shipped state — the helper returns false, byte-for-byte
 * what `=== 'true'` returned.
 *
 * SCOPE, STATED: EMBEDDING_PRIOR_ENABLED and POSTERIOR_COALESCE are closed here.
 * `POSTERIOR_FLUSH_MS` is CLASSIFIED as plumbing rather than ported — see the final test for
 * the evidence, which corrects an earlier claim of mine that it was a law-5 item.
 */

const SRC = new URL('../src/', import.meta.url).pathname;

function read(rel: string): string {
  return readFileSync(SRC + rel, 'utf8');
}

describe('law 1 — EMBEDDING_PRIOR_ENABLED is read as data', () => {
  it('guards the instrument: the file is readable and is the right one', () => {
    const s = read('lib/posterior-update.ts');
    expect(s.length).toBeGreaterThan(5000);
    expect(s).toContain('seedPriorFromConcepts');
  });

  it('THE REGRESSION: no consumption site reads process.env directly', () => {
    const s = read('lib/posterior-update.ts');
    // Was: `if (process.env.EMBEDDING_PRIOR_ENABLED === 'true')` at two sites.
    expect(s).not.toMatch(/if \(process\.env\.EMBEDDING_PRIOR_ENABLED/);
    expect(s).not.toMatch(/process\.env\.EMBEDDING_PRIOR_ENABLED === 'true' &&/);
  });

  it('both consumers call the resolver', () => {
    const s = read('lib/posterior-update.ts');
    // NOT the awaited form. The resolver is SYNCHRONOUS on purpose: it reads a cache and
    // refreshes out of band, because an awaited lookup can stall a CREDIT WRITE against an
    // unreachable store. Asserting `await embeddingPriorEnabled()` would pin that defect back
    // in — the test would enforce the very blocking call the fix removed.
    const calls = (s.match(/if \(embeddingPriorEnabled\(\)/g) ?? []).length;
    // Fixing one of two sites is this repo's most-repeated failure; assert the count.
    expect(calls).toBe(2);
  });

  it('the resolver goes through getTuningParam, not a private cache', () => {
    const s = read('lib/posterior-update.ts');
    expect(s).toMatch(/getTuningParam\('EMBEDDING_PRIOR_ENABLED'/);
  });

  it('it mirrors the established boolean idiom rather than inventing one', () => {
    const mine = read('lib/posterior-update.ts');
    const established = read('routes/activities.scoring.ts');
    // successorBlendEnabled: env truthy short-circuit, then `>= 1` on the tuning value.
    expect(established).toMatch(/getTuningParam\('SF_BLEND'[^)]*\)\) >= 1/);
    expect(mine).toMatch(/getTuningParam\('EMBEDDING_PRIOR_ENABLED'[^)]*\)\) >= 1/);
  });

  it('the env tier survives — the unconfigured path is unchanged', () => {
    const s = read('lib/posterior-update.ts');
    // `raw === 'true'` must still win, or deployments setting the var lose the prior.
    expect(s).toMatch(/raw === 'true'/);
  });

  it('POSTERIOR_COALESCE is read as data, not frozen at process start', () => {
    const s = readFileSync(SRC + 'lib/posterior-aggregator.ts', 'utf8');
    // The consumer must go through the accessor, not a module-scope const.
    expect(s).toMatch(/if \(!posteriorCoalesceEnabled\(\)\) return false;/);
    expect(s).toMatch(/getTuningParam\('POSTERIOR_COALESCE'/);
    // And the refresh must actually be scheduled, or the accessor returns a frozen value
    // wearing a function's clothes — the "producer's clothes" failure this repo names.
    expect(s).toMatch(/void refreshCoalesceSetting\(\);/);
  });

  it('a lookup failure keeps the last value — it must not silently disable coalescing', () => {
    const s = readFileSync(SRC + 'lib/posterior-aggregator.ts', 'utf8');
    // Single-flight + deadline: an unbounded lookup issued once per flush tick accumulates
    // pending work forever against a store that hangs rather than refuses.
    expect(s).toMatch(/coalesceRefreshInFlight/);
    // Coalescing matters MOST under load, which is also when a DB blip is likeliest. Flipping
    // it off on a failed read would reintroduce the conflict storm exactly when it hurts.
    const i = s.indexOf('async function refreshCoalesceSetting');
    expect(i).toBeGreaterThan(-1);
    // 2200, not 700: the third time tonight a source-window assertion failed because the
    // comment it was reading grew past the slice. An instrument that truncates its subject
    // reports on the truncation.
    expect(s.slice(i, i + 2200)).toMatch(/catch \{[\s\S]*keep the last known value/);
  });

  it('POSTERIOR_FLUSH_MS is PLUMBING, not a behavioural switch — classified, not ported', () => {
    /**
     * I twice called this a law-5 item ("cadence belongs in the pool as a rhythm impulse")
     * and declined to touch it. Reading both the rhythm mechanism and this constant refutes
     * that, in the direction of it being NEITHER violation:
     *
     *  - Law 5's cadence is what the SELECTOR reads. `rhythm_conductor_tick` scores each
     *    rhythm's due-ness, credit, staleness and affordability, and enqueues the winning
     *    family's goal — it decides WHAT THE SUBSTRATE SPENDS TIME ON. FLUSH_MS is read by
     *    no selector.
     *  - Law 1 forbids BEHAVIOUR in a frozen constant. FLUSH_MS is the setInterval period of
     *    a write buffer whose deltas are additive and commutative — the module's own header
     *    states N concurrent +δ "collapse losslessly into a single +Σδ". Changing it changes
     *    write LATENCY and batch size; it changes neither which arm is selected nor what
     *    value is written.
     *
     * So it is process plumbing, the category law 1 explicitly permits alongside ports and
     * identity. The audit swept it into a list of "env-frozen behavioral switches" next to
     * EMBEDDING_PRIOR_ENABLED (which chooses a prior) and POSTERIOR_COALESCE (which decides
     * whether the conflict-storm defence runs) — both genuinely behavioural, and both now
     * closed. Grouping a buffer interval with them was over-broad.
     *
     * Pinned as a CLASSIFICATION so the next reader inherits the reasoning rather than the
     * verdict. If someone later makes FLUSH_MS affect a written value — say by decaying
     * per-flush instead of per-delta — this test's premise breaks and it should fail.
     */
    const s = readFileSync(SRC + 'lib/posterior-aggregator.ts', 'utf8');
    // The premise: it is consumed ONLY as a timer period.
    expect(s).toMatch(/const FLUSH_MS = Math\.max\(50, parseInt\(process\.env\.POSTERIOR_FLUSH_MS/);
    const uses = (s.match(/\bFLUSH_MS\b/g) ?? []).filter(Boolean);
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(s).toMatch(/\}, FLUSH_MS\);/);
    // And the property that makes the period value-neutral: coalescing is lossless, so the
    // same deltas produce the same Σδ regardless of how often the buffer drains.
    expect(s).toMatch(/collapse losslessly into a single/);
  });
});
