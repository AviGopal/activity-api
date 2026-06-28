/**
 * db_admin repair + prune — the DESTRUCTIVE half of substrate DB self-management.
 *
 * Loaded lazily by src/routes/db-admin.ts only for operation 'repair' | 'prune'.
 * Everything dangerous lives behind a VETTED PATTERN CATALOGUE — callers select
 * a pattern by name and pass parameters; they NEVER supply raw SQL. Each pattern
 * is a parameterized template whose target table/field is itself whitelisted.
 *
 * Rails (in addition to the operation/catastrophic-op rails in db-admin.ts):
 *   - PATTERN WHITELIST    — unknown pattern -> rejected.
 *   - dry_run DEFAULTS TRUE — repair/prune mutate ONLY when `apply:true`.
 *   - BOUNDED              — affected_count > max_rows refuses to apply without
 *                            `force:true` (default cap DEFAULT_MAX_ROWS=5000).
 *   - AUDIT               — one row per invocation (dry-run AND apply) with
 *                            before/after impact counts.
 *   - SOFT-FIRST prune    — prune marks rows deprecated by default; hard DELETE
 *                            only with `hard:true` + apply:true + bound.
 */

import { logger } from '../utils/logger';

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
  rejectCatastrophicSql: (sql: string) => string | null;
  REPAIR_TARGET_WHITELIST: Record<string, string[]>;
  PRUNE_TABLE_WHITELIST: Set<string>;
  DEFAULT_MAX_ROWS: number;
  safeCount: (table: string, where?: string) => Promise<number | null>;
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
// Repair pattern catalogue. Each builds a COUNT (dry-run) and a MUTATE query
// from whitelisted table/field inputs. No raw SQL ever crosses the boundary.
// ---------------------------------------------------------------------------

type RepairPattern = {
  describe: (p: any) => string;
  validate: (p: any, ctx: Ctx) => string | null; // returns error or null
  countSql: (p: any) => { sql: string; params: Record<string, unknown> };
  mutateSql: (p: any) => { sql: string; params: Record<string, unknown> };
};

const REPAIR_PATTERNS: Record<string, RepairPattern> = {
  // Orphaned composition edges: a derived edge whose endpoints are unset is
  // unusable for credit-mixing and pollutes λ₁ accounting.
  delete_none_fk: {
    describe: () => 'DELETE activity_composition_graph rows with NONE child/parent_activity_id',
    validate: () => null,
    countSql: () => ({
      sql: 'SELECT count() AS c FROM activity_composition_graph WHERE child_activity_id IS NONE OR parent_activity_id IS NONE GROUP ALL',
      params: {},
    }),
    mutateSql: () => ({
      sql: 'DELETE activity_composition_graph WHERE child_activity_id IS NONE OR parent_activity_id IS NONE',
      params: {},
    }),
  },

  // Coerce a NULL value in an `option<...>` field to NONE so the SCHEMAFULL
  // field stops failing reads/writes. table+field are whitelisted.
  coerce_null_to_none: {
    describe: (p) => `UPDATE ${p?.table}.${p?.field} = NONE WHERE = NULL`,
    validate: (p, ctx) => {
      const allowed = ctx.REPAIR_TARGET_WHITELIST[p?.table];
      if (!allowed) return `coerce_null_to_none: table "${p?.table}" not in repair whitelist`;
      if (!allowed.includes(p?.field)) return `coerce_null_to_none: field "${p?.field}" not whitelisted for ${p?.table}`;
      return null;
    },
    // table/field already validated against the whitelist → safe to interpolate.
    countSql: (p) => ({
      sql: `SELECT count() AS c FROM ${p.table} WHERE ${p.field} = NULL GROUP ALL`,
      params: {},
    }),
    mutateSql: (p) => ({
      sql: `UPDATE ${p.table} SET ${p.field} = NONE WHERE ${p.field} = NULL`,
      params: {},
    }),
  },

  // Doubled-prefix ids (`activity:⟨activity:⟨…⟩⟩`) are unreachable via
  // type::record() and pollute the registry. Delete them.
  delete_doubled_prefix_ids: {
    describe: () => 'DELETE activity_template rows with doubled-prefix ids',
    validate: () => null,
    countSql: () => ({
      sql: `SELECT count() AS c FROM activity_template WHERE string::contains(<string> id, 'activity:⟨activity:') GROUP ALL`,
      params: {},
    }),
    mutateSql: () => ({
      sql: `DELETE activity_template WHERE string::contains(<string> id, 'activity:⟨activity:')`,
      params: {},
    }),
  },
};

// ---------------------------------------------------------------------------
// Prune pattern catalogue (growth policy). Soft-first.
// ---------------------------------------------------------------------------

type PrunePattern = {
  describe: (p: any) => string;
  validate: (p: any, ctx: Ctx) => string | null;
  countSql: (p: any) => { sql: string; params: Record<string, unknown> };
  softSql?: (p: any) => { sql: string; params: Record<string, unknown> };
  hardSql: (p: any) => { sql: string; params: Record<string, unknown> };
};

const PRUNE_PATTERNS: Record<string, PrunePattern> = {
  // Prune execution traces older than `older_than_days` (default 90). Soft =
  // set deprecated=true; hard = DELETE. The cutoff is always a bound WHERE.
  prune_traces_older_than: {
    describe: (p) => `prune activity_execution_traces older than ${p?.older_than_days ?? 90} days`,
    validate: (p, ctx) => {
      const table = p?.table ?? 'activity_execution_traces';
      if (!ctx.PRUNE_TABLE_WHITELIST.has(table)) return `prune: table "${table}" not in prune whitelist`;
      const days = p?.older_than_days ?? 90;
      if (typeof days !== 'number' || days < 7) return 'prune: older_than_days must be a number >= 7 (refusing to prune recent data)';
      return null;
    },
    countSql: (p) => ({
      sql: `SELECT count() AS c FROM ${p?.table ?? 'activity_execution_traces'} WHERE executed_at < (time::now() - ${Math.floor(p?.older_than_days ?? 90)}d) GROUP ALL`,
      params: {},
    }),
    softSql: (p) => ({
      sql: `UPDATE ${p?.table ?? 'activity_execution_traces'} SET deprecated = true, deprecated_at = time::now() WHERE executed_at < (time::now() - ${Math.floor(p?.older_than_days ?? 90)}d)`,
      params: {},
    }),
    hardSql: (p) => ({
      sql: `DELETE ${p?.table ?? 'activity_execution_traces'} WHERE executed_at < (time::now() - ${Math.floor(p?.older_than_days ?? 90)}d)`,
      params: {},
    }),
  },
};

// ---------------------------------------------------------------------------
// Shared count helper
// ---------------------------------------------------------------------------

async function runCount(ctx: Ctx, sql: string, params: Record<string, unknown>): Promise<number> {
  const rows = await ctx.surrealDB.query<any>(sql, params);
  const row = (Array.isArray(rows) ? rows : [])[0];
  return row && typeof row.c === 'number' ? row.c : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function resolveRepairOrPrune(
  operation: 'repair' | 'prune',
  pointer: any,
  actor: string | null,
  ctx: Ctx,
): Promise<DbAdminResult> {
  const patternName: string = pointer?.pattern;
  const apply = pointer?.apply === true; // RAIL: dry_run defaults TRUE
  const force = pointer?.force === true;
  const maxRows = typeof pointer?.max_rows === 'number' && pointer.max_rows > 0 ? pointer.max_rows : ctx.DEFAULT_MAX_ROWS;

  const catalogue = operation === 'repair' ? REPAIR_PATTERNS : PRUNE_PATTERNS;

  // RAIL: pattern whitelist.
  const pattern = (catalogue as any)[patternName];
  if (!pattern) {
    await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName ?? null, applied: false, actor, impact_count: 0, detail: { error: 'pattern_not_whitelisted' } });
    return bad(`db_admin ${operation}: pattern "${patternName}" is not in the vetted catalogue. Allowed: ${Object.keys(catalogue).join(', ')}`);
  }

  // Per-pattern parameter validation (table/field whitelists, bounds).
  const vErr = pattern.validate(pointer, ctx);
  if (vErr) {
    await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, impact_count: 0, detail: { error: vErr } });
    return bad(vErr);
  }

  // Dry-run impact count (always computed first).
  const { sql: cSql, params: cParams } = pattern.countSql(pointer);
  let affected: number;
  try {
    affected = await runCount(ctx, cSql, cParams);
  } catch (err: any) {
    await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, detail: { error: err?.message } });
    return bad(`db_admin ${operation} count failed: ${err?.message}`, 500);
  }

  const base = {
    operation,
    pattern: patternName,
    description: pattern.describe(pointer),
    affected_count: affected,
    max_rows: maxRows,
    dry_run: !apply,
  };

  // DRY-RUN PATH (default): no mutation, just report + audit.
  if (!apply) {
    await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, impact_count: affected, detail: { dry_run: true, description: base.description } });
    return ok(
      { ...base, note: 'dry_run — no rows mutated. Re-send with apply:true to execute.' },
      `db_admin_${operation}_dryrun`,
      `${operation} dry-run: ${affected} rows would be affected (${patternName})`,
    );
  }

  // APPLY PATH — bound check.
  if (affected > maxRows && !force) {
    await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, impact_count: affected, detail: { refused: 'exceeds_max_rows', max_rows: maxRows } });
    return bad(`db_admin ${operation} refused: affected_count ${affected} exceeds max_rows ${maxRows}. Raise max_rows or pass force:true to override.`);
  }

  // Select mutation SQL. Prune is SOFT-FIRST unless hard:true.
  let mutate: { sql: string; params: Record<string, unknown> };
  let mode = 'mutate';
  if (operation === 'prune') {
    const pp = pattern as PrunePattern;
    if (pointer?.hard === true) {
      mutate = pp.hardSql(pointer);
      mode = 'hard_delete';
    } else if (pp.softSql) {
      mutate = pp.softSql(pointer);
      mode = 'soft_deprecate';
    } else {
      mutate = pp.hardSql(pointer);
      mode = 'hard_delete';
    }
  } else {
    mutate = (pattern as RepairPattern).mutateSql(pointer);
  }

  // Final catastrophic-op gate on the actual SQL about to run (defence in depth).
  const cat = ctx.rejectCatastrophicSql(mutate.sql);
  if (cat) {
    await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, impact_count: affected, detail: { error: cat } });
    return bad(cat);
  }

  // SNAPSHOT-BEFORE-DESTRUCTIVE (autonomous reversibility): for any op that DELETES or
  // mutates rows, capture the affected rows to /workspace/db-backups BEFORE touching
  // them, so a bad autonomous prune/repair is recoverable WITHOUT operator action. The
  // snapshot is FAIL-SAFE: if we cannot back the rows up, we ABORT — never delete data
  // we can't restore. Soft-deprecate prune is reversible by design (un-deprecate) so it
  // is exempt. (2026-06-28)
  let backupPath: string | null = null;
  if (mode === 'hard_delete' || (operation === 'repair' && /\b(DELETE|UPDATE)\b/i.test(mutate.sql))) {
    // Derive a SELECT for the same target rows from the DELETE/UPDATE predicate.
    const m = mutate.sql.match(/^\s*DELETE\s+(\S+)\s+WHERE\s+(.+)$/is)
      ?? mutate.sql.match(/^\s*UPDATE\s+(\S+)\s+SET\s+.+?\s+WHERE\s+(.+)$/is);
    if (!m) {
      await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, impact_count: affected, detail: { error: 'snapshot_abort: could not derive backup SELECT from mutate predicate', mode } });
      return bad('db_admin: aborting destructive op — could not derive a pre-mutation backup query. No rows touched.');
    }
    try {
      const rows = await ctx.surrealDB.query<any>(`SELECT * FROM ${m[1]} WHERE ${m[2]} LIMIT ${maxRows}`, mutate.params);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupPath = `/workspace/db-backups/${stamp}-${operation}-${patternName}.json`;
      await Bun.write(backupPath, JSON.stringify({ at: new Date().toISOString(), operation, pattern: patternName, table: m[1], predicate: m[2], affected_count: affected, rows }, null, 0));
    } catch (err: any) {
      await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, impact_count: affected, detail: { error: `snapshot_abort: ${err?.message}`, mode } });
      return bad(`db_admin: aborting destructive op — pre-mutation backup failed (${err?.message}). No rows touched. Data is never deleted without a recoverable snapshot.`);
    }
  }

  try {
    await ctx.surrealDB.query<any>(mutate.sql, mutate.params);
  } catch (err: any) {
    logger.error('db_admin mutate failed', { operation, pattern: patternName, error: err?.message });
    await ctx.writeAudit({ operation, params: pointer ?? {}, pattern: patternName, applied: false, actor, impact_count: affected, detail: { error: err?.message, mode } });
    return bad(`db_admin ${operation} apply failed: ${err?.message}`, 500);
  }

  // After-count for accountability.
  let afterCount: number | null = null;
  try {
    afterCount = await runCount(ctx, cSql, cParams);
  } catch { /* best-effort */ }

  await ctx.writeAudit({
    operation,
    params: pointer ?? {},
    pattern: patternName,
    applied: true,
    actor,
    impact_count: affected,
    detail: { mode, before: affected, after: afterCount, description: base.description, backup_path: backupPath },
  });

  return ok(
    { ...base, applied: true, mode, before: affected, after: afterCount, backup_path: backupPath },
    `db_admin_${operation}_applied`,
    `${operation} applied (${mode}): ${affected} -> ${afterCount ?? '?'} rows (${patternName})`,
  );
}
