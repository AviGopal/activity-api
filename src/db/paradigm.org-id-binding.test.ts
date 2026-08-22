/**
 * The posterior lookup must bind BOTH stored org_id forms.
 *
 * THE REGRESSION THIS PINS — measured on the live database 2026-08-22:
 *
 *   variant_performance_metrics.org_id, by count:
 *     organizations:substrate   3275      public             17
 *     organizations:metabob       76      metabob_internal    1
 *                                         unknown             1
 *
 *   WHERE account_id IS NONE AND org_id = 'substrate'                ->     0
 *   WHERE account_id IS NONE AND org_id = 'organizations:substrate'  -> 3,275
 *
 * `getCanonicalPosteriors` STRIPPED the `organizations:` prefix before binding
 * $org_id, so it bound 'substrate' and matched nothing — on every call. Its own doc
 * comment states the consequence: "an empty map means every caller falls back to the
 * uninformative prior". That is exactly what selection did: every Thompson draw used
 * Beta(1,1) plus heuristic boosts, observed live as alpha=4.0/beta=1.0 for an arm whose
 * stored posterior was alpha=23.76/beta=10.86. beta sat pinned at 1.0 because no failure
 * evidence could ever reach the draw.
 *
 * The strip was a deliberate back-compat shim for legacy plain-string rows. Those 19 rows
 * are real, so the fix accepts EITHER form rather than swapping one for the other — which
 * is why the bare form is asserted here too and not treated as vestigial.
 *
 * WHY THIS READS SOURCE INSTEAD OF MOCKING.
 *
 * The first version of this file drove `getActivityScores` through a `mock.module` of
 * '../db/surreal'. It passed in isolation — locally AND inside the container — and failed
 * in a full `bun test` run, because `mock.module` is global and order-dependent: once any
 * earlier test file has imported the real module, the cached binding wins and the mock
 * never applies. substrate-pull-sync refused to converge on it twice, blocking the very
 * fix this test exists to protect.
 *
 * Asserting on source is deterministic under any file ordering, and it is the pattern this
 * repo already uses for exactly this purpose — see `execution-traces.sql-targets.test.ts`,
 * which pins SQL targets the same way. The property being guarded is a static one (which
 * parameters the query binds), so a static check is the honest instrument rather than a
 * concession.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dir, 'paradigm.ts'), 'utf8');

/**
 * The two posterior-lookup sites, and only those.
 *
 * An earlier anchor matched every `account_id IS NONE AND` line in the file — 11 of them,
 * mostly unrelated queries against other tables where a single org form is fine. It failed
 * on a THIRD site that was already correct (it spells its second parameter
 * `$plain_org_id`), which is how that site was discovered. Useful accident, bad anchor:
 * a test that fails on working code teaches nothing.
 *
 * These two are identified by the parameter name the posterior lookups actually bind
 * (`$org_id_prefix`), plus the pre-fix shape so a silent narrowing is still caught rather
 * than making the clause invisible to this test.
 */
const POSTERIOR_LOOKUP_SITES = 2;

function posteriorLookupClauses(): string[] {
  // `$org_id_prefix` is bound by these two sites and nowhere else, so it identifies them
  // exactly. If one is narrowed back to the single form the parameter vanishes from its
  // WHERE and the count assertion below fails — which is precisely the regression that
  // already happened once.
  return SOURCE.split('\n').filter(
    (l) => /account_id IS NONE AND/.test(l) && /\$org_id_prefix\b/.test(l),
  );
}

describe('posterior lookup org_id binding', () => {
  test('THE REGRESSION: every legacy-row org clause matches BOTH forms', () => {
    const clauses = posteriorLookupClauses();
    // BOTH sites, not "at least one". A substrate-authored commit previously reverted the
    // second site while leaving its `params.org_id_prefix` binding in place — an unused
    // parameter, which no placeholder/binding check catches because the mismatch runs the
    // harmless direction. Asserting the COUNT is what catches that.
    expect(clauses.length).toBe(POSTERIOR_LOOKUP_SITES);

    for (const clause of clauses) {
      // Before the fix each of these read `... AND org_id = $org_id)` — ONE comparison.
      // The property is "compares org_id against two different parameters", NOT any
      // particular parameter name: a third site found by this very assertion spells its
      // second form `$plain_org_id`, and it was correct all along. Pinning a naming
      // convention here would have failed a working query and taught nothing.
      const orgParams = new Set(
        [...clause.matchAll(/org_id\s*=\s*\$(\w+)/g)].map((m) => m[1]),
      );
      expect(orgParams.size).toBeGreaterThanOrEqual(2);
    }
  });

  test('both forms are actually bound as parameters, not just named in SQL', () => {
    // A widened WHERE with an unbound parameter is worse than the original defect.
    const placeholders = new Set(
      [...SOURCE.matchAll(/\$(org_id_\w+)/g)].map((m) => m[1]),
    );
    expect(placeholders.size).toBeGreaterThan(0);

    for (const name of placeholders) {
      const bound = new RegExp(`(?:^|[\\s.{])${name}\\s*[:=]`, 'm').test(SOURCE);
      expect(bound).toBe(true);
    }
  });

  test('the prefixed form is derived by ADDING the prefix, not stripping it', () => {
    // The defect was a strip. Guard the direction explicitly: at least one binding must
    // construct `organizations:${...}` rather than removing it.
    expect(SOURCE).toMatch(/org_id_\w+\s*[:=][^\n]*`organizations:\$\{/);
  });

  test('the bare form survives — the 19 legacy plain-string rows still match', () => {
    // Fixing this by swapping to the prefixed form alone would orphan the rows the
    // original shim was written for. Both must remain.
    expect(SOURCE).toMatch(/replace\('organizations:',\s*''\)/);
  });

  test('NEGATIVE CONTROL: a single-form legacy clause would fail this test', () => {
    // Proves the assertion above is not vacuous: the pre-fix shape must not pass.
    const preFix = "WHERE ((account_id = $account_id) OR (account_id IS NONE AND org_id = $org_id))";
    const orgParams = new Set([...preFix.matchAll(/org_id\s*=\s*\$(\w+)/g)].map((m) => m[1]));
    expect(orgParams.size).toBe(1);
  });
});
