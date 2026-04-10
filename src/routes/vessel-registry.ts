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
import { computeVesselHealthScore, getOrganizationVesselHealth } from '../services/vessel-health';

const app = new Hono();

// =============================================================================
// TYPES
// =============================================================================

// VesselCapabilityV2 format with shape versioning
interface VesselCapabilityV2 {
  type: 'impulse-resolver' | 'tool' | 'activity' | 'mcp-server';
  shapes?: Array<{
    name: string;
    version?: string; // Semver constraint (e.g., "^1.0.0", "~1.2.0", "1.x")
  }>;
  tools?: string[];
  activities?: string[];
  mcp?: {
    protocol: string;
    tools: string[];
  };
}

// Legacy format (still supported)
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
  shapes: string[]; // Simple shape names (for backward compatibility)
  capabilities?: VesselCapability[] | VesselCapabilityV2[]; // Support both formats
  metadata?: Record<string, any>;
  ttl?: number;
  version?: string; // Vessel version (semver)
  protocol?: string; // Communication protocol
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
 * GET /v2/vessels/discover?shape=<shape>&version=<version>
 *
 * Find vessels that can resolve a specific impulse shape.
 * Integrates with shape registry for version compatibility checking.
 */
app.get('/discover', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  const shape = c.req.query('shape');
  const version = c.req.query('version');

  if (!shape) {
    return c.json({ error: 'shape query parameter is required' }, 400);
  }

  try {
    // Lookup shape in registry to validate it exists
    const shapeQuery = `
      SELECT name, version, description
      FROM shape_definition
      WHERE name = $shape
        AND (public = true OR org_id IS NONE OR org_id = $orgId)
      ORDER BY version DESC
      LIMIT 1;
    `;

    const shapeResults = await surrealDB.query<{ name: string; version: string; description: string }[]>(
      shapeQuery,
      { shape, orgId: auth.orgId }
    );

    const shapeDefinition = shapeResults[0]?.[0];
    if (!shapeDefinition) {
      return c.json({
        error: 'Shape not found in registry',
        shape,
        suggestion: 'Register this shape via POST /v2/shapes before using it',
      }, 404);
    }

    // Find vessels advertising this shape
    const vesselQuery = `
      SELECT * FROM vessel
      WHERE $shape IN shapes
        AND org_id = $orgId
        AND expires_at > time::now()
      ORDER BY last_heartbeat DESC;
    `;

    const vessels = await surrealDB.query<VesselRecord[]>(vesselQuery, {
      shape,
      orgId: auth.orgId,
    });

    if (vessels[0]?.length === 0) {
      return c.json({
        error: `No vessels found for shape: ${shape}`,
        shape,
        shape_version: shapeDefinition.version,
      }, 404);
    }

    // Record routing trace
    const traceQuery = `
      CREATE routing_trace CONTENT {
        shape: $shape,
        shape_version: $version,
        requesting_vessel_id: NONE,
        selected_vessel_id: $selectedVesselId,
        selection_reason: 'discovery_query',
        candidates: $candidates,
        success: true,
        latency_ms: 0,
        org_id: $orgId,
        timestamp: time::now()
      };
    `;

    await surrealDB.query(traceQuery, {
      shape,
      version: version || shapeDefinition.version,
      selectedVesselId: vessels[0][0]?.id || null,
      candidates: vessels[0].map((v: VesselRecord) => ({
        vessel_id: v.id,
        endpoint: v.endpoint,
        last_heartbeat: v.last_heartbeat,
      })),
      orgId: auth.orgId,
    });

    logger.info('Vessel discovery', {
      shape,
      version: version || shapeDefinition.version,
      orgId: auth.orgId,
      found: vessels[0].length,
    });

    return c.json({
      vessels: vessels[0],
      shape_info: {
        name: shapeDefinition.name,
        version: shapeDefinition.version,
        description: shapeDefinition.description,
      },
    });
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

    const vesselList = vessels[0] || [];
    const now = new Date();
    const active = vesselList.filter((v) => new Date(v.expires_at) > now);
    const expired = vesselList.filter((v) => new Date(v.expires_at) <= now);

    return c.json({
      vessels: activeOnly ? active : vesselList,
      total: vesselList.length,
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

    if (vessels[0]?.length === 0) {
      return c.json({ error: 'Vessel not found' }, 404);
    }

    const vessel = vessels[0][0];
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
 * Get comprehensive health score and status for a vessel.
 * Uses circuit breaker state, routing history, and heartbeat data.
 */
app.get('/:vesselId/health', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  const vesselId = c.req.param('vesselId');
  const checkEndpoint = c.req.query('check_endpoint') === 'true';

  try {
    // Compute health score
    const healthScore = await computeVesselHealthScore(vesselId, auth.orgId);

    if (healthScore.score === 0 && healthScore.details.lastHeartbeat === 'never') {
      return c.json({ error: 'Vessel not found' }, 404);
    }

    // Optionally: actively probe vessel endpoint
    let reachable = false;
    let latencyMs = 0;

    if (checkEndpoint) {
      const vesselQuery = `
        SELECT endpoint FROM vessel
        WHERE id = $vesselId AND org_id = $orgId
        LIMIT 1;
      `;
      const vesselResults = await surrealDB.query<{ endpoint: string }[]>(vesselQuery, {
        vesselId,
        orgId: auth.orgId,
      });

      const vessel = vesselResults[0]?.[0];
      if (vessel) {
        try {
          const startTime = Date.now();
          const response = await fetch(`${vessel.endpoint}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });
          latencyMs = Date.now() - startTime;
          reachable = response.ok;
        } catch (error) {
          reachable = false;
        }
      }
    }

    return c.json({
      ...healthScore,
      endpoint_check: checkEndpoint
        ? {
            reachable,
            latency_ms: latencyMs,
          }
        : undefined,
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

/**
 * POST /v2/vessels/heartbeat
 *
 * Record vessel heartbeat for health scoring.
 * Vessels should call this every 60 seconds.
 */
app.post('/heartbeat', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  let body: { vesselId: string; metrics?: any };
  try {
    body = await c.req.json();
  } catch (error) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.vesselId) {
    return c.json({ error: 'vesselId is required' }, 400);
  }

  try {
    // Import health scoring service dynamically to avoid circular deps
    const { HealthScoringService } = await import('../services/health-scoring');

    // Record heartbeat and update health score
    const metrics = await HealthScoringService.recordHeartbeat(body.vesselId, auth.orgId);

    logger.debug('Vessel heartbeat recorded', {
      vesselId: body.vesselId,
      healthScore: metrics.health_score,
      availability: metrics.availability,
    });

    return c.json({
      vesselId: body.vesselId,
      health_score: metrics.health_score,
      eligible_for_routing: metrics.eligible_for_routing,
      availability: metrics.availability,
      next_heartbeat_in_seconds: 60,
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Heartbeat recording failed', {
      vesselId: body.vesselId,
      error: err.message,
    });
    return c.json({ error: 'Failed to record heartbeat', details: err.message }, 500);
  }
});

/**
 * GET /v2/vessels/health/organization
 *
 * Get health scores for all vessels in the organization.
 */
app.get('/health/organization', async (c) => {
  const auth = getJwtAuthFromContext(c);
  if (!auth) {
    return c.json({ error: 'JWT authentication required' }, 401);
  }

  try {
    const healthScores = await getOrganizationVesselHealth(auth.orgId);

    return c.json({
      vessels: healthScores,
      summary: {
        total: healthScores.length,
        healthy: healthScores.filter((v) => v.status === 'healthy').length,
        degraded: healthScores.filter((v) => v.status === 'degraded').length,
        unhealthy: healthScores.filter((v) => v.status === 'unhealthy').length,
        expired: healthScores.filter((v) => v.status === 'expired').length,
        avg_score: healthScores.reduce((sum, v) => sum + v.score, 0) / healthScores.length || 0,
      },
    });
  } catch (error) {
    const err = error as Error;
    logger.error('Organization health check failed', {
      orgId: auth.orgId,
      error: err.message,
    });
    return c.json({ error: 'Failed to get organization health', details: err.message }, 500);
  }
});

export default app;
