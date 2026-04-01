/**
 * Heartbeat Worker
 *
 * Background job that runs every 10 seconds to:
 * 1. Find connections that missed heartbeat (stale)
 * 2. Calculate grace period based on execution state
 * 3. Transition stale connections to grace status
 * 4. Expire grace periods and mark connections as disconnected
 * 5. Handle orphaned executions
 */

import { surrealDB } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { logger } from '../utils/logger';
import {
  releaseSlot,
  calculateGracePeriod,
  storeConnectionDetails
} from '../routes/connections';

// Configuration
const HEARTBEAT_INTERVAL_MS = 10 * 1000; // 10 seconds
const HEARTBEAT_TIMEOUT_MS = 30 * 1000; // Connection is stale after 30s without heartbeat

interface Connection {
  id: string;
  api_key_id: string;
  org_id: string;
  session_token: string;
  connected_at: string;
  status: 'active' | 'grace' | 'disconnected';
  last_heartbeat: string;
  grace_until?: string;
  current_execution?: string;
  execution_started_at?: string;
  estimated_duration_ms?: number;
}

/**
 * Process heartbeats - find stale connections and manage grace periods
 */
async function processHeartbeats(): Promise<void> {
  const now = Date.now();
  const staleThreshold = new Date(now - HEARTBEAT_TIMEOUT_MS).toISOString();

  try {
    // Find active connections that missed heartbeat
    const staleConnections = await surrealDB.query<Connection>(
      `SELECT * FROM active_connections
       WHERE status = 'active'
       AND last_heartbeat < $threshold`,
      { threshold: staleThreshold }
    );

    for (const conn of staleConnections) {
      try {
        // Calculate grace period based on execution state
        const gracePeriodMs = calculateGracePeriod(conn);
        const graceUntil = new Date(now + gracePeriodMs).toISOString();

        // Transition to grace status
        await surrealDB.query(
          `UPDATE $connId SET
            status = 'grace',
            grace_until = $graceUntil,
            updated_at = $now`,
          {
            connId: conn.id,
            graceUntil,
            now: new Date().toISOString()
          }
        );

        // Update Redis
        await storeConnectionDetails(conn.id, {
          status: 'grace',
          grace_until: graceUntil
        });

        logger.info('[HeartbeatWorker] Connection entered grace period', {
          active_connectionsId: conn.id,
          apiKeyId: conn.api_key_id,
          gracePeriodMs,
          graceUntil,
          hasExecution: !!conn.current_execution
        });
      } catch (error) {
        const err = error as Error;
        logger.error('[HeartbeatWorker] Failed to transition active_connections to grace', {
          active_connectionsId: conn.id,
          error: err.message
        });
      }
    }

    // Find grace periods that have expired
    const expiredConnections = await surrealDB.query<Connection>(
      `SELECT * FROM active_connections
       WHERE status = 'grace'
       AND grace_until < $now`,
      { now: new Date().toISOString() }
    );

    for (const conn of expiredConnections) {
      try {
        const nowIso = new Date().toISOString();

        // Mark as disconnected
        await surrealDB.query(
          `UPDATE $connId SET
            status = 'disconnected',
            disconnected_at = $now,
            updated_at = $now`,
          { connId: conn.id, now: nowIso }
        );

        // If there was an execution, mark it as orphaned
        if (conn.current_execution) {
          await surrealDB.query(
            `UPDATE $execId MERGE {
              outcome: {
                status: 'orphaned',
                error: 'Connection lost during execution'
              },
              updated_at: $now
            }`,
            { execId: conn.current_execution, now: nowIso }
          );

          logger.warn('[HeartbeatWorker] Orphaned execution due to active_connections loss', {
            active_connectionsId: conn.id,
            executionId: conn.current_execution
          });
        }

        // Release the slot in Redis
        await releaseSlot(conn.api_key_id, conn.id);

        logger.info('[HeartbeatWorker] Connection grace period expired', {
          active_connectionsId: conn.id,
          apiKeyId: conn.api_key_id,
          hadExecution: !!conn.current_execution
        });
      } catch (error) {
        const err = error as Error;
        logger.error('[HeartbeatWorker] Failed to expire active_connections', {
          active_connectionsId: conn.id,
          error: err.message
        });
      }
    }

    // Log summary if any work was done
    if (staleConnections.length > 0 || expiredConnections.length > 0) {
      logger.debug('[HeartbeatWorker] Cycle complete', {
        staleTransitioned: staleConnections.length,
        graceExpired: expiredConnections.length
      });
    }

  } catch (error) {
    const err = error as Error;
    logger.error('[HeartbeatWorker] Failed to process heartbeats', {
      error: err.message
    });
  }
}

/**
 * Clean up old disconnected connections (run less frequently)
 * Removes connections that have been disconnected for > 24 hours
 */
async function cleanupOldConnections(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const deleted = await surrealDB.query<{ count: number }>(
      `DELETE active_connections WHERE status = 'disconnected' AND disconnected_at < $cutoff RETURN COUNT()`
    , { cutoff });

    const count = deleted[0]?.count || 0;
    if (count > 0) {
      logger.info('[HeartbeatWorker] Cleaned up old disconnected connections', {
        deleted: count
      });
    }
  } catch (error) {
    const err = error as Error;
    logger.error('[HeartbeatWorker] Failed to cleanup old connections', {
      error: err.message
    });
  }
}

// Worker state
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Start the heartbeat worker
 */
export function startHeartbeatWorker(): void {
  if (isRunning) {
    logger.warn('[HeartbeatWorker] Already running');
    return;
  }

  isRunning = true;

  // Run heartbeat processing every 10 seconds
  heartbeatInterval = setInterval(processHeartbeats, HEARTBEAT_INTERVAL_MS);

  // Run cleanup once per hour
  cleanupInterval = setInterval(cleanupOldConnections, 60 * 60 * 1000);

  // Run initial processing after 5 seconds (let system stabilize)
  setTimeout(processHeartbeats, 5000);

  logger.info('[HeartbeatWorker] Started', {
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS
  });
}

/**
 * Stop the heartbeat worker
 */
export function stopHeartbeatWorker(): void {
  if (!isRunning) {
    return;
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  isRunning = false;
  logger.info('[HeartbeatWorker] Stopped');
}

/**
 * Check if worker is running
 */
export function isHeartbeatWorkerRunning(): boolean {
  return isRunning;
}

// Export for testing
export { processHeartbeats, cleanupOldConnections, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS };
