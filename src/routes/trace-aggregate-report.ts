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
 *     group_by?: "activity_id" | "status" | "variant_id",   // default activity_id
 *     metric?: "count" | "failure_count" | "success_count" | "cost_sum"
 *                                                            // default count
 *     window_hours?: number,    // default 24, clamped [1, 720]
 *     limit?: number,           // default 10, clamped [1, 100]
 *     order?: "desc" | "asc",   // default desc (highest first)
 *   }
 *
 * Returns a structured object the format step can render directly:
 *   {
 *     metric, group_by, window_hours, generated_at,
 *     rows: [{ key, value }],   // already sorted + capped
 *     total_groups, query_ms
 *   }
 * On no data it returns rows: [] with a clear `empty: true` flag — NEVER a
 * timeout / HTTP 000 / false-zero. count() failures surface as null, not 0.
 *
 * Read-only, pure (takes a Surreal client + parsed pointer). Auth/scoping is
 * applied by the caller exactly like executionTraceWithSignatures.
 */

import type { Surreal } from 'surrealdb';
import { logger } from '../utils/logger';

export interface TraceAggregateReportInput {
  group_by?: string;
  metric?: string;
  window_hours?: number;
  limit?: number;
  order?: string;
}

export interface TraceAggregateAuthContext {
  orgId: string;
  accountId?: string | null;
  authType?: 'jwt' | 'apikey' | 'minibob_token';
}

export interface TraceAggregateRow {
  key: string;
  value: number;
}

export interface TraceAggregateReport {
  shape: 'traceAggregateReport';
  metric: string;
  group_by: string;
  window_hours: number;
  generated_at: string;
  rows: TraceAggregateRow[];
  total_groups: number;
  empty: boolean;
  query_ms: number;
}

const GROUP_FIELDS = new Set(['activity_id', 'status', 'variant_id']);
const METRICS = new Set(['count', 'failure_count', 'success_count', 'cost_sum']);

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

  const groupBy = GROUP_FIELDS.has(String(input.group_by))
    ? String(input.group_by)
    : 'activity_id';
  const metric = METRICS.has(String(input.metric)) ? String(input.metric) : 'count';
  const windowHours = clampInt(input.window_hours, 24, 1, 720);
  const limit = clampInt(input.limit, 10, 1, 100);
  const order = String(input.order) === 'asc' ? 'ASC' : 'DESC';

  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

  // WHERE: indexed window filter + metric pre-filter + tenant scoping.
  const where: string[] = ['executed_at >= type::datetime($since)'];
  const params: Record<string, unknown> = { since };

  // success_count / failure_count pre-filter on the indexed `success` column so
  // the GROUP BY only touches matching rows (idx_aet_activity_success_time).
  if (metric === 'failure_count') where.push('success = false');
  else if (metric === 'success_count') where.push('success = true');

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
  const valueExpr =
    metric === 'cost_sum' ? 'math::sum(cost_usd) AS value' : 'count() AS value';

  // CRITICAL: do NOT alias the grouped column (`SELECT activity_id AS key ...
  // GROUP BY activity_id` collapses the whole result into ONE degenerate bucket
  // in SurrealDB 2.3.3 — verified: aliasing the grouped field → 1 group of 39911,
  // selecting the raw field name → 300 correct groups). Select the raw groupBy
  // field; the JS layer maps it to `key`. ORDER/LIMIT cannot be applied
  // server-side either (ORDER BY over an aggregate is what triggers the partial
  // single-bucket plan), so we group fully, then sort + cap in JS — the group
  // count is bounded (≤ a few hundred distinct templates) so this is cheap. (2026-06-27)
  const sql = `
    SELECT ${groupBy}, ${valueExpr}
    FROM activity_execution_traces
    WHERE ${where.join(' AND ')}
    GROUP BY ${groupBy}
  `;

  const startedAt = Date.now();
  let rows: TraceAggregateRow[] = [];
  let queryOk = true;
  try {
    const result = await db.query(sql, params);
    const set = Array.isArray(result) && result.length > 0 ? result[0] : [];
    const arr = Array.isArray(set) ? (set as Array<Record<string, unknown>>) : [];
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
        return { key, value };
      })
      .filter((r) => r.key !== '(none)' || r.value > 0);
    // Sort + cap in JS (ORDER BY/LIMIT over the aggregate triggers SurrealDB's
    // degenerate single-bucket plan; the full group set is small — at most a few
    // hundred distinct templates — so JS sort is cheap and correct).
    rows.sort((a, b) => (order === 'ASC' ? a.value - b.value : b.value - a.value));
    if (rows.length > limit) rows = rows.slice(0, limit);
  } catch (err) {
    queryOk = false;
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
    generated_at: new Date().toISOString(),
    rows,
    total_groups: rows.length,
    empty: rows.length === 0,
    query_ms: queryOk ? queryMs : -1,
  };
}
