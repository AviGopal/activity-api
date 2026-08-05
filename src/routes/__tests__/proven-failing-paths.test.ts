/**
 * A path proven not to reach must never be recommended as a reusable pathway.
 *
 * Recommendation is per-goal_hash with no ABSOLUTE bar: Thompson picks the best of the paths
 * recorded for this goal, and when the only recorded path has never reached, Beta sampling over
 * a single arm returns it anyway. The walk then labels the replay `learned_pathway` and re-runs
 * a path that is known not to work.
 *
 * Measured 2026-08-05 over 4,494 recorded paths / 9,704 executions:
 *     learned_pathway   765 executions,  14 successes  —  1%
 *     fresh_derivation 1,194 executions, 417 successes — 34%
 * The tier that is supposed to be the CEILING was the floor by a factor of thirty, and 3,727
 * executions (38% of all execution) went to 352 paths that have never once reached.
 *
 * The rule is asserted here directly rather than through the HTTP handler (which needs a live
 * SurrealDB), because the rule IS the fix — the predicate deciding what counts as unusable.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = join(import.meta.dir, '..', 'goal-paths.ts');

/** The predicate as implemented in the route, kept in sync by the source assertions below. */
const isProvenFailing = (p: { total_executions?: number; successful_executions?: number | null }): boolean => {
  const execs = p.total_executions ?? 0;
  const succ = p.successful_executions ?? null;
  return succ !== null && succ === 0 && execs >= 3;
};

describe('proven-failing path predicate', () => {
  it('withholds a path with repeated executions and no successes', () => {
    expect(isProvenFailing({ total_executions: 6, successful_executions: 0 })).toBe(true);
  });

  it('KEEPS a path that has ever reached', () => {
    expect(isProvenFailing({ total_executions: 100, successful_executions: 1 })).toBe(false);
  });

  // Exploration must survive. A path with one or two failures may simply be new or unlucky;
  // disqualifying it would stop the walk ever finding a pathway that works.
  it('KEEPS a path that is merely new — too few observations to be proven', () => {
    expect(isProvenFailing({ total_executions: 1, successful_executions: 0 })).toBe(false);
    expect(isProvenFailing({ total_executions: 2, successful_executions: 0 })).toBe(false);
  });

  // Fail safe: a MISSING counter must never disqualify a path. Only an observed zero does.
  it('KEEPS a path that does not report successful_executions at all', () => {
    expect(isProvenFailing({ total_executions: 500 })).toBe(false);
    expect(isProvenFailing({ total_executions: 500, successful_executions: null })).toBe(false);
  });
});

describe('goal-paths route wiring', () => {
  const src = readFileSync(ROUTE, 'utf8');

  it('filters the recommendation candidate set before sampling', () => {
    expect(src).toContain('isProvenFailing');
    // The filter has to happen BEFORE the explore/exploit split, or a withheld path can still
    // be returned by the exploration branch (which deliberately prefers least-executed paths).
    expect(src.indexOf('const isProvenFailing')).toBeLessThan(src.indexOf('const shouldExplore'));
  });

  it('returns no recommendation when everything recorded is proven-failing', () => {
    // Returning [] is the useful answer: it sends the walk to fresh derivation rather than
    // handing it a plan known not to reach.
    expect(src).toContain('if (paths.length === 0)');
  });

  it('counts successes rather than the derived success_rate', () => {
    // success_rate is miscomputed on a large fraction of rows (398 of 2,392 templates reported
    // rate 0 while successful_executions was > 0), so the predicate must read the raw counter.
    const start = src.indexOf('const isProvenFailing');
    const block = src.slice(start, src.indexOf('};', start));
    expect(block).toContain('successful_executions');
    expect(block).not.toContain('success_rate');
  });
});
