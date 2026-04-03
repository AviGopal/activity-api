/**
 * Connection Slot Routes
 *
 * Manages connection slots for API key-based billing model.
 * Each API key has a limited number of concurrent connection slots.
 *
 * Endpoints:
 * - POST /v2/connections/acquire - Acquire a connection slot
 * - POST /v2/connections/heartbeat - Send heartbeat to maintain connection
 * - POST /v2/connections/reconnect - Reconnect within grace period
 * - POST /v2/connections/release - Release a connection slot
 *
 * State machine: active → grace → disconnected
 */

import { Hono } from 'hono';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';

const connections = new Hono();

// ============================================================================
// Types
// ============================================================================

interface ApiKey {
  id: string;
  org_id: string;
  key_hash: string;
  max_connections: number;
  tier: 'starter' | 'pro' | 'enterprise';
  is_active: boolean;
  llm_budget: {
    tokens_per_month: number;
    tokens_used: number;
    reset_at: string;
    overage_enabled: boolean;
  };
}

interface Connection {
  id: string;
  api_key_id: string;
  org_id: string;
  instance_name?: string;
  session_token: string;
  status: 'active' | 'grace' | 'disconnected';
  connected_at: string;
  last_heartbeat: string;
  grace_until?: string;
  current_execution?: string;
  execution_started_at?: string;
  estimated_duration_ms?: number;
  jwt_token?: string;
  jwt_expires_at?: string;
}

interface AcquireRequest {
  api_key: string;
  instance_name?: string;
}

interface HeartbeatRequest {
  current_execution?: {
    execution_id: string;
    activity_id: string;
    started_at: string;
    estimated_duration_ms?: number;
  };
}

interface ReconnectRequest {
  session_token: string;
}

// ============================================================================
// Redis Slot Management
// ============================================================================

const SLOT_TTL_SECONDS = 300; // 5 minutes, refreshed on heartbeat
const CONNECTION_DETAILS_TTL = 3600; // 1 hour

/**
 * Acquire a slot in Redis (atomic operation)
 * Returns true if slot acquired, false if limit reached
 */
async function acquireSlot(apiKeyId: string, connectionId: string, maxConnections: number): Promise<boolean> {
  const redis = RedisClient.getInstance();
  const client = redis.getClient();

  const setKey = `connections:${apiKeyId}`;

  // Atomic check and add using Lua script
  const script = `
    local current = redis.call('SCARD', KEYS[1])
    local max = tonumber(ARGV[1])
    if current < max then
      redis.call('SADD', KEYS[1], ARGV[2])
      redis.call('EXPIRE', KEYS[1], ${SLOT_TTL_SECONDS})
      return 1
    end
    return 0
  `;

  const result = await client.eval(script, 1, setKey, maxConnections.toString(), connectionId);

  if (result === 1) {
    logger.info('Slot acquired', { apiKeyId, connectionId, maxConnections });
    return true;
  }

  logger.info('Slot limit reached', { apiKeyId, connectionId, maxConnections });
  return false;
}

/**
 * Release a slot in Redis
 */
async function releaseSlot(apiKeyId: string, connectionId: string): Promise<void> {
  const redis = RedisClient.getInstance();
  await redis.srem(`connections:${apiKeyId}`, connectionId);
  await redis.del(`conn:${connectionId}`);
  logger.info('Slot released', { apiKeyId, connectionId });
}

/**
 * Get current slot count for an API key
 */
async function getSlotCount(apiKeyId: string): Promise<number> {
  const redis = RedisClient.getInstance();
  const members = await redis.smembers(`connections:${apiKeyId}`);
  return members.length;
}

/**
 * Refresh slot TTL on heartbeat
 */
async function refreshSlotTTL(apiKeyId: string): Promise<void> {
  const redis = RedisClient.getInstance();
  await redis.expire(`connections:${apiKeyId}`, SLOT_TTL_SECONDS);
}

/**
 * Store connection details in Redis for quick lookup
 */
async function storeConnectionDetails(connectionId: string, details: Partial<Connection>): Promise<void> {
  const redis = RedisClient.getInstance();
  const key = `conn:${connectionId}`;

  for (const [field, value] of Object.entries(details)) {
    if (value !== undefined && value !== null) {
      await redis.hset(key, field, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }

  await redis.expire(key, CONNECTION_DETAILS_TTL);
}

/**
 * Get connection details from Redis
 */
async function getConnectionDetails(connectionId: string): Promise<Record<string, string> | null> {
  const redis = RedisClient.getInstance();
  const client = redis.getClient();
  const key = `conn:${connectionId}`;

  const details = await client.hgetall(key);
  return Object.keys(details).length > 0 ? details : null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate a cryptographically secure session token
 */
function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Calculate grace period based on execution state
 */
function calculateGracePeriod(connection: Connection): number {
  const BASE_GRACE_MS = 2 * 60 * 1000; // 2 minutes idle
  const MAX_GRACE_MS = 30 * 60 * 1000; // 30 minutes hard cap

  if (!connection.current_execution || !connection.execution_started_at) {
    return BASE_GRACE_MS;
  }

  const elapsed = Date.now() - new Date(connection.execution_started_at).getTime();

  // Use estimated duration if available
  if (connection.estimated_duration_ms) {
    const remaining = connection.estimated_duration_ms - elapsed;
    const grace = remaining + (5 * 60 * 1000); // +5 min buffer
    return Math.min(Math.max(grace, BASE_GRACE_MS), MAX_GRACE_MS);
  }

  // Default: assume activity takes 15 minutes max
  const DEFAULT_ACTIVITY_MS = 15 * 60 * 1000;
  const remaining = DEFAULT_ACTIVITY_MS - elapsed;
  return Math.min(Math.max(remaining, BASE_GRACE_MS), MAX_GRACE_MS);
}

// ============================================================================
// POST /v2/connections/acquire
// ============================================================================

connections.post('/acquire', async (c) => {
  try {
    const body = await c.req.json() as AcquireRequest;
    const { api_key, instance_name } = body;

    if (!api_key) {
      return c.json({
        error: 'missing_api_key',
        message: 'api_key is required'
      }, 400);
    }

    // Find API key by hash comparison
    // First, get all active API keys and verify hash
    const apiKeys = await surrealDB.query<ApiKey>(
      `SELECT * FROM api_keys WHERE is_active = true AND status = 'active'`
    );

    let matchedKey: ApiKey | null = null;
    for (const key of apiKeys) {
      try {
        const isValid = await argon2.verify(key.key_hash, api_key);
        if (isValid) {
          matchedKey = key;
          break;
        }
      } catch {
        // Hash verification failed, continue to next key
      }
    }

    if (!matchedKey) {
      return c.json({
        error: 'invalid_api_key',
        message: 'API key is invalid or revoked'
      }, 401);
    }

    // Get max_connections (default to 1 if not set)
    const maxConnections = matchedKey.max_connections || 1;

    // Generate connection ID and session token
    const connectionId = `connection:${crypto.randomUUID()}`;
    const sessionToken = generateSessionToken();

    // Try to acquire slot in Redis
    const slotAcquired = await acquireSlot(matchedKey.id, connectionId, maxConnections);

    if (!slotAcquired) {
      // Get current connections for error response
      const activeCount = await getSlotCount(matchedKey.id);

      // Get oldest connection info
      const activeConnections = await surrealDB.query<Connection>(
        `SELECT * FROM active_connections
         WHERE api_key_id = $apiKeyId AND status IN ['active', 'grace']
         ORDER BY connected_at ASC LIMIT 1`,
        { apiKeyId: matchedKey.id }
      );

      const oldest = activeConnections[0];

      return c.json({
        error: 'connection_limit_reached',
        message: 'All connection slots are in use',
        max_connections: maxConnections,
        active_connections: activeCount,
        oldest_connection: oldest ? {
          instance_name: oldest.instance_name,
          connected_at: oldest.connected_at,
          status: oldest.status
        } : undefined
      }, 429);
    }

    // Generate JWT for this connection via identity-vessel
    // The apikey_record SurrealDB ACCESS method has been removed in favor of
    // HMAC-based validation via identity-vessel (faster, stateless, centralized)
    let jwtToken: string;
    try {
      const identityVesselUrl =
        process.env.IDENTITY_VESSEL_URL ||
        'http://identity-vessel.activity-system.svc.cluster.local:8080';

      const response = await fetch(`${identityVesselUrl}/v1/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        logger.warn('Identity vessel token exchange failed', { status: response.status });
        return c.json({
          error: 'auth_failed',
          message: 'Failed to authenticate API key'
        }, 401);
      }

      const result = await response.json() as { token: string };
      jwtToken = result.token;
    } catch (error) {
      const err = error as Error;
      logger.error('Identity vessel token exchange error', { error: err.message });
      return c.json({
        error: 'auth_service_unavailable',
        message: 'Authentication service temporarily unavailable'
      }, 503);
    }

    // Calculate JWT expiry (24 hours for connections)
    const jwtExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Create connection record in SurrealDB
    const now = new Date().toISOString();
    const connectionRecord = await surrealDB.query<Connection>(
      `CREATE $connectionId CONTENT {
        api_key_id: $apiKeyId,
        org_id: $orgId,
        instance_name: $instanceName,
        session_token: $sessionToken,
        status: 'active',
        connected_at: $now,
        last_heartbeat: $now,
        jwt_token: $jwtToken,
        jwt_expires_at: $jwtExpiresAt,
        created_at: $now,
        updated_at: $now
      }`,
      {
        connectionId,
        apiKeyId: matchedKey.id,
        orgId: matchedKey.org_id,
        instanceName: instance_name || null,
        sessionToken,
        now,
        jwtToken,
        jwtExpiresAt
      }
    );

    // Store in Redis for quick heartbeat/status checks
    await storeConnectionDetails(connectionId, {
      api_key_id: matchedKey.id,
      org_id: matchedKey.org_id,
      status: 'active',
      last_heartbeat: now
    });

    // Get current active count
    const activeConnections = await getSlotCount(matchedKey.id);

    logger.info('Connection acquired', {
      connectionId,
      apiKeyId: matchedKey.id,
      orgId: matchedKey.org_id,
      instanceName: instance_name,
      activeConnections,
      maxConnections
    });

    return c.json({
      connection_id: connectionId,
      session_token: sessionToken,
      jwt: jwtToken,
      jwt_expires_at: jwtExpiresAt,
      org_id: matchedKey.org_id.toString().replace('organizations:', ''),
      max_connections: maxConnections,
      active_connections: activeConnections,
      llm_budget: {
        tokens_remaining: matchedKey.llm_budget.tokens_per_month - matchedKey.llm_budget.tokens_used,
        reset_at: matchedKey.llm_budget.reset_at
      }
    }, 201);

  } catch (error) {
    const err = error as Error;
    logger.error('Failed to acquire connection', { error: err.message });
    return c.json({
      error: 'internal_error',
      message: 'Failed to acquire connection slot'
    }, 500);
  }
});

// ============================================================================
// POST /v2/connections/heartbeat
// ============================================================================

connections.post('/heartbeat', async (c) => {
  try {
    // Require JWT auth for heartbeat
    if (!hasJwtAuth(c)) {
      return c.json({
        error: 'unauthorized',
        message: 'JWT authentication required'
      }, 401);
    }

    const jwtAuth = getJwtAuthFromContext(c);
    const body = await c.req.json().catch(() => ({})) as HeartbeatRequest;

    // Get connection ID from header
    const connectionId = c.req.header('X-Connection-ID');
    if (!connectionId) {
      return c.json({
        error: 'missing_connection_id',
        message: 'X-Connection-ID header is required'
      }, 400);
    }

    // Verify connection exists and belongs to this org
    const connectionsResult = await queryWithAuth<Connection>(
      jwtAuth!.jwtToken,
      `SELECT * FROM $connectionId WHERE status IN ['active', 'grace']`,
      { connectionId }
    );

    if (connectionsResult.length === 0) {
      return c.json({
        error: 'connection_not_found',
        message: 'Connection not found or already disconnected'
      }, 404);
    }

    const connection = connectionsResult[0];

    // Update heartbeat and execution state
    const now = new Date().toISOString();
    const updateFields: Record<string, any> = {
      last_heartbeat: now,
      status: 'active', // Restore to active if was in grace
      grace_until: null,
      updated_at: now
    };

    if (body.current_execution) {
      updateFields.current_execution = body.current_execution.execution_id;
      updateFields.execution_started_at = body.current_execution.started_at;
      updateFields.estimated_duration_ms = body.current_execution.estimated_duration_ms || null;
    } else {
      updateFields.current_execution = null;
      updateFields.execution_started_at = null;
      updateFields.estimated_duration_ms = null;
    }

    await queryWithAuth(
      jwtAuth!.jwtToken,
      `UPDATE $connectionId MERGE $updateFields`,
      { connectionId, updateFields }
    );

    // Refresh Redis TTL
    if (connection.api_key_id) {
      await refreshSlotTTL(connection.api_key_id);
    }

    // Update Redis details
    await storeConnectionDetails(connectionId, {
      status: 'active',
      last_heartbeat: now,
      current_execution: body.current_execution?.execution_id
    });

    // Calculate grace period for response
    const gracePeriodMs = calculateGracePeriod({
      ...connection,
      current_execution: body.current_execution?.execution_id,
      execution_started_at: body.current_execution?.started_at,
      estimated_duration_ms: body.current_execution?.estimated_duration_ms
    });

    logger.debug('Heartbeat received', {
      connectionId,
      hasExecution: !!body.current_execution,
      gracePeriodMs
    });

    return c.json({
      status: 'active',
      next_heartbeat_due: new Date(Date.now() + 30000).toISOString(), // 30 seconds
      grace_period_ms: gracePeriodMs
    });

  } catch (error) {
    const err = error as Error;
    logger.error('Heartbeat failed', { error: err.message });
    return c.json({
      error: 'internal_error',
      message: 'Failed to process heartbeat'
    }, 500);
  }
});

// ============================================================================
// POST /v2/connections/reconnect
// ============================================================================

connections.post('/reconnect', async (c) => {
  try {
    const body = await c.req.json() as ReconnectRequest;
    const { session_token } = body;

    if (!session_token) {
      return c.json({
        error: 'missing_session_token',
        message: 'session_token is required'
      }, 400);
    }

    // Find connection by session token
    const connectionsResult = await surrealDB.query<Connection>(
      `SELECT * FROM active_connections WHERE session_token = $sessionToken LIMIT 1`,
      { sessionToken: session_token }
    );

    if (connectionsResult.length === 0) {
      return c.json({
        error: 'session_not_found',
        message: 'Session not found'
      }, 404);
    }

    const connection = connectionsResult[0];

    // Check if already disconnected (past grace period)
    if (connection.status === 'disconnected') {
      return c.json({
        error: 'session_expired',
        message: 'Grace period has passed, please acquire a new connection'
      }, 410);
    }

    // Check if grace period has expired (even if status not yet updated)
    if (connection.grace_until && new Date(connection.grace_until) < new Date()) {
      // Update status to disconnected
      await surrealDB.query(
        `UPDATE $connectionId SET status = 'disconnected', disconnected_at = $now, updated_at = $now`,
        { connectionId: connection.id, now: new Date().toISOString() }
      );

      // Release the slot
      await releaseSlot(connection.api_key_id, connection.id);

      return c.json({
        error: 'session_expired',
        message: 'Grace period has passed, please acquire a new connection'
      }, 410);
    }

    // We need the original API key to regenerate JWT
    // For now, get it from the api_keys table via the api_key_id
    const apiKeysResult = await surrealDB.query<ApiKey>(
      `SELECT * FROM $apiKeyId`,
      { apiKeyId: connection.api_key_id }
    );

    if (apiKeysResult.length === 0) {
      return c.json({
        error: 'api_key_not_found',
        message: 'Associated API key not found'
      }, 500);
    }

    // For reconnection, we need to use the existing JWT or issue a new one
    // Since we can't regenerate without the plain API key (and we no longer use
    // apikey_record SurrealDB access), use the stored JWT if still valid
    let jwtToken = connection.jwt_token;
    let jwtExpiresAt = connection.jwt_expires_at;

    // If JWT is expired or missing, we can't reconnect without the API key
    if (!jwtToken || (jwtExpiresAt && new Date(jwtExpiresAt) < new Date())) {
      return c.json({
        error: 'jwt_expired',
        message: 'JWT has expired, please acquire a new connection with your API key'
      }, 410);
    }

    // Restore connection to active status
    const now = new Date().toISOString();
    await surrealDB.query(
      `UPDATE $connectionId SET
        status = 'active',
        last_heartbeat = $now,
        grace_until = NONE,
        updated_at = $now`,
      { connectionId: connection.id, now }
    );

    // Re-add to Redis slot set (may have been cleaned up)
    const redis = RedisClient.getInstance();
    await redis.sadd(`connections:${connection.api_key_id}`, connection.id);
    await refreshSlotTTL(connection.api_key_id);

    // Update Redis details
    await storeConnectionDetails(connection.id, {
      status: 'active',
      last_heartbeat: now
    });

    logger.info('Connection reconnected', {
      connectionId: connection.id,
      apiKeyId: connection.api_key_id
    });

    return c.json({
      connection_id: connection.id,
      jwt: jwtToken,
      jwt_expires_at: jwtExpiresAt,
      current_execution: connection.current_execution ? {
        execution_id: connection.current_execution,
        started_at: connection.execution_started_at
      } : undefined,
      status: 'active'
    });

  } catch (error) {
    const err = error as Error;
    logger.error('Reconnection failed', { error: err.message });
    return c.json({
      error: 'internal_error',
      message: 'Failed to reconnect'
    }, 500);
  }
});

// ============================================================================
// POST /v2/connections/release
// ============================================================================

connections.post('/release', async (c) => {
  try {
    // Require JWT auth for release
    if (!hasJwtAuth(c)) {
      return c.json({
        error: 'unauthorized',
        message: 'JWT authentication required'
      }, 401);
    }

    const jwtAuth = getJwtAuthFromContext(c);

    // Get connection ID from header
    const connectionId = c.req.header('X-Connection-ID');
    if (!connectionId) {
      return c.json({
        error: 'missing_connection_id',
        message: 'X-Connection-ID header is required'
      }, 400);
    }

    // Verify connection exists and belongs to this org
    const releaseConnectionsResult = await queryWithAuth<Connection>(
      jwtAuth!.jwtToken,
      `SELECT * FROM $connectionId`,
      { connectionId }
    );

    if (releaseConnectionsResult.length === 0) {
      return c.json({
        error: 'connection_not_found',
        message: 'Connection not found'
      }, 404);
    }

    const connection = releaseConnectionsResult[0];

    // Mark as disconnected
    const now = new Date().toISOString();
    await queryWithAuth(
      jwtAuth!.jwtToken,
      `UPDATE $connectionId SET
        status = 'disconnected',
        disconnected_at = $now,
        updated_at = $now`,
      { connectionId, now }
    );

    // Release the slot in Redis
    await releaseSlot(connection.api_key_id, connectionId);

    logger.info('Connection released', {
      connectionId,
      apiKeyId: connection.api_key_id
    });

    return c.json({
      released: true,
      connection_id: connectionId
    });

  } catch (error) {
    const err = error as Error;
    logger.error('Release failed', { error: err.message });
    return c.json({
      error: 'internal_error',
      message: 'Failed to release connection'
    }, 500);
  }
});

// ============================================================================
// GET /v2/connections/count - Get connection count for an API key
// ============================================================================

connections.get('/count', async (c) => {
  try {
    const apiKeyId = c.req.query('api_key_id');

    if (!apiKeyId) {
      return c.json({
        error: 'missing_api_key_id',
        message: 'api_key_id query parameter is required'
      }, 400);
    }

    // Get count from Redis (fast path)
    const redisCount = await getSlotCount(apiKeyId);

    // Also get from SurrealDB for accuracy (in case Redis is stale)
    const dbConnections = await surrealDB.query<{ count: number }>(
      `SELECT count() as count FROM active_connections
       WHERE api_key_id = $apiKeyId AND status IN ['active', 'grace']
       GROUP ALL`,
      { apiKeyId }
    );

    const dbCount = dbConnections[0]?.count || 0;

    // Get max_connections from the API key
    const apiKeyInfo = await surrealDB.query<ApiKey>(
      `SELECT max_connections, tier FROM $apiKeyId`,
      { apiKeyId }
    );

    const maxConnections = apiKeyInfo[0]?.max_connections || 1;
    const tier = apiKeyInfo[0]?.tier || 'starter';

    logger.debug('Connection count query', {
      apiKeyId,
      redisCount,
      dbCount,
      maxConnections
    });

    return c.json({
      api_key_id: apiKeyId,
      current_connections: Math.max(redisCount, dbCount), // Use higher count for safety
      max_connections: maxConnections,
      tier,
      slots_available: maxConnections - Math.max(redisCount, dbCount)
    });

  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get connection count', { error: err.message });
    return c.json({
      error: 'internal_error',
      message: 'Failed to get connection count'
    }, 500);
  }
});

// ============================================================================
// GET /v2/connections/status (for debugging/dashboard)
// ============================================================================

connections.get('/status', async (c) => {
  try {
    if (!hasJwtAuth(c)) {
      return c.json({
        error: 'unauthorized',
        message: 'JWT authentication required'
      }, 401);
    }

    const jwtAuth = getJwtAuthFromContext(c);

    // Get all connections for this org
    const orgConnections = await queryWithAuth<Connection>(
      jwtAuth!.jwtToken,
      `SELECT * FROM active_connections WHERE status IN ['active', 'grace'] ORDER BY connected_at DESC`
    );

    return c.json({
      connections: orgConnections.map(conn => ({
        id: conn.id,
        instance_name: conn.instance_name,
        status: conn.status,
        connected_at: conn.connected_at,
        last_heartbeat: conn.last_heartbeat,
        grace_until: conn.grace_until,
        has_execution: !!conn.current_execution
      })),
      total: orgConnections.length
    });

  } catch (error) {
    const err = error as Error;
    logger.error('Failed to get connection status', { error: err.message });
    return c.json({
      error: 'internal_error',
      message: 'Failed to get connection status'
    }, 500);
  }
});

export default connections;

// Export slot management functions for worker use
export { acquireSlot, releaseSlot, getSlotCount, refreshSlotTTL, calculateGracePeriod, storeConnectionDetails, getConnectionDetails };
