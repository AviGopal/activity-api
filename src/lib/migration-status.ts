/**
 * Failed migrations, as the running server sees them.
 *
 * scripts/init-database.ts runs before this process (the unit's ExecStartPre) and
 * records each file's outcome in `init_migrations.status`. A file the engine
 * rejected is recorded `failed` with the engine's text. The runner exits 0 so the
 * vessel still starts; this module is what keeps the failure visible afterwards:
 *
 *  - /health reports `checks.migrations` degraded, naming each failed file;
 *  - one substrateGap per failed file is filed with development-vessel, the
 *    existing gap-filing path (substrateGap_write, the same one the
 *    conservation-audit-emit bridge uses), with a stable id
 *    `migration-apply-failed-<file stem>`, so a re-filed gap updates, never grows.
 *
 * A row with no status predates per-file status and is not read as failed.
 */
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

export interface FailedMigration { filename: string; error: string; failed_at: string | null }

export interface MigrationHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  failed_count: number;
  failed: FailedMigration[];
  error?: string;
}

const FAILED_SQL = "SELECT filename, error, failed_at FROM init_migrations WHERE status = 'failed' ORDER BY filename";

/** Only rows that are unmistakably failed-migration rows count. */
function toFailed(rows: unknown): FailedMigration[] {
  if (!Array.isArray(rows)) return [];
  const out: FailedMigration[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    const filename = row['filename'];
    if (typeof filename !== 'string' || !/\.(surql|sql)$/.test(filename)) continue;
    out.push({
      filename,
      error: typeof row['error'] === 'string' ? (row['error'] as string) : '',
      failed_at: row['failed_at'] == null ? null : String(row['failed_at']),
    });
  }
  return out;
}

/** Read the failed rows now. Throws when the store cannot be read. */
export async function readFailedMigrations(): Promise<FailedMigration[]> {
  return toFailed(await surrealDB.query<Record<string, unknown>>(FAILED_SQL));
}

export function gapIdForMigration(filename: string): string {
  return `migration-apply-failed-${filename.replace(/\.(surql|sql)$/, '')}`;
}

let cache: { at: number; value: MigrationHealth } | null = null;
const CACHE_MS = 60_000;

/** The /health view. Never throws; an unreadable ledger is `unknown`, not degraded. */
export async function migrationHealth(now = Date.now()): Promise<MigrationHealth> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  let value: MigrationHealth;
  try {
    const failed = await Promise.race([
      readFailedMigrations(),
      new Promise<never>((_, rej) => { const t = setTimeout(() => rej(new Error('init_migrations read timed out')), 3_000); (t as { unref?: () => void }).unref?.(); }),
    ]);
    value = { status: failed.length > 0 ? 'degraded' : 'healthy', failed_count: failed.length, failed };
  } catch (e) {
    value = { status: 'unknown', failed_count: 0, failed: [], error: e instanceof Error ? e.message : String(e) };
  }
  cache = { at: now, value };
  return value;
}

export function resetMigrationHealthCache(): void { cache = null; }

export const DEFAULT_GAP_URL = 'http://127.0.0.1:8090/v2/impulses/resolve';

/** One substrateGap_write body for a failed migration. */
export function migrationGapBody(f: FailedMigration): Record<string, unknown> {
  return {
    impulse: {
      type: 'substrateGap_write',
      gap: {
        id: gapIdForMigration(f.filename),
        category: 'systematic_failure',
        source: 'substrate_detected',
        status: 'open',
        detected_at: new Date().toISOString(),
        summary:
          `Migration ${f.filename} failed to apply: the engine rejected it (a parse error applies none of ` +
          `the file's statements). init_migrations records it status=failed and activity-api /health ` +
          `reports migrations degraded until it applies. Engine error: ${f.error || '(none recorded)'}`,
      },
    },
  };
}

/**
 * File one gap per failed migration. Returns the ids posted successfully.
 * Each id is filed at most once per process; a failed post is retried on the next call.
 */
const filed = new Set<string>();
export async function fileMigrationGaps(opts: { url?: string; apiKey?: string; failed?: FailedMigration[] } = {}): Promise<string[]> {
  const url = opts.url ?? DEFAULT_GAP_URL;
  const apiKey = opts.apiKey ?? process.env['METABOB_API_KEY'] ?? '';
  const failed = opts.failed ?? await readFailedMigrations();
  const posted: string[] = [];
  for (const f of failed) {
    const id = gapIdForMigration(f.filename);
    if (filed.has(id)) continue;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        body: JSON.stringify(migrationGapBody(f)),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) { filed.add(id); posted.push(id); }
      else logger.warn('[Migrations] gap filing refused', { id, status: res.status });
    } catch (e) {
      logger.warn('[Migrations] gap filing failed', { id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return posted;
}

export function resetFiledGaps(): void { filed.clear(); }

/**
 * After the listener is up: read the ledger and file gaps, retrying a few times so
 * a development-vessel that starts later still receives them. Timers are unref'd.
 */
export function scheduleMigrationGapFiling(delaysMs: number[] = [30_000, 120_000, 600_000]): void {
  const run = async (i: number) => {
    let pending = 0;
    try {
      const failed = await readFailedMigrations();
      if (failed.length > 0) {
        logger.error('[Migrations] failed migrations recorded', { count: failed.length, files: failed.map((f) => f.filename) });
        await fileMigrationGaps({ failed });
        pending = failed.filter((f) => !filed.has(gapIdForMigration(f.filename))).length;
      }
    } catch (e) {
      pending = 1;
      logger.warn('[Migrations] could not read init_migrations', { error: e instanceof Error ? e.message : String(e) });
    }
    if (pending > 0 && i + 1 < delaysMs.length) {
      const t = setTimeout(() => void run(i + 1), delaysMs[i + 1]);
      (t as { unref?: () => void }).unref?.();
    }
  };
  const t = setTimeout(() => void run(0), delaysMs[0]);
  (t as { unref?: () => void }).unref?.();
}
