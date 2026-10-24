/**
 * traceAggregateReport — FAST server-side aggregate over execution traces.
 *
 * The operator data-report goal class ("the 5 templates with the highest
 * failure counts in 24h", "total cost grouped by tier over 24h", "executions
 * per status this week") was going HOLLOW because the only path the
 * decomposition planner had was `executionTraceWithSignatures` — a RAW-TRACE
 * fetch (+ per-impulse signature hydration) that ships up to 500 rows to the
 * LLM and asks it to aggregate. Over a 269K-row trace table that path TIMES OUT
 * (40s+, HTTP 000 under load) and the report comes back empty / meta-commentary.
 *
 * This resolver does the GROUP BY / COUNT / SUM **in SurrealDB**, on the indexed
 * `executed_at` column (composite indexes like idx_aet_activity_success_time
 * cover the (activity_id, success, executed_at) shape), and returns a small,
 * already-aggregated result. The format/LLM step then just renders a handful of
 * pre-computed rows — fast, bounded, and load-robust.
 *
 * Pointer contract (all optional except sensible defaults):
 *   {
 *     type: "traceAggregateReport",
 *     group_by?: "activity_id" | "status" | "variant_id" | "failure_class" | "goal_hash",
 *                                                            // default activity_id
 *     metric?: "count" | "failure_count" | "success_count" | "cost_sum"
 *                                                            // default count
 *     window_hours?: number,    // default 24, clamped [1, 720]
 *     limit?: number,           // default 10, clamped [1, MAX_GROUPS] (20000)
 *     order?: "desc" | "asc",   // default desc (highest first)
 *     tag?: string,             // only rows whose tags CONTAIN this exact tag (e.g. "state_signature:<sig>")
 *     group_by_tag?: string,    // a tag key (e.g. "dispatcher_used"): also group by the value of the row's first
 *                               // "<key>:<value>" tag; each row then carries tag_value (the value, or null when none)
 *     exclude_observe?: boolean, // default true: observe executions are not counted (false counts them too)
 *     success_rule?: "success_flag" | "status_or_flag" | "reached",
 *                               // what success_count / failure_count count as a success; default success_flag
 *   }
 * Every one of the last four is optional and a call without them is unchanged. A present but malformed one is refused
 * (measured: false + reason), never dropped: a tag filter silently ignored would count the whole window as if it
 * matched.
 *
 * Returns a structured object the format step can render directly:
 *   {
 *     metric, group_by, window_hours, generated_at,
 *     rows: [{ key, value }],   // already sorted + capped
 *     total_groups, query_ms,
 *     measured, matched_total   // matched_total: rows the window matched, for every metric
 *   }
 * On no data it returns rows: [] with a clear `empty: true` flag — NEVER a
 * timeout / HTTP 000 / false-zero. count() failures surface as null, not 0.
 *
 * Read-only, pure (takes a Surreal client + parsed pointer). Auth/scoping is
 * applied by the caller exactly like executionTraceWithSignatures.
 */

import type { Surreal } from 'surrealdb';
import { logger } from '../utils/logger';
import { OBSERVE_TRACE_TAGS } from '../lib/reach-classify';

export interface TraceAggregateReportInput {
  group_by?: string;
  metric?: string;
  window_hours?: number;
  limit?: number;
    order?: string;
  failure_class?: string;
  reason_contains?: string;
  until_hours_ago?: number;
  tag?: unknown;
  group_by_tag?: unknown;
  exclude_observe?: unknown;
  success_rule?: unknown;
}

export interface TraceAggregateAuthContext {
  orgId: string;
  accountId?: string | null;
  authType?: 'jwt' | 'apikey' | 'minibob_token';
}

export interface TraceAggregateRow {
  key: string;
  value: number;
  /** Only when group_by_tag was asked: the value of the row group's `<group_by_tag>:<value>` tag, null when none. */
  tag_value?: string | null;
}

export interface TraceAggregateReport {
  shape: 'traceAggregateReport';
  metric: string;
  group_by: string;
  window_hours: number;
  until_hours_ago?: number;
  generated_at: string;
  rows: TraceAggregateRow[];
  /** Total distinct groups BEFORE the limit cap — not merely rows.length. */
  total_groups: number;
  /** True when `rows` was capped at `limit` and more groups exist. */
  truncated: boolean;
  empty: boolean;
  query_ms: number;
  measured: boolean;
  matched_total: number | null;
  reason?: string;
  // Echoed only when the caller supplied them, so a call without them returns the same object as before they existed.
  tag?: string;
  group_by_tag?: string;
  exclude_observe?: boolean;
  success_rule?: string;
}

const GROUP_FIELDS = new Set(['activity_id', 'status', 'variant_id', 'failure_class', 'goal_hash']);
const METRICS = new Set(['count', 'failure_count', 'success_count', 'cost_sum']);
// What success_count / failure_count count as a success. success_flag is the stored `success` boolean (the default, and
// the only rule before these existed). status_or_flag is the rule boredom-vessel's posterior fetchers apply to the trace
// list: status success|completed, or success = true. reached is the stored reach verdict (`reached`, option<bool>): a
// row with no verdict (NONE) is neither a success nor a failure under it.
const SUCCESS_RULES = new Set(['success_flag', 'status_or_flag', 'reached']);
const SUCCESS_STATUSES = ['success', 'completed'];
const TAG_KEY = /^[A-Za-z0-9_.-]+$/;

// The most groups one report returns. The query groups EVERY matching row in the database either way (the cap is
// applied in JS below), so this bounds the response, not the database work. It was 1000, which is below the number
// of distinct activity_ids in a 720 h window, so every 30-day per-template count came back truncated and its readers
// (development-vessel's reachable-unlearned report and health tick) had to call their counts UNMEASURED. A reader
// that needs every group asks for this many and still checks `truncated`: past the cap the report says so.
const MAX_GROUPS = 20000;

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Build + run the aggregate. The query is shaped so SurrealDB can use the
 * `executed_at` (or composite activity/success/executed_at) index for the
 * window filter, then GROUP BY the requested dimension server-side.
 */
export async function runTraceAggregateReport(
  db: Surreal,
  rawInput: unknown,
  auth: TraceAggregateAuthContext,
): Promise<TraceAggregateReport> {
  const input = (rawInput ?? {}) as TraceAggregateReportInput;

  // An omitted group_by is the documented default; a present one must be served.
  const groupByOmitted = input.group_by == null || String(input.group_by) === '';
  const groupBy = groupByOmitted ? 'activity_id' : String(input.group_by);
  const metric = METRICS.has(String(input.metric)) ? String(input.metric) : 'count';
  const windowHours = clampInt(input.window_hours, 24, 1, 720);
  const limit = clampInt(input.limit, 10, 1, MAX_GROUPS);
  const order = String(input.order) === 'asc' ? 'ASC' : 'DESC';
  const untilHoursAgo = clampInt(input.until_hours_ago, 0, 0, 720);

  // The optional filters and dimensions. Each is read only when present; a present malformed one is refused below.
  const echo: Partial<Pick<TraceAggregateReport, 'tag' | 'group_by_tag' | 'exclude_observe' | 'success_rule'>> = {};
  let invalid: string | undefined;
  const tag = input.tag === undefined ? undefined : typeof input.tag === 'string' && input.tag ? input.tag : null;
  if (tag === null) invalid = 'invalid_tag';
  else if (tag !== undefined) echo.tag = tag;
  const groupByTagRaw = input.group_by_tag === undefined ? undefined
    : typeof input.group_by_tag === 'string' ? input.group_by_tag.replace(/:$/, '') : '';
  const groupByTag = groupByTagRaw === undefined ? undefined : TAG_KEY.test(groupByTagRaw) ? groupByTagRaw : null;
  if (groupByTag === null) invalid ??= 'invalid_group_by_tag';
  else if (groupByTag !== undefined) echo.group_by_tag = groupByTag;
  const excludeObserve = input.exclude_observe === undefined ? true
    : typeof input.exclude_observe === 'boolean' ? input.exclude_observe : null;
  if (excludeObserve === null) invalid ??= 'invalid_exclude_observe';
  else if (input.exclude_observe !== undefined) echo.exclude_observe = excludeObserve;
  const successRule = input.success_rule === undefined ? 'success_flag'
    : typeof input.success_rule === 'string' && SUCCESS_RULES.has(input.success_rule) ? input.success_rule : null;
  if (successRule === null) invalid ??= 'unserved_success_rule';
  else if (input.success_rule !== undefined) echo.success_rule = successRule;

  // Refuse unserved group_by rather than silently falling back to activity_id.
  if (!GROUP_FIELDS.has(groupBy)) {
    return {
      shape: 'traceAggregateReport',
      metric,
      group_by: String(input.group_by ?? ''),
      window_hours: windowHours,
      until_hours_ago: untilHoursAgo,
      generated_at: new Date().toISOString(),
      rows: [],
      total_groups: 0,
      truncated: false,
      empty: true,
      query_ms: -1,
      measured: false,
      matched_total: null,
      reason: 'unserved_group_by',
    };
  }
  if (invalid) {
    return {
      shape: 'traceAggregateReport',
      metric,
      group_by: groupBy,
      window_hours: windowHours,
      until_hours_ago: untilHoursAgo,
      generated_at: new Date().toISOString(),
      rows: [],
      total_groups: 0,
      truncated: false,
      empty: true,
      query_ms: -1,
      measured: false,
      matched_total: null,
      reason: invalid,
      ...echo,
    };
  }

  const nowMs = Date.now();
  const untilMs = nowMs - untilHoursAgo * 3600_000;
  const since = new Date(untilMs - windowHours * 3600_000).toISOString();
  const until = new Date(untilMs).toISOString();

  // WHERE: indexed window filter + metric pre-filter + tenant scoping.
  const where: string[] = ['executed_at >= type::datetime($since)'];
  const params: Record<string, unknown> = { since };
  if (untilHoursAgo > 0) {
    where.push('executed_at <= type::datetime($until)');
    (params as Record<string, unknown>).until = until;
  }

  // success_count / failure_count pre-filter on the indexed `success` column so
  // the GROUP BY only touches matching rows (idx_aet_activity_success_time).
  // Under another success_rule the pre-filter is that rule's predicate (status and reached carry no index).
  if (successRule === 'status_or_flag') {
    if (metric === 'success_count') where.push('(success = true OR status IN $success_statuses)');
    else if (metric === 'failure_count') where.push('success = false AND status NOT IN $success_statuses');
    if (metric === 'success_count' || metric === 'failure_count') params.success_statuses = [...SUCCESS_STATUSES];
  } else if (successRule === 'reached') {
    if (metric === 'success_count') where.push('reached = true');
    else if (metric === 'failure_count') where.push('reached = false');
  } else if (metric === 'failure_count') where.push('success = false');
    else if (metric === 'success_count') where.push('success = true');

  // OBSERVE (lib/reach-classify.ts isObserveTrace): an observe execution (goal-host's learning_mode "observe" probe) is
  // a measurement, not evidence about an arm, so no count in this report includes it — its failure class above all, which
  // the gap detectors read. The same tags isObserveTrace reads, bound as a parameter. BINARY form on purpose: a unary
  // `!` makes SurrealDB 2.3.10 fall back to a full table scan. A row with no tags (NONE) contains none and is counted.
  // exclude_observe: false (explicit only) counts them too, as the trace list route does.
  if (excludeObserve) {
    where.push('(tags CONTAINSANY $observe_tags) = false');
    params.observe_tags = [...OBSERVE_TRACE_TAGS];
  }

  // Filter by failure class and reason text if provided.
  if (typeof input.failure_class === 'string' && input.failure_class) {
    where.push('(metadata.verdict_class = $failure_class OR (metadata.verdict_class IS NONE AND failure_mode.class = $failure_class))');
    params.failure_class = input.failure_class;
  }
  if (typeof input.reason_contains === 'string' && input.reason_contains) {
    where.push('failure_mode.reason CONTAINS $reason_contains');
    params.reason_contains = input.reason_contains;
  }
  // One exact tag, e.g. state_signature:<sig>. Binary CONTAINS on a bound value; `tags` carries no index, so this is a
  // residual on the executed_at range, and a NONE tags field contains nothing.
  if (tag !== undefined) {
    where.push('tags CONTAINS $tag');
    params.tag = tag;
  }

  // API-key callers can't pass SurrealDB PERMISSIONS (self-signed JWT); apply an
  // app-side tenant filter. INDEX-AWARE: scope by `org_id` (covered by the
  // composite idx_aet_org_id_executed_at on (org_id, executed_at)) rather than
  // the `(account_id = X OR account_id IS NONE)` disjunction the raw-trace path
  // uses — that disjunction defeats the index and ~tripled the GROUP BY time
  // (2s -> 5.8s measured). org-scoping keeps the window+aggregate index-served
  // (~2.7s over 24K failure rows) and is correct: substrate traces all carry
  // org_id. When an accountId is present we add it as an extra equality (still
  // index-compatible: account_id has its own composite idx_aet_account_id_executed_at).
  if (auth.authType === 'apikey') {
    where.push('org_id = $orgId');
    params.orgId = auth.orgId;
    if (auth.accountId) {
      where.push('account_id = $account_id');
      params.account_id = auth.accountId;
    }
  }

  // The aggregate expression. count() for the count metrics; cost sum otherwise.
  // math::sum(cost_usd) tolerates missing rows (returns 0 for an empty set).
  // A cost sum also counts its rows (`matched`), so matched_total is a row count
  // for every metric; for the count metrics `value` already is one.
  const valueExpr =
    metric === 'cost_sum' ? 'math::sum(cost_usd) AS value, count() AS matched' : 'count() AS value';
  const rowCountField = metric === 'cost_sum' ? 'matched' : 'value';

  // CRITICAL: do NOT alias the grouped column (`SELECT activity_id AS key ...
  // GROUP BY activity_id` collapses the whole result into ONE degenerate bucket
  // in SurrealDB 2.3.3 — verified: aliasing the grouped field → 1 group of 39911,
  // selecting the raw field name → 300 correct groups). Select the raw groupBy
  // field; the JS layer maps it to `key`. ORDER/LIMIT cannot be applied
  // server-side either (ORDER BY over an aggregate is what triggers the partial
  // single-bucket plan), so we group fully, then sort + cap in JS — the group
  // count is bounded (≤ a few hundred distinct templates) so this is cheap. (2026-06-27)
  let selectExpr = groupBy;
  if (groupBy === 'failure_class') {
    // Coalesce late-verdict class and insert-time class. Alias to keep JS simple.
    selectExpr = '(metadata.verdict_class ?? failure_mode.class) AS failure_class';
  } else if (groupBy === 'goal_hash') {
    // goal_hash is nested. Alias to flatten it for JS.
    selectExpr = 'metadata.goal_hash AS goal_hash';
  }
  // A second dimension: the row's first `<group_by_tag>:` tag, aliased to its own name and grouped by that alias (the
  // failure_class form above), so each group is one (groupBy, tag) pair. The prefix is stripped in JS.
  let groupExpr = groupBy;
  const tagPrefix = groupByTag ? `${groupByTag}:` : undefined;
  if (tagPrefix) {
    selectExpr += ', array::first((tags ?? [])[WHERE string::starts_with($this, $group_tag_prefix)]) AS group_tag';
    groupExpr = `${groupBy}, group_tag`;
    params.group_tag_prefix = tagPrefix;
  }

  const sql = `
    SELECT ${selectExpr}, ${valueExpr}
    FROM execution
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupExpr}
  `;

  const startedAt = Date.now();
  let rows: TraceAggregateRow[] = [];
  let totalGroups = 0;
  let truncated = false;
  let matchedTotal: number | null = 0;
  let reason: string | undefined;
  let queryOk = true;
  try {
    const result = await db.query(sql, params);
    const set = Array.isArray(result) && result.length > 0 ? result[0] : [];
    const arr = Array.isArray(set) ? (set as Array<Record<string, unknown>>) : [];
    // Rows matched across every group, before the limit cap. A group with no
    // numeric row count makes the total unknown (null), never a guess.
    matchedTotal = arr.reduce<number | null>((s, r) => {
      const n = r[rowCountField];
      return s !== null && typeof n === 'number' && Number.isFinite(n) ? s + n : null;
    }, 0);
    if (matchedTotal === null) reason = 'row_count_unavailable';
    rows = arr
      .map((r) => {
        // The grouped column comes back under its raw field name (we no longer
        // alias it — aliasing breaks SurrealDB grouping). Read groupBy then fall
        // back to `key` for compatibility.
        const rawKey = r[groupBy] ?? r.key;
        const key =
          rawKey == null
            ? '(none)'
            : typeof rawKey === 'string'
              ? rawKey
              : String(rawKey);
        const rawVal = r.value;
        // count() never returns false here; a null value is a genuine miss, not
        // a false-zero. Surface it as null-coerced-to-0 ONLY for cost sums (sum
        // of nothing IS 0); for counts a null means the row had no aggregate, so
        // keep it explicit as 0 (an empty group simply won't appear).
        const value =
          typeof rawVal === 'number' ? rawVal : Number(rawVal ?? 0) || 0;
        if (!tagPrefix) return { key, value };
        // In a GROUP BY the engine (2.3.10) hands the grouped expression back as a one-element array (an empty one for
        // a row with no such tag), so read either form.
        const t = Array.isArray(r.group_tag) ? r.group_tag[0] : r.group_tag;
        const tag_value = typeof t === 'string' && t.startsWith(tagPrefix) ? t.slice(tagPrefix.length) : null;
        return { key, value, tag_value };
      })
      .filter((r) => r.key !== '(none)' || r.value > 0);
    // Sort + cap in JS (ORDER BY/LIMIT over the aggregate triggers SurrealDB's
    // degenerate single-bucket plan; the full group set is small — at most a few
    // hundred distinct templates — so JS sort is cheap and correct).
    rows.sort((a, b) => (order === 'ASC' ? a.value - b.value : b.value - a.value));
    totalGroups = rows.length;
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      truncated = true;
    }
  } catch (err) {
    queryOk = false;
    matchedTotal = null;
    logger.error('[trace-aggregate-report] aggregate query failed', {
      error: err instanceof Error ? err.message : String(err),
      group_by: groupBy,
      metric,
    });
    // Degrade to an empty-but-valid result (NOT a thrown 500): the planner /
    // format step gets a clear "no data" rather than a timeout.
    rows = [];
  }

  const queryMs = Date.now() - startedAt;
  return {
    shape: 'traceAggregateReport',
    metric,
    group_by: groupBy,
    window_hours: windowHours,
    until_hours_ago: untilHoursAgo,
    generated_at: new Date().toISOString(),
    rows,
    total_groups: totalGroups,
    truncated,
    empty: rows.length === 0,
    measured: queryOk,
    matched_total: matchedTotal,
    ...(reason ? { reason } : {}),
    query_ms: queryOk ? queryMs : -1,
    ...echo,
  };
}
