/**
 * Pins the SAFETY BOUNDARY of mint dedup, and the entry-gate widening of 2026-08-11.
 *
 * THE DEFECT: the dedup path was entered only when the incoming name or id ended in a
 * `-<timestamp>` run of >=10 digits. Measured on the live catalogue, that pattern matched
 * 1,623 historical rows and ZERO of the 95 templates minted in the last week — the compose
 * loop stopped emitting timestamp-suffixed names, so a working matcher sat aimed at a
 * population that had moved while 162 exact-duplicate-NAME families (1,293 rows)
 * accumulated. Each unmerged duplicate is a fresh Beta(1,1) cell splitting Thompson
 * traffic (law 3).
 *
 * NO BEHAVIOUR CHANGED. Widening the entry gate so un-suffixed duplicate names also
 * dedup was tried and REVERTED: it broke the deliberate contract pinned by the sibling
 * suite `activities-mint-dedup.test.ts` ("un-suffixed names never trigger the dedup
 * candidate query") — baseline 4/4 pass, widened 3 pass / 1 fail. That is a design
 * decision with a real cost (a SELECT on every mint), so it is filed as a gap rather
 * than taken unilaterally.
 *
 * What remains is a behaviour-preserving extraction: the match predicate was inline in
 * the route handler and therefore unassertable. These tests pin the invariant that makes
 * ANY future widening safe — a merge requires an identical shape signature, so two rows
 * sharing only a name are never collapsed onto one posterior. That is the property to
 * check first if the widening is ever taken.
 *
 * Complementary, not duplicative: the sibling suite drives the whole route with a mocked
 * SurrealDB and covers the ENTRY GATE; this one covers the predicate the gate guards.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

// `activities.ts` pulls in the DB config at import time, which throws without
// SURREALDB_*. Defer the import into beforeAll behind the env the module requires —
// the same pattern the other route-level tests in this repo use.
let selectDedupTarget: typeof import('./activities').selectDedupTarget;
let shapeSignature: typeof import('./activities').shapeSignature;
let TS_SUFFIX_RE: typeof import('./activities').TS_SUFFIX_RE;

beforeAll(async () => {
  process.env.SURREALDB_URL ||= 'ws://localhost:8000';
  process.env.SURREALDB_NAMESPACE ||= 'activity-system';
  process.env.SURREALDB_DATABASE ||= 'learning_loop';
  process.env.SURREALDB_USERNAME ||= 'test';
  process.env.SURREALDB_PASSWORD ||= 'test';
  process.env.JWT_SECRET ||= 'dev-only-jwt-secret-do-not-use-in-prod';
  ({ selectDedupTarget, shapeSignature, TS_SUFFIX_RE } = await import('./activities'));
});

const row = (id: string, name: string, input: string[] = ['a'], output: string[] = ['b']) =>
  ({ id_str: id, name, input_shapes: input, output_shapes: output });

const opts = (over: Partial<{ normalizedName: string; incomingSig: string; activityId: string }> = {}) => ({
  normalizedName: 'aggregate-report',
  incomingSig: 'a|b',
  activityId: 'incoming-id',
  ...over,
});

describe('selectDedupTarget — the merges it MUST refuse', () => {
  test('same name, DIFFERENT shape signature → no merge (distinct capabilities)', () => {
    const cands = [row('other-id', 'aggregate-report', ['a'], ['DIFFERENT'])];
    expect(selectDedupTarget(cands, opts())).toBeUndefined();
  });

  test('a near-miss name is not a match', () => {
    const cands = [row('other-id', 'aggregate-report-v2')];
    expect(selectDedupTarget(cands, opts())).toBeUndefined();
  });

  test('never merges a row onto itself', () => {
    const cands = [row('incoming-id', 'aggregate-report')];
    expect(selectDedupTarget(cands, opts())).toBeUndefined();
  });

  test('a candidate with no id is not a merge target', () => {
    const cands = [{ ...row('', 'aggregate-report'), id_str: '' }];
    expect(selectDedupTarget(cands, opts())).toBeUndefined();
  });

  test('empty / null / undefined candidate sets are handled, not thrown on', () => {
    expect(selectDedupTarget([], opts())).toBeUndefined();
    expect(selectDedupTarget(null, opts())).toBeUndefined();
    expect(selectDedupTarget(undefined, opts())).toBeUndefined();
  });
});

describe('selectDedupTarget — the merges it must PERFORM', () => {
  test('an exact duplicate NAME with no timestamp suffix WOULD be a valid merge target', () => {
    // The 162-family / 1,293-row population. The predicate would accept these; the ENTRY
    // GATE is what keeps them out, and it is unchanged. This documents what a future
    // widening would unlock — it asserts nothing about current runtime behaviour.
    const cands = [row('older-id', 'aggregate-report')];
    expect(selectDedupTarget(cands, opts())?.id_str).toBe('older-id');
  });

  test('still merges the original timestamp-suffixed sibling', () => {
    const cands = [row('older-id', 'aggregate-report-1753657200123')];
    expect(selectDedupTarget(cands, opts())?.id_str).toBe('older-id');
  });

  test('prefers the EXACT normalized name over a timestamp-suffixed sibling', () => {
    const cands = [row('suffixed', 'aggregate-report-1753657200123'), row('exact', 'aggregate-report')];
    expect(selectDedupTarget(cands, opts())?.id_str).toBe('exact');
  });

  test('shape comparison is order-insensitive — a reordered list is the same capability', () => {
    const cands = [row('older-id', 'aggregate-report', ['b', 'a'], ['d', 'c'])];
    expect(selectDedupTarget(cands, opts({ incomingSig: 'a,b|c,d' }))?.id_str).toBe('older-id');
  });
});

describe('supporting predicates', () => {
  test('TS_SUFFIX_RE needs >=10 digits, anchored at the end', () => {
    expect(TS_SUFFIX_RE.test('x-1753657200123')).toBe(true);
    expect(TS_SUFFIX_RE.test('x-123')).toBe(false);
    expect(TS_SUFFIX_RE.test('x-1753657200123-tail')).toBe(false);
  });

  test('shapeSignature sorts and tolerates non-arrays', () => {
    expect(shapeSignature(['b', 'a'])).toBe('a,b');
    expect(shapeSignature(undefined)).toBe('');
    expect(shapeSignature('nope')).toBe('');
  });
});
