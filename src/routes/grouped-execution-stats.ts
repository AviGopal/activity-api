/**
 * groupedExecutionStats — per-activity execution HEALTH in one resolve.
 *
 * traceAggregateReport emits ONE metric per call as {key,value} rows, so it can
 * rank by count OR by success_count, but never express "activity X ran N,
 * succeeded S, rate S/N, failing mostly with mode M" in a single row. A family
 * re-picked at ~0 success (a LIVELOCK) is therefore invisible to the
 * self-direction loop (boredom / VoI / gap->goal can all CHOOSE work but none can
 * SEE that a family is doomed). This report joins per-activity count +
 * success_count + success_rate + dominant failure_mode over the same window and
 * tenant scoping, so a livelock (high count, near-zero success_rate) becomes a
 * named, detectable condition the escalation seam can fold into selection weights.
 *
 * Reorganize-before-create: same table (v_paradigm_execution_traces), same
 * index-aware window + org scoping, and the same "select the raw grouped field,
 * NEVER alias it (SurrealDB 2.3.3 aliased-group-collapse), sort/cap in JS"
 * convention as trace-aggregate-report.ts. Read-only, pure. Degrades to an
 * empty-but-valid result on query error (never a 500 / timeout).
 *
 * Pointer contract (all optional):
 *   {
 *     type: "groupedExecutionStats",
 *     window_hours?: number,   // default 24, clamped [1, 720]
 *     limit?: number,          // default 25, clamped [1, 200]
 *     min_count?: number,      // default 1 — drop tiny-sample activities
 *     activity_id?: string,    // restrict to one family (the per-activity filter
 *                              // traceAggregateReport lacks)
 *     order?: "desc" | "asc",  // by count, default desc (livelocks are high-count)
 *   }
 */

import type { Surreal } from 'surrealdb';
import { logger } from '../utils/logger';

export interface GroupedExecutionStatsInput {
  window_hours?: number;
  limit?: number;
  min_count?: number;
  activity_id?: string;
  order?: string;
}

export interface GroupedExecutionStatsAuthContext {
  orgId: string;
  accountId?: string | null;
  authType?: 'jwt' | 'apikey' | 'minibob_token';
}

export interface GroupedExecutionStatsRow {
  activity_id: string;
  count: number;
  success_count: number;
  success_rate: number;
  top_failure_mode: string | null;
}

export interface GroupedExecutionStats {
  shape: 'groupedExecutionStats';
  window_hours: number;
  generated_at: string;
  rows: GroupedExecutionStatsRow[];
  total_groups: number;
  empty: boolean;
  query_ms: number;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function runGroupedExecutionStats(
  db: Surreal,
  rawInput: unknown,
  auth: GroupedExecutionStatsAuthContext,
): Promise<GroupedExecutionStats> {
  const input = (rawInput ?? {}) as GroupedExecutionStatsInput;
  const windowHours = clampInt(input.window_hours, 24, 1, 720);
  const limit = clampInt(input.limit, 25, 1, 200);
  const minCount = clampInt(input.min_count, 1, 0, 1_000_000);
  const order = String(input.order) === 'asc' ? 'ASC' : 'DESC';
  const activityFilter =
    typeof input.activity_id === 'string' && input.activity_id.trim()
      ? input.activity_id.trim()
      : null;

  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

  // Index-aware window + tenant scoping (mirrors trace-aggregate-report.ts:
  // org-scoping keeps idx_aet_org_id_executed_at engaged; API-key callers can't
  // pass SurrealDB PERMISSIONS so the tenant filter is applied app-side).
  const baseWhere: string[] = ['executed_at >= type::datetime($since)'];
  const params: Record<string, unknown> = { since };
  if (auth.authType === 'apikey') {
    baseWhere.push('org_id = $orgId');
    params.orgId = auth.orgId;
    if (auth.accountId) {
      baseWhere.push('account_id = $account_id');
      params.account_id = auth.accountId;
    }
  }
  if (activityFilter) {
    baseWhere.push('activity_id = $activity_id');
    params.activity_id = activityFilter;
  }
  const whereSql = baseWhere.join(' AND ');

  // CRITICAL: do NOT alias the grouped column (SurrealDB 2.3.3 collapses
  // `SELECT x AS key ... GROUP BY x` into one degenerate bucket). Select the raw
  // grouped field; fold in JS. Two grouped counts over the same window (total,
  // then success=true) joined by activity_id — the proven trace-aggregate shape.
  const totalSql = `SELECT activity_id, count() AS value FROM v_paradigm_execution_traces WHERE ${whereSql} GROUP BY activity_id`;
  const succSql = `SELECT activity_id, count() AS value FROM v_paradigm_execution_traces WHERE ${whereSql} AND success = true GROUP BY activity_id`;

  const startedAt = Date.now();
  let queryOk = true;
  const totals = new Map<string, number>();
  const succs = new Map<string, number>();
  const topMode = new Map<string, string>();

  const readGroup = (result: unknown): Array<Record<string, unknown>> => {
    const set = Array.isArray(result) && result.length > 0 ? result[0] : [];
    return Array.isArray(set) ? (set as Array<Record<string, unknown>>) : [];
  };
  const asKey = (r: Record<string, unknown>): string => {
    const raw = r.activity_id ?? r.key;
    return raw == null ? '(none)' : typeof raw === 'string' ? raw : String(raw);
  };
  const asNum = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

  try {
    for (const r of readGroup(await db.query(totalSql, params))) totals.set(asKey(r), asNum(r.value));
    for (const r of readGroup(await db.query(succSql, params))) succs.set(asKey(r), asNum(r.value));

    // Best-effort dominant failure_mode per activity (failed rows only). The
    // nested-field double-group is fragile; guard it so the core stat (the
    // livelock signal: count / success_rate) survives even if this degrades to
    // null. Read the grouped nested field defensively (flattened OR nested form).
    try {
      const failSql = `SELECT activity_id, failure_mode.type, count() AS value FROM v_paradigm_execution_traces WHERE ${whereSql} AND success = false GROUP BY activity_id, failure_mode.type`;
      const best = new Map<string, { mode: string; n: number }>();
      for (const r of readGroup(await db.query(failSql, params))) {
        const k = asKey(r);
        const fm = (r as { failure_mode?: { type?: unknown } }).failure_mode;
        const rawMode = (r as Record<string, unknown>)['failure_mode.type'] ?? fm?.type;
        const mode = rawMode == null ? '' : String(rawMode);
        if (!mode) continue;
        const n = asNum(r.value);
        const cur = best.get(k);
        if (!cur || n > cur.n) best.set(k, { mode, n });
      }
      for (const [k, v] of best) topMode.set(k, v.mode);
    } catch (ferr) {
      logger.warn('[grouped-execution-stats] failure_mode histogram degraded (null top_failure_mode)', {
        error: ferr instanceof Error ? ferr.message : String(ferr),
      });
    }
  } catch (err) {
    queryOk = false;
    logger.error('[grouped-execution-stats] aggregate query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let rows: GroupedExecutionStatsRow[] = [];
  for (const [activity_id, count] of totals) {
    if (activity_id === '(none)' || count < minCount) continue;
    const success_count = succs.get(activity_id) ?? 0;
    rows.push({
      activity_id,
      count,
      success_count,
      success_rate: count > 0 ? success_count / count : 0,
      top_failure_mode: topMode.get(activity_id) ?? null,
    });
  }
  // Sort + cap in JS (ORDER BY over the aggregate triggers the degenerate plan).
  // Default desc by count — a livelock is a high-count / low-success-rate row.
  rows.sort((a, b) => (order === 'ASC' ? a.count - b.count : b.count - a.count));
  if (rows.length > limit) rows = rows.slice(0, limit);

  return {
    shape: 'groupedExecutionStats',
    window_hours: windowHours,
    generated_at: new Date().toISOString(),
    rows,
    total_groups: rows.length,
    empty: rows.length === 0,
    query_ms: queryOk ? Date.now() - startedAt : -1,
  };
}
