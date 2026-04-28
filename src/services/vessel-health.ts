/**
 * Vessel Health Score Computation
 *
 * Computes health scores for vessels based on heartbeat status,
 * circuit breaker state, and historical routing success.
 */

import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { accountIdScopedWhere } from '../routes/activities';

export interface VesselHealthScore {
  vesselId: string;
  score: number; // 0.0 to 1.0
  status: 'healthy' | 'degraded' | 'unhealthy' | 'expired';
  factors: {
    heartbeat: number; // 0.0 to 1.0
    circuitBreaker: number; // 0.0 to 1.0
    routingSuccess: number; // 0.0 to 1.0
  };
  details: {
    lastHeartbeat: string;
    expiresAt: string;
    circuitState?: string;
    recentFailures?: number;
  };
}

/**
 * Compute health score for a vessel
 */
export async function computeVesselHealthScore(
  vesselId: string,
  orgId: string,
  accountId: string | null = null
): Promise<VesselHealthScore> {
  try {
    // Get vessel heartbeat status
    const vesselQuery = `
      SELECT last_heartbeat, expires_at
      FROM vessel
      WHERE id = $vesselId AND ${accountIdScopedWhere()}
      LIMIT 1;
    `;
    const vesselResults = await surrealDB.query<
      { last_heartbeat: string; expires_at: string }[]
    >(vesselQuery, { vesselId, org_id: orgId, account_id: accountId });

    const vessel = vesselResults[0]?.[0];
    if (!vessel) {
      return {
        vesselId,
        score: 0,
        status: 'unhealthy',
        factors: { heartbeat: 0, circuitBreaker: 0, routingSuccess: 0 },
        details: {
          lastHeartbeat: 'never',
          expiresAt: 'unknown',
        },
      };
    }

    const now = new Date();
    const expiresAt = new Date(vessel.expires_at);
    const lastHeartbeat = new Date(vessel.last_heartbeat);

    // Heartbeat factor (0.0 to 1.0)
    const isExpired = expiresAt <= now;
    const timeSinceHeartbeat = now.getTime() - lastHeartbeat.getTime();
    const heartbeatFactor = isExpired
      ? 0
      : Math.max(0, 1 - timeSinceHeartbeat / (5 * 60 * 1000)); // Decay over 5 minutes

    // Circuit breaker factor (0.0 to 1.0)
    const circuitQuery = `
      SELECT state, failure_count
      FROM circuit_breaker_trace
      WHERE vessel_id = $vesselId AND ${accountIdScopedWhere()}
      ORDER BY timestamp DESC
      LIMIT 1;
    `;
    const circuitResults = await surrealDB.query<
      { state: string; failure_count: number }[]
    >(circuitQuery, { vesselId, org_id: orgId, account_id: accountId });

    const circuit = circuitResults[0]?.[0];
    let circuitFactor = 1.0;
    let circuitState = 'closed';
    let recentFailures = 0;

    if (circuit) {
      circuitState = circuit.state;
      recentFailures = circuit.failure_count;

      if (circuit.state === 'open') {
        circuitFactor = 0;
      } else if (circuit.state === 'half_open') {
        circuitFactor = 0.5;
      } else {
        // Closed but with failures - reduce score based on failure count
        circuitFactor = Math.max(0, 1 - circuit.failure_count * 0.1);
      }
    }

    // Routing success factor (0.0 to 1.0)
    const routingQuery = `
      SELECT success
      FROM routing_trace
      WHERE selected_vessel_id = $vesselId AND ${accountIdScopedWhere()}
      ORDER BY timestamp DESC
      LIMIT 10;
    `;
    const routingResults = await surrealDB.query<{ success: boolean }[]>(
      routingQuery,
      { vesselId, org_id: orgId, account_id: accountId }
    );

    let routingFactor = 1.0;
    if (routingResults[0]?.length > 0) {
      const successCount = routingResults[0].filter((r) => r.success).length;
      routingFactor = successCount / routingResults[0].length;
    }

    // Compute overall score (weighted average)
    const score =
      heartbeatFactor * 0.5 + // Heartbeat is most important
      circuitFactor * 0.3 + // Circuit breaker state
      routingFactor * 0.2; // Historical routing success

    // Determine status
    let status: 'healthy' | 'degraded' | 'unhealthy' | 'expired';
    if (isExpired) {
      status = 'expired';
    } else if (score >= 0.8) {
      status = 'healthy';
    } else if (score >= 0.5) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      vesselId,
      score,
      status,
      factors: {
        heartbeat: heartbeatFactor,
        circuitBreaker: circuitFactor,
        routingSuccess: routingFactor,
      },
      details: {
        lastHeartbeat: vessel.last_heartbeat,
        expiresAt: vessel.expires_at,
        circuitState,
        recentFailures,
      },
    };
  } catch (error: any) {
    logger.error('Failed to compute vessel health score', {
      vesselId,
      error: error.message,
    });

    return {
      vesselId,
      score: 0,
      status: 'unhealthy',
      factors: { heartbeat: 0, circuitBreaker: 0, routingSuccess: 0 },
      details: {
        lastHeartbeat: 'error',
        expiresAt: 'error',
      },
    };
  }
}

/**
 * Get health scores for all vessels in an organization
 */
export async function getOrganizationVesselHealth(
  orgId: string,
  accountId: string | null = null
): Promise<VesselHealthScore[]> {
  try {
    // Get all active vessels
    const vesselsQuery = `
      SELECT id FROM vessel
      WHERE ${accountIdScopedWhere()} AND expires_at > time::now()
      ORDER BY last_heartbeat DESC;
    `;
    const vesselsResults = await surrealDB.query<{ id: string }[]>(
      vesselsQuery,
      { org_id: orgId, account_id: accountId }
    );

    const vessels = vesselsResults[0] || [];
    const healthScores: VesselHealthScore[] = [];

    for (const vessel of vessels) {
      const score = await computeVesselHealthScore(vessel.id, orgId, accountId);
      healthScores.push(score);
    }

    return healthScores;
  } catch (error: any) {
    logger.error('Failed to get organization vessel health', {
      orgId,
      error: error.message,
    });
    return [];
  }
}
