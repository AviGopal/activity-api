/**
 * Shared FTS rebuild job — used by both the periodic scheduler (index.ts) and
 * the HTTP endpoint (routes/activities.ts). The in-process flag prevents
 * concurrent REBUILD calls from racing: SurrealDB rejects a second REBUILD on
 * the same index with "currently building", but two callers racing on *different*
 * indexes (periodic on idx N, HTTP on idx 1) can produce a partial-rebuild
 * state that leaves some indexes cold while the test's beforeAll exits early.
 */

import { logger } from '../utils/logger';

let isRebuildInProgress = false;

const FTS_INDEXES = [
  'idx_activity_fts_name',
  'idx_activity_fts_tags',
] as const;

/**
 * Rebuild the FTS indexes (name, tags) sequentially.
 * Returns immediately (no-op) if a rebuild is already running in this process.
 */
export async function rebuildFtsIndexes(): Promise<void> {
  if (isRebuildInProgress) {
    logger.info('[FTS] rebuildFtsIndexes: already in progress, skipping');
    return;
  }
  isRebuildInProgress = true;
  const { surrealDB } = await import('../db/surreal');
  try {
    const start = Date.now();
    for (const idx of FTS_INDEXES) {
      try {
        await surrealDB.query(`REBUILD INDEX ${idx} ON activity`);
      } catch (err: any) {
        if (String(err).includes('currently building')) {
          logger.info(`[FTS] ${idx} already rebuilding (external), skipping`);
        } else {
          throw err;
        }
      }
    }
    logger.info('[FTS] rebuildFtsIndexes complete', { ms: Date.now() - start });
  } finally {
    isRebuildInProgress = false;
  }
}

export function isFtsRebuildInProgress(): boolean {
  return isRebuildInProgress;
}
