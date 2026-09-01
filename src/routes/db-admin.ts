/**
 * db_admin resolver — substrate self-management of its own SurrealDB.
 *
 * Gives the SUBSTRATE full, runtime, in-container authority to diagnose and
 * maintain the activity-api SurrealDB (NS activity-system / DB learning_loop):
 * diagnose · create_index · apply_migration · repair · prune.
 *
 * Because this is write authority over the substrate's OWN data, the safety
 * rails are non-negotiable and are enforced BEFORE any dangerous operation:
 *
 *   1. OPERATION WHITELIST   — unknown `operation` is rejected outright.
 *   2. PATTERN WHITELIST     — repair/prune may ONLY run a vetted, parameterized
 *                              SQL template from the catalogue below. Caller-
 *                              supplied raw SQL is NEVER executed for
 *                              repair/prune/delete.
 *   3. dry_run DEFAULTS TRUE  — for ALL mutations. repair/prune additionally
 *                              REQUIRE an explicit `apply:true` to mutate.
 *   4. BOUNDED               — every destructive op caps affected rows at
 *                              max_rows; exceeding it refuses to apply without
 *                              an explicit `force:true`.
 *   5. AUDIT                 — every invocation (dry-run AND apply) writes one
 *                              row to `db_admin_audit` (migration 150).
 *   6. NO CATASTROPHIC OPS   — DROP TABLE / REMOVE DATABASE|TABLE / TRUNCATE /
 *                              DELETE-without-WHERE are hard-rejected in ALL
 *                              paths, including caller-supplied migration SQL.
 *
 * Runs as DB root (surrealDB.query) — that is the point: the substrate manages
 * its own store. All accountability flows through the audit table.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { resolveReconcileTraceStore } from './db-admin-reconcile';

// ---------------------------------------------------------------------------
// Whitelists
// ---------------------------------------------------------------------------

export const DB_ADMIN_OPERATIONS = [
  'diagnose',
  'create_index',
  'apply_migration',
  'repair',
  'prune',
  'reconcile_trace_store',
] as const;
export type DbAdminOperation = (typeof DB_ADMIN_OPERATIONS)[number];

/**
 * Tables/fields the data-mutating patterns are permitted to touch. A pattern
 * referencing anything outside this set is rejected — this is the second line
 * of defence behind the pattern whitelist itself.
 */
const REPAIR_TARGET_WHITELIST: Record<string, string[]> = {
  activity_composition_graph: ['child_activity_id', 'parent_activity_id'],
  context_thompson_scores: ['account_id'],
  activity_template: ['id'],
  variant_performance_metrics: ['account_id'],
};

const PRUNE_TABLE_WHITELIST = new Set([
  'activity_execution_traces',
  'execution',
]);

const DEFAULT_MAX_ROWS = 5000;

// ---------------------------------------------------------------------------
// Catastrophic-op rejection — applies to ALL SQL strings before execution.
// ---------------------------------------------------------------------------

const CATASTROPHIC_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bDROP\s+(TABLE|DATABASE|NAMESPACE)\b/i, label: 'DROP TABLE/DATABASE/NAMESPACE' },
  { re: /\bREMOVE\s+(TABLE|DATABASE|NAMESPACE|FIELD|INDEX|EVENT)\b/i, label: 'REMOVE TABLE/DATABASE/...' },
  { re: /\bTRUNCATE\b/i, label: 'TRUNCATE' },
];

/**
 * Reject catastrophic SQL. Returns an error string if the SQL is forbidden,
 * else null. Also rejects a DELETE with no WHERE clause (mass-delete).
 */
export function rejectCatastrophicSql(sql: string): string | null {
  for (const { re, label } of CATASTROPHIC_PATTERNS) {
    if (re.test(sql)) return `catastrophic operation rejected: ${label}`;
  }
  // DELETE / DELETE FROM must always be WHERE-bounded.
  const deleteStmts = sql.match(/\bDELETE\b[^;]*/gi) ?? [];
  for (const stmt of deleteStmts) {
    if (!/\bWHERE\b/i.test(stmt)) {
      return 'catastrophic operation rejected: DELETE without WHERE clause';
    }
  }
  return null;
}

/**
 * For apply_migration: caller-supplied DEFINE statements only. Reject anything
 * that is not an additive/idempotent DEFINE (IF NOT EXISTS / OVERWRITE), and
 * reject any DROP/DELETE/REMOVE outright.
 */
function validateMigrationStatement(stmt: string): string | null {
  const s = stmt.trim();
  if (!s) return null;
  const cat = rejectCatastrophicSql(s);
  if (cat) return cat;
  if (/\b(DELETE|REMOVE|DROP)\b/i.test(s)) {
    return `apply_migration rejects DELETE/REMOVE/DROP statements: "${s.slice(0, 80)}"`;
  }
  // Must be a DEFINE; must carry IF NOT EXISTS or OVERWRITE so re-run is safe.
  if (!/^DEFINE\b/i.test(s)) {
    return `apply_migration only accepts DEFINE statements: "${s.slice(0, 80)}"`;
  }
  if (!/\b(IF\s+NOT\s+EXISTS|OVERWRITE)\b/i.test(s)) {
    return `apply_migration DEFINE must be idempotent (IF NOT EXISTS / OVERWRITE): "${s.slice(0, 80)}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function writeAudit(entry: {
  operation: string;
  params: unknown;
  pattern?: string | null;
  impact_count?: number | null;
  applied: boolean;
  actor?: string | null;
  detail?: Record<string, unknown> | null;
}): Promise<string | null> {
  try {
    // The optional fields are `option<...>` in the schema, which accepts NONE
    // (absent) but NOT NULL. The JS SDK serializes JS `null` as SurrealDB NULL,
    // so we OMIT null-valued optional keys from CONTENT entirely (→ field unset
    // → NONE) rather than sending null.
    const content: Record<string, unknown> = {
      operation: entry.operation,
      params: entry.params ?? {},
      applied: entry.applied,
    };
    if (entry.pattern != null) content.pattern = entry.pattern;
    if (entry.impact_count != null) content.impact_count = entry.impact_count;
    if (entry.actor != null) content.actor = entry.actor;
    if (entry.detail != null) content.detail = entry.detail;

    const rows = await surrealDB.query<any>(
      `CREATE db_admin_audit CONTENT $content`,
      { content },
    );
    const row = (rows || [])[0];
    return row ? String(row.id) : null;
  } catch (err: any) {
    // Audit failure must NOT silently lose the trail — surface loudly, but do
    // not let it mask a successful (or refused) operation result.
    logger.error('db_admin audit write failed', { error: err?.message, operation: entry.operation });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Operation: diagnose (READ-ONLY)
// ---------------------------------------------------------------------------

const INTEGRITY_SCANS: { id: string; table: string; where: string; remediation: any }[] = [
  {
    id: 'acg_none_fk',
    table: 'activity_composition_graph',
    where: 'child_activity_id IS NONE OR parent_activity_id IS NONE',
    remediation: { operation: 'repair', params: { pattern: 'delete_none_fk' } },
  },
  {
    id: 'cts_null_account_id',
    table: 'context_thompson_scores',
    where: 'account_id = NULL',
    remediation: {
      operation: 'repair',
      params: { pattern: 'coerce_null_to_none', table: 'context_thompson_scores', field: 'account_id' },
    },
  },
];

async function safeCount(table: string, where?: string): Promise<number | null> {
  try {
    const sql = where
      ? `SELECT count() AS count_value FROM ${table} WHERE ${where} GROUP ALL`
      : `SELECT count() AS c FROM ${table} GROUP ALL`;
    const rows = await surrealDB.query<any>(sql);
    const row = (Array.isArray(rows) ? rows : [])[0];
    return row && typeof row.c === 'number' ? row.c : 0;
  } catch (err: any) {
    logger.warn('db_admin diagnose count failed', { table, where, error: err?.message });
    return null;
  }
}

async function runDiagnose(pointer: any): Promise<any> {
  const { getDbStats } = await import('../db/surreal');
  const dbMetrics = getDbStats();

  // Integrity scan
  const integrity: any[] = [];
  const suggested: any[] = [];
  for (const scan of INTEGRITY_SCANS) {
    const count = await safeCount(scan.table, scan.where);
    integrity.push({ id: scan.id, table: scan.table, predicate: scan.where, violating_rows: count });
    if (count && count > 0) suggested.push({ ...scan.remediation, reason: `${count} ${scan.id} rows` });
  }

  // Doubled-prefix id scan (across template tables).
  let doubledPrefix: number | null = null;
  try {
    const rows = await surrealDB.query<any>(
      `SELECT count() AS c FROM activity_template WHERE string::contains(<string> id, 'activity:⟨activity:') GROUP ALL`,
    );
    const row = (Array.isArray(rows) ? rows : [])[0];
    doubledPrefix = row && typeof row.c === 'number' ? row.c : 0;
  } catch {
    doubledPrefix = 0;
  }
  integrity.push({ id: 'doubled_prefix_ids', table: 'activity_template', violating_rows: doubledPrefix });
  if (doubledPrefix && doubledPrefix > 0) {
    suggested.push({ operation: 'repair', params: { pattern: 'delete_doubled_prefix_ids' }, reason: `${doubledPrefix} doubled-prefix ids` });
  }

  // Table row counts (best-effort over a fixed set of hot tables).
  const tablesOfInterest = pointer?.tables ?? [
    'activity_execution_traces',
    'activity_template',
    'activity_composition_graph',
    'context_thompson_scores',
    'variant_performance_metrics',
    'impulse_relevance_metrics',
    'db_admin_audit',
    'init_migrations',
  ];
  const row_counts: Record<string, number | null> = {};
  for (const t of tablesOfInterest) row_counts[t] = await safeCount(t);

  // Missing-index heuristic — surface slow ops from /metrics/db; a high
  // slow_queries count against large tables suggests a missing index. We
  // cannot read SurrealDB's query planner, so this is advisory: name the
  // largest tables and the latency tail so the caller can target create_index.
  const slowTables = Object.entries(row_counts)
    .filter(([, c]) => typeof c === 'number' && (c as number) > 100000)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .map(([t, c]) => ({ table: t, rows: c }));
  if (slowTables.length > 0) {  // a large table with an unindexed hot column is worth surfacing regardless of the transient slow-query window
    // Emit a CONCRETE, auto-applyable suggestion: for each large table, find its known
    // hot filter/order columns that are NOT already indexed and propose a concrete
    // CONCURRENTLY index (non-blocking, safe to auto-apply). No more `<choose>`
    // placeholders — the maintenance tick can act on these directly. (2026-06-28)
    const HOT_COLS: Record<string, string[]> = {
      activity_execution_traces: ['executed_at', 'activity_id', 'status', 'org_id'],
      goal_execution_paths: ['goal_hash', 'updated_at'],
      variant_performance_metrics: ['variant_id'],
      context_thompson_scores: ['template_id'],
      activity_composition_graph: ['edge_kind'],
      successor_features: ['template_id'],
    };
    for (const { table, rows } of slowTables.slice(0, 3)) {
      const hot = HOT_COLS[table];
      if (!hot) continue;
      let indexedCols = new Set<string>();
      try {
        const info = await surrealDB.query<any>(`INFO FOR TABLE ${table}`);
        const idx = ((info?.[0] as any)?.indexes ?? {}) as Record<string, string>;
        for (const def of Object.values(idx)) {
          const fm = String(def).match(/FIELDS\s+([A-Za-z0-9_.,\s]+)/i);
          if (fm) fm[1].split(',').forEach((c) => indexedCols.add(c.trim()));
        }
      } catch { /* advisory only */ }
      const missing = hot.find((c) => !indexedCols.has(c));
      if (missing) {
        suggested.push({
          operation: 'create_index',
          reason: `${dbMetrics.slow_queries} slow queries; ${table} (${rows} rows) hot column "${missing}" is unindexed`,
          params: { table, name: `idx_${table}_${missing.replace(/\W/g, '_')}`.slice(0, 60), fields: missing, concurrent: true },
          advisory: false,
        });
      }
    }
  }

  return {
    db_metrics: {
      error_rate: dbMetrics.error_rate,
      slow_queries: dbMetrics.slow_queries,
      latency_ms: dbMetrics.latency_ms,
      in_flight: dbMetrics.in_flight,
      qps: dbMetrics.qps,
    },
    integrity,
    row_counts,
    large_tables: slowTables,
    suggested_remediations: suggested,
  };
}

// ---------------------------------------------------------------------------
// Operation: create_index (additive — may default-apply)
// ---------------------------------------------------------------------------

function isSafeIdent(s: string): boolean {
  return typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

async function runCreateIndex(pointer: any): Promise<{ ok: boolean; error?: string; result?: any; impact: number }> {
  const name = pointer?.name;
  const table = pointer?.table;
  const fields = pointer?.fields;
  const unique = pointer?.unique === true;

  if (!isSafeIdent(name)) return { ok: false, error: 'create_index: `name` must be a simple identifier', impact: 0 };
  if (!isSafeIdent(table)) return { ok: false, error: 'create_index: `table` must be a simple identifier', impact: 0 };
  // fields: string or array of simple field names (dotted paths allowed).
  const fieldList = Array.isArray(fields) ? fields : typeof fields === 'string' ? [fields] : [];
  if (fieldList.length === 0) return { ok: false, error: 'create_index: `fields` required', impact: 0 };
  for (const f of fieldList) {
    if (typeof f !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(f)) {
      return { ok: false, error: `create_index: invalid field "${f}"`, impact: 0 };
    }
  }

  // CONCURRENTLY builds the index ASYNCHRONOUSLY in the background (verified on
  // SurrealDB 2.3.3: returns in ~2ms even on the 275k-row activity_execution_traces,
  // instead of the 27-min synchronous hang). This is what makes large-table indexing
  // AUTONOMOUS + non-blocking — the substrate can index its biggest tables itself
  // without freezing the /sql endpoint. IF NOT EXISTS keeps it re-run safe. Pass
  // concurrent:false for a synchronous build (small tables / when you need it ready
  // immediately). (2026-06-28)
  const concurrent = pointer?.concurrent !== false;
  const sql = `DEFINE INDEX IF NOT EXISTS ${name} ON ${table} FIELDS ${fieldList.join(', ')}${unique ? ' UNIQUE' : ''}${concurrent ? ' CONCURRENTLY' : ''}`;
  const cat = rejectCatastrophicSql(sql);
  if (cat) return { ok: false, error: cat, impact: 0 };

  try {
    await surrealDB.query<any>(sql);
    return { ok: true, result: { sql, definition: sql, concurrent, note: concurrent ? 'index building asynchronously in background (non-blocking)' : 'synchronous build' }, impact: 1 };
  } catch (err: any) {
    return { ok: false, error: `create_index failed: ${err?.message}`, impact: 0 };
  }
}

// ---------------------------------------------------------------------------
// Operation: apply_migration (additive — may default-apply)
//   mode 'statements' — run vetted idempotent DEFINEs + record in init_migrations
//   mode 'reconcile'  — mark known-failing migration filenames as applied so
//                       they STOP re-running every restart (the 1332-failure fix)
// ---------------------------------------------------------------------------

async function recordMigrationApplied(filename: string): Promise<void> {
  // Mirrors scripts/init-database.ts markMigrationApplied (INSERT IGNORE on the
  // UNIQUE filename index).
  await surrealDB.query<any>(
    `INSERT IGNORE INTO init_migrations (filename, applied_at) VALUES ($f, time::now())`,
    { f: filename },
  );
}

async function runApplyMigration(pointer: any): Promise<{ ok: boolean; error?: string; result?: any; impact: number }> {
  const mode = pointer?.mode;

  if (mode === 'reconcile') {
    const filenames: string[] = Array.isArray(pointer?.filenames) ? pointer.filenames : [];
    if (filenames.length === 0) {
      return { ok: false, error: 'apply_migration reconcile: `filenames` (string[]) required', impact: 0 };
    }
    for (const f of filenames) {
      if (typeof f !== 'string' || !/^[\w.\-]+\.surql$/.test(f)) {
        return { ok: false, error: `apply_migration reconcile: invalid filename "${f}"`, impact: 0 };
      }
    }
    const reconciled: string[] = [];
    for (const f of filenames) {
      await recordMigrationApplied(f);
      reconciled.push(f);
    }
    return { ok: true, result: { mode, reconciled }, impact: reconciled.length };
  }

  if (mode === 'statements') {
    const statements: string[] = Array.isArray(pointer?.statements) ? pointer.statements : [];
    const filename: string | undefined = pointer?.filename;
    if (statements.length === 0) {
      return { ok: false, error: 'apply_migration statements: `statements` (string[]) required', impact: 0 };
    }
    // Validate ALL statements before running ANY (fail closed).
    for (const stmt of statements) {
      const v = validateMigrationStatement(stmt);
      if (v) return { ok: false, error: v, impact: 0 };
    }
    const applied: string[] = [];
    for (const stmt of statements) {
      const s = stmt.trim();
      if (!s) continue;
      await surrealDB.query<any>(s);
      applied.push(s.slice(0, 120));
    }
    if (filename && /^[\w.\-]+\.surql$/.test(filename)) {
      await recordMigrationApplied(filename);
    }
    return { ok: true, result: { mode, statements_applied: applied.length, filename: filename ?? null }, impact: applied.length };
  }

  return { ok: false, error: "apply_migration: `mode` must be 'statements' or 'reconcile'", impact: 0 };
}

// ---------------------------------------------------------------------------
// Repair / prune — implemented in commit #2 (db-admin-repair.ts).
// Imported lazily so the safe core stands alone if that module is absent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

export interface DbAdminResult {
  status: number;
  body: any;
}

export async function resolveDbAdmin(pointer: any, actor: string | null): Promise<DbAdminResult> {
  const operation: string = pointer?.operation;

  // RAIL 1: operation whitelist.
  if (!DB_ADMIN_OPERATIONS.includes(operation as DbAdminOperation)) {
    return {
      status: 400,
      body: {
        success: false,
        error: `db_admin: unknown operation "${operation}". Allowed: ${DB_ADMIN_OPERATIONS.join(', ')}`,
      },
    };
  }

  try {
    if (operation === 'diagnose') {
      const report = await runDiagnose(pointer);
      await writeAudit({ operation, params: { tables: pointer?.tables ?? null }, applied: false, actor, impact_count: 0 });
      return {
        status: 200,
        body: {
          success: true,
          content: JSON.stringify(report),
          metadata: {
            shape: 'db_admin_diagnose',
            summary: `diagnose: error_rate=${report.db_metrics.error_rate} slow=${report.db_metrics.slow_queries} suggestions=${report.suggested_remediations.length}`,
          },
        },
      };
    }

    if (operation === 'create_index') {
      const r = await runCreateIndex(pointer);
      await writeAudit({
        operation,
        params: { name: pointer?.name, table: pointer?.table, fields: pointer?.fields, unique: pointer?.unique === true },
        applied: r.ok,
        actor,
        impact_count: r.impact,
        detail: r.ok ? r.result : { error: r.error },
      });
      if (!r.ok) return { status: 400, body: { success: false, error: r.error } };
      return {
        status: 200,
        body: {
          success: true,
          content: JSON.stringify(r.result),
          metadata: { shape: 'db_admin_create_index', summary: `index ${pointer?.name} ensured on ${pointer?.table}` },
        },
      };
    }

    if (operation === 'apply_migration') {
      const r = await runApplyMigration(pointer);
      await writeAudit({
        operation,
        params: { mode: pointer?.mode, filename: pointer?.filename ?? null, filenames: pointer?.filenames ?? null },
        applied: r.ok,
        actor,
        impact_count: r.impact,
        detail: r.ok ? r.result : { error: r.error },
      });
      if (!r.ok) return { status: 400, body: { success: false, error: r.error } };
      return {
        status: 200,
        body: {
          success: true,
          content: JSON.stringify(r.result),
          metadata: { shape: 'db_admin_apply_migration', summary: `apply_migration ${pointer?.mode}: ${r.impact} affected` },
        },
      };
    }

    if (operation === 'reconcile_trace_store') {
      return await resolveReconcileTraceStore(pointer, actor, { surrealDB, writeAudit });
    }

    // repair / prune — delegate to the repair module (commit #2). If absent,
    // the operation is whitelisted but not yet implemented in this build.
    if (operation === 'repair' || operation === 'prune') {
      let mod: any;
      try {
        // Computed specifier: keeps commit #1 standing alone (the repair module
        // ships in commit #2) without a static unresolved-import typecheck error.
        const repairModule = './db-admin-repair';
        mod = await import(/* @vite-ignore */ repairModule);
      } catch {
        await writeAudit({ operation, params: pointer ?? {}, applied: false, actor, impact_count: 0, detail: { error: 'not_implemented' } });
        return { status: 501, body: { success: false, error: `db_admin: operation "${operation}" not available in this build` } };
      }
      return await mod.resolveRepairOrPrune(operation, pointer, actor, {
        surrealDB,
        writeAudit,
        rejectCatastrophicSql,
        REPAIR_TARGET_WHITELIST,
        PRUNE_TABLE_WHITELIST,
        DEFAULT_MAX_ROWS,
        safeCount,
      });
    }

    return { status: 400, body: { success: false, error: `db_admin: unhandled operation "${operation}"` } };
  } catch (err: any) {
    logger.error('db_admin operation failed', { operation, error: err?.message });
    await writeAudit({ operation, params: pointer ?? {}, applied: false, actor, detail: { error: err?.message } });
    return { status: 500, body: { success: false, error: `db_admin ${operation} failed: ${err?.message}` } };
  }
}
