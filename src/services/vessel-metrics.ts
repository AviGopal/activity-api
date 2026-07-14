/**
 * Phase 22 (Autonomous Vessel Forge): vessel production success rate.
 * Read-only over existing activity_execution_traces — no new table, no migration.
 */

import { surrealDB } from '../db/surreal';
import { queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';

export interface VesselProductionSuccessRate {
  vessel_id: string;
  window_hours: number;
  total_uses: number;
  successful_uses: number;
  success_rate: number;
  failure_modes: Record<string, number>;
  status: 'green' | 'yellow' | 'red';
}

/**
 * Compute the production success rate for a forged (or any) vessel over the
 * last `windowHours` hours by scanning activity_execution_traces where the
 * vessel appears in `composition_chain` OR as `vessel_id`.
 *
 * Read-only — no new table, no migration. Uses existing AET fields.
 */
export async function computeVesselProductionSuccessRate(
  forgedVesselId: string,
  windowHours: number,
  jwtToken?: string,
): Promise<VesselProductionSuccessRate> {
  const windowSeconds = windowHours * 3600;
  const query = `
    SELECT
      success,
      failure_mode.type AS failure_type
    FROM v_paradigm_execution_traces
    WHERE (
        vessel_id = $vessel_id
        OR composition_chain CONTAINS $vessel_id
      )
      AND created_at > time::now() - ${windowSeconds}s
    LIMIT 1000
  `;
  try {
    const rows = jwtToken
      ? await queryWithAuth<Array<{ success: boolean; failure_type?: string }>>(jwtToken, query, { vessel_id: forgedVesselId })
      : await surrealDB.query<Array<{ success: boolean; failure_type?: string }>>(query, { vessel_id: forgedVesselId });

    const flat = (rows || []).flat?.() ?? (rows as any[]) ?? [];
    const total = flat.length;
    const successful = flat.filter((r) => r.success === true).length;
    const failureModes: Record<string, number> = {};
    for (const r of flat) {
      if (r.failure_type) {
        failureModes[r.failure_type] = (failureModes[r.failure_type] ?? 0) + 1;
      }
    }

    const successRate = total > 0 ? successful / total : 0;
    const status: 'green' | 'yellow' | 'red' =
      successRate >= 0.9 ? 'green' : successRate >= 0.7 ? 'yellow' : 'red';

    return {
      vessel_id: forgedVesselId,
      window_hours: windowHours,
      total_uses: total,
      successful_uses: successful,
      success_rate: successRate,
      failure_modes: failureModes,
      status,
    };
  } catch (err: any) {
    logger.error('computeVesselProductionSuccessRate failed', { vessel_id: forgedVesselId, error: err?.message });
    throw err;
  }
}
