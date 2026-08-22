/**
 * The posterior lookup must match the org_id form the rows are actually stored in.
 *
 * THE REGRESSION THIS PINS — measured on the live database 2026-08-22:
 *
 *   variant_performance_metrics.org_id, by count:
 *     organizations:substrate   3275
 *     organizations:metabob       76
 *     public                      17
 *     metabob_internal             1
 *     unknown                      1
 *
 *   SELECT count() ... WHERE account_id IS NONE AND org_id = 'substrate'                ->     0
 *   SELECT count() ... WHERE account_id IS NONE AND org_id = 'organizations:substrate'  -> 3275
 *
 * `getCanonicalPosteriors` STRIPS the `organizations:` prefix before binding $org_id, so
 * it bound 'substrate' and matched nothing — on every call. Its own doc comment states
 * the consequence: "an empty map means every caller falls back to the uninformative
 * prior". That is precisely what selection did: every Thompson draw used Beta(1,1) plus
 * heuristic boosts, observed live as alpha=4.0/beta=1.0 for an arm whose stored posterior
 * was alpha=23.76/beta=10.86. beta stayed pinned at 1.0 because no failure evidence could
 * ever reach the draw.
 *
 * The strip was a deliberate back-compat shim (see the comment at the legacy fallback:
 * "Legacy table may have existing data with plain strings / TODO: after migrating to
 * record format, use orgId directly"). The migration happened; the shim outlived it and
 * now matches the 19-row minority while orphaning the 3,351-row majority. So the fix is
 * to match BOTH forms, not to swap one for the other — which is why the plain-string case
 * below is a first-class assertion and not an afterthought.
 *
 * TESTED AT THE CONSUMING LAYER, deliberately. The mock does not merely record the SQL —
 * it FILTERS rows by the bound parameters the way SurrealDB would. A test that asserted on
 * query text would pass on any string containing "org_id" and would not have caught this.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// See the note in variant-creator.retire-by-posterior.test.ts: config.ts throws at import
// time without these, and a sibling test restores them to undefined, so set them
// unconditionally rather than with ??=.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

interface Row {
  variant_id: string;
  org_id: string;
  account_id: string | null;
  thompson_alpha: number;
  thompson_beta: number;
}

/** Rows as the live table actually stores them. */
let rows: Row[] = [];
const captured: { sql: string; params: any }[] = [];

/**
 * Stand-in for SurrealDB's WHERE evaluation over the two org_id predicates the posterior
 * lookup can emit. Any bound parameter whose name starts with `org_id` is treated as an
 * accepted org form — that is exactly the widening the fix introduces, and it lets this
 * test pass for any correct implementation rather than pinning one spelling.
 */
function evaluate(sql: string, params: any): Row[] {
  if (!/FROM variant_performance_metrics/i.test(sql)) return [];
  const orgForms = Object.entries(params ?? {})
    .filter(([k, v]) => k.startsWith('org_id') && typeof v === 'string')
    .map(([, v]) => v as string);
  const accountId = params?.account_id ?? null;
  const ids: string[] = params?.activity_ids ?? [];
  return rows.filter((r) => {
    const idOk = ids.length === 0 || ids.includes(r.variant_id);
    const tenantOk =
      (accountId !== null && r.account_id === accountId) ||
      (r.account_id === null && orgForms.includes(r.org_id));
    return idOk && tenantOk;
  });
}

// A MODULE MOCK MUST EXPORT EVERYTHING THE REAL MODULE DOES.
//
// The first version of this file omitted `dbStats` and `getDbStats`, which broke
// unrelated suites in a full `bun test` run while passing in isolation — and
// substrate-pull-sync correctly refused to converge on it. This repo has a
// meta-test that enumerates the omissions ("mocks '../db/surreal' but omits:
// getDbStats, dbStats"); that guard is what caught it, so keep this list in sync
// with `src/db/surreal.ts`'s exports rather than trimming it to what this file
// happens to use.
const dbStatsStub = {
  snapshot: () => ({}),
  record: () => {},
  reset: () => {},
};

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      captured.push({ sql, params });
      return evaluate(sql, params);
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
  dbStats: dbStatsStub,
  getDbStats: () => ({}),
}));

const { getActivityScores } = await import('./paradigm');

beforeEach(() => {
  captured.length = 0;
  rows = [];
});

describe('posterior lookup org_id binding', () => {
  test('THE REGRESSION: a prefixed-org row is found when the caller passes the prefixed org', async () => {
    rows = [
      {
        variant_id: 'detect-vessel-code-drift',
        org_id: 'organizations:substrate',
        account_id: null,
        thompson_alpha: 23.76,
        thompson_beta: 10.86,
      },
    ];

    const res = await getActivityScores(
      'organizations:substrate',
      ['detect-vessel-code-drift'],
      undefined,
      null,
    );

    // Before the fix this returned nothing, and selection fell back to Beta(1,1).
    const hit = (res?.data ?? []).find((r: any) =>
      String(r.activity_id ?? r.variant_id).includes('detect-vessel-code-drift'),
    );
    expect(hit).toBeDefined();
    expect(Number((hit as any).thompson_alpha ?? (hit as any).alpha)).toBeCloseTo(23.76, 2);
    expect(Number((hit as any).thompson_beta ?? (hit as any).beta)).toBeCloseTo(10.86, 2);
  });

  test('the bare org form is also passed to the caller (prefixed input)', async () => {
    rows = [];
    await getActivityScores('organizations:substrate', ['x'], undefined, null);
    const q = captured.find((c) => /FROM variant_performance_metrics/i.test(c.sql));
    expect(q).toBeDefined();
    const orgForms = Object.entries(q!.params ?? {})
      .filter(([k]) => k.startsWith('org_id'))
      .map(([, v]) => v);
    // BOTH forms must be bound: the prefixed one for the 3,351-row majority and the bare
    // one for the 19 legacy plain-string rows. Binding only one orphans the other.
    expect(orgForms).toContain('organizations:substrate');
    expect(orgForms).toContain('substrate');
  });

  test('legacy plain-string rows still match (the shim\'s original purpose)', async () => {
    rows = [
      {
        variant_id: 'legacy-arm',
        org_id: 'public',
        account_id: null,
        thompson_alpha: 5,
        thompson_beta: 2,
      },
    ];
    const res = await getActivityScores('public', ['legacy-arm'], undefined, null);
    expect((res?.data ?? []).length).toBeGreaterThan(0);
  });

  test('NEGATIVE CONTROL: another org\'s rows are NOT returned', async () => {
    rows = [
      {
        variant_id: 'other-org-arm',
        org_id: 'organizations:metabob',
        account_id: null,
        thompson_alpha: 99,
        thompson_beta: 1,
      },
    ];
    const res = await getActivityScores(
      'organizations:substrate',
      ['other-org-arm'],
      undefined,
      null,
    );
    // Widening the org match must not widen it across tenants.
    expect((res?.data ?? []).length).toBe(0);
  });

  test('NEGATIVE CONTROL: an empty table yields no rows rather than a fabricated prior', async () => {
    rows = [];
    const res = await getActivityScores('organizations:substrate', ['nothing'], undefined, null);
    expect((res?.data ?? []).length).toBe(0);
  });
});
