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
import { betaSample, normalizeSuccessorValue, successorBlendEnabled, successorBlendWeight, updateShapeScoresFromExecution, variantMetricsRecordId } from "./activities.scoring";

export const COMPOSITION_HUB_MARKERS = ['validator-dispatch', 'slot-binding'];

export const COMPOSITION_SCAFFOLD_MARKERS = ['compose-', 'genuine-edge-probe'];

export type CompositionEdgeKind = 'genuine' | 'scaffold' | 'hub';

export function classifyCompositionEdge(
  parentActivityId: string | null | undefined,
  childActivityId: string | null | undefined,
  // Recurrence/shape evidence supplied by WRITE-path callers. When present, a
  // non-marker edge is 'genuine' ONLY with empirical proof — it has recurred with
  // success (the data demonstrably flowed enough to succeed repeatedly) OR a shape
  // the parent produces is one the child consumes. A brand-new/unproven non-marker
  // edge is 'scaffold' until it earns 'genuine'. This is the honest λ₁ signal: the
  // bare node-name verdict (no opts) marked EVERY non-wrapper pair genuine, which
  // inflated the genuine count ~3× with single-shot/observer noise. Read-time
  // callers pass no opts and keep the legacy node-name verdict (backward-compatible).
  opts?: { executionCount?: number; successCount?: number; shapeFlow?: boolean },
): CompositionEdgeKind {
  const p = String(parentActivityId || '');
  const ch = String(childActivityId || '');
  const touchesHub = COMPOSITION_HUB_MARKERS.some((h) => p.includes(h) || ch.includes(h));
  if (touchesHub) return 'hub';
  const touchesScaffold = COMPOSITION_SCAFFOLD_MARKERS.some((s) => p.includes(s) || ch.includes(s));
  if (touchesScaffold) return 'scaffold';
  if (opts) {
    const ec = opts.executionCount ?? 0, sc = opts.successCount ?? 0;
    const recurring = ec >= 5 && sc >= 3;
    return (recurring || opts.shapeFlow === true) ? 'genuine' : 'scaffold';
  }
  return 'genuine';
}
