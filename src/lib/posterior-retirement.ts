/**
 * The tenant scope and retirement predicate for variant_performance_metrics, as SurrealQL text,
 * shared by the per-arm retire path (services/variant-creator.ts), getVariantScores' fallback
 * (db/paradigm.ts) and the read-only retirement dry-run below.
 *
 * WHY THE ORG CLAUSE NORMALISES BOTH SIDES. variant_performance_metrics.org_id is stored with the
 * `organizations:` prefix on nearly every row (7,562 of 7,581 measured) and bare on a legacy few,
 * and account_id is NONE on all of them. Both readers bound the STRIPPED org and compared it to the
 * raw column, so they matched only the legacy few: retire-by-posterior found no row for almost every
 * arm and returned false, so no arm was ever retired by it, and the fallback missed prefixed rows.
 * Stripping the prefix inside the clause, on the column AND on the bound value, matches either
 * spelling whichever form a caller binds.
 *
 * It lives in its own module, not in variant-creator.ts, because seven test files mock that module
 * with fixed factories and mock-module-completeness requires every real export to appear in each.
 */

/** Binds $account_id (bind NULL, never NONE: `account_id = NONE` is true on every row) and $org_id. */
export const VPM_TENANT_SCOPE_SQL =
  `((account_id = $account_id) OR (account_id IS NONE AND ` +
  `string::replace(org_id ?? '', 'organizations:', '') = string::replace($org_id ?? '', 'organizations:', '')))`;

/** In-code fallbacks for the two tuning rows the retire path reads (substrate_tuning_param). */
export const RETIREMENT_MIN_EXECUTIONS_DEFAULT = 20;
export const RETIREMENT_SUCCESS_FLOOR_DEFAULT = 0.3;

/**
 * The retire path's verdict on one metrics row, in SurrealQL: at least $min_executions runs and a
 * posterior mean alpha/(alpha+beta) below $success_floor, with the same defaults the JS verdict
 * applies to a missing column (0 executions, alpha 1, beta 1) and the same refusal of a
 * non-positive alpha or beta. The real-engine test pins that the two agree.
 */
export const RETIREMENT_POSTERIOR_SQL =
  `(total_executions ?? 0) >= $min_executions` +
  ` AND (thompson_alpha ?? 1) > 0 AND (thompson_beta ?? 1) > 0` +
  ` AND (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1)) < $success_floor`;

/** variant_id to the bare arm id, as the retire path derives it (activity: prefix and ⟨⟩` removed). */
const BARE_ARM_SQL =
  "string::replace(string::replace(string::replace(string::replace(variant_id ?? '', 'activity:', ''), '⟨', ''), '⟩', ''), '`', '')";

/**
 * READ-ONLY dry-run: every arm in one tenant that would retire on its next graded failure, named.
 * Binds $org_id, $account_id (NULL), $min_executions, $success_floor. "Not yet retired" mirrors the
 * retire UPDATE: the activity record exists and its retired flag is false or NONE. An arm can appear
 * once per metrics row; the retire path reads one row per arm (LIMIT 1), so dedupe by `arm`.
 */
export const RETIREMENT_DRY_RUN_SQL =
  `SELECT arm, variant_id, org_id, total_executions, thompson_alpha, thompson_beta, posterior_mean FROM (` +
  ` SELECT variant_id, org_id, total_executions, thompson_alpha, thompson_beta,` +
  ` ${BARE_ARM_SQL} AS arm,` +
  ` (thompson_alpha ?? 1) / ((thompson_alpha ?? 1) + (thompson_beta ?? 1)) AS posterior_mean` +
  ` FROM variant_performance_metrics` +
  ` WHERE ${VPM_TENANT_SCOPE_SQL} AND ${RETIREMENT_POSTERIOR_SQL}` +
  ` ) WHERE type::thing('activity', arm).id != NONE` +
  ` AND (type::thing('activity', arm).retired = false OR type::thing('activity', arm).retired IS NONE)` +
  ` ORDER BY posterior_mean ASC`;
