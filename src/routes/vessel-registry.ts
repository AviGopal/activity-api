/**
 * Vessel Registry Routes (SPEC-004)
 *
 * Centralized discovery and health tracking for all vessels.
 * Vessels register themselves, advertise capabilities, and heartbeat to maintain active status.
 */

import { Hono } from 'hono';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { getJwtAuthFromContext } from '../middleware/jwtAuth';

const app = new Hono();

// =============================================================================
// TYPES
// =============================================================================

interface VesselCapability {
  type: 'impulse-resolver' | 'tool' | 'activity' | 'mcp-server';
  shapes?: string[];
  tools?: string[];
  activities?: string[];
  mcp?: {
    protocol: string;
    tools: string[];
  };
}

interface RegisterVesselRequest {
  vesselId: string;
  vesselName: string;
  endpoint: string;
  shapes: string[];
  capabilities?: VesselCapability[];
  metadata?: Record<string, any>;
  ttl?: number;
}

interface VesselRecord {
  id: string;
  name: string;
  endpoint: string;
  shapes: string[];
  capabilities: VesselCapability[];
  metadata?: Record<string, any>;
  version?: string;
  environment?: string;
  ttl: number;
  registered_at: string;
  last_heartbeat: string;
  expires_at: string;
  org_id: string;
}

// =============================================================================
// ROUTES
// =============================================================================

/**
 * POST /v2/vessels/register
 *
 * Register or refresh vessel registration.
 * This is the heartbeat endpoint - vessels call this every TTL/2 seconds.
 */
app.post('/register', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  let body: RegisterVesselRequest;
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.vesselId || !body.vesselName || !body.endpoint || !body.shapes) {
    return c.json({
      error: 'Invalid vessel definition',
      details: 'vesselId, vesselName, endpoint, and shapes are required',
    }, 400);
  }

  if (!Array.isArray(body.shapes) || body.shapes.length === 0) {
    return c.json({
      error: 'Invalid vessel definition',
      details: 'shapes array cannot be empty',
    }, 400);
  }

  const ttl = body.ttl || 300; // Default 5 minutes
  const recordId = `vessel:${body.vesselId}`;

  try {
    // First try to get existing vessel to preserve registered_at
    const existingQuery = `SELECT registered_at FROM ${recordId}`;
    const existing = await surrealDB.query<{ registered_at?: string }[]>(existingQuery);
    const existingRegisteredAt = existing?.[0]?.[0]?.registered_at;

    // Upsert vessel record using CONTENT (creates or replaces)
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const query = `
      UPDATE ${recordId} CONTENT {
        id: $vesselId,
        name: $vesselName,
        endpoint: $endpoint,
        shapes: $shapes,
        capabilities: $capabilities,
        metadata: $metadata,
        version: $version,
        environment: $environment,
        ttl: $ttl,
        last_heartbeat: time::now(),
        expires_at: $expiresAt,
        org_id: $orgId,
        registered_at: $registeredAt
      }
      RETURN id, expires_at;
    `;

    const results = await surrealDB.query<{ id: string; expires_at: string }[]>(query, {
      vesselId: body.vesselId,
      vesselName: body.vesselName,
      endpoint: body.endpoint,
      shapes: body.shapes,
      capabilities: body.capabilities || [],
      metadata: body.metadata || {},
      version: body.metadata?.version,
      environment: body.metadata?.environment,
      ttl,
      expiresAt,
      orgId: auth.orgId,
      registeredAt: existingRegisteredAt || now,
    });

    const result = results[0]?.[0];
    if (!result) {
      throw new Error('Failed to register vessel');
    }

    logger.info('Vessel registered/heartbeat', {
      vesselId: body.vesselId,
      orgId: auth.orgId,
      endpoint: body.endpoint,
      shapes: body.shapes,
      expiresAt: result.expires_at,
    });

    return c.json({
      id: result.id,
      expires_at: result.expires_at,
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Vessel registration failed', {
      vesselId: body.vesselId,
      error: err.message,
    });
    return c.json({ error: 'Failed to register vessel', details: err.message }, 500);
  }
});

/**
 * GET /v2/vessels/discover?shape=<shape>
 *
 * Find vessels that can resolve a specific impulse shape.
 */
app.get('/discover', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  const shape = c.req.query('shape');
  if (!shape) {
    return c.json({ error: 'shape query parameter is required' }, 400);
  }

  try {
    const query = `
      SELECT * FROM vessel
      WHERE $shape IN shapes
        AND org_id = $orgId
        AND expires_at > time::now()
      ORDER BY last_heartbeat DESC;
    `;

    const vessels = await surrealDB.query<VesselRecord[]>(query, {
      shape,
      orgId: auth.orgId,
    });

    if (vessels.length === 0) {
      return c.json({
        error: `No vessels found for shape: ${shape}`,
        shape,
      }, 404);
    }

    logger.info('Vessel discovery', {
      shape,
      orgId: auth.orgId,
      found: vessels.length,
    });

    return c.json({ vessels });
  } catch (error) {
    const err = error as Error;
    logger.error('Vessel discovery failed', {
      shape,
      error: err.message,
    });
    return c.json({ error: 'Failed to discover vessels', details: err.message }, 500);
  }
});

/**
 * GET /v2/vessels
 *
 * List all registered vessels (for monitoring/debugging).
 */
app.get('/', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  const activeOnly = c.req.query('active_only') === 'true';

  try {
    let query = `
      SELECT * FROM vessel
      WHERE org_id = $orgId
    `;

    if (activeOnly) {
      query += ' AND expires_at > time::now()';
    }

    query += ' ORDER BY last_heartbeat DESC;';

    const vessels = await surrealDB.query<VesselRecord[]>(query, {
      orgId: auth.orgId,
    });

    const now = new Date();
    const active = vessels.filter((v) => new Date(v.expires_at) > now);
    const expired = vessels.filter((v) => new Date(v.expires_at) <= now);

    return c.json({
      vessels: activeOnly ? active : vessels,
      total: vessels.length,
      active: active.length,
      expired: expired.length,
    });
  } catch (error) {
    const err = error as Error;
    logger.error('List vessels failed', { error: err.message });
    return c.json({ error: 'Failed to list vessels', details: err.message }, 500);
  }
});

/**
 * GET /v2/vessels/:vesselId
 *
 * Get details of a specific vessel.
 */
app.get('/:vesselId', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  const vesselId = c.req.param('vesselId');

  try {
    const query = `
      SELECT * FROM vessel
      WHERE id = $vesselId
        AND org_id = $orgId
      LIMIT 1;
    `;

    const vessels = await surrealDB.query<VesselRecord[]>(query, {
      vesselId,
      orgId: auth.orgId,
    });

    if (vessels.length === 0) {
      return c.json({ error: 'Vessel not found' }, 404);
    }

    const vessel = vessels[0];
    const now = new Date();
    const expiresAt = new Date(vessel.expires_at);
    const isHealthy = expiresAt > now;

    return c.json({
      vessel: {
        ...vessel,
        health: {
          status: isHealthy ? 'healthy' : 'expired',
          uptime_seconds: vessel.metadata?.uptime_seconds,
          last_check: vessel.last_heartbeat,
        },
      },
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Get vessel failed', {
      vesselId,
      error: err.message,
    });
    return c.json({ error: 'Failed to get vessel', details: err.message }, 500);
  }
});

/**
 * DELETE /v2/vessels/:vesselId
 *
 * Unregister a vessel (graceful shutdown).
 */
app.delete('/:vesselId', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  const vesselId = c.req.param('vesselId');

  try {
    const query = `
      DELETE FROM vessel
      WHERE id = $vesselId
        AND org_id = $orgId;
    `;

    await surrealDB.query(query, {
      vesselId,
      orgId: auth.orgId,
    });

    logger.info('Vessel unregistered', {
      vesselId,
      orgId: auth.orgId,
    });

    return c.body(null, 204);
  } catch (error) {
    const err = error as Error;
    logger.error('Unregister vessel failed', {
      vesselId,
      error: err.message,
    });
    return c.json({ error: 'Failed to unregister vessel', details: err.message }, 500);
  }
});

/**
 * GET /v2/vessels/:vesselId/health
 *
 * Check vessel health (reachability and expiry status).
 */
app.get('/:vesselId/health', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  const vesselId = c.req.param('vesselId');

  try {
    const query = `
      SELECT * FROM vessel
      WHERE id = $vesselId
        AND org_id = $orgId
      LIMIT 1;
    `;

    const vessels = await surrealDB.query<VesselRecord[]>(query, {
      vesselId,
      orgId: auth.orgId,
    });

    if (vessels.length === 0) {
      return c.json({ error: 'Vessel not found' }, 404);
    }

    const vessel = vessels[0];
    const now = new Date();
    const expiresAt = new Date(vessel.expires_at);
    const expiresInSeconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
    const isHealthy = expiresInSeconds > 0;

    // Optionally: ping vessel endpoint to check reachability
    let reachable = false;
    let latencyMs = 0;

    try {
      const startTime = Date.now();
      const response = await fetch(`${vessel.endpoint}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });
      latencyMs = Date.now() - startTime;
      reachable = response.ok;
    } catch (error) {
      // Vessel unreachable
      reachable = false;
    }

    return c.json({
      vesselId: vessel.id,
      endpoint: vessel.endpoint,
      reachable,
      latency_ms: latencyMs,
      last_heartbeat: vessel.last_heartbeat,
      expires_in_seconds: expiresInSeconds,
      status: isHealthy && reachable ? 'healthy' : 'unhealthy',
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Vessel health check failed', {
      vesselId,
      error: err.message,
    });
    return c.json({ error: 'Failed to check vessel health', details: err.message }, 500);
  }
});

export default app;
