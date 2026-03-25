/**
 * Vessel Status Routes
 *
 * Provides endpoints for monitoring MiniBob vessel status
 * Integrates with Kubernetes API to get real-time pod information
 */

import { Hono } from 'hono';
import { logger } from '../utils/logger';
import { surrealDB } from '../db/surreal';

const app = new Hono();

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
 * List all MiniBob vessel instances with current status
 *
 * Returns:
 * - Real-time pod status from Kubernetes (if available)
 * - Current activity execution state from database heartbeats
 * - Resource usage metrics
 * - Execution statistics
 */
app.get('/status', async (c) => {
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
 * MiniBob vessels send heartbeats to report their status
 * This allows dashboard to show real-time vessel state even without K8s API access
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
app.post('/heartbeat', async (c) => {
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

    logger.info('Vessel heartbeat recorded', {
      pod_name: body.pod_name,
      namespace: body.namespace,
      status: body.status,
    });

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
 * Get status of a specific vessel by pod name
 */
app.get('/:podName/status', async (c) => {
  try {
    const podName = c.param('podName');

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

export default app;
