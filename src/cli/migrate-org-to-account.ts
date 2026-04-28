/**
 * Phase F: account_id backfill CLI.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Backfills `account_id` on legacy rows (account_id IS NONE) across the 41
 * Phase A (migration 095) + 7 Phase A2 (migration 097) tables. Sets
 * `account_id_version=2` to distinguish from Phase B's `=1` dual-writes,
 * so --rollback can clear only its own work.
 *
 * Account lookup: GET <user-vessel>/v2/accounts/by-org/:orgId. Falls back
 * to a 1:1 organizations:<x> → accounts:<x> mapping (matches user-vessel
 * sql/002-accounts-and-projects.surql backfill) if the route is missing.
 *
 * Modes: --dry-run, --table <name>, --resume, --rollback. Guardrails: 100
 * UPDATE/sec, LIMIT 500 pagination, idempotent (WHERE account_id IS NONE).
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { writeFileSync, readFileSync, existsSync } from 'fs';

// Tables — mirror migrations 095 (41) + 097 (7) = 48.
export const PHASE_A_TABLES: readonly string[] = ('activity execution impulse vessel activity_composition_graph activity_dataflows activity_execution_traces activity_prerequisites activity_registry activity_state_affinity circuit_breaker_trace code_variants composite_sequence_patterns composition_edge context_thompson_scores discovered_state_pattern execution_pattern execution_sequences execution_state_snapshot execution_traces external_validation_history state_feature_importance state_transition thompson_selection_log goal_execution_paths impulse_budget_log impulse_data impulse_relevance_metrics impulse_resolution_metrics impulse_state_pattern impulse_usage_history llm_resolution_log pattern prerequisite_patterns relevance_feedback routing_trace shape_definition tool_usage variant_performance_metrics ci_runs minibob_instance').split(' ');
export const PHASE_A2_TABLES: readonly string[] = ('composition_chain composition_node impulse_shape_activity_score tool_argument_pattern tool_usage_patterns vessel_circuit_breaker vessel_health_metrics').split(' ');
export const ALL_TABLES: readonly string[] = [...PHASE_A_TABLES, ...PHASE_A2_TABLES];

export const CHECKPOINT_PATH = '/tmp/migrate-account-id.checkpoint.json';
export const PAGE_SIZE = 500;
export const RATE_LIMIT_PER_SEC = 100;
export const CHECKPOINT_INTERVAL_ROWS = 100;

export interface CliOptions {
  dryRun: boolean; rollback: boolean; resume: boolean;
  table: string | null; userVesselEndpoint: string;
}
export interface TableProgress {
  processed: number; skipped: number; offset: number; done: boolean;
}
export type Checkpoint = Record<string, TableProgress>;
export interface DbLike {
  query<T = any>(sql: string, params?: Record<string, any>): Promise<T[]>;
}
export interface FetchLike {
  (input: string, init?: any): Promise<{
    ok: boolean; status: number; json: () => Promise<any>;
  }>;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: false, rollback: false, resume: false, table: null,
    userVesselEndpoint:
      process.env.USER_VESSEL_ENDPOINT ||
      'http://user-vessel.activity-system.svc.cluster.local:8080',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--rollback') opts.rollback = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--table') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--table requires a table name argument');
      }
      opts.table = next;
      i++;
    } else if (a === '--user-vessel') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--user-vessel requires a URL argument');
      }
      opts.userVesselEndpoint = next;
      i++;
    }
  }
  return opts;
}

/**
 * Caches lookups and degrades to a 1:1 fallback when user-vessel is
 * unreachable. Per-org 404 is cached as null (skip those rows).
 */
export class AccountMappingCache {
  private cache = new Map<string, string | null>();
  private endpointMissing = false;

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async lookup(orgId: string): Promise<string | null> {
    if (this.cache.has(orgId)) return this.cache.get(orgId)!;
    const degrade = (reason: string, ctx: object): string | null => {
      logger.warn(`[migrate-account-id] ${reason}; degrading to org→acct fallback`, ctx);
      this.endpointMissing = true;
      const fb = this.fallbackMapping(orgId);
      this.cache.set(orgId, fb);
      return fb;
    };
    if (this.endpointMissing) {
      const fb = this.fallbackMapping(orgId);
      this.cache.set(orgId, fb);
      return fb;
    }
    const url = `${this.endpoint}/v2/accounts/by-org/${encodeURIComponent(orgId)}`;
    let resp: Awaited<ReturnType<FetchLike>>;
    try {
      resp = await this.fetchImpl(url);
    } catch (err) {
      return degrade('user-vessel unreachable', { url, error: (err as Error).message });
    }
    if (resp.status === 404) {
      logger.info('[migrate-account-id] no account mapping for org_id', { orgId });
      this.cache.set(orgId, null);
      return null;
    }
    if (resp.status === 501 || resp.status === 405) {
      return degrade('/by-org route not implemented', { status: resp.status });
    }
    if (!resp.ok) {
      throw new Error(`user-vessel lookup failed for ${orgId}: HTTP ${resp.status}`);
    }
    const body = await resp.json();
    const accountId = (body && (body.account_id ?? body.id)) as string | undefined;
    if (!accountId || typeof accountId !== 'string') {
      logger.warn('[migrate-account-id] malformed user-vessel response; skipping', { orgId, body });
      this.cache.set(orgId, null);
      return null;
    }
    const normalized = accountId.startsWith('accounts:') ? accountId : `accounts:${accountId}`;
    this.cache.set(orgId, normalized);
    return normalized;
  }

  private fallbackMapping(orgId: string): string | null {
    if (!orgId || typeof orgId !== 'string') return null;
    if (orgId.startsWith('accounts:')) return orgId;
    if (orgId.startsWith('organizations:')) {
      const suffix = orgId.slice('organizations:'.length);
      return suffix ? `accounts:${suffix}` : null;
    }
    return `accounts:${orgId}`;
  }

  isDegraded(): boolean { return this.endpointMissing; }
  size(): number { return this.cache.size; }
}

/** Token bucket: 100 ops/sec sustained, burst up to 100. */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly opsPerSec: number = RATE_LIMIT_PER_SEC,
    private readonly now: () => number = Date.now,
    private readonly sleeper: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) { this.tokens = opsPerSec; this.lastRefill = now(); }

  async acquire(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      await this.sleeper(Math.ceil(1000 / this.opsPerSec));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.opsPerSec,
      this.tokens + (elapsed / 1000) * this.opsPerSec);
    this.lastRefill = now;
  }
}

export function loadCheckpoint(path: string = CHECKPOINT_PATH): Checkpoint {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return (parsed && typeof parsed === 'object' ? parsed : {}) as Checkpoint;
  } catch (err) {
    logger.warn('[migrate-account-id] checkpoint unreadable; starting fresh',
      { path, error: (err as Error).message });
    return {};
  }
}

export function writeCheckpoint(cp: Checkpoint, path: string = CHECKPOINT_PATH): void {
  writeFileSync(path, JSON.stringify(cp, null, 2), 'utf8');
}

interface RowToBackfill { id: string; org_id: string | null | undefined; }

/** Forward migration over one table. Idempotent via WHERE account_id IS NONE. */
export async function migrateTable(
  table: string, cache: AccountMappingCache, limiter: RateLimiter, db: DbLike,
  options: CliOptions, startProgress: TableProgress,
  onCheckpoint: (progress: TableProgress) => void,
): Promise<TableProgress> {
  const progress: TableProgress = { ...startProgress };
  const finish = () => { progress.done = true; onCheckpoint(progress); return progress; };

  while (true) {
    // Successful UPDATEs remove rows from the IS-NONE set; START $offset only
    // needs to skip past unbindable rows. Skipped is the natural offset.
    const rows = await db.query<RowToBackfill>(
      `SELECT id, org_id FROM ${table} WHERE account_id IS NONE LIMIT ${PAGE_SIZE} START $offset;`,
      { offset: progress.skipped });
    if (!rows || rows.length === 0) return finish();

    let rowsSinceCheckpoint = 0;
    for (const row of rows) {
      if (!row.org_id) { progress.skipped += 1; continue; }
      const accountId = await cache.lookup(row.org_id);
      if (!accountId) { progress.skipped += 1; continue; }

      if (options.dryRun) {
        progress.processed += 1;
      } else {
        await limiter.acquire();
        await db.query(
          `UPDATE type::thing($id) SET account_id = $aid, account_id_version = 2;`,
          { id: row.id, aid: accountId });
        progress.processed += 1;
        rowsSinceCheckpoint += 1;
        if (rowsSinceCheckpoint >= CHECKPOINT_INTERVAL_ROWS) {
          onCheckpoint(progress);
          rowsSinceCheckpoint = 0;
        }
      }

      const total = progress.processed + progress.skipped;
      if (total > 0 && total % 500 === 0) {
        logger.info(
          `[migrate-account-id] table ${table}: processed ${progress.processed}, skipped ${progress.skipped}`,
          { dryRun: options.dryRun });
      }
    }

    if (rows.length < PAGE_SIZE) return finish();
    onCheckpoint(progress);
  }
}

/** Inverse: clears Phase F's writes (version=2) only. Phase B (=1) preserved. */
export async function rollbackTable(
  table: string, limiter: RateLimiter, db: DbLike, options: CliOptions,
): Promise<{ cleared: number }> {
  if (options.dryRun) {
    const rows = await db.query<{ count: number }>(
      `SELECT count() AS count FROM ${table} WHERE account_id_version = 2 GROUP ALL;`,
    );
    return { cleared: (rows[0]?.count ?? 0) as number };
  }
  await limiter.acquire();
  const rows = await db.query<{ id: string }>(
    `UPDATE ${table} SET account_id = NONE, account_id_version = 0 ` +
    `WHERE account_id_version = 2 RETURN AFTER;`,
  );
  return { cleared: Array.isArray(rows) ? rows.length : 0 };
}

export async function runMigration(
  options: CliOptions,
  db: DbLike = surrealDB,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Checkpoint> {
  const tables = options.table ? [options.table] : ALL_TABLES;
  if (options.table && !ALL_TABLES.includes(options.table)) {
    throw new Error(`Unknown table: ${options.table}. Must be one of the 48 Phase A/A2 tables.`);
  }
  const cache = new AccountMappingCache(options.userVesselEndpoint, fetchImpl);
  const limiter = new RateLimiter();
  const checkpoint: Checkpoint = options.resume ? loadCheckpoint() : {};

  if (options.rollback) {
    logger.info('[migrate-account-id] rollback mode',
      { tableFilter: options.table, dryRun: options.dryRun, tables: tables.length });
    for (const table of tables) {
      const { cleared } = await rollbackTable(table, limiter, db, options);
      logger.info(`[migrate-account-id] rollback: ${table} cleared ${cleared} rows`,
        { dryRun: options.dryRun });
      checkpoint[table] = { processed: cleared, skipped: 0, offset: 0, done: true };
      writeCheckpoint(checkpoint);
    }
    return checkpoint;
  }

  logger.info('[migrate-account-id] forward mode', {
    tableFilter: options.table, dryRun: options.dryRun, tables: tables.length,
    resume: options.resume, userVessel: options.userVesselEndpoint,
  });
  for (const table of tables) {
    const start = checkpoint[table] ?? { processed: 0, skipped: 0, offset: 0, done: false };
    if (start.done) {
      logger.info(`[migrate-account-id] skipping done table: ${table}`, { progress: start });
      continue;
    }
    const final = await migrateTable(table, cache, limiter, db, options, start, (p) => {
      checkpoint[table] = p;
      writeCheckpoint(checkpoint);
    });
    logger.info(
      `[migrate-account-id] finished table ${table}: processed ${final.processed}, skipped ${final.skipped}`,
      { dryRun: options.dryRun });
  }

  let totalProcessed = 0, totalSkipped = 0;
  for (const t of tables) {
    const p = checkpoint[t];
    if (p) { totalProcessed += p.processed; totalSkipped += p.skipped; }
  }
  logger.info('[migrate-account-id] done', {
    tables: tables.length, totalProcessed, totalSkipped,
    dryRun: options.dryRun, cacheSize: cache.size(), degraded: cache.isDegraded(),
  });
  return checkpoint;
}

if (typeof Bun !== 'undefined' && typeof Bun.main === 'string' && import.meta.path === Bun.main) {
  runMigration(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[migrate-account-id] fatal', { error: (err as Error).message });
      process.exit(1);
    });
}
