/**
 * Vessel Status Routes
 *
 * Provides endpoints for monitoring MiniBob vessel status
 * Integrates with Kubernetes API to get real-time pod information
 */

import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { logger } from '../utils/logger';
import { surrealDB } from '../db/surreal';
import { discoveryClient } from '../services/discovery-client';
import { config } from '../config';

const app = new Hono();

/**
 * Deprecation middleware for legacy vessel endpoints
 * Adds deprecation headers to responses
 */
async function deprecationMiddleware(c: Context, next: Next) {
  // Add deprecation headers
  c.header('X-API-Deprecated', 'true');
  c.header('X-API-Deprecation-Date', '2026-05-01');
  c.header('X-API-Sunset-Date', '2026-07-01');
  c.header('X-API-Replacement', 'discovery-vessel');
  c.header('X-API-Migration-Guide', 'https://docs.metabob.com/discovery-vessel-migration');

  await next();
}

interface VesselStatus {
  pod_name: string;
  namespace: string;
  status: 'idle' | 'executing' | 'bored' | 'error' | 'unknown';
  current_activity?: {
    variant_id: string;
    activity_id: string;
    variant_name: string;
    started_at: string;
    current_task?: string;
    progress?: number; // 0-100 percentage
  };
  metrics?: {
    cpu_usage?: number; // percentage
    memory_usage?: number; // MB
    executions_completed: number;
    total_cost_usd: number;
    uptime_seconds: number;
  };
  last_heartbeat: string;
  created_at?: string;
  ready: boolean;
  phase: string; // Running, Pending, Failed, etc.
}

interface ListVesselsResponse {
  vessels: VesselStatus[];
  total: number;
}

/**
 * Get vessel status from database (heartbeat records)
 */
async function getVesselStatusFromDB(): Promise<VesselStatus[]> {
  try {
    // Query vessel heartbeats from the last 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const query = `
      SELECT
        pod_name,
        namespace,
        status,
        current_activity,
        metrics,
        last_heartbeat,
        created_at
      FROM vessel_heartbeats
      WHERE last_heartbeat >= $since
      ORDER BY last_heartbeat DESC
    `;

    const vessels = await surrealDB.query<VesselStatus>(query, {
      since: fiveMinutesAgo,
    });

    // Mark vessels as ready if they've sent heartbeat in last minute
    const oneMinuteAgo = Date.now() - 60 * 1000;

    return (vessels || []).map((v) => ({
      ...v,
      ready: new Date(v.last_heartbeat).getTime() > oneMinuteAgo,
      phase: v.ready ? 'Running' : 'Unknown',
    }));

  } catch (error) {
    logger.error('Failed to get vessel status from DB', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Get vessel status from Kubernetes API (if available)
 * Falls back to database heartbeats if K8s API is not accessible
 */
async function getVesselStatusFromK8s(): Promise<VesselStatus[]> {
  try {
    // Check if we're running in a K8s environment
    const k8sServiceHost = process.env.KUBERNETES_SERVICE_HOST;
    if (!k8sServiceHost) {
      logger.debug('Not running in Kubernetes, using DB heartbeats');
      return getVesselStatusFromDB();
    }

    // TODO: Implement K8s API integration
    // For now, fall back to database heartbeats
    // In future implementation:
    // 1. Load K8s client credentials from service account
    // 2. Query pods with label selector: app.kubernetes.io/name=minibob
    // 3. Extract pod status, resource usage, and container state
    // 4. Join with database heartbeats for current activity information

    logger.debug('K8s API integration not yet implemented, using DB heartbeats');
    return getVesselStatusFromDB();

  } catch (error) {
    logger.error('Failed to get vessel status from K8s', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Fall back to database heartbeats
    return getVesselStatusFromDB();
  }
}

/**
 * GET /v2/vessels/status
 *
 * DEPRECATED: Use discovery-vessel instead
 *
 * List all MiniBob vessel instances with current status
 *
 * Returns:
 * - Real-time pod status from Kubernetes (if available)
 * - Current activity execution state from database heartbeats
 * - Resource usage metrics
 * - Execution statistics
 */
app.get('/status', deprecationMiddleware, async (c) => {
  try {
    // Get vessel status (tries K8s API first, falls back to DB)
    const vessels = await getVesselStatusFromK8s();

    logger.info('Vessel status fetched', {
      count: vessels.length,
      ready: vessels.filter((v) => v.ready).length,
      executing: vessels.filter((v) => v.status === 'executing').length,
    });

    const response: ListVesselsResponse = {
      vessels,
      total: vessels.length,
    };

    return c.json(response);

  } catch (error) {
    logger.error('Failed to get vessel status', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to get vessel status',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/vessels/heartbeat
 *
 * DEPRECATED: Use discovery-vessel instead
 *
 * MiniBob vessels send heartbeats to report their status
 * This allows dashboard to show real-time vessel state even without K8s API access
 *
 * PROXY MODE: Dual-writes to both discovery-vessel and SurrealDB for backward compatibility
 *
 * Request body:
 * {
 *   pod_name: string,
 *   namespace: string,
 *   status: 'idle' | 'executing' | 'bored' | 'error',
 *   current_activity?: { variant_id, activity_id, variant_name, started_at, current_task, progress },
 *   metrics?: { executions_completed, total_cost_usd, uptime_seconds }
 * }
 */
app.post('/heartbeat', deprecationMiddleware, async (c) => {
  try {
    const body = await c.req.json();

    // Validate required fields
    if (!body.pod_name || !body.namespace || !body.status) {
      return c.json({
        error: 'Missing required fields',
        required: ['pod_name', 'namespace', 'status'],
      }, 400);
    }

    const heartbeat = {
      pod_name: body.pod_name,
      namespace: body.namespace,
      status: body.status,
      current_activity: body.current_activity || null,
      metrics: body.metrics || null,
      last_heartbeat: new Date().toISOString(),
    };

    // Upsert heartbeat record (update if exists, insert if not)
    const query = `
      UPSERT vessel_heartbeats SET
        pod_name = $pod_name,
        namespace = $namespace,
        status = $status,
        current_activity = $current_activity,
        metrics = $metrics,
        last_heartbeat = $last_heartbeat,
        updated_at = $last_heartbeat
      WHERE pod_name = $pod_name AND namespace = $namespace
    `;

    await surrealDB.query(query, heartbeat);

    logger.info('Vessel heartbeat recorded (legacy DB)', {
      pod_name: body.pod_name,
      namespace: body.namespace,
      status: body.status,
    });

    // PROXY MODE: Also forward to discovery-vessel if enabled
    if (discoveryClient.isEnabled() && config.discovery.enabled) {
      try {
        // Transform legacy heartbeat to discovery format
        const discoveryHeartbeat = {
          vesselId: body.pod_name, // Use pod_name as vessel ID
          metrics: body.metrics ? {
            executionsCompleted: body.metrics.executions_completed,
            avgLatencyMs: 0, // Not tracked in legacy format
            errorRate: 0, // Not tracked in legacy format
          } : undefined,
        };

        // Send to discovery-vessel (non-blocking)
        const discoveryEndpoint = config.discovery.endpoint;
        fetch(`${discoveryEndpoint}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(discoveryHeartbeat),
        })
          .then((res) => {
            if (res.ok) {
              logger.debug('[Proxy] Heartbeat forwarded to discovery-vessel', {
                vesselId: body.pod_name,
              });
            }
          })
          .catch((error) => {
            logger.warn('[Proxy] Failed to forward heartbeat to discovery-vessel', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } catch (error) {
        // Non-blocking: log error but don't fail request
        logger.warn('[Proxy] Error forwarding heartbeat', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return c.json({
      success: true,
      pod_name: body.pod_name,
      timestamp: heartbeat.last_heartbeat,
    });

  } catch (error) {
    logger.error('Failed to record vessel heartbeat', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to record heartbeat',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/vessels/:podName/status
 *
 * DEPRECATED: Use discovery-vessel instead
 *
 * Get status of a specific vessel by pod name
 */
app.get('/:podName/status', deprecationMiddleware, async (c) => {
  try {
    const podName = c.req.param('podName');

    const query = `
      SELECT * FROM vessel_heartbeats
      WHERE pod_name = $pod_name
      ORDER BY last_heartbeat DESC
      LIMIT 1
    `;

    const result = await surrealDB.query<VesselStatus>(query, {
      pod_name: podName,
    });

    if (!result || result.length === 0) {
      return c.json({
        error: 'Vessel not found',
        pod_name: podName,
      }, 404);
    }

    const vessel = result[0];
    const oneMinuteAgo = Date.now() - 60 * 1000;

    return c.json({
      ...vessel,
      ready: new Date(vessel.last_heartbeat).getTime() > oneMinuteAgo,
      phase: vessel.ready ? 'Running' : 'Unknown',
    });

  } catch (error) {
    logger.error('Failed to get vessel status', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to get vessel status',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/vessels/register
 *
 * DEPRECATED: Use discovery-vessel directly instead
 *
 * Register a vessel's capabilities for discovery
 * Vessels announce what impulse shapes they can resolve
 *
 * PROXY MODE: Dual-writes to both discovery-vessel and SurrealDB for backward compatibility
 *
 * Request body:
 * {
 *   vesselId: string,
 *   vesselName: string,
 *   endpoint: string,
 *   shapes: string[],
 *   metadata?: object
 * }
 */
app.post('/register', deprecationMiddleware, async (c) => {
  try {
    const body = await c.req.json();

    // Validate required fields
    if (!body.vesselId || !body.vesselName || !body.endpoint || !body.shapes) {
      return c.json({
        error: 'Missing required fields',
        required: ['vesselId', 'vesselName', 'endpoint', 'shapes'],
      }, 400);
    }

    if (!Array.isArray(body.shapes) || body.shapes.length === 0) {
      return c.json({
        error: 'shapes must be a non-empty array',
      }, 400);
    }

    const registration = {
      vessel_id: body.vesselId,
      vessel_name: body.vesselName,
      endpoint: body.endpoint,
      shapes: body.shapes,
      metadata: body.metadata || {},
      registered_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };

    // Upsert vessel registration (update if exists, insert if not)
    const query = `
      UPSERT vessel_capabilities SET
        vessel_id = $vessel_id,
        vessel_name = $vessel_name,
        endpoint = $endpoint,
        shapes = $shapes,
        metadata = $metadata,
        registered_at = $registered_at,
        last_seen = $last_seen
      WHERE vessel_id = $vessel_id
    `;

    await surrealDB.query(query, registration);

    logger.info('Vessel registered (legacy DB)', {
      vesselId: body.vesselId,
      vesselName: body.vesselName,
      endpoint: body.endpoint,
      shapes: body.shapes,
    });

    // PROXY MODE: Also forward to discovery-vessel if enabled
    if (discoveryClient.isEnabled() && config.discovery.enabled) {
      try {
        const discoveryEndpoint = config.discovery.endpoint;
        const discoveryRegistration = {
          vesselId: body.vesselId,
          vesselName: body.vesselName,
          version: body.metadata?.version || 'unknown',
          endpoint: body.endpoint,
          shapes: body.shapes,
          metadata: body.metadata,
        };

        // Send to discovery-vessel (non-blocking)
        fetch(`${discoveryEndpoint}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(discoveryRegistration),
        })
          .then((res) => {
            if (res.ok) {
              logger.info('[Proxy] Registration forwarded to discovery-vessel', {
                vesselId: body.vesselId,
              });
            }
          })
          .catch((error) => {
            logger.warn('[Proxy] Failed to forward registration to discovery-vessel', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } catch (error) {
        // Non-blocking: log error but don't fail request
        logger.warn('[Proxy] Error forwarding registration', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return c.json({
      success: true,
      vesselId: body.vesselId,
      timestamp: registration.registered_at,
      message: 'Vessel registered successfully (legacy endpoint - please migrate to discovery-vessel)',
    });

  } catch (error) {
    logger.error('Failed to register vessel', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to register vessel',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/vessels/discover?shape=<shape>
 *
 * DEPRECATED: Use discovery-vessel directly instead
 *
 * Discover vessels that can resolve a specific impulse shape
 *
 * Query params:
 * - shape: The impulse shape to query for (e.g., "terminalState", "execution_trace")
 *
 * Returns:
 * {
 *   vessels: [{ vesselId, vesselName, endpoint, shapes, metadata }],
 *   shape: string,
 *   found: boolean
 * }
 */
app.get('/discover', deprecationMiddleware, async (c) => {
  try {
    const shape = c.req.query('shape');

    if (!shape) {
      return c.json({
        error: 'Missing required query parameter: shape',
      }, 400);
    }

    // Query vessels that can resolve this shape
    // Only include vessels that have sent heartbeat in last 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const query = `
      SELECT
        vessel_id,
        vessel_name,
        endpoint,
        shapes,
        metadata,
        last_seen
      FROM vessel_capabilities
      WHERE $shape IN shapes
        AND last_seen >= $since
      ORDER BY last_seen DESC
    `;

    const vessels = await surrealDB.query(query, {
      shape,
      since: fiveMinutesAgo,
    });

    // Map to VesselCapability format
    const vesselCapabilities = (vessels || []).map((v: any) => ({
      vesselId: v.vessel_id,
      vesselName: v.vessel_name,
      endpoint: v.endpoint,
      shapes: v.shapes,
      metadata: v.metadata || {},
    }));

    logger.info('Vessel discovery query', {
      shape,
      found: vesselCapabilities.length,
    });

    if (vesselCapabilities.length === 0) {
      return c.json({
        vessels: [],
        shape,
        found: false,
        message: `No vessels found that can resolve shape: ${shape}`,
      }, 404);
    }

    return c.json({
      vessels: vesselCapabilities,
      shape,
      found: true,
    });

  } catch (error) {
    logger.error('Failed to discover vessels', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to discover vessels',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/vessels/capabilities
 *
 * DEPRECATED: Use discovery-vessel directly instead
 *
 * List all registered vessel capabilities
 */
app.get('/capabilities', deprecationMiddleware, async (c) => {
  try {
    // Get all vessel capabilities registered in last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const query = `
      SELECT
        vessel_id,
        vessel_name,
        endpoint,
        shapes,
        metadata,
        registered_at,
        last_seen
      FROM vessel_capabilities
      WHERE last_seen >= $since
      ORDER BY last_seen DESC
    `;

    const vessels = await surrealDB.query(query, {
      since: oneHourAgo,
    });

    const vesselCapabilities = (vessels || []).map((v: any) => ({
      vesselId: v.vessel_id,
      vesselName: v.vessel_name,
      endpoint: v.endpoint,
      shapes: v.shapes,
      metadata: v.metadata || {},
      registeredAt: v.registered_at,
      lastSeen: v.last_seen,
    }));

    logger.info('Listed vessel capabilities', {
      count: vesselCapabilities.length,
    });

    return c.json({
      vessels: vesselCapabilities,
      total: vesselCapabilities.length,
    });

  } catch (error) {
    logger.error('Failed to list vessel capabilities', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to list vessel capabilities',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

export default app;
