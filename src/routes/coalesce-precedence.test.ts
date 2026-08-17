import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `x ?? 0 + $inc` PARSES AS `x ?? (0 + $inc)`, SO EXISTING ROWS NEVER INCREMENT.
 *
 * In SurrealDB, `+` binds tighter than `??`. An UPSERT written as
 *
 *     success_count: (SELECT VALUE success_count FROM ONLY t:[...]) ?? 0 + $success_increment
 *
 * therefore means: if the row exists, take its CURRENT count and discard the increment; only
 * if it is absent compute `0 + $inc`. New rows look perfectly correct, which is the entire
 * reason this survived — the defect is invisible on any test that inserts and reads back once.
 * On `alpha` it is worse: `?? 0 + $inc + 1` drops the `+ 1` too, so an existing arm's alpha is
 * assigned a raw success_count.
 *
 * WHY A DETECTOR RATHER THAN A THIRD FIX. `db/paradigm.ts` was corrected earlier, with the
 * diagnosis written into a comment above the query. The same UPSERT existed in TWO other
 * copies — `routes/activities.scoring.ts` (reached from POST /executions) and an inline copy
 * in `routes/activities.ts` (reached from POST /shape-scores) — and both were still broken,
 * across 8 sites total. Fixing one copy of a duplicated query does not fix the query; a
 * comment recording the diagnosis is read only by whoever opens that file.
 *
 * This is also why the sweep is by REGEX over the whole tree rather than by a list of known
 * files: the audit that found this named the first line of each copy, and there were four
 * sites in each. An enumeration written from a report is an enumeration of what the report
 * happened to quote.
 */

const SRC = new URL('../', import.meta.url).pathname;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** `) ?? 0 + $something` — the coalesce closing OUTSIDE the addition. */
const BROKEN = /\)\s*\?\?\s*0\s*\+\s*\$/;

/** `) ?? 0) + $something` — the coalesce closing BEFORE the addition. */
const FIXED = /\)\s*\?\?\s*0\)\s*\+\s*\$/;

describe('SurrealDB coalesce precedence in accumulator UPSERTs', () => {
  it('guards the scan: it can see the source tree at all', () => {
    const files = tsFiles(SRC);
    // Without this, a broken path makes every assertion below pass vacuously — the exact
    // shape of failure this file exists to prevent elsewhere.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('db/paradigm.ts'))).toBe(true);
  });

  it('THE REGRESSION: no accumulator coalesces outside its addition', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith('coalesce-precedence.test.ts'))
      .filter((f) => BROKEN.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(SRC, 'src/'));
    // Was: src/routes/activities.ts (4 sites), src/routes/activities.scoring.ts (4 sites).
    expect(offenders).toEqual([]);
  });

  it('the corrected idiom is actually present — not merely absent-of-broken', () => {
    // A file with no accumulator at all also has no BROKEN match. Asserting the positive
    // form proves the check is looking at live code rather than passing on emptiness.
    const withFixed = tsFiles(SRC).filter((f) => FIXED.test(readFileSync(f, 'utf8')));
    expect(withFixed.length).toBeGreaterThanOrEqual(3);
  });

  it('NEGATIVE CONTROL: the pattern distinguishes the two forms', () => {
    // Before trusting a clean sweep, prove a dirty tree would be detected.
    const broken = 'success_count: (\n SELECT VALUE x FROM ONLY t\n) ?? 0 + $inc,';
    const fixed = 'success_count: ((\n SELECT VALUE x FROM ONLY t\n) ?? 0) + $inc,';
    expect(BROKEN.test(broken)).toBe(true);
    expect(BROKEN.test(fixed)).toBe(false);
    expect(FIXED.test(fixed)).toBe(true);
    expect(FIXED.test(broken)).toBe(false);
  });

  it('the three copies of this UPSERT agree on the idiom', () => {
    // The deeper defect is that one query is written out three times. Until they are one
    // function, this asserts they cannot drift apart again on THIS axis.
    const copies = [
      'db/paradigm.ts',
      'routes/activities.scoring.ts',
      'routes/activities.ts',
    ].map((rel) => readFileSync(join(SRC, rel), 'utf8'));
    for (const src of copies) {
      expect(src).toContain('impulse_shape_activity_score:[$org_id, $shape, $activity_id]');
      expect(BROKEN.test(src)).toBe(false);
    }
  });
});
