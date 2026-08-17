// Extracted from activities.ts by parity-gated seam extraction (behavior-neutral move).
import { validRepairSignature, repairBoostFromRows } from '../lib/repair-signature-consume';
import { Hono } from 'hono';
import beta from '@stdlib/random-base-beta';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { invalidateTemplateCache, invalidateTemplateCacheMany } from '../utils/template-cache';
import { logger } from '../utils/logger';
import { ensureTags, computeTagPrefixes, deriveCategory } from '../utils/tags';
import { analyzeTaskSemantics } from '../utils/semantic-tags';
import {
  extractContextTokensWithDecay,
  computeContextBucket,
  computeStateSpaceSignature,
  decayWeight,
  type SessionContext,
} from '../utils/session-context';
import { calculateImpulseRelevancyBoosts, discoverMissingImpulses } from '../utils/impulse-relevancy';
import { inferShapesFromTemplate, mergeShapes } from '../utils/shape-inference';
import { calculateOutputShapeCoverage } from '../utils/outcome-to-shape';
import { captureValidationTrace } from '../utils/validation-traces';
import { normalizeRecordId } from '../utils/surrealdb-types';
import { localEmbeddingService } from '../services/embedding-service';
import {
  insertActivity,
  insertExecution,
  getActivityScores,
  getShapeConditionedScores,
  queryActivitiesByShapes,
  queryActivitiesByFTS,
  queryActivitiesByDense,
  transformToLegacyTemplate,
  isDualWriteEnabled,
  getVariantFamily,
  getVariantScores,
  buildVariantTree,
  normalizeActivityId,
  type ParadigmActivity,
  type ParadigmExecution,
  type ActivityScore,
  type VariantInfo,
  type VariantScore,
  type VariantTreeNode,
} from '../db/paradigm';
import { mergeByRRF } from '../utils/rrf';
import {
  runDiscoverByShapes,
  validateDiscoverByShapesInput,
} from '../services/discover-by-shapes';
import type { SessionData } from '../models/schemas';
import { getJwtAuthFromContext, hasJwtAuth, getExecutionScopeFromContext, type JwtAuthContext } from '../middleware/jwtAuth';
import {
  applyCompatibilityFilter,
  generatePointerRecommendations,
  identifyBlockingShapes,
  buildPointerStateSpace,
  type ImpulseStateEntry,
} from '../services/recommendation';
import { generateActivity } from '../services/activity-generator';
import { applyReputationFactor } from '../services/thompson-sampling';
import {
  successorFeaturesEnabled,
  fetchSuccessorFeatureCells,
  successorFeatureCellKey,
  rewardFromCompletionShapes,
  successorValue,
} from '../lib/successor-features';
import {
  ExecutionRecordSchema,
  CreateTemplateRequestSchema,
  CompositionRecordRequestSchema,
  CompositionGraphQuerySchema,
  ImpulseRelevanceRecordRequestSchema,
  ImpulseRelevanceQuerySchema,
  ToolUsageRecordRequestSchema,
  ToolUsageQuerySchema,
  ExecutionSequenceRecordRequestSchema,
  ExecutionSequenceQuerySchema,
  StoreExecutionTraceRequestSchema,
  ToolArgumentPatternRecordRequestSchema,
  ToolArgumentRecommendationsQuerySchema,
  ShapeScoreUpdateRequestSchema,
  ActivityFeedbackRequestSchema,
  type ExecutionRecord,
  type ExecutionRecordResponse,
  type CreateTemplateRequest,
  type CreateTemplateResponse,
  type CompositionRecordRequest,
  type CompositionGraphResponse,
  type CompositionEdge,
  type ImpulseRelevanceMetric,
  type ImpulseRelevanceResponse,
  type ToolUsagePattern,
  type ToolUsageResponse,
  type ExecutionSequence,
  type ExecutionSequenceResponse,
  type StoreExecutionTraceResponse,
  type ToolArgumentPattern,
  type ToolArgumentRecommendationsResponse,
  type ShapeScoreUpdateResponse,
  type ActivityFeedbackRequest,
  type ActivityFeedbackResponse,
  type ImpulseShapeActivityScore,
} from '../models/schemas';
import { broadcaster } from '../websocket/broadcaster';
import { autoCreateVariantIfNeeded, checkAndRetireTemplate } from '../services/variant-creator';
import { applyOutcomeToPosteriors } from '../lib/posterior-update';
import { incrementTraceStoreCounter } from '../lib/trace-store-counters';
import { classifyTemplateTiers } from '../services/tier-classifier';
import { lookupAssignment, readClusterPosterior } from '../lib/cluster-posterior';
import { getTuningParam } from '../lib/tuning-params';

export const betaSample: (alpha: number, betaParam: number) => number = (() => {
  const seed = process.env.THOMPSON_SAMPLING_SEED;
  if (seed) {
    const seedNum = parseInt(seed, 10);
    if (!isNaN(seedNum)) {
      logger.info('Thompson Sampling initialized with seed', { seed: seedNum });
      return beta.factory({ seed: seedNum });
    }
  }
  return beta;
})();

export async function successorBlendEnabled(): Promise<boolean> {
  if (process.env.SF_BLEND === '1' || process.env.SF_BLEND === 'true') return true;
  return (await getTuningParam('SF_BLEND', process.env.SF_BLEND, 0)) >= 1;
}

export function successorBlendWeight(): number {
  const raw = process.env.SF_BLEND_WEIGHT;
  if (raw === undefined || raw === '') return 0.5;
  const w = parseFloat(raw);
  if (!Number.isFinite(w) || w < 0) return 0.5;
  return w;
}

export function normalizeSuccessorValue(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v / (1 + v);
}

export function variantMetricsRecordId(
  variantId: string,
  accountId: string | undefined | null
): string {
  const variantSlug = variantId.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!accountId) return variantSlug;
  const acctSlug = accountId.replace(/^accounts:/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${variantSlug}__${acctSlug}`;
}

export async function updateShapeScoresFromExecution(
  activityId: string,
  shapes: string[],
  success: boolean,
  orgId: string,
  jwtToken?: string | null,
  accountId: string | null = null
): Promise<void> {
  if (!shapes || shapes.length === 0) {
    return; // No shapes to update
  }

  try {
    const successIncrement = success ? 1 : 0;
    const failureIncrement = success ? 0 : 1;

    for (const shape of shapes) {
      try {
        // Phase B-followup: dual-write account_id + version on the MERGE.
        const upsertQuery = `
          UPSERT impulse_shape_activity_score:[$org_id, $shape, $activity_id]
          MERGE {
            shape: $shape,
            activity_id: $activity_id,
            org_id: $org_id,
            account_id: $account_id,
            account_id_version: $account_id_version,
            success_count: ((
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0) + $success_increment,
            failure_count: ((
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0) + $failure_increment,
            alpha: ((
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0) + $success_increment + 1,
            beta: ((
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0) + $failure_increment + 1,
            updated_at: time::now()
          };
        `;

        const params = {
          shape,
          activity_id: activityId,
          org_id: orgId,
          account_id: accountId,
          account_id_version: 1,
          success_increment: successIncrement,
          failure_increment: failureIncrement,
        };

        // Use authenticated connection if JWT token provided, otherwise use root connection
        if (jwtToken) {
          await queryWithAuth(jwtToken, upsertQuery, params);
        } else {
          await surrealDB.query(upsertQuery, params);
        }
      } catch (shapeError: any) {
        logger.warn('Failed to update shape score in execution flow', {
          shape,
          activity_id: activityId,
          error: shapeError.message,
        });
      }
    }

    logger.debug('Shape scores updated from execution', {
      activity_id: activityId,
      shapes_count: shapes.length,
      success,
    });
  } catch (error: any) {
    // Non-blocking: don't fail the execution recording if shape score update fails
    logger.warn('Shape score update from execution failed (non-blocking)', {
      activity_id: activityId,
      error: error.message,
    });
  }
}
