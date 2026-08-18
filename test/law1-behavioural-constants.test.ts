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
 * SCOPE, STATED: this covers EMBEDDING_PRIOR_ENABLED only. `POSTERIOR_COALESCE` and
 * `POSTERIOR_FLUSH_MS` are the same class and are NOT closed here — see the final test, which
 * pins them as known-open rather than letting them look covered.
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
    const calls = (s.match(/await embeddingPriorEnabled\(\)/g) ?? []).length;
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

  it('KNOWN-OPEN, pinned so it does not read as covered', () => {
    // POSTERIOR_COALESCE gates whether coalescing runs at all; POSTERIOR_FLUSH_MS is a
    // CADENCE, which law 5 says belongs in the pool as a rhythm impulse rather than a tuning
    // row — a different seam, and a design call rather than a mechanical port. Both are still
    // module-scope env reads. Pinned here so the next reader sees them named rather than
    // inferring from this file's existence that the class is closed.
    const s = readFileSync(SRC + 'lib/posterior-aggregator.ts', 'utf8');
    expect(s).toMatch(/process\.env\.POSTERIOR_COALESCE/);
    expect(s).toMatch(/process\.env\.POSTERIOR_FLUSH_MS/);
  });
});
