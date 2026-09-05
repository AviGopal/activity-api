/**
 * goal_hash must key a goal CLASS, not a goal INSTANCE.
 *
 * goal_execution_paths is the surface Thompson learns pathway reuse over, and it is keyed by
 * goal_hash. Gap-closing goals embed a unique gap id — "Close substrate gap route-edit-5994fcfb:
 * …" — so before this change every single one hashed to its own row.
 *
 * Measured 2026-08-05 over the live path store: the close-substrate-gap family held 2,145
 * DISTINCT paths across 3,102 executions. That is 1.4 executions per path, and 647 of those paths
 * were route-edit variants of one another. A Beta posterior over a singleton is just its prior, so
 * the largest goal family in the substrate could never learn or reuse a pathway — every instance
 * paid the full fresh-derivation cost and the family sat at 5.1% reach.
 *
 * The rule is asserted against normalizeGoal's OBSERVABLE BEHAVIOUR (same class → same hash,
 * different class → different hash) rather than against a specific digest, so the test survives a
 * change of hash function and fails only if the class/instance distinction breaks.
 */
import { describe, expect, it } from 'bun:test';

/**
 * Mirror of normalizeGoal in ../goal-paths.ts. It is module-private there; the source assertions
 * at the bottom of this file keep the mirror honest, so a drift in the route shows up as a
 * failure here rather than as silently passing behavioural tests.
 */
function normalizeGoal(goal: string): string {
  return goal
    .toLowerCase()
    .trim()
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/\b[0-9a-f]{8,}(?::\d+)?\b/g, (m) => (/\d/.test(m) ? 'id' : m))
    .replace(/\b\d{10,}\b/g, 'n')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, '_');
}

describe('goal_hash collapses instances onto a class', () => {
  it('collapses route-edit gap ids — the 647-path case', () => {
    const a = normalizeGoal('Close substrate gap route-edit-5994fcfb:21-compose-report');
    const b = normalizeGoal('Close substrate gap route-edit-477438a2:16-compose-report');
    expect(a).toBe(b);
  });

  it('collapses a long execution/commit id', () => {
    const a = normalizeGoal('reinforce composition activity 4458130d7fc0ed7ec8d351b462b4c0094b114c30');
    const b = normalizeGoal('reinforce composition activity b230667a1c9d4e5f6a7b8c9d0e1f2a3b4c5d6e7f');
    expect(a).toBe(b);
  });

  it('collapses epoch-millisecond timestamps', () => {
    const a = normalizeGoal('close substrate gap novel-failure-satisfier|unknown-1785587617261');
    const b = normalizeGoal('close substrate gap novel-failure-satisfier|unknown-1785910849845');
    expect(a).toBe(b);
  });

  // The collapse must not become a shredder. Two goals that differ in MEANING have to stay
  // distinct, or the walk would reuse a pathway learned for an unrelated goal — which is a worse
  // failure than not learning at all.
  it('KEEPS genuinely different goals apart', () => {
    expect(normalizeGoal('close substrate gap route-edit-5994fcfb')).not.toBe(
      normalizeGoal('close substrate gap orphaned-capability-obsidian'),
    );
    expect(normalizeGoal('report the total number of files')).not.toBe(
      normalizeGoal('report the total number of commits'),
    );
  });

  // An all-letter hex run is an ordinary English-ish word far more often than it is an id, so the
  // digit requirement is load-bearing, not decoration.
  it('leaves all-letter hex words alone', () => {
    expect(normalizeGoal('the deadbeef case')).toContain('deadbeef');
    expect(normalizeGoal('facade effaced')).toContain('facade');
  });

  // Short hex must survive: a 6-char token is far more likely to be a word or a short abbrev than
  // a gap id, and collapsing it would merge unrelated goals.
  it('leaves short hex runs alone', () => {
    expect(normalizeGoal('bug ab12cd')).toContain('ab12cd');
  });

  it('is idempotent — re-normalizing an already-collapsed goal is a no-op', () => {
    const once = normalizeGoal('close substrate gap route-edit-5994fcfb');
    expect(normalizeGoal(once)).toBe(once);
  });
});

describe('goal-paths route wiring', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(import.meta.dir, '..', 'goal-paths.ts'),
    'utf8',
  );

  it('elides identifiers BEFORE stripping punctuation', () => {
    // Punctuation removal would weld a gap id onto its neighbouring words ("gap route-edit-5994fcfb"
    // becomes "gap_routeedit5994fcfb"), destroying the \b boundaries the elision relies on. Order
    // is the whole correctness argument.
    const start = src.indexOf('function normalizeGoal');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body.indexOf('[0-9a-f]{8,}')).toBeLessThan(body.indexOf('[^\\w\\s]'));
  });

  it('requires a digit in the elided hex run', () => {
    expect(src).toContain("/\\d/.test(m)");
  });

  // THE MIRROR MUST EQUAL THE SHIPPED FUNCTION, TRANSFORM FOR TRANSFORM.
  //
  // The two assertions above check invariants of the source TEXT (ordering, and that one
  // substring is present). Neither compares the mirror to the source, so the file's own claim
  // that they "keep the mirror honest" did not hold. Measured 2026-09-05: the shipped
  // normalizeGoal had FIVE .replace() calls after e340ad3 added the leading-bracket strip,
  // the mirror had FOUR, and both assertions passed while every behavioural test above ran
  // against the stale copy. That is why two inert commits to this function (3a92282,
  // b9fc69d) passed the test gate — a test that mirrors its subject cannot fail for a change
  // to the subject.
  //
  // This compares the .replace() chains directly. It is deliberately structural rather than
  // behavioural: the mirror exists only because normalizeGoal is module-private, so the real
  // fix is to export it and import it here. Until then, this assertion is what makes the
  // mirror honest in fact rather than by assertion.
  it('mirror matches the shipped normalizeGoal transform-for-transform', () => {
    const chainOf = (text: string): string[] => {
      const start = text.indexOf('function normalizeGoal');
      const body = text.slice(start, text.indexOf('\n}', start));
      return (body.match(/\.replace\([^\n]*/g) ?? []).map((s) => s.replace(/\s*\/\/.*$/, '').trim());
    };
    const mirrorSrc = require('node:fs').readFileSync(import.meta.path, 'utf8');
    expect(chainOf(mirrorSrc)).toEqual(chainOf(src));
  });
});
