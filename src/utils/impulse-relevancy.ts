/**
 * Impulse Relevancy Integration
 *
 * Queries impulse_relevance_metrics table to boost/penalize activity scores
 * based on which impulses are loaded and how relevant they are.
 */

import { surrealDB } from '../db/surreal';
import { logger } from './logger';

export interface ImpulseRelevanceMetric {
  impulse_id: string;
  activity_variant_id: string;
  relevance_score: number;      // P(success | impulse loaded)
  irrelevance_score: number;    // P(success | impulse NOT loaded)
  net_value_score?: number;     // relevance_score - irrelevance_score * 0.5
  times_loaded: number;
  times_execution_succeeded: number;
  times_execution_failed: number;
}

export interface ImpulseRelevancyBoost {
  activityId: string;
  alphaBoost: number;
  betaPenalty: number;
  relevantImpulses: string[];
  missingCriticalImpulses: string[];
  details: {
    loaded_impulse_boost: number;
    missing_impulse_penalty: number;
    harmful_impulse_penalty: number;
  };
}

/**
 * Query impulse relevancy metrics for a set of activities and impulses
 *
 * @param activityIds - Activity IDs to check
 * @param loadedImpulses - Impulse IDs currently loaded
 * @param decayWeights - Optional per-shape decay weights (from session_context timestamps)
 * @returns Map of activityId → relevancy boost calculation
 */
export async function calculateImpulseRelevancyBoosts(
  activityIds: string[],
  loadedImpulses: string[],
  decayWeights?: Map<string, number>
): Promise<Map<string, ImpulseRelevancyBoost>> {
  if (activityIds.length === 0) {
    return new Map();
  }

  try {
    // Query all relevancy metrics for these activities
    const query = `
      SELECT
        impulse_id,
        activity_variant_id,
        relevance_score,
        irrelevance_score,
        times_loaded,
        times_execution_succeeded,
        times_execution_failed,
        times_not_loaded_succeeded,
        times_not_loaded_failed
      FROM impulse_relevance_metrics
      WHERE activity_variant_id IN $activity_ids
        AND (times_loaded > 0 OR times_not_loaded_succeeded + times_not_loaded_failed > 0)
    `;

    const result = await surrealDB.query(query, {
      activity_ids: activityIds,
    });

    const metrics: ImpulseRelevanceMetric[] = result || [];

    logger.debug('Impulse relevancy metrics fetched', {
      activityCount: activityIds.length,
      metricsCount: metrics.length,
      loadedImpulses: loadedImpulses.length,
    });

    // Group metrics by activity
    const metricsByActivity = new Map<string, ImpulseRelevanceMetric[]>();
    for (const metric of metrics) {
      const activityMetrics = metricsByActivity.get(metric.activity_variant_id) || [];
      activityMetrics.push(metric);
      metricsByActivity.set(metric.activity_variant_id, activityMetrics);
    }

    // Calculate boosts for each activity
    const boosts = new Map<string, ImpulseRelevancyBoost>();

    for (const activityId of activityIds) {
      const activityMetrics = metricsByActivity.get(activityId) || [];

      let alphaBoost = 0;
      let betaPenalty = 0;
      const relevantImpulses: string[] = [];
      const missingCriticalImpulses: string[] = [];

      let loadedImpulseBoost = 0;
      let missingImpulsePenalty = 0;
      let harmfulImpulsePenalty = 0;

      for (const metric of activityMetrics) {
        const isLoaded = loadedImpulses.includes(metric.impulse_id);
        const relevanceDiff = metric.relevance_score - metric.irrelevance_score;

        // Thresholds for classification
        const CRITICAL_THRESHOLD = 0.3;   // relevance >> irrelevance
        const HARMFUL_THRESHOLD = -0.3;   // irrelevance >> relevance

        // Decay weight defaults to 1.0 — impulses without timestamps are treated as fully fresh
        const dw = decayWeights?.get(metric.impulse_id) ?? 1.0;

        if (relevanceDiff > CRITICAL_THRESHOLD) {
          // This impulse is CRITICAL (success rate much higher when loaded)
          if (isLoaded) {
            const boost = Math.ceil(relevanceDiff * 10 * dw);
            alphaBoost += boost;
            loadedImpulseBoost += boost;
            relevantImpulses.push(metric.impulse_id);
          } else {
            const penalty = Math.ceil(relevanceDiff * 5 * dw);
            betaPenalty += penalty;
            missingImpulsePenalty += penalty;
            missingCriticalImpulses.push(metric.impulse_id);
          }
        } else if (relevanceDiff < HARMFUL_THRESHOLD) {
          // This impulse is HARMFUL (success rate lower when loaded)
          if (isLoaded) {
            const penalty = Math.ceil(Math.abs(relevanceDiff) * 5 * dw);
            betaPenalty += penalty;
            harmfulImpulsePenalty += penalty;
          }
        }
        // If -0.3 < relevanceDiff < 0.3, impulse is NEUTRAL - ignore
      }

      boosts.set(activityId, {
        activityId,
        alphaBoost,
        betaPenalty,
        relevantImpulses,
        missingCriticalImpulses,
        details: {
          loaded_impulse_boost: loadedImpulseBoost,
          missing_impulse_penalty: missingImpulsePenalty,
          harmful_impulse_penalty: harmfulImpulsePenalty,
        },
      });
    }

    logger.info('Impulse relevancy boosts calculated', {
      activitiesWithBoosts: Array.from(boosts.values()).filter(
        b => b.alphaBoost > 0 || b.betaPenalty > 0
      ).length,
      totalActivities: activityIds.length,
    });

    return boosts;
  } catch (error: any) {
    logger.error('Failed to calculate impulse relevancy boosts', {
      error: error.message,
      stack: error.stack,
    });
    // Return empty map on error - recommendation can still proceed without relevancy
    return new Map();
  }
}

/**
 * Discover which missing impulses would unlock better activities
 *
 * Finds impulses that are critical for high-performing activities but not currently loaded.
 *
 * @param activityIds - All candidate activity IDs
 * @param loadedImpulses - Currently loaded impulse IDs
 * @param limit - Max number of impulse suggestions to return
 * @returns Recommended impulses to load, with reasoning
 */
export async function discoverMissingImpulses(
  activityIds: string[],
  loadedImpulses: string[],
  limit: number = 5
): Promise<Array<{
  impulse_id: string;
  reason: string;
  unlocks_activities: string[];
  avg_relevance_boost: number;
}>> {
  if (activityIds.length === 0) {
    return [];
  }

  try {
    // Query metrics for impulses NOT currently loaded
    const query = `
      SELECT
        impulse_id,
        activity_variant_id,
        relevance_score,
        irrelevance_score,
        net_value_score,
        times_execution_succeeded,
        times_loaded
      FROM impulse_relevance_metrics
      WHERE activity_variant_id IN $activity_ids
        AND times_loaded > 0
    `;

    const result = await surrealDB.query(query, {
      activity_ids: activityIds,
    });

    const metrics: ImpulseRelevanceMetric[] = result || [];

    // Compute net_value_score for pre-migration rows; exclude non-positive values
    const enriched = metrics.map(m => {
      const nvs = m.net_value_score !== undefined && m.net_value_score !== null
        ? m.net_value_score
        : Math.max(-1, Math.min(1, m.relevance_score - m.irrelevance_score * 0.5));
      return { ...m, net_value_score: nvs };
    }).filter(m => m.net_value_score! > 0);

    // Filter to only missing impulses
    const missingMetrics = enriched.filter(m => !loadedImpulses.includes(m.impulse_id));

    // Group by impulse_id
    const impulseGroups = new Map<string, typeof missingMetrics>();
    for (const metric of missingMetrics) {
      const group = impulseGroups.get(metric.impulse_id) || [];
      group.push(metric);
      impulseGroups.set(metric.impulse_id, group);
    }

    // Calculate value of each missing impulse
    const suggestions = Array.from(impulseGroups.entries()).map(([impulseId, mGroup]) => {
      const unlocksActivities = mGroup.map(m => m.activity_variant_id);
      const avgNetValue =
        mGroup.reduce((sum, m) => sum + m.net_value_score!, 0) / mGroup.length;
      const totalSuccesses = mGroup.reduce((sum, m) => sum + m.times_execution_succeeded, 0);

      return {
        impulse_id: impulseId,
        reason: `Critical for ${mGroup.length} activities (avg net value: ${(avgNetValue * 100).toFixed(1)}%, ${totalSuccesses} past successes)`,
        unlocks_activities: unlocksActivities,
        avg_relevance_boost: avgNetValue,
        total_successes: totalSuccesses,
      };
    });

    // Sort by avg_net_value * unlocks_count (impact)
    suggestions.sort((a, b) => {
      const impactA = a.avg_relevance_boost * a.unlocks_activities.length;
      const impactB = b.avg_relevance_boost * b.unlocks_activities.length;
      return impactB - impactA;
    });

    return suggestions.slice(0, limit);
  } catch (error: any) {
    logger.error('Failed to discover missing impulses', {
      error: error.message,
    });
    return [];
  }
}
