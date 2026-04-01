/**
 * Vessel Registry Cleanup Job
 *
 * Periodically removes expired vessels from the registry.
 * Vessels expire when they fail to send heartbeats within their TTL.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

/**
 * Clean up expired vessels from the registry.
 *
 * Deletes all vessel records where expires_at < now().
 * This ensures stale vessels don't pollute discovery results.
 */
export async function cleanupExpiredVessels(): Promise<void> {
  try {
    const query = `
      DELETE FROM vessel
      WHERE expires_at < time::now()
      RETURN id;
    `;

    const deleted = await surrealDB.query<{ id: string }[]>(query);

    if (deleted.length > 0) {
      logger.info('Cleaned up expired vessels', {
        count: deleted.length,
        vessels: deleted.map((v) => v.id),
      });
    }
  } catch (error) {
    const err = error as Error;
    logger.error('Failed to clean up expired vessels', {
      error: err.message,
    });
  }
}

/**
 * Start the cleanup job.
 *
 * Runs every 60 seconds to remove expired vessels.
 */
export function startCleanupJob(): NodeJS.Timeout {
  logger.info('Starting vessel cleanup job', {
    intervalSeconds: 60,
  });

  // Run immediately on start
  cleanupExpiredVessels();

  // Then run every 60 seconds
  return setInterval(cleanupExpiredVessels, 60_000);
}
