/**
 * db_admin `reconcile_trace_store` — bounded copy-forward swap for
 * activity_execution_traces (AET).
 *
 * Part of openspec/changes/2026-07-08-substrate-self-managed-db-reconciliation
 * (see design.md "The swap"). AET grows unboundedly (218,953 rows / 13GB
 * measured pre-window; a global COUNT() took 86.5s); this operation keeps it
 * small by copying forward a bounded "keep set" — a hot window plus a
 * stratified per-activity reservoir — into a fresh table, then swapping.
 * SurrealDB has no table rename, so the swap is: build `_next` → drop the
 * views + AET → replay AET's schema onto the now-empty name → copy `_next`
 * back in → drop `_next` → redefine the views.
 *
 * Loaded (statically) by src/routes/db-admin.ts only for operation
 * 'reconcile_trace_store'. Distinct from db-admin-repair.ts's vetted-pattern
 * catalogue: this operation's SQL is NOT caller-parameterized at all — every
 * table name is a fixed constant below, so it does not (and must not) route
 * through `rejectCatastrophicSql` (that guard exists to block CALLER-SUPPLIED
 * SQL; the REMOVE TABLE statements here are fixed, reviewed, and load-bearing
 * to the swap itself).
 *
 * Rails:
 *   - LEASE-GATED — refuses (fail-closed) without a valid, unexpired
 *     maintenance lease matching `lease_token`. See validateMaintenanceLease.
 *   - dry_run DEFAULTS TRUE — a live run requires an explicit `dry_run:false`.
 *   - FIXED TABLE NAMES — no caller-supplied table names anywhere.
 *   - AUDIT — every invocation (dry-run AND live, refused AND applied) writes
 *     one row to db_admin_audit (migration 150), including the captured DDL
 *     snapshot and, on failure, the step reached (no automatic rollback —
 *     recovery is from the DDL snapshot + the operator's DB backup).
 *
 * SurrealDB-specific constraints observed throughout (design.md):
 *   - `type::datetime()` / `time::now()` only, never `<datetime>` cast.
 *   - ROOT path (ctx.surrealDB.query) for every DDL/copy/delete statement.
 *   - Optional fields omitted rather than sent as null.
 *   - Every read is bounded (indexed range/equality or LIMIT) — no
 *     unbounded global ORDER BY / GROUP BY.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';
import { config } from '../config';
import { normalizeRecordId } from '../utils/surrealdb-types';
import { TRACE_STORE_COUNTER_ID } from '../lib/trace-store-counters';
import { isDualWriteEnabled } from '../db/paradigm';
import { loadTraceRetentionConfig, runTraceRetentionSweep } from '../services/trace-retention';

// ---------------------------------------------------------------------------
// Fixed constants — no caller-supplied table names anywhere in this module.
// ---------------------------------------------------------------------------

export const AET_TABLE = 'activity_execution_traces';
export const AET_NEXT_TABLE = 'activity_execution_traces_next';
export const AET_VIEWS = [
  'v_activity_execution_traces_by_account',
  'view_activity_executions',
  'view_execution_traces',
] as const;

/** The load-bearing index set, defined exactly once, deduped (design.md §5). */
const AET_INDEX_DEFS = [
  `DEFINE INDEX OVERWRITE idx_aet_executed_at ON ${AET_TABLE} FIELDS executed_at`,
  `DEFINE INDEX OVERWRITE idx_aet_execution_id ON ${AET_TABLE} FIELDS execution_id UNIQUE`,
  `DEFINE INDEX OVERWRITE idx_aet_activity_id_executed_at ON ${AET_TABLE} FIELDS activity_id, executed_at`,
  `DEFINE INDEX OVERWRITE idx_aet_activity_success_time ON ${AET_TABLE} FIELDS activity_id, success, executed_at`,
  `DEFINE INDEX OVERWRITE idx_aet_vessel_id ON ${AET_TABLE} FIELDS vessel_id`,
  `DEFINE INDEX OVERWRITE idx_aet_parent ON ${AET_TABLE} FIELDS parent_execution_id`,
  `DEFINE INDEX OVERWRITE idx_aet_correlation ON ${AET_TABLE} FIELDS correlation_id`,
  `DEFINE INDEX OVERWRITE idx_aet_status ON ${AET_TABLE} FIELDS status`,
  `DEFINE INDEX OVERWRITE idx_aet_org_id_executed_at ON ${AET_TABLE} FIELDS org_id, executed_at`,
  `DEFINE INDEX OVERWRITE idx_aet_composition_chain ON ${AET_TABLE} FIELDS composition_chain`,
];

// THE WRITER AND THE VALIDATOR MUST DERIVE THIS THE SAME WAY (2026-08-09).
//
// This constant was a bare '/workspace/leases/maintenance.json' while the only
// writer — development-vessel's maintenanceLease_write — derives its path as
// `join(WORKSPACE_ROOT, 'leases', 'maintenance.json')`. Both processes run with
// WORKSPACE_ROOT=/workspace/git/super-repo, so the writer wrote
//   /workspace/git/super-repo/leases/maintenance.json
// and this gate read
//   /workspace/leases/maintenance.json
// which has never existed on any host. Measured: ENOENT, and therefore
// `reconcile_trace_store refused` on EVERY call that got this far — the lease
// gate could not pass, so the reconcile could not run, so the trace store grew
// unbounded (300k against a 150k cap) while its reconciler held the global
// change_window lease and blocked all self-editing.
//
// Two components documented as sharing a file, each computing its location from
// a different rule, with no test covering the pair. Matching fallbacks are not
// agreement — derive from the same variable so they cannot drift apart again.
const DEFAULT_LEASE_PATH = join(
  process.env['WORKSPACE_ROOT'] ?? '/workspace',
  'leases',
  'maintenance.json',
);

// ---------------------------------------------------------------------------
// Maintenance lease gate — pure, independently testable.
// ---------------------------------------------------------------------------

export interface MaintenanceLease {
  holder: string;
  token: string;
  acquired_at: string;
  expires_at: string;
}

export interface LeaseValidationResult {
  ok: boolean;
  error?: string;
  lease?: MaintenanceLease;
}

/**
 * Validate a caller-supplied `lease_token` against the file-backed
 * maintenance lease. Fail-closed: any of "file missing", "unparsable JSON",
 * "expired", or "token mismatch" refuses. Never throws.
 */
export function validateMaintenanceLease(
  leasePath: string,
  token: string | undefined | null,
  now: Date = new Date(),
): LeaseValidationResult {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'reconcile_trace_store: `lease_token` is required' };
  }

  let raw: string;
  try {
    raw = readFileSync(leasePath, 'utf-8');
  } catch (err: any) {
    return { ok: false, error: `maintenance lease not found at ${leasePath}: ${err?.message ?? err}` };
  }

  let lease: any;
  try {
    lease = JSON.parse(raw);
  } catch (err: any) {
    return { ok: false, error: `maintenance lease at ${leasePath} is not valid JSON: ${err?.message ?? err}` };
  }

  if (!lease || typeof lease !== 'object') {
    return { ok: false, error: 'maintenance lease file did not parse to an object' };
  }
  if (typeof lease.token !== 'string' || typeof lease.expires_at !== 'string') {
    return { ok: false, error: 'maintenance lease file missing required fields (token, expires_at)' };
  }

  const expiresAt = new Date(lease.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, error: `maintenance lease expires_at is not a parseable date: "${lease.expires_at}"` };
  }
  if (expiresAt.getTime() < now.getTime()) {
    return { ok: false, error: `maintenance lease expired at ${lease.expires_at}` };
  }
  if (lease.token !== token) {
    return { ok: false, error: 'maintenance lease token mismatch' };
  }

  return {
    ok: true,
    lease: {
      holder: String(lease.holder ?? 'unknown'),
      token: lease.token,
      acquired_at: String(lease.acquired_at ?? ''),
      expires_at: lease.expires_at,
    },
  };
}

function leasePathFromEnv(): string {
  return process.env.MAINTENANCE_LEASE_PATH || DEFAULT_LEASE_PATH;
}

// ---------------------------------------------------------------------------
// Shared ctx (mirrors db-admin-repair.ts's Ctx contract)
// ---------------------------------------------------------------------------

type Ctx = {
  surrealDB: { query<T = any>(sql: string, params?: Record<string, unknown>): Promise<T[]> };
  writeAudit: (entry: {
    operation: string;
    params: unknown;
    pattern?: string | null;
    impact_count?: number | null;
    applied: boolean;
    actor?: string | null;
    detail?: Record<string, unknown> | null;
  }) => Promise<string | null>;
};

export interface DbAdminResult {
  status: number;
  body: any;
}

function ok(content: unknown, shape: string, summary: string): DbAdminResult {
  return { status: 200, body: { success: true, content: JSON.stringify(content), metadata: { shape, summary } } };
}
function bad(error: string, status = 400): DbAdminResult {
  return { status, body: { success: false, error } };
}

// ---------------------------------------------------------------------------
// Counters read helper
// ---------------------------------------------------------------------------

async function readCounters(ctx: Ctx): Promise<{ row_count: number; cap: number }> {
  try {
    const rows = await ctx.surrealDB.query<any>(`SELECT * FROM ${TRACE_STORE_COUNTER_ID}`);
    const row = (Array.isArray(rows) ? rows : [])[0];
    return {
      row_count: row && typeof row.row_count === 'number' ? row.row_count : 0,
      cap: row && typeof row.cap === 'number' ? row.cap : config.traceStore.cap,
    };
  } catch {
    return { row_count: 0, cap: config.traceStore.cap };
  }
}

async function safeCount(ctx: Ctx, table: string): Promise<number> {
  const rows = await ctx.surrealDB.query<any>(`SELECT count() AS c FROM ${table} GROUP ALL`);
  const row = (Array.isArray(rows) ? rows : [])[0];
  return row && typeof row.c === 'number' ? row.c : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function resolveReconcileTraceStore(pointer: any, actor: string | null, ctx: Ctx): Promise<DbAdminResult> {
  const operation = 'reconcile_trace_store';
  const dryRun = pointer?.dry_run !== false; // RAIL: dry_run DEFAULTS TRUE

  // RAIL: lease gate (fail-closed, checked before anything else — including
  // the dry-run report, so a caller can't probe state without a valid lease).
  const leasePath = leasePathFromEnv();
  const leaseResult = validateMaintenanceLease(leasePath, pointer?.lease_token);
  if (!leaseResult.ok) {
    await ctx.writeAudit({
      operation,
      params: { dry_run: dryRun },
      applied: false,
      actor,
      impact_count: 0,
      detail: { refused: true, reason: leaseResult.error, lease_path: leasePath },
    });
    return bad(`reconcile_trace_store refused: ${leaseResult.error}`, 403);
  }

  const hotWindowDays = config.traceStore.hotWindowDays;
  const reservoirPerActivity = config.traceStore.reservoirPerActivity;
  if (!Number.isInteger(hotWindowDays) || hotWindowDays <= 0) {
    return bad(`reconcile_trace_store: invalid hotWindowDays config (${hotWindowDays})`, 500);
  }
  if (!Number.isInteger(reservoirPerActivity) || reservoirPerActivity <= 0) {
    return bad(`reconcile_trace_store: invalid reservoirPerActivity config (${reservoirPerActivity})`, 500);
  }

  const counters = await readCounters(ctx);
  const overCap = counters.row_count > counters.cap;

  // -------------------------------------------------------------------------
  // DRY-RUN (default): report + audit, touch nothing.
  // -------------------------------------------------------------------------
  if (dryRun) {
    const plan = [
      `snapshot DDL: INFO FOR TABLE ${AET_TABLE} + INFO FOR DB (views)`,
      `REMOVE TABLE IF EXISTS ${AET_NEXT_TABLE}`,
      `copy hot window (executed_at > now - ${hotWindowDays}d) into ${AET_NEXT_TABLE}`,
      `copy stratified reservoir (<= ${reservoirPerActivity} rows per activity_id, bounded by activity_template list) into ${AET_NEXT_TABLE}`,
      `verify ${AET_NEXT_TABLE} row count > 0`,
      `REMOVE TABLE IF EXISTS ${AET_VIEWS.join(', ')}`,
      `REMOVE TABLE ${AET_TABLE}`,
      `replay captured field DEFINEs onto ${AET_TABLE}`,
      `define load-bearing index set once (${AET_INDEX_DEFS.length} indexes)`,
      `INSERT INTO ${AET_TABLE} (SELECT * FROM ${AET_NEXT_TABLE})`,
      `REMOVE TABLE ${AET_NEXT_TABLE}`,
      `redefine the ${AET_VIEWS.length} views from captured DDL`,
      `reset trace_store_counters (row_count = final count, last_reconciled_at = now())`,
    ];
    const report = {
      dry_run: true,
      row_count: counters.row_count,
      cap: counters.cap,
      over_cap: overCap,
      hot_window_days: hotWindowDays,
      reservoir_per_activity: reservoirPerActivity,
      plan,
    };
    await ctx.writeAudit({
      operation,
      params: { dry_run: true },
      applied: false,
      actor,
      impact_count: counters.row_count,
      detail: report,
    });
    return ok(report, 'db_admin_reconcile_trace_store_dryrun', `reconcile_trace_store dry-run: row_count=${counters.row_count} cap=${counters.cap} over_cap=${overCap}`);
  }

  // -------------------------------------------------------------------------
  // AET DECOMMISSIONED short-circuit — never swap a frozen, non-authoritative
  // table (and never destructively rewrite the live `execution` store).
  //
  // The copy-forward swap below rewrites activity_execution_traces (AET). AET
  // is the DUAL_WRITE shadow; once DUAL_WRITE is off (isDualWriteEnabled() ===
  // false) AET is frozen and no longer authoritative — `execution` is. Running
  // the swap on a frozen AET is not merely pointless, it LIVELOCKS: both
  // keep-set sources yield 0 rows (the hot window finds nothing newer than
  // now - hotWindowDays in a table that stopped growing; the stratified
  // reservoir iterates activity_template, which is empty), so verify_next_count
  // aborts every run at "keep-set is empty, refusing to swap" and
  // last_reconciled_at never advances — the health observer then re-emits
  // forever.
  //
  // Correct behavior when AET is decommissioned: skip the swap, delegate cap
  // management to the trace-retention sweep over the authoritative `execution`
  // table (src/services/trace-retention.ts — bounded, indexed, non-destructive
  // reservoir delete), advance last_reconciled_at so the observer stops
  // re-emitting, and return success. We honor trace-retention's own
  // enabled/dryRun contract (loadTraceRetentionConfig), so this deletes nothing
  // the operator has not explicitly enabled. row_count is intentionally left
  // untouched: it is the O(1) counter kept in sync with `execution` via the
  // per-insert increment + the retention decrement, so a blind reset here would
  // desync it.
  if (!isDualWriteEnabled()) {
    let retention: Record<string, unknown>;
    const rcfg = loadTraceRetentionConfig();
    if (!rcfg.enabled) {
      retention = { skipped: true, reason: 'trace-retention disabled (set TRACE_RETENTION_ENABLED=true)' };
    } else {
      try {
        const sweep = await runTraceRetentionSweep(rcfg);
        const deleted = sweep.results.reduce((n, r) => n + (r.deletedActual ?? 0), 0);
        retention = { deleted, dry_run: rcfg.dryRun, strata: sweep.results.length, duration_ms: sweep.durationMs };
      } catch (err: any) {
        retention = { error: err?.message ?? String(err) };
      }
    }

    // Advance last_reconciled_at (and re-affirm the cap) so the observer's
    // staleness signal clears. Do NOT overwrite row_count here.
    try {
      await ctx.surrealDB.query(
        `UPSERT ${TRACE_STORE_COUNTER_ID} SET
           table_name = 'execution',
           cap = (cap ?? $cap),
           last_reconciled_at = time::now()`,
        { cap: config.traceStore.cap },
      );
    } catch (err: any) {
      logger.warn('reconcile_trace_store: last_reconciled_at advance failed (non-fatal)', { error: err?.message });
    }

    const result = {
      dry_run: false,
      aet_decommissioned: true,
      swap_skipped: true,
      delegated_to: 'trace-retention sweep over `execution`',
      retention,
      before_row_count: counters.row_count,
      cap: counters.cap,
      over_cap: overCap,
    };
    await ctx.writeAudit({
      operation,
      params: { dry_run: false },
      applied: true,
      actor,
      impact_count: counters.row_count,
      detail: result,
    });
    return ok(
      result,
      'db_admin_reconcile_trace_store',
      `reconcile_trace_store: AET decommissioned — swap skipped, delegated to trace-retention over execution`,
    );
  }

  // -------------------------------------------------------------------------
  // LIVE RUN — bounded copy-forward swap (design.md "The swap").
  // Only reached while DUAL_WRITE is on (AET rollback window).
  // -------------------------------------------------------------------------
  const startedAt = Date.now();
  let step = 'start';
  try {
    // (a) Snapshot DDL — field defs on AET + the 3 views' full DEFINE TABLE
    // statements — kept in memory AND written into the audit row so a bad
    // swap is recoverable from the audit trail (no automatic rollback).
    step = 'snapshot_ddl';
    const aetInfoRows = await ctx.surrealDB.query<any>(`INFO FOR TABLE ${AET_TABLE}`);
    const aetInfo = (Array.isArray(aetInfoRows) ? aetInfoRows : [])[0] ?? {};
    const fieldDdls: string[] = Object.values(aetInfo.fields ?? {}) as string[];

    const dbInfoRows = await ctx.surrealDB.query<any>('INFO FOR DB');
    const dbInfo = (Array.isArray(dbInfoRows) ? dbInfoRows : [])[0] ?? {};
    const tablesMap: Record<string, string> = dbInfo.tables ?? {};
    const aetTableDdl: string | null = tablesMap[AET_TABLE] ?? null;
    const viewDdls: Record<string, string> = {};
    for (const v of AET_VIEWS) if (tablesMap[v]) viewDdls[v] = tablesMap[v];

    const ddlSnapshot = { fieldDdls, aetTableDdl, viewDdls, capturedAt: new Date().toISOString() };

    // (b) Hot window → _next.
    step = 'hot_window_copy';
    await ctx.surrealDB.query(`REMOVE TABLE IF EXISTS ${AET_NEXT_TABLE}`);
    const hotClause = `time::now() - ${hotWindowDays}d`;
    await ctx.surrealDB.query(
      `INSERT INTO ${AET_NEXT_TABLE} (SELECT * FROM ${AET_TABLE} WHERE executed_at > ${hotClause})`,
    );

    // (c) Stratified reservoir, bounded by a fixed list of activity ids
    // (never a global GROUP BY over AET).
    step = 'stratified_reservoir_copy';
    const strataRows = await ctx.surrealDB.query<any>(`SELECT VALUE id FROM activity_template LIMIT 2000`);
    const strataIds = (Array.isArray(strataRows) ? strataRows : [])
      .map((id) => normalizeRecordId(id))
      .filter((id) => id.length > 0);
    for (const aid of strataIds) {
      await ctx.surrealDB.query(
        `INSERT INTO ${AET_NEXT_TABLE} (SELECT * FROM ${AET_TABLE} WHERE activity_id = $aid AND executed_at <= ${hotClause} ORDER BY executed_at DESC LIMIT ${reservoirPerActivity})`,
        { aid },
      );
    }

    // (d) Verify keep-set is plausible before touching the live table.
    step = 'verify_next_count';
    const nextCount = await safeCount(ctx, AET_NEXT_TABLE);
    if (nextCount === 0) {
      await ctx.writeAudit({
        operation,
        params: { dry_run: false },
        applied: false,
        actor,
        impact_count: 0,
        detail: { aborted_at_step: step, reason: `${AET_NEXT_TABLE} count is 0 after copy — aborting before touching ${AET_TABLE}`, ddl_snapshot: ddlSnapshot },
      });
      return bad(`reconcile_trace_store aborted at ${step}: keep-set is empty, refusing to swap`, 500);
    }

    // (e) Drop views + AET (SurrealDB has no table rename).
    step = 'drop_views_and_aet';
    for (const v of AET_VIEWS) {
      await ctx.surrealDB.query(`REMOVE TABLE IF EXISTS ${v}`);
    }
    await ctx.surrealDB.query(`REMOVE TABLE ${AET_TABLE}`);

    // (f) Replay schema onto the now-empty table name, then define the
    // load-bearing index set exactly once.
    step = 'replay_schema';
    if (aetTableDdl) {
      await ctx.surrealDB.query(aetTableDdl);
    }
    for (const stmt of fieldDdls) {
      await ctx.surrealDB.query(stmt);
    }
    for (const stmt of AET_INDEX_DEFS) {
      await ctx.surrealDB.query(stmt);
    }

    // (g) Copy the keep-set back in.
    step = 'copy_back';
    await ctx.surrealDB.query(`INSERT INTO ${AET_TABLE} (SELECT * FROM ${AET_NEXT_TABLE})`);

    // (h) Drop the staging table.
    step = 'drop_next';
    await ctx.surrealDB.query(`REMOVE TABLE ${AET_NEXT_TABLE}`);

    // (i) Redefine the views from the captured DDL.
    step = 'redefine_views';
    for (const v of AET_VIEWS) {
      const ddl = viewDdls[v];
      if (ddl) await ctx.surrealDB.query(ddl);
    }

    // (j) Reset counters from the (now-small) final count.
    step = 'reset_counters';
    const finalCount = await safeCount(ctx, AET_TABLE);
    await ctx.surrealDB.query(
      `UPSERT ${TRACE_STORE_COUNTER_ID} SET
         table_name = 'activity_execution_traces',
         row_count = $rc,
         cap = (cap ?? $cap),
         last_reconciled_at = time::now()`,
      { rc: finalCount, cap: config.traceStore.cap },
    );

    // (k) Audit success with before/after + duration.
    step = 'done';
    const durationMs = Date.now() - startedAt;
    const result = {
      dry_run: false,
      before_row_count: counters.row_count,
      after_row_count: finalCount,
      next_keep_set_count: nextCount,
      hot_window_days: hotWindowDays,
      reservoir_per_activity: reservoirPerActivity,
      duration_ms: durationMs,
    };
    await ctx.writeAudit({
      operation,
      params: { dry_run: false },
      applied: true,
      actor,
      impact_count: finalCount,
      detail: { ...result, ddl_snapshot: ddlSnapshot },
    });
    return ok(result, 'db_admin_reconcile_trace_store', `reconcile_trace_store: ${counters.row_count} -> ${finalCount} rows in ${durationMs}ms`);
  } catch (err: any) {
    // No automatic rollback — recovery is from the DDL snapshot (in the audit
    // row) + the operator's DB backup (design.md verification gates).
    logger.error('reconcile_trace_store failed mid-swap', { step, error: err?.message });
    await ctx.writeAudit({
      operation,
      params: { dry_run: false },
      applied: false,
      actor,
      detail: { failed_at_step: step, error: err?.message ?? String(err) },
    });
    return bad(`reconcile_trace_store failed at step "${step}": ${err?.message ?? err}`, 500);
  }
}
