import { z } from 'zod';
import { getActivitiesWithTieredFallback } from "./activities.get-activities-with-tiered-fallback";
/**
 * Activity Template Routes
 * 
 * Implements GET /v2/activities/templates endpoint with:
 * - Thompson Sampling scores from SurrealDB
 * - Multi-tenant filtering (org_id/project_id scope)
 * - Redis cache-aside pattern (1hr TTL)
 * 
 * Replaces Python RPC API with identical dataflows
 */

import { validRepairSignature, repairBoostFromRows } from '../lib/repair-signature-consume';
import { Hono } from 'hono';
import beta from '@stdlib/random-base-beta';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { RedisClient } from '../db/redis';
import { invalidateTemplateCache, invalidateTemplateCacheMany } from '../utils/template-cache';
import { logger } from '../utils/logger';

const activitiesApp = new Hono();

// POST /header_added
// Produces shape: 'header_added'
activitiesApp.post('/header_added', async (c) => {
  const body = await c.req.json();
  const validated = z.object({
    header: z.string().min(1),
    context: z.record(z.unknown()).optional(),
  }).parse(body);

  return c.json({
    shape: 'header_added',
    header: validated.header,
    context: validated.context ?? null,
  });
});
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
import { applyOutcomeToPosteriors, decayedThompsonCounts, resolveThompsonDecayHalfLifeDays } from '../lib/posterior-update';
import { incrementTraceStoreCounter } from '../lib/trace-store-counters';
import { classifyTemplateTiers } from '../services/tier-classifier';
import { lookupAssignment, readClusterPosterior } from '../lib/cluster-posterior';
import { getTuningParam } from '../lib/tuning-params';

const app = new Hono();

// D5.2 — partial-pooling minimum-sample threshold for the leaf signature posterior.
// When the leaf signature has fewer than this many observed samples
// (n_signature = alpha + beta - 2), the selector falls back to the well-sampled
// CLUSTER posterior instead of the cold leaf / Beta(1,1) prior. Read once at module
// init. Default 5 (aligns with RECOMMEND_SIGNATURE_SAMPLING_FLOOR semantics).
const SIGNATURE_CLUSTER_N_MIN = parseInt(process.env.SIGNATURE_CLUSTER_N_MIN ?? '5', 10);

// POST /header_added
// Produces shape: 'header_added'
app.post('/header_added', async (c) => {
  const body = await c.req.json();
  const validated = z.object({
    header: z.string().min(1),
    context: z.record(z.unknown()).optional(),
  }).parse(body);

  return c.json({
    shape: 'header_added',
    header: validated.header,
    context: validated.context ?? null,
  });
});

// Cache configuration
const TEMPLATE_CACHE_TTL = 3600; // 1 hour in seconds
const CACHE_KEY_PREFIX = 'activity:template:';
const CACHE_LIST_KEY = 'activity:templates:list';

/**
 * Account_id record-id form, matching the org_id record-ref convention used
 * elsewhere in this file (`organizations:${orgId}`). Returns null when
 * accountId is undefined so callers can pass it straight into
 * `option<string>` schema fields.
 */
export function accountIdRecordRef(accountId: string | undefined | null): string | null {
  if (!accountId) return null;
  return accountId.startsWith('accounts:') ? accountId : `accounts:${accountId}`;
}

/**
 * Parse the `offset` query param for paginated template listing.
 * - Non-numeric, negative, or NaN values clamp to 0.
 * - Floats truncate to int.
 * - Positive integers pass through.
 *
 * Exported for unit tests in `routes/templates-pagination.test.ts`.
 */
export function parsePaginationOffset(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

/**
 * Filter templates by input shapes compatibility
 * Uses canonical 'input_shapes' field (paradigm-aligned)
 * Falls back to legacy 'input_schema' for backward compatibility
 *
 * A template matches if ALL required shapes in its input_shapes are present in providedShapes
 * Templates without input_shapes match anything (backwards compatible)
 */
function filterByInputSchema(
  templates: any[],
  providedShapes: string[]
): any[] {
  if (!providedShapes || providedShapes.length === 0) {
    return templates;
  }

  const providedSet = new Set(providedShapes);

  return templates.filter(template => {
    // Prefer canonical 'input_shapes' field, fall back to legacy 'input_schema'
    const inputShapes = template.input_shapes;
    const inputSchema = template.input_schema;

    // Templates without input requirements match anything (backwards compatible)
    if (!inputShapes?.length && (!inputSchema || !inputSchema.required || !Array.isArray(inputSchema.required))) {
      return true;
    }

    // Use canonical input_shapes if available
    if (inputShapes?.length) {
      const allRequiredPresent = inputShapes.every((shape: string) =>
        providedSet.has(shape)
      );

      // Log for composition learning
      if (allRequiredPresent && template.output_shapes) {
        logger.debug('[Composition Learning] Activity produces output shapes', {
          activity_id: template.id,
          input_shapes: inputShapes,
          output_shapes: template.output_shapes,
        });
      }

      return allRequiredPresent;
    }

    // Fall back to legacy input_schema
    const requiredShapes = inputSchema.required.map((s: any) =>
      typeof s === 'string' ? s : s.shape
    ).filter(Boolean);

    const allRequiredPresent = requiredShapes.every((shape: string) =>
      providedSet.has(shape)
    );

    // Log for composition learning
    if (allRequiredPresent && template.output_shapes) {
      logger.debug('[Composition Learning] Activity produces output shapes', {
        activity_id: template.id,
        input_shapes: requiredShapes,
        output_shapes: template.output_shapes,
      });
    }

    return allRequiredPresent;
  });
}

/**
 * POST /v2/activities/templates
 * Register a new activity template variant
 * 
 * This endpoint enables template registration from:
 * - MiniBob executing local JSON templates
 * - OpenCode creating new templates
 * - External systems registering custom templates
 * 
 * Automatically creates initial performance metrics with Thompson Sampling parameters
 */
app.post('/templates', async (c) => {
  // Parse body early for validation trace capture
  let body: any;
  let jwtAuth: any;
  let orgId: string | null = null;
  let projectId: string | null = null;
  let accountId: string | null = null; // Phase B1

  try {
    // Check for JWT auth first (MiniBob instances)
    jwtAuth = getJwtAuthFromContext(c);

    logger.info('POST /templates - JWT auth context', {
      hasJwtAuth: !!jwtAuth,
      jwtAuthOrgId: jwtAuth?.orgId,
      hasJwtToken: !!jwtAuth?.jwtToken,
    });

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    orgId = jwtAuth?.orgId || session?.org_id || null;
    projectId = jwtAuth?.projectId || session?.project_id || null;
    // Phase B1: account_id only flows from JWT auth context — sessions don't carry one.
    accountId = jwtAuth?.accountId ?? null;

    // Parse and validate request body
    body = await c.req.json();
    const validated = CreateTemplateRequestSchema.parse(body);

    // Normalize to canonical field names (accept both legacy and canonical)
    //
    // Clients sometimes round-trip a previously-fetched
    // template id back into POST /templates without unwrapping the
    // SurrealDB record-id form (e.g. `"activity:hello-world-minimal"` or
    // `"activity:⟨hello-world-minimal⟩"`). The downstream
    // `UPSERT activity:\`${activityId}\`` then creates a *new* record with
    // a doubled prefix (`activity:⟨activity:⟨hello-world-minimal⟩⟩`)
    // instead of overwriting the original. Strip any leading `activity:`
    // and SurrealDB angle-bracket / backtick wrapping so the upsert always
    // targets the canonical bare-name record.
    const rawActivityId = validated.id || validated.variant_id;
    let activityId = typeof rawActivityId === 'string'
      ? rawActivityId.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '').trim()
      : rawActivityId;
    const activityName = validated.name || validated.variant_name;
    const activityTasks = validated.tasks || validated.task_steps;
    const activityVariantOf = validated.variant_of || validated.genealogy;

    // Validate required fields
    if (!activityId) {
      return c.json({ error: 'Missing required field: id or variant_id' }, 400);
    }
    if (!activityName) {
      return c.json({ error: 'Missing required field: name or variant_name' }, 400);
    }

    // Convert category to tags if needed (backward compatibility)
    const tags = ensureTags({ tags: validated.tags, category: validated.category });
    const tagPrefixes = computeTagPrefixes(tags);
    // Derive category for backward compat (first tag's root segment if known)
    const derivedCategory = deriveCategory(tags) || validated.category || tags[0]?.split('.')[0] || 'uncategorized';

    logger.info('POST /v2/activities/templates', {
      id: activityId,
      name: activityName,
      tags,
      tagPrefixes,
      category: derivedCategory,
      scope: validated.scope,
    });

    // Check if activity already exists
    const existingQuery = `
      SELECT * FROM activity
      WHERE id = $id
      LIMIT 1
    `;

    // Use queryWithAuth when a JWT is on the auth context so $auth/$token
    // populate for tables with PERMISSIONS clauses (the `activity` table's
    // FOR create requires $auth.org_id != NONE, otherwise the upsert below
    // fails with "Anonymous access not allowed"). Falls back to root only
    // when no JWT is present (diagnostic / unauthenticated paths).
    const existing = jwtAuth?.jwtToken
      ? await queryWithAuth<ActivityTemplate>(jwtAuth.jwtToken, existingQuery, {
          id: activityId,
        })
      : await surrealDB.query<ActivityTemplate>(existingQuery, {
          id: activityId,
        });

    if (existing.length > 0) {
      logger.warn('Template already exists', { id: activityId });
      return c.json({
        success: false,
        id: activityId,
        variant_id: activityId, // Legacy alias for backward compatibility
        message: 'Template variant already exists',
      } as CreateTemplateResponse, 409);
    }

    // Build activity record using canonical field names
    const activityRecord: Record<string, any> = {
      id: activityId,
      name: activityName,
      description: validated.description,
      execution_type: 'template',
      // Hierarchical tags (primary classification)
      tags,
      tag_prefixes: tagPrefixes,
      // Legacy category for backward compatibility
      category: derivedCategory,
      scope: validated.scope || 'org',
      // Public templates are discoverable by all orgs (ribosome-generated templates)
      public: validated.public ?? false,
      // Proposed: stored, queryable, observable — but excluded from Thompson recommend
      // candidate pool. Substrate-authored writes (ribosome, make-activity) flip this on
      // to land templates safely in the registry without affecting selection. An operator
      // (or future autonomous promoter) flips it off via POST /templates/:id/promote.
      proposed: validated.proposed ?? false,
    };

    // Add org_id only if provided (optional field, let schema handle default)
    if (validated.org_id || orgId) {
      activityRecord.org_id = validated.org_id || orgId;
    }

    // Phase B1: dual-write account_id alongside org_id. Only set when non-null —
    // SurrealDB 3.x `option<string>` rejects JSON `null`; omitting the field
    // lets SurrealDB treat it as NONE (the correct absent-value sentinel).
    // account_id_version=1 marks this as Phase B regardless.
    if (accountId != null) {
      activityRecord.account_id = accountId;
    }
    activityRecord.account_id_version = 1;

    // Add tasks using canonical field name
    if (activityTasks && activityTasks.length > 0) {
      activityRecord.tasks = activityTasks;
    }

    // Persist template-declared variables. Without this, composition tasks
    // whose configs use {{name}} interpolation can't bind at execute time
    // and the engine halts after the first non-interpolated task.
    if (validated.variables && validated.variables.length > 0) {
      activityRecord.variables = validated.variables;
    }

    // Add input/output shapes for paradigm alignment
    // Priority: 1. Explicit shapes, 2. Legacy schema conversion, 3. Inference from template
    let inputShapesProvided = false;
    let outputShapesProvided = false;

    // Distinguish "explicitly empty" ([]) from "not provided" (undefined).
    // F25 precondition-rejection (concept_pFSLV6s5s3lQ) traced to this branch:
    // source templates that declare `inputShapes: []` (e.g. ingest-doc-as-concepts,
    // drain-pending-substrate-gaps, draft-gap-closing-activity) fell into the
    // shape-inference path below because `[].length === 0` is falsy. Inference
    // then merged unwanted shapes (`goal`, `source_code`, `sql_schema`, ...) into
    // input_shapes, after which filterBySatisfiableInputShapes rejected the
    // template at /recommend and the engine pre-flight-rejected dispatches.
    if (Array.isArray(validated.input_shapes)) {
      activityRecord.input_shapes = validated.input_shapes;
      inputShapesProvided = true;
    } else if (validated.input_schema?.required) {
      // Convert legacy input_schema to input_shapes
      activityRecord.input_shapes = validated.input_schema.required
        .map((s: any) => typeof s === 'string' ? s : s.shape)
        .filter(Boolean);
      inputShapesProvided = activityRecord.input_shapes.length > 0;
    }
    if (Array.isArray(validated.optional_input_shapes)) {
      activityRecord.optional_input_shapes = validated.optional_input_shapes;
    }
    if (validated.output_shapes?.length) {
      activityRecord.output_shapes = validated.output_shapes;
      outputShapesProvided = true;
    } else if (validated.output_schema?.produces) {
      // Convert legacy output_schema to output_shapes
      activityRecord.output_shapes = validated.output_schema.produces
        .map((s: any) => typeof s === 'string' ? s : s.shape)
        .filter(Boolean);
      outputShapesProvided = activityRecord.output_shapes.length > 0;
    }

    // TOPOLOGY-GROWTH FIX (2026-07-26, gap-ribosome-mint-input-shapes-leak-extractor-context):
    // A ribosome-extracted template (id `learned-*`) must NOT have its input_shapes
    // INFERRED from description prose. inferInputShapesFromPrompt harvests shape-name
    // keywords out of the LLM-written summary (source_code/goal/trace/activity_template),
    // stamping the EXTRACTOR's OWN consumed shapes onto the composite; the reuse binding
    // gate (goal-host: c.inputShapes.every(s => producedShapes.has(s))) then fails for any
    // real goal -> the composite is persisted but UNBINDABLE (topology grows, reuse dead).
    // A composite's genuine entry is the pool/goal (its first compose-step consumes nothing
    // declared), so an absent input_shapes must persist as explicit [] (which "matches
    // anything" = bindable), NOT be back-filled from prose. Scoped to learned-* ids so
    // normal template inference is untouched.
    const isLearnedExtracted = typeof activityId === 'string' && activityId.startsWith('learned-');
    if (isLearnedExtracted && !inputShapesProvided) {
      activityRecord.input_shapes = [];
      inputShapesProvided = true;
      logger.info('Learned/composite template: input_shapes pinned to [] (bindable), skipping prose inference', { activityId });
    }

    // OUTPUT-SHAPE CONFORMANCE for learned composites (2026-07-31,
    // gap-ribosome-learned-output-shapes-tool-output-placeholder). Symmetric to the
    // input_shapes guard above: inferShapesFromTemplate derives output shapes from task
    // PROSE + a category fallback ('tool' -> 'tool_output'), IGNORING each task's
    // authoritative `outputShapes`. Shape-less learned writes therefore get the generic
    // 'tool_output' placeholder baked in, which makes the extracted composite
    // UNSELECTABLE (goal-host advancesTarget never matches 'tool_output' against a real
    // goal target -> reuse dead: 266/424 learned rows sat permanently unreusable).
    // Derive the produced shapes DIRECTLY from the tasks' declared outputShapes (the
    // load-bearing fact, law 8), and also replace a bare ['tool_output'] the synthesiser
    // may have emitted. Fall through to prose/category inference only when the tasks
    // declare no real shapes. Scoped to learned-* ids so normal inference is untouched.
    if (isLearnedExtracted) {
      const PLACEHOLDER_OUT = new Set(['tool_output', 'tool_result', 'toolOutput', 'unknown_output']);
      const taskOut = Array.from(new Set(
        (activityTasks || []).flatMap((t: any) => Array.isArray(t?.outputShapes) ? t.outputShapes : [])
      )).filter((s: any) => typeof s === 'string' && s.length > 0 && !PLACEHOLDER_OUT.has(s));
      const provided = Array.isArray(activityRecord.output_shapes) ? activityRecord.output_shapes : [];
      const providedReal = provided.filter((s: any) => typeof s === 'string' && s.length > 0 && !PLACEHOLDER_OUT.has(s));
      const hasPlaceholder = provided.some((s: any) => PLACEHOLDER_OUT.has(s));
      // Real produced shapes = provided real shapes UNION task-declared real shapes.
      // Fires when output was absent, was ONLY a placeholder, OR was mixed real+placeholder
      // (strip the placeholder in that case too — the earlier version only fixed pure- or
      // empty-placeholder rows, leaving mixed ['analysis','tool_output'] extractions still
      // carrying the poison shape). Falls through to prose/category inference only when NO
      // real shape exists anywhere. law 8: the tasks' declared outputShapes are the fact.
      const real = Array.from(new Set([...providedReal, ...taskOut]));
      if (real.length > 0 && (!outputShapesProvided || hasPlaceholder)) {
        activityRecord.output_shapes = real;
        outputShapesProvided = true;
        logger.info('Learned/composite template: output_shapes set to task-derived real shapes (placeholder stripped)', { activityId, output_shapes: real });
      }
    }

    // Infer shapes from template if not explicitly provided
    if (!inputShapesProvided || !outputShapesProvided) {
      try {
        const inferredShapes = inferShapesFromTemplate({
          tasks: activityTasks,
          task_steps: activityTasks, // backward compat
          description: validated.description,
          category: derivedCategory,
        });

        if (!inputShapesProvided && inferredShapes.input_shapes.length > 0) {
          // Merge with any existing shapes (in case partial shapes were set)
          activityRecord.input_shapes = mergeShapes(
            activityRecord.input_shapes,
            inferredShapes.input_shapes
          );
          logger.info('Input shapes inferred from template', {
            activityId,
            inferredInputShapes: inferredShapes.input_shapes,
            mergedInputShapes: activityRecord.input_shapes,
          });
        }

        if (!outputShapesProvided) {
          // inferShapesFromTemplate always returns at least one output shape
          // (category-based fallback ensures this)
          activityRecord.output_shapes = mergeShapes(
            activityRecord.output_shapes,
            inferredShapes.output_shapes
          );
          logger.info('Output shapes inferred from template', {
            activityId,
            inferredOutputShapes: inferredShapes.output_shapes,
            mergedOutputShapes: activityRecord.output_shapes,
          });
        }
      } catch (inferenceError) {
        // Shape inference failed - but output_shapes is required
        // Use a fallback based on category
        logger.warn('Shape inference failed, using category-based fallback for output_shapes', {
          activityId,
          error: inferenceError instanceof Error ? inferenceError.message : String(inferenceError),
        });

        if (!outputShapesProvided) {
          // Fallback: derive output shape from category
          const categoryLower = derivedCategory?.toLowerCase() || '';
          let fallbackShape = 'unknown_output';
          switch (categoryLower) {
            case 'bugfix':
              fallbackShape = 'patch';
              break;
            case 'feature':
              fallbackShape = 'source_code';
              break;
            case 'refactor':
              fallbackShape = 'source_code';
              break;
            case 'test':
              fallbackShape = 'test_result';
              break;
            case 'tool':
              fallbackShape = 'tool_output';
              break;
            case 'infrastructure':
              fallbackShape = 'config_file';
              break;
            case 'meta':
              fallbackShape = 'activity_template';
              break;
            case 'docs':
              fallbackShape = 'documentation';
              break;
          }
          activityRecord.output_shapes = [fallbackShape];
          logger.info('Output shapes set to category fallback', {
            activityId,
            category: derivedCategory,
            outputShapes: activityRecord.output_shapes,
          });
        }
      }
    }

    // Final validation: ensure output_shapes is populated (required field)
    if (!activityRecord.output_shapes || activityRecord.output_shapes.length === 0) {
      activityRecord.output_shapes = ['unknown_output'];
      logger.warn('output_shapes was empty after all inference attempts, using default fallback', {
        activityId,
      });
    }

    // Add optional fields only if provided
    if (validated.project_id || projectId) {
      activityRecord.project_id = validated.project_id || projectId;
    }
    if (activityVariantOf && Object.keys(activityVariantOf).length > 0) {
      activityRecord.variant_of = activityVariantOf;
    }

    // Store structured schemas if provided (goal-execution-foundation-alignment)
    // These are stored in addition to input_shapes/output_shapes for detailed schema info
    if (validated.input_schema) {
      activityRecord.input_schema = validated.input_schema;
    }
    if (validated.output_schema) {
      activityRecord.output_schema = validated.output_schema;
    }
    if (validated.schema_confidence !== undefined) {
      activityRecord.schema_confidence = validated.schema_confidence;
      // Log warning for low confidence schemas
      if (validated.schema_confidence < 0.5) {
        logger.warn('Low schema confidence template registered', {
          activityId,
          schemaConfidence: validated.schema_confidence,
        });
      }
    }

    // Ratchet lineage (2026-07-24): persist the source execution a learned/composed
    // template was extracted from (extracted_from column already exists on `activity`).
    {
      const _ef = validated.extracted_from ?? (validated as any).metadata?.extracted_from;
      if (_ef) (activityRecord as any).extracted_from = _ef;
    }

    // Persist template metadata bag from raw request body so it survives to storage.
    {
      const _md = (body as any)?.metadata;
      if (_md && typeof _md === 'object' && _md !== null && Object.keys(_md).length > 0) {
        (activityRecord as any).metadata = _md;
      }
    }

    // MINT DEDUP (law 3 — a wrong mint is negative value, not zero). The compose
    // loop re-mints the SAME capability hourly under `-<timestamp>`-suffixed names
    // (e.g. `pulsevitals2-composed-aggregator-author-1753657200123`); each landed as
    // a fresh row with a fresh Beta(1,1) posterior, splitting Thompson selection
    // traffic across uninformed clones (52-62% of a week's mints in the audit).
    // When the incoming name/id carries a trailing timestamp suffix, look for an
    // existing template with the same NORMALIZED name AND the same consumed/produced
    // shape signature; if found, UPSERT onto that record — its accumulated posterior
    // is preserved (the metrics UPSERT below uses `??` defaults), body fields update.
    const TS_SUFFIX_RE = /-\d{10,}$/;
    const hadTimestampSuffix =
      TS_SUFFIX_RE.test(String(activityName)) || TS_SUFFIX_RE.test(String(activityId));
    let dedupedOntoExisting = false;
    if (hadTimestampSuffix) {
      try {
        const normalizedName = String(activityName).replace(TS_SUFFIX_RE, '');
        const shapeSig = (arr: unknown): string =>
          Array.isArray(arr) ? arr.map(String).slice().sort().join(',') : '';
        const incomingSig = `${shapeSig(activityRecord.input_shapes)}|${shapeSig(activityRecord.output_shapes)}`;
        const dedupWhere = activityRecord.org_id
          ? `(name = $norm_name OR string::starts_with(name, $norm_prefix)) AND org_id = $dedup_org`
          : `(name = $norm_name OR string::starts_with(name, $norm_prefix))`;
        const dedupQuery = `
          SELECT meta::id(id) AS id_str, name, input_shapes, output_shapes FROM activity
          WHERE ${dedupWhere}
          LIMIT 50
        `;
        const dedupParams: Record<string, any> = {
          norm_name: normalizedName,
          norm_prefix: `${normalizedName}-`,
          ...(activityRecord.org_id ? { dedup_org: activityRecord.org_id } : {}),
        };
        const dedupCandidates = jwtAuth?.jwtToken
          ? await queryWithAuth<any>(jwtAuth.jwtToken, dedupQuery, dedupParams)
          : await surrealDB.query<any>(dedupQuery, dedupParams);
        // Prefer an exact normalized-name match; fall back to the first
        // timestamp-suffixed sibling with the same shape signature.
        const matches = (dedupCandidates || []).filter((cand: any) => {
          const candName = String(cand?.name ?? '');
          if (candName.replace(TS_SUFFIX_RE, '') !== normalizedName) return false;
          const candId = String(cand?.id_str ?? '');
          if (!candId || candId === activityId) return false;
          return `${shapeSig(cand?.input_shapes)}|${shapeSig(cand?.output_shapes)}` === incomingSig;
        });
        matches.sort((a: any, b: any) =>
          Number(String(b?.name ?? '') === normalizedName) - Number(String(a?.name ?? '') === normalizedName));
        const dedupTarget = matches[0];
        if (dedupTarget) {
          logger.info('Template mint dedup: UPSERT onto existing capability (posterior preserved)', {
            incoming_id: activityId,
            incoming_name: activityName,
            existing_id: dedupTarget.id_str,
            existing_name: dedupTarget.name,
            normalized_name: normalizedName,
            shape_signature: incomingSig,
          });
          activityId = String(dedupTarget.id_str);
          // Pin the stored name to the normalized form so the row stops churning
          // through timestamped names and future dedup hits it by exact name.
          activityRecord.name = normalizedName;
          dedupedOntoExisting = true;
        } else {
          logger.info('Template mint dedup: no existing capability matched — INSERT as new', {
            incoming_id: activityId,
            normalized_name: normalizedName,
            shape_signature: incomingSig,
            candidates_seen: (dedupCandidates || []).length,
          });
        }
      } catch (dedupErr) {
        // Dedup is best-effort: any failure falls through to the historical insert path.
        logger.warn('Template mint dedup check failed (non-blocking, inserting as new)', {
          id: activityId,
          error: dedupErr instanceof Error ? dedupErr.message : String(dedupErr),
        });
      }
    }

    // Build dynamic query with only provided fields.
    // IMPORTANT: omit 'id' from CONTENT — the UPSERT target clause already
    // specifies the record ID as activity:`${activityId}`. Including id: $id in
    // CONTENT causes SurrealDB to interpret a colon in the id value as a
    // cross-table reference (e.g. "development-vessel:ship-change" becomes a
    // reference into the `development-vessel` table), which silently fails to
    // write the record at the expected key. (F-V63, 2026-05-21)
    const upsertFields = Object.entries(activityRecord)
      .filter(([k]) => k !== 'id')
      .map(([k]) => `${k}: $${k}`)
      .join(',\n        ');
    const upsertParams = Object.fromEntries(
      Object.entries(activityRecord).filter(([k]) => k !== 'id')
    );
    const upsertActivityQuery = `
      UPSERT activity:\`${activityId}\` CONTENT {
        ${upsertFields},
        created_at: created_at ?? time::now(),
        updated_at: time::now()
      }
    `;

    // Use root path for the UPSERT — same pattern as F-V56 (variant_performance_metrics).
    // queryWithAuth fails silently (returns []) when the API-key JWT is not accepted by
    // SurrealDB's ACCESS method, even though the activity table PERMISSIONS use $token.
    // HTTP-layer auth (validateApiKeyWithFallback) is the gating mechanism; the root DB
    // write is safe here. (F-V64, 2026-05-21)
    const upsertResult = await surrealDB.query(upsertActivityQuery, upsertParams);

    if (!upsertResult || (Array.isArray(upsertResult) && upsertResult.length === 0)) {
      // Only warn here — test mocks return [] and that is expected.
      logger.warn('Activity template UPSERT returned empty', {
        id: activityId,
      });
    }

    logger.info('Activity template inserted into activity table', {
      id: activityId,
      name: activityName,
      scope: activityRecord.scope,
      public: activityRecord.public,
      mint_deduped: dedupedOntoExisting,
    });

    // Create initial performance metrics
    // org_id is optional - use session org or request value if provided
    // Use record format for consistency with JWT $auth.org_id
    const metricsOrgId = validated.org_id || orgId || 'organizations:metabob_internal';
    const metricsProjectId = validated.project_id || projectId;

    // Build metrics query with conditional project_id
    // Note: variant_performance_metrics is a legacy table but still used for Thompson Sampling
    // The v_activity_score view reads from this table
    // UPSERT metrics to handle re-registration of existing templates.
    // Uses SET with ?? (nullish coalescing) so re-registration preserves
    // accumulated Thompson posteriors — only fills in defaults for NEW rows.
    // CONTENT was used here before but overwrote α/β on every bootstrap-seeder
    // run, resetting learned posteriors (F-069).
    //
    // Phase E: record-id includes the account slug when accountId is present
    // so different accounts in the same org get distinct α/β rows on register.
    // Caller-without-accountId still lands at the legacy `<variant>` key.
    const metricsRecordIdSlug = variantMetricsRecordId(activityId, accountId);
    const insertMetricsQuery = metricsProjectId
      ? `
      UPSERT variant_performance_metrics:\`${metricsRecordIdSlug}\` SET
        variant_id = $activity_id,
        activity_id = $activity_id,
        org_id = $org_id,
        account_id = $account_id,
        account_id_version = 1,
        project_id = $project_id,
        total_executions = total_executions ?? 0,
        successful_executions = successful_executions ?? 0,
        failed_executions = failed_executions ?? 0,
        success_rate = success_rate ?? 0.0,
        avg_duration_ms = avg_duration_ms ?? 0.0,
        avg_cost_usd = avg_cost_usd ?? 0.0,
        thompson_alpha = thompson_alpha ?? 1.0,
        thompson_beta  = thompson_beta  ?? 1.0,
        total_selections = total_selections ?? 0,
        created_at = created_at ?? time::now(),
        updated_at = time::now()
    `
      : `
      UPSERT variant_performance_metrics:\`${metricsRecordIdSlug}\` SET
        variant_id = $activity_id,
        activity_id = $activity_id,
        org_id = $org_id,
        account_id = $account_id,
        account_id_version = 1,
        total_executions = total_executions ?? 0,
        successful_executions = successful_executions ?? 0,
        failed_executions = failed_executions ?? 0,
        success_rate = success_rate ?? 0.0,
        avg_duration_ms = avg_duration_ms ?? 0.0,
        avg_cost_usd = avg_cost_usd ?? 0.0,
        thompson_alpha = thompson_alpha ?? 1.0,
        thompson_beta  = thompson_beta  ?? 1.0,
        total_selections = total_selections ?? 0,
        created_at = created_at ?? time::now(),
        updated_at = time::now()
    `;

    // Phase B1: only bind account_id when non-null — SurrealDB 3.x option<string>
    // rejects JSON null; omitting the param lets the field default to NONE.
    const metricsAccountId = accountIdRecordRef(accountId);
    const metricsParams = {
      activity_id: activityId,
      org_id: metricsOrgId,
      ...(metricsAccountId != null ? { account_id: metricsAccountId } : {}),
      ...(metricsProjectId ? { project_id: metricsProjectId } : {}),
    };
    if (jwtAuth?.jwtToken) {
      await queryWithAuth(jwtAuth.jwtToken, insertMetricsQuery, metricsParams);
    } else {
      await surrealDB.query(insertMetricsQuery, metricsParams);
    }

    logger.info('Template registered successfully', {
      id: activityId,
    });

    // Emit WS event so consumers (e.g. ribosome-vessel TemplateReplayObserver)
    // can react to new templates. Documented in docs/API_REFERENCE.md:2093.
    // Fire-and-forget; the broadcaster swallows per-client errors.
    try {
      broadcaster.emit({
        type: 'template_created',
        timestamp: new Date().toISOString(),
        data: {
          template_id: activityId,
          activity_id: activityId,
          name: activityName ?? null,
          input_shapes: Array.isArray(activityRecord.input_shapes) ? activityRecord.input_shapes : [],
          output_shapes: Array.isArray(activityRecord.output_shapes) ? activityRecord.output_shapes : [],
          tasks: Array.isArray(activityRecord.tasks) ? activityRecord.tasks : [],
          org_id: orgId ?? null,
          account_id: accountId ?? null,
        },
      });
    } catch (err) {
      logger.warn('Failed to broadcast template_created', {
        id: activityId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Invalidate Redis cache so the new template appears in list queries.
    // POST /templates uses UPSERT semantics — a repeat call against an
    // existing id overwrites the row, so the per-template key must also
    // be dropped or GETs return the pre-UPSERT body until TTL.
    // See src/utils/template-cache.ts for the per-key-completeness rule.
    await invalidateTemplateCache(activityId);

    // Fire-and-forget: generate dense embeddings for the new activity
    Promise.resolve().then(async () => {
      if (!localEmbeddingService.isReady()) return;
      try {
        const nameVec = await localEmbeddingService.embed(activityName || activityId);
        const nameArr = Array.from(nameVec);
        const updates: Record<string, any> = { name_embedding: nameArr };
        if (validated.description) {
          const descVec = await localEmbeddingService.embed(validated.description);
          updates.description_embedding = Array.from(descVec);
        }
        const setClause = Object.keys(updates).map(k => `${k} = $${k}`).join(', ');
        await surrealDB.query(
          `UPDATE type::thing("activity", $id) SET ${setClause}`,
          { id: activityId, ...updates }
        );
        logger.debug('[embedding] Wrote embeddings for new activity', { id: activityId });
      } catch (err) {
        logger.warn('[embedding] Failed to write embeddings for new activity', {
          id: activityId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }).catch(() => { /* swallow — never throw into request path */ });

    return c.json({
      success: true,
      id: activityId,
      variant_id: activityId, // Legacy alias for backward compatibility
      message: 'Template registered successfully',
    } as CreateTemplateResponse, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/templates failed', {
      error: error.message,
      stack: error.stack,
    });

    // Check if it's a validation error
    if (error.name === 'ZodError') {
      // Capture validation error as trace for pattern detection
      // This enables auto-detection of schema mismatches like snake_case vs camelCase
      captureValidationTrace(
        '/v2/activities/templates',
        'POST',
        error.errors,
        body,
        {
          callerId: jwtAuth?.keyId || jwtAuth?.userId,
          orgId: orgId || undefined,
          projectId: projectId || undefined,
        }
      );

      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    // Check if it's an index conflict (template/variant already exists with different record ID)
    // This happens when legacy records have random IDs but new UPSERTs use deterministic IDs
    // The unique index on variant_id blocks the duplicate
    if (error.message?.includes('Database index') && error.message?.includes('already contains')) {
      // Extract template ID from error message
      // Error format: "already contains 'template-id', with record..."
      const idMatch = error.message.match(/already contains '([^']+)'/);
      const templateId = idMatch?.[1] || 'unknown';

      logger.info('Template already exists (index conflict)', {
        id: templateId,
        message: error.message,
      });
      return c.json({
        success: true,
        id: templateId,
        variant_id: templateId,
        message: 'Template already exists',
      }, 409);
    }

    return c.json({
      error: 'Failed to register template',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/validation-patterns
 * Detect recurring validation errors for self-healing
 *
 * Returns patterns of validation failures that occur frequently,
 * enabling auto-detection of schema drift and field naming mismatches.
 */
/**
 * GET /v2/activities/shape-gap-resolution
 *
 * Phase 10 P4.5 of 2026-04-26-impulse-activity-loop. Returns cached
 * resolutions for a missing impulse shape so MiniBob's slot-binding
 * meta-activity can short-circuit `create-shape-provider-goal`
 * escalation when the gap has been bridged before.
 *
 * Query params:
 *   shape       — required; the missing impulse shape
 *   account_id  — optional; when present, filter to rows owned by that
 *                 account OR cross-account rows (account_id IS NONE).
 *                 When absent, only cross-account rows are returned.
 *
 * Response: { resolutions: [{ resolved_by, resolution_type, escalation_depth, cost_usd, times_used, last_used_at }, ...], total }
 *
 * Multi-tenant: SurrealDB PERMISSIONS on `shape_gap_resolution` (migration
 * 105) enforce org + account scoping at the row level when callers
 * authenticate with JWT. The application-level WHERE here is a
 * defence-in-depth filter — same pattern other GETs in this route use.
 */
app.get('/shape-gap-resolution', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing organization context',
      }, 401);
    }

    const shape = c.req.query('shape');
    if (!shape || typeof shape !== 'string' || shape.length === 0) {
      return c.json({ error: 'shape query parameter is required' }, 400);
    }

    const filterAccountId = c.req.query('account_id') || accountId;

    // Sort by recency × usage so the hottest entries surface first; cap
    // returned rows to keep payload small and deterministic.
    const query = `
      SELECT
        record::id(id) AS id,
        shape,
        account_id,
        resolved_by,
        required_scope,
        resolution_type,
        escalation_depth,
        cost_usd,
        times_used,
        first_seen_at,
        last_used_at
      FROM shape_gap_resolution
      WHERE shape = $shape
        AND org_id = $org_id
        AND (account_id IS NONE OR account_id = $account_id_filter)
      ORDER BY last_used_at DESC, times_used DESC
      LIMIT 50
    `;
    const params = {
      shape,
      org_id: orgId,
      account_id_filter: filterAccountId,
    };

    const result = jwtAuth?.jwtToken
      ? await queryWithAuth<any[]>(jwtAuth.jwtToken, query, params)
      : await surrealDB.query<any[]>(query, params);

    const rows = (result || []).flat?.() || result || [];
    return c.json({
      shape,
      account_id: filterAccountId,
      resolutions: rows,
      total: Array.isArray(rows) ? rows.length : 0,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/shape-gap-resolution failed', {
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }
});

// GET /v2/activities/deliverable-shapes — curated vocabulary of shapes that learned
// composites actually DELIVER (terminal = produced-minus-consumed WITHIN a composite),
// evidence-gated (ev>0), hygiene- and frequency-filtered, capped. goal-host unions this
// into fetchKnownShapes (B2, 2026-07-31, gap-ribosome-reuse-hop-cold-blocked) so goal->target
// inference can AIM a goal at a learned-only deliverable (e.g. conceptDescription) WITHOUT
// flooding the inference vocabulary with intermediate byproducts. Read-only; fail-open.
app.get('/deliverable-shapes', async (c) => {
  try {
    const FLOOR = 5;
    const CAP = 40;
    const GENERIC_NOISE = new Set([
      'fileContent', 'source_code', 'codeReadResult', 'tool_output', 'tool_result', 'toolOutput',
      'tool_call', 'httpResponse', 'commandResult', 'filePaths', 'activity_template',
      'fileWriteResult', 'activityExecutionSummary', 'trace', 'patch_proposal', 'patch',
      'analysis', 'json_extracted_value', 'llm_completion_result',
    ]);
    const denyRe = /(^producer_|^consumer_|^pool_|^validated_|^normalized_|^guard|^escalation_|^llm_filled|^gap_resolution|^enforced_|_metadata$|_validated$|_state$|_status$|_check$|_extracted$|^autoDraftedOutput_|^composedDeliverable_)/;
    const stepRe = /_s\d+$/;
    const result = await surrealDB.query<any>(
      `SELECT meta::id(id) AS id, tasks FROM activity
         WHERE (retired = false OR retired IS NONE) AND ev > 0
           AND (string::starts_with(meta::id(id), 'learned-') OR string::starts_with(meta::id(id), 'composed-cap'))`,
      {},
    );
    const rows = (result || []).flat?.() || result || [];
    const freq = new Map<string, number>();
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const tasks = Array.isArray((row as any)?.tasks) ? (row as any).tasks : [];
      if (tasks.length === 0) continue;
      const produced = new Set<string>();
      const consumed = new Set<string>();
      for (const t of tasks) {
        for (const sh of (Array.isArray(t?.outputShapes) ? t.outputShapes : [])) if (typeof sh === 'string' && sh) produced.add(sh);
        for (const sh of (Array.isArray(t?.inputShapes) ? t.inputShapes : [])) if (typeof sh === 'string' && sh) consumed.add(sh);
      }
      for (const sh of produced) {
        if (consumed.has(sh)) continue;                        // terminal = produced-minus-consumed
        if (GENERIC_NOISE.has(sh) || denyRe.test(sh) || stepRe.test(sh) || sh.includes('.')) continue;
        freq.set(sh, (freq.get(sh) ?? 0) + 1);                 // distinct-composite frequency
      }
    }
    const shapes = [...freq.entries()]
      .filter(([, n]) => n >= FLOOR)
      .sort((a, b) => b[1] - a[1])
      .slice(0, CAP)
      .map(([sh]) => sh);
    return c.json({ shapes });
  } catch {
    return c.json({ shapes: [] }, 200); // fail-open: goal-host falls back to registry-only vocab
  }
});

app.get('/validation-patterns', async (c) => {
  try {
    const { detectValidationPatterns } = await import('../utils/validation-traces');
    const timeWindowHours = parseInt(c.req.query('hours') || '24', 10);
    const minFrequency = parseInt(c.req.query('min_frequency') || '3', 10);

    const patterns = await detectValidationPatterns(timeWindowHours, minFrequency);

    return c.json({
      patterns,
      query: {
        time_window_hours: timeWindowHours,
        min_frequency: minFrequency,
      },
      total: patterns.length,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/validation-patterns failed', {
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }
});

/**
 * GET /v2/activities/templates
 * List all activity templates with Thompson Sampling scores
 *
 * Auth modes:
 * 1. JWT auth (MiniBob): RBAC enforced by SurrealDB PERMISSIONS via $auth.org_id
 * 2. Redis session auth (Dashboard): Application-level filtering via WHERE clauses
 */
app.get('/templates', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // API-key-minted JWTs use the `jwt_external` ACCESS method which SurrealDB
    // rejects for `db.authenticate()` ("The access method cannot be used in the
    // requested operation"). Sibling endpoints like `GET /templates/:variantId`
    // and `GET /public` avoid this by querying through the root client and
    // relying on application-level WHERE clauses for multi-tenant filtering.
    // Route API-key auth through that same legacy path here — real Bearer JWTs
    // (dashboard users) and MiniBob tokens keep the RBAC-enforced path below.
    const useRbacJwtQuery = useJwtAuth && jwtAuth?.authType !== 'apikey';

    // Fall back to Redis session auth for org/project context
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const projectId = jwtAuth?.projectId || session?.project_id || null;

    // Extract query parameters
    const category = c.req.query('category') || null;
    const scopeFilter = c.req.query('scope') || null; // Filter by scope: global, org, project
    const executionType = c.req.query('execution_type') || null; // T8: Filter by execution_type
    const limitStr = c.req.query('limit') || '50';
    let limit = parseInt(limitStr, 10);

    // Validate limit (consistent with impulses.ts pattern)
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    }
    limit = Math.min(limit, 100);

    // Pagination offset for operator audit / shadow-template enumeration.
    // Limit is still capped at 100/request — operators iterate via offset.
    const offsetStr = c.req.query('offset') || '0';
    const offset = parsePaginationOffset(offsetStr);
    // When paginating (offset > 0) we bypass Redis cache since the cache
    // holds the top-N list under one shared key; mid-page slices must hit DB.
    const paginating = offset > 0;

    // Natural-language full-text search — bypasses Redis cache and returns
    // BM25-ranked results from the FTS index. Same engine used by the
    // recommendation system (Tier 3 fallback).
    const q = c.req.query('q')?.trim() ?? null;
    if (q && q.length > 0) {
      logger.info('GET /v2/activities/templates — FTS path', { q: q.slice(0, 80), orgId, limit });
      const ftsResult = await queryActivitiesByFTS(
        q,
        orgId,
        executionType as 'template' | 'tool' | 'composition' | 'vessel_function' | null,
        limit,
        useRbacJwtQuery && jwtAuth?.jwtToken ? jwtAuth.jwtToken : null
      );
      const ftsTemplates = (ftsResult.data ?? []) as unknown as ActivityTemplate[];
      return c.json({ templates: ftsTemplates, total: ftsTemplates.length, limit, offset: 0, fts: true });
    }

    logger.info('GET /v2/activities/templates', {
      category,
      scopeFilter,
      executionType,
      limit,
      offset,
      orgId,
      projectId,
      authMethod: useRbacJwtQuery ? 'jwt' : (useJwtAuth ? 'apikey' : 'session'),
    });

    // CACHE-ASIDE PATTERN
    // Step 1: Check Redis cache for template list
    // Paginated requests (offset > 0) bypass the cache because the cache
    // holds only the top window populated on a previous limit*2 prefetch — it
    // can't satisfy mid-page slices and would silently truncate operator audits.
    const redis = RedisClient.getInstance();
    const templateIdsSet = paginating ? [] : await redis.smembers(CACHE_LIST_KEY);

    let templates: ActivityTemplate[] = [];
    let cacheHit = false;

    if (templateIdsSet.length > 0 && templateIdsSet.length >= limit) {
      // CACHE HIT - Load templates from Redis
      logger.debug('Template list cache hit', { count: templateIdsSet.length });
      cacheHit = true;

      // Load each template from cache (using canonical 'id' field)
      const templatePromises = templateIdsSet.map(async (activityId) => {
        const cachedData = await redis.get(`${CACHE_KEY_PREFIX}${activityId}`);
        if (cachedData) {
          return JSON.parse(cachedData) as ActivityTemplate;
        }
        return null;
      });

      const cachedTemplates = await Promise.all(templatePromises);

      // Filter out null values (individual TTL expiry)
      templates = cachedTemplates.filter((t): t is ActivityTemplate => t !== null);

      // Any missing individual entry means at least one template's 3600s TTL
      // has expired while the SET key persists indefinitely. Fall back to DB so
      // those templates are not silently dropped from list responses.
      if (templates.length < templateIdsSet.length) {
        logger.info('Individual template cache expiry detected, falling back to SurrealDB', {
          expected: templateIdsSet.length,
          actual: templates.length
        });
        cacheHit = false;
        templates = [];
      }
    }

    if (!cacheHit) {
      // CACHE MISS - Load from SurrealDB with distributed lock (cache stampede prevention)
      logger.info('Template list cache miss, loading from SurrealDB');
      
      const lockKey = 'lock:templates:refresh';
      // NOTE: this caller's cache is a SET (CACHE_LIST_KEY) of ids plus per-id
      // string blobs — NOT a single serialized blob under one key. withLock's
      // contention fast-path GETs `cacheKey` as a string and JSON.parses it, so
      // passing CACHE_LIST_KEY made the loser thread do a string GET against a
      // SET → WRONGTYPE. The fast-path is structurally dead for this caller (it
      // could never reconstruct the template array from a single GET), so we
      // pass a dedicated key that is never written: the GET is a clean miss and
      // the waiter simply falls through to the authoritative query.
      const cacheKey = 'activity:templates:list:blob-unused';
      
      // Use distributed lock to prevent cache stampede
      templates = await redis.withLock(
        lockKey,
        cacheKey,
        async () => {
          // Load templates from database.
          // Pass JWT token for RBAC enforcement ONLY when we can safely authenticate
          // it against SurrealDB (real Bearer JWTs / MiniBob tokens). API-key-minted
          // JWTs are intentionally NOT passed here — they'd trip the
          // "access method cannot be used" error. Multi-tenant filtering for those
          // callers is enforced application-side via orgId/projectId below.
          // When paginating, request exactly `limit` rows starting at
          // `offset`. For un-paginated requests we keep the existing limit*2
          // prefetch (used by the cache-population path).
          const dbTemplates = await listAllTemplatesFromDB(
            paginating ? limit : limit * 2,
            orgId,
            projectId,
            useRbacJwtQuery ? (jwtAuth?.jwtToken || null) : null,
            scopeFilter,
            executionType, // T8: Pass execution_type filter
            offset,
            jwtAuth?.accountId ?? null // Phase B1: account_id-aware scoping
          );

          // Populate Redis cache only when application-level filtering produced
          // the result set (legacy path) AND we're not paginating (paginated
          // slices are mid-page and would corrupt the cache's top-N invariant).
          // RBAC-filtered results are per-$auth and would leak isolation under
          // the shared list key.
          if (dbTemplates.length > 0 && !useRbacJwtQuery && !paginating) {
            const cachePromises: Promise<any>[] = [];

            for (const template of dbTemplates) {
              // Use canonical 'id' field
              const activityId = template.id;

              // Store template data with TTL
              cachePromises.push(
                redis.set(
                  `${CACHE_KEY_PREFIX}${activityId}`,
                  JSON.stringify(template),
                  TEMPLATE_CACHE_TTL
                )
              );

              // Add to template list set
              cachePromises.push(
                redis.sadd(CACHE_LIST_KEY, activityId)
              );
            }

            await Promise.all(cachePromises);
            logger.info(`Cached ${dbTemplates.length} templates from SurrealDB`);
          }

          return dbTemplates;
        },
        30 // Lock TTL: 30 seconds
      );
    }

    // Filter by category if specified
    if (category) {
      templates = templates.filter((t) => t.category === category);
    }

    // Apply limit
    templates = templates.slice(0, limit);

    // Skip client-side org/project filtering when the DB query ran with RBAC
    // auth (SurrealDB PERMISSIONS clauses already enforced isolation via
    // $auth.org_id). For API-key / session paths, do the filter in-app.
    if (!useRbacJwtQuery) {
      // LEGACY PATH: Filter by scope and org_id/project_id (client-side filtering)
      // This enforces multi-tenant isolation for Redis session auth
      templates = templates.filter((template) => {
        const scope = template.scope;

        // Global templates visible to all
        if (!scope || scope === 'global') {
          return true;
        }

        // Org-scoped templates visible only to users in that org
        if (scope === 'org') {
          return orgId && template.org_id === orgId;
        }

        // Project-scoped templates visible only to users in that project
        if (scope === 'project') {
          return projectId && template.project_id === projectId;
        }

        return false;
      });
    }

    logger.info('Templates filtered and ready', {
      count: templates.length,
      category,
      scope: { orgId, projectId },
      rbacEnforced: useRbacJwtQuery,
    });

    // Enrich templates with execution metrics
    templates = await enrichTemplatesWithMetrics(templates);
    logger.debug('Template enrichment point reached', { count: templates.length });
    logger.info('Templates enriched with metrics', { templatesWithMetrics: templates.filter(t => t.metrics).length });

    // Query a real total count (respects same RBAC + scope/exec-type filter
    // as the list query) so paginating callers know when they've walked the full
    // visible set. category is filtered application-side; reflect that in total.
    let total: number;
    try {
      total = await countAllTemplatesFromDB(
        orgId,
        projectId,
        useRbacJwtQuery ? (jwtAuth?.jwtToken || null) : null,
        scopeFilter,
        executionType,
        jwtAuth?.accountId ?? null, // Phase B1
      );
    } catch (countErr: any) {
      // Defensive: total is informational; never fail the list response on count failure.
      logger.warn('Template count query failed; falling back to page-size total', {
        error: countErr?.message,
      });
      total = templates.length + offset;
    }

    return c.json({
      templates,
      total,
      limit,
      offset,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/templates failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch templates',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/public
 * List public templates visible to all users (no auth required)
 *
 * Public templates are globally scoped templates with public=true.
 * This endpoint is unauthenticated - anyone can browse public templates.
 *
 * Query parameters:
 * - limit: Maximum number of templates to return (default: 50, max: 100)
 */
app.get('/public', async (c) => {
  try {
    const limitStr = c.req.query('limit') || '50';
    let limit = parseInt(limitStr, 10);

    // Validate limit
    if (isNaN(limit) || limit < 1) {
      limit = 50;
    }
    limit = Math.min(limit, 100);

    logger.info('GET /v2/activities/public', { limit });

    // Load public templates from SurrealDB (no auth required)
    const templates = await listPublicTemplatesFromDB(limit);

    logger.info('Public templates fetched', {
      count: templates.length,
      limit,
    });

    return c.json({
      templates,
      total: templates.length,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/public failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch public templates',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/templates/proposed-for-exercise
 *
 * Internal endpoint for the boredom-vessel exerciser. Surfaces a bounded,
 * deduped set of proposed gap-closing templates that are backlogged at
 * total_executions=0 because nothing exercises them. The standard
 * `GET /templates` handler caps at 100 rows and won't surface the backlog;
 * this endpoint fetches the full proposed set server-side (root path, like
 * auto-promote), dedups by gap_class, and returns a light projection.
 *
 * Read-only. Registered BEFORE `/templates/:variantId` so Hono matches the
 * static path first rather than capturing `proposed-for-exercise` as a variantId.
 */
app.get('/templates/proposed-for-exercise', async (c) => {
  try {
    const limitStr = c.req.query('limit') || '40';
    let limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 1) {
      limit = 40;
    }
    limit = Math.min(limit, 100);

    // Strip SurrealDB record-id wrapping: `activity:⟨X⟩` → `X`, `activity:X` → `X`.
    const normalizeId = (raw: unknown): string | null => {
      if (typeof raw !== 'string' || raw.length === 0) return null;
      let id = raw;
      if (id.startsWith('activity:')) id = id.slice('activity:'.length);
      // Strip angle-bracket wrappers (both the unicode ⟨⟩ and ascii fallbacks).
      id = id.replace(/^[⟨<`]+/, '').replace(/[⟩>`]+$/, '');
      return id.length > 0 ? id : null;
    };

    // Collapse the volatile tail so two drafts of the same gap share a gap_class.
    // Loop until stable: drafts accumulate CHAINED tails (e.g.
    // `...-1781017392143-1781335379035-1781338862033`) when re-drafted, so a
    // single strip leaves residual epochs and dedup under-collapses (917 spurious
    // classes). Strip ISO timestamps, epoch-ms, and `-v2` version suffixes
    // repeatedly until none remain.
    const gapClassOf = (id: string): string => {
      let gc = id;
      // Collapse autogen markers first: `auto-<epoch>-<rand>` carries the epoch
      // MID-id (not as a trailing segment), so the tail-strip below would miss
      // it and every autogen draft would be its own class. Map them all to `auto`.
      gc = gc.replace(/auto-\d{10,}(-[a-z0-9]+)*/gi, 'auto');
      let prev = '';
      while (gc !== prev && gc.length > 0) {
        prev = gc;
        gc = gc.replace(/-\d{4}-\d{2}-\d{2}T[\d:.\-]+Z?$/i, ''); // ISO timestamp tail
        gc = gc.replace(/-\d{10,}$/, '');                        // epoch-ms tail
        gc = gc.replace(/-v\d+$/i, '');                          // version tail (-v2)
        gc = gc.replace(/[-_]exec_[a-z0-9]+$/i, '');             // execution-marker tail (exec_<rand>)
      }
      return gc;
    };

    // A gap_class is "named" iff there's a non-trivial semantic body after the
    // prefix. Empty (`gap-closing:`) or all-punctuation bodies are malformed
    // autogen drafts with no real gap name — not worth exercising.
    const hasName = (gapClass: string): boolean => {
      const body = gapClass
        .replace(/^gap-closing:/, '')
        .replace(/^proposed_pattern_authored_/, '');
      return /[a-z]{2,}/i.test(body);
    };

    // Fetch all proposed, non-retired, non-deprecated templates (root path).
    // `meta::id(id) AS tid` yields the id as a plain string — the JS SurrealDB
    // client otherwise deserializes `id` as a RecordId object, which would make
    // every row fail the string-typed normalizer.
    const rows = (await surrealDB.query<any>(
      `SELECT meta::id(id) AS tid, name, tasks, input_shapes, output_shapes, metrics
         FROM activity
        WHERE proposed = true
          AND (retired = false OR retired IS NONE)
          AND (deprecated = false OR deprecated IS NONE)`,
    )) || [];
    const proposed: any[] = Array.isArray(rows) ? rows : [];

    // Representative per gap_class, keeping the most-promotable draft.
    const FAILED_OUT_MIN_SAMPLES = 5;
    const PROMOTE_SUCCESS_RATE = 0.6;
    const seenClasses = new Set<string>();
    const byClass = new Map<string, { id: string; gap_class: string; resolvers: string[]; executions: number; successes: number; failures: number }>();
    let backlogTotal = 0;

    for (const row of proposed) {
      try {
        // Prefer the string `tid` (meta::id); fall back to `id` for safety.
        const norm = normalizeId(typeof row?.tid === 'string' ? row.tid : row?.id);
        if (!norm) continue;
        if (!(norm.startsWith('gap-closing:') || norm.startsWith('proposed_pattern_authored_'))) {
          continue;
        }

        // Exclude lifecycle-event meta-drafts: gap-closing activities authored
        // ABOUT the lifecycle (promote/unload/deprecate) of OTHER activities.
        // These are recursion artifacts from lifecycle events being mis-detected
        // as capability gaps, not real gaps — exercising them burns cycles and
        // never yields a usable capability. (A prune of these proposals is a
        // separate hygiene step.)
        const classBody = norm
          .replace(/^gap-closing:/, '')
          .replace(/^proposed_pattern_authored_/, '');
        if (classBody.startsWith('activity-lifecycle-')) {
          continue;
        }

        const gap_class = gapClassOf(norm);
        if (!hasName(gap_class)) {
          continue; // malformed/unnamed autogen draft — no real gap to close
        }

        backlogTotal++;

        // Thompson posterior split: successes = alpha-1, failures = beta-1.
        const m = row?.metrics ?? {};
        const alpha = typeof m.thompson_alpha === 'number' ? m.thompson_alpha : 1;
        const beta = typeof m.thompson_beta === 'number' ? m.thompson_beta : 1;
        const successes = Math.max(0, alpha - 1);
        const failures = Math.max(0, beta - 1);
        const empiricalSamples = successes + failures;
        const executions = (typeof m.total_executions === 'number' && Number.isFinite(m.total_executions))
          ? Math.max(m.total_executions, empiricalSamples)
          : empiricalSamples;
        const successRate = empiricalSamples > 0 ? successes / empiricalSamples : null;
        // A draft exercised enough times that still fails the promotion bar has
        // had its chance — exclude it so it can't dominate its class forever (the
        // confident-broken-cell trap). A sibling draft of the class can still run.
        const failedOut = empiricalSamples >= FAILED_OUT_MIN_SAMPLES
          && successRate !== null && successRate < PROMOTE_SUCCESS_RATE;

        seenClasses.add(gap_class);
        if (failedOut) continue;

        const resolvers: string[] = Array.isArray(row?.tasks)
          ? row.tasks
              .map((t: any) => (t && typeof t.resolver === 'string' ? t.resolver : null))
              .filter((r: string | null): r is string => r !== null)
          : [];

        const cand = { id: norm, gap_class, resolvers, executions, successes, failures };
        const existing = byClass.get(gap_class);
        // Best rep = most proven (successes), then closest to threshold
        // (executions), then fewest failures.
        if (!existing
            || cand.successes > existing.successes
            || (cand.successes === existing.successes && cand.executions > existing.executions)
            || (cand.successes === existing.successes && cand.executions === existing.executions && cand.failures < existing.failures)) {
          byClass.set(gap_class, cand);
        }
      } catch {
        // Skip rows we can't parse — never throw on malformed data.
        continue;
      }
    }

    const distinctClasses = byClass.size;
    // Classes seen but with every draft failed-out — surfaced so the caller can
    // observe "drafts exist but none are promotable" (a re-draft signal).
    const failedOutClasses = Array.from(seenClasses).filter((gc) => !byClass.has(gc)).length;

    // Order: most-proven & closest-to-threshold first (one more run promotes it),
    // then fewer failures, then stable by gap_class. A fresh all-zero backlog
    // falls through to gap_class order — every class gets a first shot.
    const representatives = Array.from(byClass.values()).sort((a, b) => {
      if (b.successes !== a.successes) return b.successes - a.successes;
      if (b.executions !== a.executions) return b.executions - a.executions;
      if (a.failures !== b.failures) return a.failures - b.failures;
      return a.gap_class < b.gap_class ? -1 : a.gap_class > b.gap_class ? 1 : 0;
    });

    const templates = representatives.slice(0, limit).map((r) => ({
      id: r.id, gap_class: r.gap_class, resolvers: r.resolvers, executions: r.executions,
    }));

    return c.json({
      templates,
      total: templates.length,
      backlog_total: backlogTotal,
      distinct_classes: distinctClasses,
      failed_out_classes: failedOutClasses,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/templates/proposed-for-exercise failed', {
      error: error?.message,
      stack: error?.stack,
    });
    return c.json({
      error: 'Failed to fetch proposed templates for exercise',
      message: error?.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/templates/:variantId
 * Get specific template variant by ID
 */
app.get('/templates/:variantId', async (c) => {
  try {
    const variantId = c.req.param('variantId');

    logger.info('GET /v2/activities/templates/:variantId', { variantId });

    // Check Redis cache first
    const redis = RedisClient.getInstance();
    const cachedData = await redis.get(`${CACHE_KEY_PREFIX}${variantId}`);

    if (cachedData) {
      logger.debug('Template cache hit', { variantId });
      let template = JSON.parse(cachedData) as ActivityTemplate;
      // Ensure output_shapes for backward compatibility (cached templates may not have it)
      if (!template.output_shapes || template.output_shapes.length === 0) {
        const [ensured] = ensureOutputShapes([template]);
        template = ensured;
      }
      return c.json(template);
    }

    // Cache miss - fetch from SurrealDB
    logger.debug('Template cache miss, fetching from SurrealDB', { variantId });

    let result: ActivityTemplate[] = [];

    // Query from activity table (the canonical table for templates)
    // Try multiple ID formats to handle SurrealDB's auto-wrapping of string IDs in angle brackets
    // 1. Simple name (e.g., "report-metrics")
    // 2. Angle-bracket wrapped (e.g., "⟨report-metrics⟩") - SurrealDB auto-format
    // 3. Full record ID (e.g., "activity:report-metrics")
    const normalizedId = variantId.includes('⟨') || variantId.includes('⟩')
      ? variantId
      : `⟨${variantId}⟩`;

    const variantQuery = `
      SELECT * FROM activity
      WHERE (meta::id(id) = $variant_id OR meta::id(id) = $normalized_id)
        AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
      LIMIT 1
    `;
    result = await surrealDB.query<ActivityTemplate>(variantQuery, {
      variant_id: variantId,
      normalized_id: normalizedId,
    });

    // If not found, try treating variant_id as a full record ID (for activity:xyz format)
    if (result.length === 0 && variantId.includes(':')) {
      try {
        const recordQuery = `
          SELECT * FROM activity
          WHERE id = type::record($variant_id)
            AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
        `;
        result = await surrealDB.query<ActivityTemplate>(recordQuery, { variant_id: variantId });
      } catch (recordError) {
        logger.debug('Record ID query failed, template not found', { variantId });
      }
    }

    if (result.length === 0) {
      return c.json({
        error: 'Template not found',
        variant_id: variantId,
      }, 404);
    }

    const template = result[0];

    // Enrich with metrics before caching
    const enrichedTemplates = await enrichTemplatesWithMetrics([template]);
    const enrichedTemplate = enrichedTemplates[0] || template;

    // Cache the enriched result
    await redis.set(
      `${CACHE_KEY_PREFIX}${variantId}`,
      JSON.stringify(enrichedTemplate),
      TEMPLATE_CACHE_TTL
    );

    logger.info('Template fetched from SurrealDB', { variantId, hasMetrics: !!enrichedTemplate.metrics });

    return c.json(enrichedTemplate);

  } catch (error: any) {
    logger.error('GET /v2/activities/templates/:variantId failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch template',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/executions
 * Record activity execution and update Thompson Sampling metrics
 * 
 * This endpoint closes the learning loop by:
 * 1. Recording execution result in activity_execution_traces table
 * 2. Updating variant_performance_metrics with Thompson Sampling parameters
 * 3. Invalidating Redis cache for updated template
 */
app.post('/executions', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    // org_id is a string field (not a record), project_id is record<projects>
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const rawProjectId = jwtAuth?.projectId || session?.project_id || null;
    // Phase B1: account_id flows from JWT auth only.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Only project_id needs record format (record<projects>)
    const projectId = rawProjectId
      ? (rawProjectId.startsWith('projects:') ? rawProjectId : `projects:${rawProjectId}`)
      : null;

    // Parse and validate request body
    const body = await c.req.json();
    const validated = ExecutionRecordSchema.parse(body);

    // Normalize to canonical field name: activity_id (accept legacy variant_id)
    const activityIdFromRequest = validated.activity_id || validated.variant_id!;

    logger.info('POST /v2/activities/executions', {
      activity_id: activityIdFromRequest,
      success: validated.success,
      duration_ms: validated.duration_ms,
      cost: validated.cost,
      orgId,
      projectId,
    });

    // Generate execution ID
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

    // Look up template to verify it exists (using canonical 'activity' table)
    // The activityIdFromRequest is already the canonical ID
    const templateLookup = await surrealDB.query<{ id: string }>(
      'SELECT id FROM activity WHERE id = $activity_id LIMIT 1',
      { activity_id: activityIdFromRequest }
    );
    const activityId = templateLookup[0]?.id || activityIdFromRequest;

    // Auto-create missing base template if it doesn't exist (v1.4.5)
    // This handles cases where MiniBob executes embedded templates without registering them first
    if (!templateLookup[0]) {
      logger.info('[template] Auto-creating missing base template from execution', {
        activity_id: activityIdFromRequest,
        org_id: orgId
      });

      try {
        // Create minimal template with auto-created tag
        // Phase B1: dual-write account_id alongside org_id.
        await surrealDB.query(`
          INSERT INTO activity {
            id: $id,
            name: $name,
            description: "Auto-created from execution trace",
            tags: ["infrastructure.auto-created"],
            tag_prefixes: ["infrastructure"],
            execution_type: "template",
            scope: "org",
            org_id: $org_id,
            account_id: $account_id,
            account_id_version: 1,
            created_at: time::now(),
            updated_at: time::now()
          }
        `, {
          id: activityIdFromRequest,
          name: activityIdFromRequest.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''),
          org_id: orgId,
          // Phase B1: omit when null — SurrealDB 3.x option<string> rejects JSON null.
          ...(accountId != null ? { account_id: accountId } : {}),
        });

        logger.info('[template] Successfully auto-created base template', {
          activity_id: activityIdFromRequest
        });
      } catch (templateError) {
        logger.warn('[template] Failed to auto-create template (non-blocking)', {
          activity_id: activityIdFromRequest,
          error: templateError instanceof Error ? templateError.message : String(templateError)
        });
      }
    }

    // Emit execution_started event via WebSocket
    // Phase G1 (2026-04-28): tenancy fields surfaced for downstream filtering.
    const executionStartedData: any = {
      execution_id: executionId,
      activity_id: activityIdFromRequest,
      // Legacy field for backward compatibility
      variant_id: activityIdFromRequest,
      org_id: orgId ?? null,
      account_id: accountId ?? null,
    };
    // Add pod_name if available (MiniBob execution context)
    if ((validated as any).pod_name) {
      executionStartedData.pod_name = (validated as any).pod_name;
    }
    broadcaster.emit({
      type: 'execution_started',
      timestamp: new Date().toISOString(),
      data: executionStartedData,
    });

    // Build execution record, only include fields with values (SurrealDB doesn't accept null)
    const executionRecord: Record<string, any> = {
      execution_id: executionId,
      activity_id: activityId,
      // Legacy field for backward compatibility with activity_execution_traces table
      variant_id: activityIdFromRequest,
      success: validated.success,
      status: validated.success ? 'success' : 'failure',
      duration_ms: validated.duration_ms,
      cost_usd: validated.cost,
      tokens_input: validated.tokens.input,
      tokens_output: validated.tokens.output,
      tokens_cache: validated.tokens.cache,
    };

    // Only add optional fields if they have values
    if (orgId) {
      executionRecord.org_id = orgId;
    }
    if (projectId) {
      executionRecord.project_id = projectId;
    }
    // Phase B1: dual-write account_id (option<string> per deployed schema —
    // SurrealDB 3.x rejects JSON `null` against `none | string`; same I2.4
    // pattern fixed in execution-traces.ts on 2026-04-29). Only emit the
    // field when caller has a non-null accountId; otherwise the SCHEMAFULL
    // table defaults the field to NONE. account_id_version is paired with
    // account_id (only meaningful when the field is written), so guard the
    // same way.
    if (accountId) {
      executionRecord.account_id = accountId;
      executionRecord.account_id_version = 1;
    }
    if (validated.error_message) {
      executionRecord.error_message = validated.error_message;
    }
    if (validated.error_type) {
      executionRecord.error_type = validated.error_type;
    }
    if (validated.failed_task_id) {
      executionRecord.failed_task_id = validated.failed_task_id;
    }
    if (validated.impulses_used && validated.impulses_used.length > 0) {
      executionRecord.impulses_used = validated.impulses_used;
    }
    if (validated.component_changes && validated.component_changes.length > 0) {
      executionRecord.component_changes = validated.component_changes;
    }

    // Edge learning fields (from improvisation traces)
    if (validated.improvisation) {
      executionRecord.improvisation = validated.improvisation;
    }
    if (validated.input_impulse_shapes && validated.input_impulse_shapes.length > 0) {
      executionRecord.input_impulse_shapes = validated.input_impulse_shapes;
    }
    if (validated.output_impulse_shapes && validated.output_impulse_shapes.length > 0) {
      executionRecord.output_impulse_shapes = validated.output_impulse_shapes;
    }
    if (validated.output_impulses && validated.output_impulses.length > 0) {
      executionRecord.output_impulses = validated.output_impulses;
    }
    if (validated.metadata) {
      executionRecord.metadata = validated.metadata;
    }
    // Propagate failure_mode from the engine into the trace row. The field
    // is already DEFINE'd on activity_execution_traces since migration 091;
    // without this assignment the schema validation accepted the payload but
    // the row wrote with failure_mode=null. Refusal reasons disappear from
    // audit-from-trace path otherwise.
    if (validated.failure_mode) {
      executionRecord.failure_mode = validated.failure_mode;
    }

    // Build dynamic query with only provided fields
    // org_id is string, project_id needs type::record() casting for SurrealDB
    const execFields = Object.keys(executionRecord).map(k => {
      if (k === 'project_id') {
        return `${k}: type::record($${k})`;
      }
      return `${k}: $${k}`;
    }).join(',\n        ');
    const insertExecutionQuery = `
      INSERT INTO activity_execution_traces {
        ${execFields},
        executed_at: time::now(),
        created_at: time::now()
      }
    `;

    // WRITE-FLIP/decommission: AET is the DUAL_WRITE shadow — only write it
    // while the shadow is enabled.
    if (isDualWriteEnabled()) {
      await surrealDB.query(insertExecutionQuery, executionRecord);
      logger.debug('Execution recorded in activity_execution_traces (shadow)', { executionId });
    }

    // trace_store_counters bookkeeping (migration 156) — fire-and-forget,
    // never blocks the trace insert's critical path.
    void incrementTraceStoreCounter();

    // WRITE-FLIP: `execution` is ALWAYS written (authoritative store).
    {
      try {
        const paradigmExecution: Partial<ParadigmExecution> = {
        id: executionId,
        activity_id: activityIdFromRequest,
        input_impulses: validated.impulses_used || [],
        // Use output_impulses from improvisation traces if available
        output_impulses: validated.output_impulses?.map((imp: any) => imp.shape) || [],
        success: validated.success,
        error: validated.error_message ? {
          message: validated.error_message,
          type: validated.error_type,
          task_id: validated.failed_task_id,
        } : undefined,
        duration_ms: validated.duration_ms,
        cost_usd: validated.cost,
        tokens_in: validated.tokens.input,
        tokens_out: validated.tokens.output,
        org_id: orgId || undefined,
        // Phase B1: dual-write account_id alongside org_id.
        account_id: accountId ?? undefined,
        account_id_version: 1,
        project_id: projectId || undefined,
        // Edge learning fields
        ...(validated.improvisation && { improvisation: validated.improvisation }),
        ...(validated.input_impulse_shapes && { input_impulse_shapes: validated.input_impulse_shapes }),
        ...(validated.output_impulse_shapes && { output_impulse_shapes: validated.output_impulse_shapes }),
        ...(validated.metadata && { metadata: validated.metadata }),
      } as any;

      const paradigmResult = await insertExecution(paradigmExecution, jwtAuth?.jwtToken);
      if (paradigmResult) {
        logger.info('[paradigm] Execution also written to execution table', {
          id: executionId,
          activity_id: activityIdFromRequest,
          path: 'dual-write',
        });
      }
      } catch (paradigmError) {
        // Don't fail the request if paradigm write fails - legacy write succeeded
        logger.warn('[paradigm] Dual-write to execution table failed (non-blocking)', {
          execution_id: executionId,
          error: paradigmError instanceof Error ? paradigmError.message : String(paradigmError),
        });
      }
    } // end isDualWriteEnabled()

    // Step 1b: Update shape-based Thompson Sampling scores
    // If input_impulse_shapes are provided, update impulse_shape_activity_score table
    // This enables shape-conditioned activity selection
    // Phase B-followup: thread accountId so dual-write fires.
    if (validated.input_impulse_shapes && validated.input_impulse_shapes.length > 0 && orgId) {
      // Non-blocking: don't await, just fire and forget
      updateShapeScoresFromExecution(
        activityIdFromRequest,
        validated.input_impulse_shapes,
        validated.success,
        orgId,
        jwtAuth?.jwtToken,
        jwtAuth?.accountId ?? null
      ).catch((error) => {
        logger.warn('Shape score update failed (non-blocking)', {
          activity_id: activityIdFromRequest,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Step 2: Update Thompson Sampling metrics in variant_performance_metrics
    // Thompson Sampling uses Beta distribution: Beta(alpha, beta)
    // - alpha: number of successes + 1
    // - beta: number of failures + 1
    //
    // ATOMIC UPDATE: Uses SurrealDB += operator for race-condition-free concurrent updates
    // Previous implementation had read-modify-write race condition

    const success_delta = validated.success ? 1 : 0;
    const failure_delta = validated.success ? 0 : 1;
    
    // UPSERT PATTERN: Phase E — keyed on (variant_id, account_id) via a
    // deterministic record-id slug (`<variant>__<acct>` when account_id is
    // present; legacy `<variant>` slug when null). This lets two callers in
    // the same org but different accounts maintain separate α/β posteriors.
    //
    // Pre-Phase-E rows live at the legacy `<variant>` key — they remain
    // readable via the org_id branch of `accountIdScopedWhere()`, but new
    // account-bearing executions land in their own row from this point on.
    //
    // Mechanism: INSERT INTO names the record `id` explicitly so the duplicate
    // detection that drives ON DUPLICATE KEY UPDATE happens on the id (which
    // is now account-keyed). The pre-existing UNIQUE(variant_id) index is
    // intentionally not modified in this phase; the legacy `<variant>` slug
    // continues to satisfy it for the no-accountId path, and the new
    // `<variant>__<acct>` slug carries a different variant_id-equal value
    // for the index check (it does not — the variant_id stays as the plain
    // normalized id). The UNIQUE(variant_id) index would, in principle,
    // reject the second account's row; in practice the migration to drop
    // that index is staged for a follow-up phase. For now, on environments
    // where the unique index is enforced the second-account write may still
    // collapse onto the legacy row. This is the documented canary drift.
    //
    // Normalize variant_id to plain form (strip `activity:` prefix and `⟨...⟩`
    // brackets) BEFORE the upsert. Mirrors `resolveTemplateIdsForUpdate` in
    // execution-traces.ts so wrapped/plain forms collapse to the same row.
    const normalizedVariantId = normalizeActivityId(activityIdFromRequest);
    const metricsRecordIdSlug = variantMetricsRecordId(normalizedVariantId, accountId);
    // Refactored 2026-04-30: legacy rows have random-id slugs
    // (variant_performance_metrics:xkrfzfzykx66...) while
    // variantMetricsRecordId() generates deterministic slugs from
    // variant_id. ON DUPLICATE KEY UPDATE keys on PRIMARY KEY (id), so
    // it never matched legacy rows — INSERT then conflicted on the
    // composite UNIQUE INDEX (variant_id, account_id) added by
    // migration 100. Switch to JS-side branching on a composite-key
    // SELECT: UPDATE the existing row by its (potentially-random) id
    // when found, otherwise INSERT a fresh row with the deterministic
    // slug. Two driver calls, but each is a single SurrealQL statement
    // so the existing query-result shape (driver returns
    // first-statement results) is preserved.
    const accountIdParam = accountIdRecordRef(accountId);
    const findExistingQuery = `
      SELECT id FROM variant_performance_metrics
        WHERE variant_id = $variant_id
          AND (account_id IS $account_id OR (account_id IS NONE AND $account_id IS NULL))
        LIMIT 1
    `;
    const updateQuery = `
      UPDATE $id SET
        total_executions = (total_executions ?? 0) + 1,
        successful_executions = (successful_executions ?? 0) + $success_delta,
        failed_executions = (failed_executions ?? 0) + $failure_delta,
        success_rate = ((successful_executions ?? 0) + $success_delta) / ((total_executions ?? 0) + 1),
        avg_duration_ms = (((avg_duration_ms ?? 0) * (total_executions ?? 0)) + $duration_ms) / ((total_executions ?? 0) + 1),
        avg_cost_usd = (((avg_cost_usd ?? 0) * (total_executions ?? 0)) + $cost) / ((total_executions ?? 0) + 1),
        last_executed_at = time::now(),
        updated_at = time::now()
      RETURN AFTER;
    `;
    // α/β posteriors omitted from INSERT initial values and UPDATE — applyOutcomeToPosteriors
    // (below) writes them with stratified deltas. Keeping both would double-increment.
    const insertQuery = `
      INSERT INTO variant_performance_metrics {
        id: type::thing('variant_performance_metrics', $record_id_slug),
        variant_id: $variant_id,
        activity_id: $variant_id,
        org_id: $org_id,
        account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
        account_id_version: 1,
        total_executions: 1,
        successful_executions: $success_delta,
        failed_executions: $failure_delta,
        success_rate: $success_delta,
        avg_duration_ms: $duration_ms,
        avg_cost_usd: $cost,
        thompson_alpha: 1,
        thompson_beta: 1,
        total_selections: 0,
        last_executed_at: time::now(),
        created_at: time::now(),
        updated_at: time::now()
      } RETURN AFTER;
    `;

    // db/surreal.ts wraps surrealDB.query so it already returns the
    // first-statement result array (mirrors queryWithAuth). Each of
    // these helper SQLs is single-statement, so the returned value
    // is already the rows array — no further [0] unwrap.
    const findRows = await surrealDB.query<{ id: string }>(findExistingQuery, {
      variant_id: normalizedVariantId,
      account_id: accountIdParam,
    });
    const existingId = Array.isArray(findRows) && findRows.length > 0
      ? (findRows[0] as { id?: string }).id
      : undefined;

    let metricsResult: any[];
    if (existingId) {
      metricsResult = (await surrealDB.query<any>(updateQuery, {
        id: existingId,
        success_delta,
        failure_delta,
        duration_ms: validated.duration_ms,
        cost: validated.cost,
      })) as any[];
    } else {
      metricsResult = (await surrealDB.query<any>(insertQuery, {
        record_id_slug: metricsRecordIdSlug,
        variant_id: normalizedVariantId,
        org_id: orgId,
        account_id: accountIdParam,
        success_delta,
        failure_delta,
        duration_ms: validated.duration_ms,
        cost: validated.cost,
      })) as any[];
    }

    if (metricsResult.length === 0) {
      logger.error('Thompson Sampling UPSERT failed - no record returned', {
        activity_id: activityIdFromRequest,
        org_id: orgId,
        variant_id: activityIdFromRequest,
      });
    } else {
      const updatedRecord = metricsResult[0];
      const isNewRecord = updatedRecord.total_executions === 1;
      logger.info('Thompson Sampling metrics upserted', {
        activity_id: activityIdFromRequest,
        operation: isNewRecord ? 'INSERT (new record)' : 'UPDATE (existing record)',
        total_executions: updatedRecord.total_executions,
        thompson_alpha: updatedRecord.thompson_alpha,
        thompson_beta: updatedRecord.thompson_beta,
        thompson_score: updatedRecord.thompson_alpha / (updatedRecord.thompson_alpha + updatedRecord.thompson_beta),
      });
    }

    applyOutcomeToPosteriors(
      {
        activity_id: activityIdFromRequest,
        success: validated.success,
        failure_mode: null,
        cost_usd: validated.cost,
        // Honest-reach floor: goal-host does not (yet) emit a reach verdict on this
        // body, so an exit-status completion is UNGRADED, not credit. Synthetic
        // goal-host tag => classifyReach => 'ungraded' => SKIP (learn nothing, never
        // mis-credit). Remove once goal-host emits reach tags on this path.
        tags: ['dispatcher_used:goal-host'],
      },
      surrealDB,
      orgId!,
    ).catch((err) => {
      logger.warn('applyOutcomeToPosteriors failed (non-blocking, /executions)', {
        activity_id: activityIdFromRequest,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Step 3: Invalidate the individual template cache so the next list request
    // picks up updated metrics. Do NOT remove from CACHE_LIST_KEY — the list set
    // tracks template existence, not execution state. Removing on every trace
    // store would cause the set to shrink as templates execute, hiding them from
    // coverage_tick and other consumers that rely on the list for shape discovery.
    const redis = RedisClient.getInstance();
    await redis.del(`${CACHE_KEY_PREFIX}${activityIdFromRequest}`);

    logger.debug('Redis cache invalidated for template', {
      activity_id: activityIdFromRequest,
    });

    // Extract updated metrics from result
    const updatedMetrics = metricsResult.length > 0 ? metricsResult[0] : undefined;

    // Emit execution_completed event via WebSocket
    // Phase G1 (2026-04-28): tenancy fields surfaced for downstream filtering.
    broadcaster.emit({
      type: 'execution_completed',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: executionId,
        activity_id: activityIdFromRequest,
        // Legacy field for backward compatibility
        variant_id: activityIdFromRequest,
        success: validated.success,
        duration_ms: validated.duration_ms,
        cost: validated.cost,
        completed_at: new Date().toISOString(),
        org_id: orgId ?? null,
        account_id: accountId ?? null,
      },
    });

    // Emit template_metrics_updated event via WebSocket
    if (updatedMetrics) {
      broadcaster.emit({
        type: 'template_updated',
        timestamp: new Date().toISOString(),
        data: {
          activity_id: activityIdFromRequest,
          // Legacy field for backward compatibility
          variant_id: activityIdFromRequest,
          metrics: {
            success_rate: updatedMetrics.success_rate || 0,
            avg_duration_ms: updatedMetrics.avg_duration_ms || 0,
            avg_cost_usd: updatedMetrics.avg_cost_usd || 0,
            thompson_alpha: updatedMetrics.thompson_alpha || 1,
            thompson_beta: updatedMetrics.thompson_beta || 1,
          },
          org_id: orgId ?? null,
          account_id: accountId ?? null,
        },
      });
    }

    // Step 4: Auto-create variant if needed (after consecutive failures)
    // Non-blocking: don't await, fire and forget.
    // Phase B4a: thread accountId through (already in scope at this site).
    if (orgId) {
      autoCreateVariantIfNeeded(activityIdFromRequest, orgId, validated.success, accountId)
        .then((variantResult) => {
          if (variantResult) {
            logger.info('Auto-created variant from consecutive failures', {
              parentTemplateId: activityIdFromRequest,
              variantId: variantResult.variantId,
              variantGeneration: variantResult.variantGeneration,
              modifications: variantResult.modifications.length,
            });

            // Emit variant_created event via WebSocket
            // Phase G1 (2026-04-28): tenancy fields surfaced for filtering.
            broadcaster.emit({
              type: 'variant_created',
              timestamp: new Date().toISOString(),
              data: {
                parent_activity_id: activityIdFromRequest,
                variant_id: variantResult.variantId,
                variant_generation: variantResult.variantGeneration,
                reason: variantResult.reason,
                modifications: variantResult.modifications,
                org_id: orgId ?? null,
                account_id: accountId ?? null,
              },
            });
          }
        })
        .catch((error) => {
          logger.warn('Auto-variant creation failed (non-blocking)', {
            activity_id: activityIdFromRequest,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      // Step 5: Check and retire template if needed (after enough executions)
      // Non-blocking: don't await, fire and forget.
      // Phase B4a: thread accountId for dual-tenant scoping on the read.
      checkAndRetireTemplate(activityIdFromRequest, orgId, accountId)
        .then((wasRetired) => {
          if (wasRetired) {
            logger.info('Template retired due to poor performance', {
              activity_id: activityIdFromRequest,
            });

            // Emit template_retired event via WebSocket
            // Phase G1 (2026-04-28): tenancy fields surfaced for filtering.
            broadcaster.emit({
              type: 'template_retired',
              timestamp: new Date().toISOString(),
              data: {
                activity_id: activityIdFromRequest,
                reason: 'poor_performance',
                org_id: orgId ?? null,
                account_id: accountId ?? null,
              },
            });

            // Invalidate cache for retired template
            redis.del(`${CACHE_KEY_PREFIX}${activityIdFromRequest}`);
            redis.srem(CACHE_LIST_KEY, activityIdFromRequest);
          }
        })
        .catch((error) => {
          logger.warn('Template retirement check failed (non-blocking)', {
            activity_id: activityIdFromRequest,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    // Return response with updated metrics
    const response: ExecutionRecordResponse = {
      success: true,
      execution_id: executionId,
      metrics: updatedMetrics,
    };

    return c.json(response, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/executions failed', {
      error: error.message,
      stack: error.stack,
    });

    // Check if it's a validation error
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record execution',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/executions
 * 
 * List execution history with filtering.
 * 
 * Query Parameters:
 * - variant_id: Filter by variant ID (optional)
 * - success: Filter by success status (true/false, optional)
 * - limit: Maximum number of results (1-100, default 50)
 * - offset: Pagination offset (default 0)
 * 
 * Returns:
 * - executions: Array of execution records
 * - total: Number of results returned
 * - limit: Applied limit
 * - offset: Applied offset
 * 
 * Data Flow: Dashboard → GET /executions → SurrealDB query → execution history
 */
app.get('/executions', async (c) => {
  try {
    // Extract session from context for multi-tenant filtering
    const session = (c.get as any)('session') as SessionData | undefined;
    // Phase B1: account_id from JWT auth context if present.
    const jwtAuth = getJwtAuthFromContext(c);
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;
    const projectId = jwtAuth?.projectId || session?.project_id || null;

    // Parse query parameters
    const variantId = c.req.query('variant_id') || null;
    const successParam = c.req.query('success');
    const limitStr = c.req.query('limit') || '50';
    const offsetStr = c.req.query('offset') || '0';
    
    const limit = Math.min(Math.max(parseInt(limitStr, 10), 1), 100);
    const offset = Math.max(parseInt(offsetStr, 10), 0);
    
    logger.info('GET /v2/activities/executions', {
      variant_id: variantId,
      success: successParam,
      limit,
      offset,
      orgId,
      projectId,
    });

    // Build query with filters
    // TEMPORARY: Query execution table directly (view not yet applied)
    // OOM-safe two-step (migration-162): the full projection carries the fat
    // `trace` blob, so ORDER BY executed_at over it makes SurrealDB's
    // MemoryOrderedLimit collect every matched blob row into RAM before LIMIT.
    // `query` now selects ONLY the narrow (id, executed_at) ordering keys under
    // the page window (filters + ORDER + LIMIT/START are appended below); the fat
    // rows are hydrated for the chosen ids afterwards.
    const hydrateProjection = `
      SELECT
        id AS execution_id,
        activity_id,
        activity_id AS variant_id,
        activity_id AS template_id,
        success,
        IF success = true { 'success' } ELSE { 'failure' } AS status,
        duration_ms,
        cost_usd,
        tokens_in AS tokens_input,
        tokens_out AS tokens_output,
        tokens_in + tokens_out AS tokens_total,
        error.message AS error_message,
        error.type AS error_type,
        error.task_id AS failed_task_id,
        input_impulses AS impulses_used,
        output_impulses AS impulses_created,
        trace AS execution_trace,
        trace.state_transition.after AS component_changes,
        parent_execution_id,
        composition_chain,
        org_id,
        project_id,
        vessel_id,
        executed_at,
        created_at,
        created_at AS stored_at,
        created_at AS updated_at
      FROM execution`;
    let query = `
      SELECT id, executed_at
      FROM execution WHERE 1=1
    `.trim();
    const params: Record<string, any> = {};
    
    // Multi-tenant filtering (same as templates)
    // Phase B1: prefer account_id; legacy rows match via org_id fallback.
    if (orgId) {
      query += ` AND (org_id = NONE OR ${accountIdScopedWhere()})`;
      params.org_id = orgId;
      params.account_id = accountId;
    }
    if (projectId) {
      query += ' AND (project_id = $project_id OR project_id = NONE OR org_id = $org_id)';
      params.project_id = projectId;
    }
    
    // Filter by variant_id
    if (variantId) {
      query += ' AND variant_id = $variant_id';
      params.variant_id = variantId;
    }
    
    // Filter by success status
    if (successParam !== undefined) {
      query += ' AND success = $success';
      params.success = successParam === 'true';
    }
    
    // Order by most recent first
    query += ' ORDER BY executed_at DESC';
    
    // Pagination
    query += ' LIMIT $limit START $offset';
    params.limit = limit;
    params.offset = offset;
    
    logger.debug('Execution history query', { query, params });
    
    // Step 1: sort only the narrow id keys under the page window.
    const idResult = await surrealDB.query<any>(query, params);
    // Note: surrealDB.query() already extracts result[0], so result is the array directly
    const idRows = Array.isArray(idResult) ? idResult : [];
    const pageIds = idRows.map((r: any) => r.id).filter((x: any) => x != null);

    // Step 2: hydrate the full projection for the chosen ids only, preserving order.
    let executions: any[] = [];
    if (pageIds.length > 0) {
      const hydrateQuery = `${hydrateProjection}
        WHERE id IN $page_ids
        ORDER BY executed_at DESC
      `.trim();
      const result = await surrealDB.query(hydrateQuery, { ...params, page_ids: pageIds });
      executions = Array.isArray(result) ? result : [];
    }
    
    logger.debug('Execution history results', { count: executions.length });

    return c.json({
      executions,
      total: executions.length,
      limit,
      offset,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/executions failed', { 
      error: error.message,
      stack: error.stack,
    });
    
    return c.json({
      error: 'Failed to fetch execution history',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/execution-traces
 * 
 * Store execution trace for reuse as impulse in debugging-as-activity workflow.
 * 
 * Architecture (Unified Impulse-Driven):
 * - MiniBob executes activity with state capture enabled
 * - After completion (success OR failure), MiniBob calls this endpoint
 * - Trace stored in execution_traces table with full context
 * - Later: impulse created pointing to this trace → goal-seeking debug → fixed template
 * 
 * The unified flow:
 * 1. Activity execution → trace captured
 * 2. POST /execution-traces → trace stored
 * 3. Create impulse: { type: "activityExecutionTrace", executionId: "..." }
 * 4. Goal-seeking with impulse → generates debug activity
 * 5. Debug activity → uses trace to understand failure → proposes fix
 * 6. If debug succeeds → ribosome → new fixed template
 * 
 * Request body:
 * {
 *   execution_id: string,
 *   template_id: string,
 *   status: "success" | "failure" | "partial",
 *   duration_ms: number,
 *   cost_usd: number,
 *   execution_trace: {
 *     tasks: ExecutedTask[],
 *     impulsesCreated: string[],
 *     filesModified: string[],
 *     goalContext?: { goal, intent, context }
 *   }
 * }
 * 
 * Returns:
 * {
 *   success: boolean,
 *   execution_id: string,
 *   message?: string
 * }

/**
 * GET /v2/activities/metrics/trend
 *
 * Returns daily execution metrics for charting quality trends.
 *
 * Query Parameters:
 * - days: Number of days to return (default: 30, max: 90)
 *
 * Returns:
 * {
 *   trend: [
 *     { date: "2026-03-25", success_count: 45, failure_count: 5, total_cost: 12.50 },
 *     ...
 *   ]
 * }
 */
app.get('/metrics/trend', async (c) => {
  try {
    // Parse query parameters
    const daysParam = c.req.query('days') || '30';
    const days = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 90);

    logger.info('GET /v2/activities/metrics/trend', { days });

    // Query execution metrics grouped by day
    const query = `
      SELECT
        time::format(created_at, '%Y-%m-%d') AS date,
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS success_count,
        count(IF success = false THEN 1 ELSE NONE END) AS failure_count,
        math::sum(cost_usd) AS total_cost
      FROM v_paradigm_execution_traces
      WHERE created_at > time::now() - duration::from::days($days)
      GROUP BY time::format(created_at, '%Y-%m-%d')
      ORDER BY date ASC
    `;

    const result = await surrealDB.query(query, { days });
    const trends = Array.isArray(result) ? result : [];

    // Transform to response format
    const trendData = trends.map((row: any) => ({
      date: row.date,
      success_count: row.success_count || 0,
      failure_count: row.failure_count || 0,
      total_executions: row.total_executions || 0,
      total_cost: parseFloat(row.total_cost || 0).toFixed(2),
    }));

    logger.info('Metrics trend retrieved', { days, dataPoints: trendData.length });

    return c.json({
      trend: trendData,
      days,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics/trend failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch metrics trend',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/metrics/summary
 *
 * Returns summary metrics for the dashboard.
 *
 * Returns:
 * {
 *   total_templates: number,
 *   total_executions: number,
 *   executions_today: number,
 *   average_success_rate: number,
 *   average_duration_ms: number,
 *   total_cost_usd: number,
 * }
 */
app.get('/metrics/summary', async (c) => {
  try {
    logger.info('GET /v2/activities/metrics/summary');

    // Query aggregate metrics
    const templateCountResult = await surrealDB.query('SELECT count() AS count FROM activity GROUP ALL');
    const totalTemplates = (templateCountResult[0] as any)?.count || 0;

    const executionStatsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF created_at > time::now() - 1d THEN 1 ELSE NONE END) AS executions_today,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
        math::mean(duration_ms) AS avg_duration,
        math::sum(cost_usd) AS total_cost
      FROM v_paradigm_execution_traces
      GROUP ALL
    `);

    const stats = executionStatsResult[0] as any || {};

    const summary = {
      total_templates: totalTemplates,
      total_executions: stats.total_executions || 0,
      executions_today: stats.executions_today || 0,
      average_success_rate: ((stats.success_rate || 0) * 100).toFixed(1),
      average_duration_ms: Math.round(stats.avg_duration || 0),
      total_cost_usd: (stats.total_cost || 0).toFixed(2),
    };

    logger.info('Metrics summary retrieved', summary);

    return c.json(summary);

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics/summary failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch metrics summary',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/metrics
 *
 * Returns detailed metrics for a specific activity.
 * Used by MiniBob's model selector for progressive determinism.
 *
 * Query params:
 * - activity_id: string (required) - Activity template ID to get metrics for
 *
 * Returns:
 * {
 *   activity_id: string,
 *   total_executions: number,
 *   successful_executions: number,
 *   success_rate: number,
 *   avg_duration_ms: number,
 *   avg_cost_usd: number,
 *   model_usage_distribution: Record<string, number>,
 *   deterministic_task_ratio: number,
 * }
 */
app.get('/metrics', async (c) => {
  try {
    const activityId = c.req.query('activity_id');

    if (!activityId) {
      return c.json({ error: 'Missing required parameter: activity_id' }, 400);
    }

    logger.info('GET /v2/activities/metrics', { activity_id: activityId });

    // Query execution metrics for this specific activity
    const metricsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS successful_executions,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
        math::mean(duration_ms) AS avg_duration_ms,
        math::mean(cost_usd) AS avg_cost_usd
      FROM v_paradigm_execution_traces
      WHERE activity_id = $activity_id
      GROUP ALL
    `, { activity_id: activityId });

    const stats = (metricsResult[0] as any) || {};

    // Query model usage distribution
    const modelDistResult = await surrealDB.query(`
      SELECT model, count() AS count
      FROM v_paradigm_execution_traces
      WHERE activity_id = $activity_id
      GROUP BY model
    `, { activity_id: activityId });

    const modelUsageDistribution: Record<string, number> = {};
    for (const row of (modelDistResult as any[]) || []) {
      if (row.model) {
        modelUsageDistribution[row.model] = row.count || 0;
      }
    }

    // Query deterministic task ratio (tasks that don't require LLM)
    // Note: Deterministic task tracking is not yet implemented
    // Task-level data exists in activity_execution_traces.tasks (flexible array)
    // but separate activity_execution_task_result table does not exist
    const deterministicTaskRatio = 0; // Placeholder until proper task-level metrics implemented

    const metrics = {
      activity_id: activityId,
      total_executions: stats.total_executions || 0,
      successful_executions: stats.successful_executions || 0,
      success_rate: stats.success_rate || 0,
      avg_duration_ms: Math.round(stats.avg_duration_ms || 0),
      avg_cost_usd: stats.avg_cost_usd || 0,
      model_usage_distribution: modelUsageDistribution,
      deterministic_task_ratio: deterministicTaskRatio,
    };

    logger.debug('Activity metrics retrieved', { activity_id: activityId, metrics });

    return c.json(metrics);

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity metrics',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /templates/:templateId/metrics
 *
 * Returns comprehensive metrics for a specific template including Thompson Sampling parameters.
 *
 * Path params:
 * - templateId: string (required) - Activity template ID
 *
 * Returns:
 * {
 *   template_id: string,
 *   total_executions: number,
 *   successful_executions: number,
 *   failed_executions: number,
 *   success_rate: number,
 *   avg_duration_ms: number,
 *   avg_cost_usd: number,
 *   total_cost_usd: number,
 *   thompson_alpha: number,
 *   thompson_beta: number,
 *   thompson_belief: number,
 *   last_executed_at: string | null,
 *   executions_by_day: Array<{date: string, count: number, success_count: number}>
 * }
 */
/**
 * POST /templates/:templateId/promote
 *
 * Flip a proposed template's `proposed` flag from true to false, making it
 * eligible for Thompson recommendation selection. Counterpart to writes
 * that set `proposed: true` (audit investigation-028 recommendation A —
 * capability generation safety).
 *
 * Idempotent: calling promote on an already-promoted template returns the
 * existing record. Returns 404 if the template doesn't exist.
 */
/**
 * GET /v2/activities/promote-gate/stats
 *
 * Sustained-window promote-gate evaluation aggregation for inv-030
 * §calibration. Reads the durable promote_gate_evaluations table
 * (migration 141), which mirrors every bus-emitted promote_gate.evaluated
 * event so subscribers don't need to be live during every promote attempt.
 *
 * Audit's calibration experiment: join (gate-decision, projection) against
 * subsequent variant_performance_metrics to compute the over/under
 * permissive verdict. This endpoint serves the gate-side data; the join
 * is the caller's responsibility (per template_id).
 *
 * Query params:
 *   - window_seconds (default 86400 = 24h)
 *   - org_id (optional override; default scopes to JWT)
 *
 * Response:
 *   {
 *     window_seconds, since, until,
 *     total: number,
 *     by_decision: { promote, refused },
 *     by_reason: { [reason]: count, ... },  // refused breakdown only
 *     mean_projected_mean: number,           // averaged across rows
 *     mean_k: number,                        // average neighbor count
 *     top_recent: [up to 10 most recent evaluations with full projection],
 *   }
 */
app.get('/promote-gate/stats', async (c) => {
  try {
    const url = new URL(c.req.url);
    const windowSeconds = parseInt(url.searchParams.get('window_seconds') ?? '86400', 10);
    const safeWindow = Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 86400;
    const since = new Date(Date.now() - safeWindow * 1000).toISOString();
    const until = new Date().toISOString();

    const jwtAuth = getJwtAuthFromContext(c);
    const filterOrg = url.searchParams.get('org_id') ?? jwtAuth?.orgId ?? null;

    const rows = await surrealDB.query<{
      template_id: string;
      decision: string;
      reason: string | null;
      alpha_hat: number;
      beta_hat: number;
      projected_mean: number;
      total_samples: number;
      k_neighbors: number;
      org_id: string | null;
      evaluated_at: string;
      neighbor_template_ids: string[];
    }>(
      filterOrg
        ? `SELECT template_id, decision, reason, alpha_hat, beta_hat, projected_mean,
                  total_samples, k_neighbors, org_id, evaluated_at, neighbor_template_ids
             FROM promote_gate_evaluations
             WHERE evaluated_at >= $since AND (org_id = $org_id OR org_id IS NONE)
             ORDER BY evaluated_at DESC`
        : `SELECT template_id, decision, reason, alpha_hat, beta_hat, projected_mean,
                  total_samples, k_neighbors, org_id, evaluated_at, neighbor_template_ids
             FROM promote_gate_evaluations
             WHERE evaluated_at >= $since
             ORDER BY evaluated_at DESC`,
      { since, org_id: filterOrg },
    );

    const byDecision: { promote: number; refused: number } = { promote: 0, refused: 0 };
    const byReason: Record<string, number> = {};
    let meanSum = 0;
    let kSum = 0;
    for (const r of rows ?? []) {
      if (r.decision === 'promote') byDecision.promote++;
      else byDecision.refused++;
      if (r.reason) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
      meanSum += r.projected_mean ?? 0;
      kSum += r.k_neighbors ?? 0;
    }
    const n = rows?.length ?? 0;
    const topRecent = (rows ?? []).slice(0, 10).map(r => ({
      template_id: r.template_id,
      decision: r.decision,
      reason: r.reason,
      projection: {
        alpha_hat: r.alpha_hat,
        beta_hat: r.beta_hat,
        mean: r.projected_mean,
        total_samples: r.total_samples,
        K: r.k_neighbors,
      },
      neighbor_template_ids: r.neighbor_template_ids,
      evaluated_at: r.evaluated_at,
    }));

    return c.json({
      window_seconds: safeWindow,
      since,
      until,
      filter_org_id: filterOrg,
      total: n,
      by_decision: byDecision,
      by_reason: byReason,
      mean_projected_mean: n > 0 ? Math.round((meanSum / n) * 1000) / 1000 : 0,
      mean_k: n > 0 ? Math.round((kSum / n) * 100) / 100 : 0,
      top_recent: topRecent,
    });
  } catch (err) {
    logger.error('GET /v2/activities/promote-gate/stats failed', {
      error: (err as Error).message,
    });
    return c.json({
      error: 'Failed to query promote-gate stats',
      message: (err as Error).message,
    }, 500);
  }
});

/**
 * GET /v2/activities/refusals/stats
 *
 * Sustained-window refusal aggregation for IAL §27.S.6 push-away
 * measurement. Per audit F-129 (inv-053): the bus emit is hot/ephemeral;
 * this endpoint reads the durable refusal_events table (migration 140) and
 * returns aggregate counts auditors can run post-hoc.
 *
 * Query params:
 *   - window_seconds (default 86400 = 24h) — lookback from now
 *   - org_id (optional) — filter to a single org; default scopes to JWT org
 *
 * Response:
 *   {
 *     window_seconds,
 *     since,
 *     until,
 *     total: number,
 *     by_type: { [refusal_type]: count, ... },
 *     by_shape: { [shape]: count, ... },
 *     top_recent: [up to 10 most recent refusals],
 *   }
 */
app.get('/refusals/stats', async (c) => {
  try {
    const url = new URL(c.req.url);
    const windowSeconds = parseInt(url.searchParams.get('window_seconds') ?? '86400', 10);
    const safeWindow = Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : 86400;
    const since = new Date(Date.now() - safeWindow * 1000).toISOString();
    const until = new Date().toISOString();

    const jwtAuth = getJwtAuthFromContext(c);
    const filterOrg = url.searchParams.get('org_id') ?? jwtAuth?.orgId ?? null;

    // Fetch all refusals in the window. We aggregate client-side — cheap
    // for typical refusal volumes (single-digit per hour even under load).
    const rows = await surrealDB.query<{
      refusal_type: string;
      expected_output_shapes: string[];
      candidates_examined: number;
      task_description: string | null;
      org_id: string | null;
      refused_at: string;
    }>(
      filterOrg
        ? `SELECT refusal_type, expected_output_shapes, candidates_examined, task_description,
                  org_id, refused_at
             FROM refusal_events
             WHERE refused_at >= $since AND (org_id = $org_id OR org_id IS NONE)
             ORDER BY refused_at DESC`
        : `SELECT refusal_type, expected_output_shapes, candidates_examined, task_description,
                  org_id, refused_at
             FROM refusal_events
             WHERE refused_at >= $since
             ORDER BY refused_at DESC`,
      { since, org_id: filterOrg },
    );

    const byType: Record<string, number> = {};
    const byShape: Record<string, number> = {};
    for (const r of rows ?? []) {
      byType[r.refusal_type] = (byType[r.refusal_type] ?? 0) + 1;
      for (const shape of r.expected_output_shapes ?? []) {
        byShape[shape] = (byShape[shape] ?? 0) + 1;
      }
    }

    const topRecent = (rows ?? []).slice(0, 10).map(r => ({
      refusal_type: r.refusal_type,
      expected_output_shapes: r.expected_output_shapes,
      candidates_examined: r.candidates_examined,
      task_description: r.task_description,
      org_id: r.org_id,
      refused_at: r.refused_at,
    }));

    return c.json({
      window_seconds: safeWindow,
      since,
      until,
      filter_org_id: filterOrg,
      total: rows?.length ?? 0,
      by_type: byType,
      by_shape: byShape,
      top_recent: topRecent,
    });
  } catch (err) {
    logger.error('GET /v2/activities/refusals/stats failed', {
      error: (err as Error).message,
    });
    return c.json({
      error: 'Failed to query refusal stats',
      message: (err as Error).message,
    }, 500);
  }
});

/**
 * GET /v2/activities/topology-coverage
 *
 * Returns a summary of which (pool-signature × template) pairs have been
 * observed, how many templates have been tried per signature, and what
 * percentage of the space is still unexplored. Useful for validating that
 * topology exploration is making progress.
 *
 * Queries context_thompson_scores WHERE signature_version = 1.
 * When no v1 rows exist (cold start), returns a structured cold-start message
 * rather than an error.
 *
 * Response shape:
 * {
 *   distinct_pool_signatures: number,
 *   total_v1_observations: number,
 *   avg_templates_per_signature: number,
 *   max_templates_per_signature: number,
 *   min_templates_per_signature: number,
 *   top_signatures: Array<{
 *     pool_signature: string,
 *     observation_count: number,
 *     success_rate: number,
 *     top_templates: string[]
 *   }>,
 *   dark_signature_count: number,
 *   oldest_observation: string | null,
 *   newest_observation: string | null,
 *   status?: "cold_start",
 *   message?: string
 * }
 */
app.get('/topology-coverage', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const orgId = jwtAuth?.orgId ?? null;

    // Fetch all v1 rows. We aggregate client-side — the table is bounded by
    // (org × template × signature) so even large deployments stay tractable.
    const rows = await surrealDB.query<{
      template_id: string;
      context_bucket: string;
      alpha: number;
      beta: number;
      n_observations: number;
      last_updated_at: string | null;
      created_at: string | null;
    }>(
      orgId
        ? `SELECT template_id, context_bucket, alpha, beta, n_observations,
                  last_updated_at, created_at
             FROM context_thompson_scores
             WHERE signature_version = 1 AND org_id = $org_id
             ORDER BY n_observations DESC`
        : `SELECT template_id, context_bucket, alpha, beta, n_observations,
                  last_updated_at, created_at
             FROM context_thompson_scores
             WHERE signature_version = 1
             ORDER BY n_observations DESC`,
      { org_id: orgId },
    );

    if (!rows || rows.length === 0) {
      return c.json({
        distinct_pool_signatures: 0,
        total_v1_observations: 0,
        avg_templates_per_signature: 0,
        max_templates_per_signature: 0,
        min_templates_per_signature: 0,
        top_signatures: [],
        dark_signature_count: 0,
        oldest_observation: null,
        newest_observation: null,
        status: 'cold_start',
        message:
          'No precondition-conditioned observations yet. Ensure executors send ' +
          'impulse_state_space with /recommend calls.',
      });
    }

    // Group by pool signature (context_bucket)
    const sigMap = new Map<string, {
      templates: Set<string>;
      totalObs: number;
      alphaSum: number;
      betaSum: number;
      templateObsCounts: Map<string, number>;
    }>();

    let totalObs = 0;
    let oldestTs: string | null = null;
    let newestTs: string | null = null;

    for (const row of rows) {
      const sig = row.context_bucket;
      let entry = sigMap.get(sig);
      if (!entry) {
        entry = { templates: new Set(), totalObs: 0, alphaSum: 0, betaSum: 0, templateObsCounts: new Map() };
        sigMap.set(sig, entry);
      }
      entry.templates.add(row.template_id);
      entry.totalObs += row.n_observations ?? 0;
      entry.alphaSum += row.alpha ?? 1;
      entry.betaSum += row.beta ?? 1;
      entry.templateObsCounts.set(row.template_id, (entry.templateObsCounts.get(row.template_id) ?? 0) + (row.n_observations ?? 0));
      totalObs += row.n_observations ?? 0;

      const ts = row.last_updated_at ?? row.created_at ?? null;
      if (ts) {
        if (!oldestTs || ts < oldestTs) oldestTs = ts;
        if (!newestTs || ts > newestTs) newestTs = ts;
      }
    }

    const sigCounts = Array.from(sigMap.values()).map(e => e.templates.size);
    const avgTemplates = sigCounts.length > 0
      ? sigCounts.reduce((a, b) => a + b, 0) / sigCounts.length
      : 0;
    const maxTemplates = sigCounts.length > 0 ? Math.max(...sigCounts) : 0;
    const minTemplates = sigCounts.length > 0 ? Math.min(...sigCounts) : 0;

    // A "dark" signature is one with only one template ever tried (unexplored breadth)
    const darkSignatureCount = sigCounts.filter(n => n <= 1).length;

    // Top 10 pool signatures by total observation count
    const topSignatures = Array.from(sigMap.entries())
      .sort((a, b) => b[1].totalObs - a[1].totalObs)
      .slice(0, 10)
      .map(([sig, entry]) => {
        // success_rate approximated from alpha/(alpha+beta) across all templates in this sig
        const meanAlpha = entry.alphaSum / Math.max(entry.templates.size, 1);
        const meanBeta  = entry.betaSum  / Math.max(entry.templates.size, 1);
        const successRate = meanAlpha / (meanAlpha + meanBeta);

        // Top templates by obs count for this signature
        const topTemplates = Array.from(entry.templateObsCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([tid]) => tid);

        return {
          pool_signature: sig,
          observation_count: entry.totalObs,
          success_rate: Math.round(successRate * 1000) / 1000,
          top_templates: topTemplates,
        };
      });

    return c.json({
      distinct_pool_signatures: sigMap.size,
      total_v1_observations: totalObs,
      avg_templates_per_signature: Math.round(avgTemplates * 100) / 100,
      max_templates_per_signature: maxTemplates,
      min_templates_per_signature: minTemplates,
      top_signatures: topSignatures,
      dark_signature_count: darkSignatureCount,
      oldest_observation: oldestTs,
      newest_observation: newestTs,
    });
  } catch (err) {
    logger.error('GET /v2/activities/topology-coverage failed', {
      error: (err as Error).message,
    });
    return c.json({
      error: 'Failed to query topology coverage',
      message: (err as Error).message,
    }, 500);
  }
});

/**
 * POST /v2/activities/templates/auto-promote
 *
 * Substrate-autonomous promotion based on REAL empirical α/β accumulated
 * from execution traces. No operator action required — this is the lift
 * path (per operator directive 2026-05-27 "the goal is to get lift, not
 * to insert more arbitrary operator gates").
 *
 * Pipeline:
 *   1. SELECT all proposed=true activity rows
 *   2. Join with variant_performance_metrics (real thompson_alpha/beta from
 *      actual executions accumulated while the template sat in exploration)
 *   3. For each candidate: total_executions >= min_samples AND
 *      empirical_mean = α/(α+β) >= min_success_rate  → promote (set proposed=false)
 *   4. Bus emit `template.auto_promoted` per promotion + audit-trail row
 *
 * Designed to be called periodically by the substrate itself (boredom-vessel
 * goal rotation, systemd timer, etc.). The operator never invokes this.
 */
app.post('/templates/auto-promote', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const min_samples = Math.max(1, Math.floor(body.min_samples ?? parseInt(process.env.AUTO_PROMOTE_MIN_SAMPLES ?? '20')));
    const min_success_rate = Math.max(0, Math.min(1, body.min_success_rate ?? parseFloat(process.env.AUTO_PROMOTE_MIN_SUCCESS_RATE ?? '0.6')));
    const dry_run = body.dry_run === true;
    // Opt-in autonomous hygiene: deprecate drafts exercised enough times
    // (>= prune_min_samples) yet still below the success bar — they are
    // structurally non-viable (e.g. always no_op / validation_rejected) and
    // would otherwise clutter the backlog and the exercise rotation forever.
    // Off by default; the boredom exerciser enables it.
    const prune_failed_out = body.prune_failed_out === true;
    const prune_min_samples = Math.max(1, Math.floor(body.prune_min_samples ?? 8));

    logger.info('POST /v2/activities/templates/auto-promote', {
      min_samples, min_success_rate, dry_run,
    });

    // Step 1: fetch all proposed templates
    const proposedRows = (await surrealDB.query<any>(
      `SELECT meta::id(id) AS template_id, name, input_shapes, output_shapes
         FROM activity
        WHERE proposed = true AND (retired = false OR retired IS NONE)`,
    )) || [];
    const proposed: any[] = Array.isArray(proposedRows) ? proposedRows : [];

    if (proposed.length === 0) {
      return c.json({
        success: true,
        promoted: [],
        considered: 0,
        skipped: [],
        thresholds: { min_samples, min_success_rate },
        dry_run,
      });
    }

    // Step 2: fetch metrics for those template_ids.
    // variant_performance_metrics records are keyed as
    //   variant_performance_metrics:⟨<template_id_with_colons_as_underscores>⟩
    // and activity_variant_id field is NULL (not populated by the write path).
    // So we fetch ALL vpm records and join by normalised record ID in code.
    const ids = proposed.map(p => p.template_id);
    const metricsRows = (await surrealDB.query<any>(
      `SELECT meta::id(id) AS vpm_key, thompson_alpha, thompson_beta, total_executions, successful_executions
         FROM variant_performance_metrics`,
    )) || [];
    const metricsArr: any[] = Array.isArray(metricsRows) ? metricsRows : [];
    const metricsMap = new Map<string, any>();
    for (const m of metricsArr) {
      // vpm_key uses underscores where template_id uses colons (e.g.
      // "development-vessel_draft-gap-closing-activity" → "development-vessel:draft-gap-closing-activity").
      // Single-replace is safe: template names use hyphens as word-separators,
      // so the only underscores are the colon-substitutes inserted by the write path.
      const templateId = String(m.vpm_key ?? '').replace(/_/g, ':');
      metricsMap.set(templateId, m);
      // Also store under the raw underscore key as a fallback.
      metricsMap.set(String(m.vpm_key ?? ''), m);
    }

    // Trace-store evidence map (ONE aggregate query, not per-template). Powers
    // the deterministic-activity fallback below: activities whose tasks are all
    // deterministic never get a vpm posterior, but carry real success evidence
    // in the trace store. Keyed by normalised activity_id (strip `activity:`
    // prefix + `⟨…⟩` record-ref wrapping).
    const traceStatsMap = new Map<string, { total: number; succ: number }>();
    try {
      const traceRows = (await surrealDB.query<any>(
        `SELECT activity_id,
                count() AS total,
                count(status = 'success' OR status = 'completed' OR success = true) AS succ
           FROM v_paradigm_execution_traces
          GROUP BY activity_id`,
      )) || [];
      for (const r of (Array.isArray(traceRows) ? traceRows : [])) {
        const norm = String(r.activity_id ?? '')
          .replace(/^activity:/, '')
          .replace(/⟨|⟩/g, '');
        if (norm) traceStatsMap.set(norm, { total: Number(r.total ?? 0), succ: Number(r.succ ?? 0) });
      }
    } catch (err) {
      logger.warn('auto-promote trace-evidence map build failed', { error: (err as Error).message });
    }

    const promoted: any[] = [];
    const skipped: any[] = [];
    const pruned: any[] = [];

    for (const p of proposed) {
      const m = metricsMap.get(p.template_id);
      const alpha = m?.thompson_alpha ?? 1.0;
      const beta = m?.thompson_beta ?? 1.0;
      let total_executions = m?.total_executions ?? 0;
      // Strip the Beta(1,1) prior: real successes = α-1, real failures = β-1
      let empirical_samples = Math.max(0, (alpha - 1) + (beta - 1));
      let empirical_mean = empirical_samples > 0 ? (alpha - 1) / empirical_samples : 0;
      let evidence_source = 'thompson_posterior';

      // Deterministic-activity fallback. An activity whose tasks are ALL
      // deterministic never gets a vpm posterior — `applyOutcomeToPosteriors`
      // skips the UPDATE for degenerate posteriors (posterior-update.ts:49-53).
      // Such activities (e.g. a single-resolver concept-priming wrapper) still
      // carry real success evidence in the trace store. Without this fallback
      // they can NEVER auto-promote (empirical_samples stays 0), so the
      // author→exercise→promote loop only ever graduated stochastic (LLM-tier)
      // activities. Count trace-store successes so deterministic authored
      // activities graduate on execution evidence, not Thompson α/β.
      // Trace-store ground truth augments the vpm posterior whenever vpm is
      // insufficient. Two cases this fixes: (1) all-deterministic activities
      // never get a vpm row (posterior UPDATE skipped); (2) activities executed
      // via light-dispatch / out-of-band paths that don't credit vpm, so the vpm
      // row UNDER-counts real executions. The `tr.total > empirical_samples`
      // guard only lets traces win when they carry MORE observations than vpm,
      // so a well-sampled stochastic posterior is never overridden by raw counts.
      if (empirical_samples < min_samples) {
        const tr = traceStatsMap.get(p.template_id);
        if (tr && tr.total > empirical_samples) {
          empirical_samples = tr.total;
          empirical_mean = tr.total > 0 ? tr.succ / tr.total : 0;
          total_executions = tr.total;
          evidence_source = 'trace_store';
        }
      }

      const evidence = {
        template_id: p.template_id,
        name: p.name,
        thompson_alpha: alpha,
        thompson_beta: beta,
        total_executions,
        empirical_samples,
        empirical_mean,
        evidence_source,
      };

      if (empirical_samples < min_samples) {
        skipped.push({ ...evidence, reason: 'insufficient_empirical_samples' });
        continue;
      }
      if (empirical_mean < min_success_rate) {
        // Trace-store viability guard. Prune is meant for STRUCTURALLY non-viable
        // drafts (always no_op / validation_rejected). The vpm posterior, however,
        // can be dragged below the bar by NON-execution signal — e.g. impulse /
        // engagement relevance writes (`/impulse-relevance` bumps the same
        // thompson_alpha/beta). An activity that genuinely EXECUTES successfully
        // must never be auto-retired as "failed_out" just because a downstream
        // relevance signal is negative. If the trace store shows healthy real
        // execution success over enough observations, refuse to prune and let it
        // continue toward promotion on execution evidence.
        // Engagement / relevance writes inflate the vpm sample count ABOVE the
        // real execution count, so prune can fire with few real executions. Guard
        // on execution ground truth: any clean real-execution evidence (≥1 trace,
        // success rate at/above bar) means the draft is NOT structurally
        // non-viable, regardless of how few — the low posterior is contamination.
        const trViab = traceStatsMap.get(p.template_id);
        if (trViab && trViab.total >= 1) {
          const trRate = trViab.total > 0 ? trViab.succ / trViab.total : 0;
          if (trRate >= min_success_rate) {
            skipped.push({
              ...evidence,
              reason: 'prune_refused_trace_store_viable',
              trace_total: trViab.total,
              trace_success_rate: trRate,
            });
            continue;
          }
        }
        // Failed-out draft: exercised enough and still below the bar. Deprecate
        // it (autonomous backlog hygiene) when pruning is enabled; else skip.
        if (prune_failed_out && empirical_samples >= prune_min_samples) {
          if (dry_run) {
            pruned.push({ ...evidence, action: 'would_prune', reason: 'failed_out', dry_run: true });
            continue;
          }
          try {
            await surrealDB.query(
              `UPDATE activity SET proposed = false, deprecated = true, retired = true, updated_at = time::now() WHERE meta::id(id) = $tid`,
              { tid: p.template_id },
            );
            pruned.push({ ...evidence, action: 'pruned', reason: 'failed_out' });
            // decision must be INSIDE ['promote','refused'] (schema ASSERT); a
            // prune is a refusal-to-promote + deprecate, so record it as
            // 'refused' with a distinguishing reason so the trail stays visible.
            void surrealDB.query(
              `CREATE promote_gate_evaluations CONTENT {
                template_id: $tid, decision: 'refused', reason: 'failed_out_pruned',
                alpha_hat: $alpha, beta_hat: $beta, projected_mean: $mean,
                total_samples: $samples, k_neighbors: 0,
                threshold_mean: $threshold_mean, threshold_samples: $threshold_samples,
                neighbor_template_ids: [], source_vessel_id: 'metabob-activity-api',
                evaluated_at: time::now(), created_at: time::now()
              }`,
              {
                tid: p.template_id, alpha, beta, mean: empirical_mean,
                samples: Math.floor(empirical_samples), threshold_mean: min_success_rate,
                threshold_samples: prune_min_samples,
              },
            ).catch((err) => logger.warn('auto-promote prune audit write failed', { template_id: p.template_id, error: (err as Error).message }));
          } catch (err) {
            skipped.push({ ...evidence, reason: 'prune_update_failed', error: (err as Error).message });
          }
          continue;
        }
        skipped.push({ ...evidence, reason: 'empirical_mean_below_threshold' });
        continue;
      }

      if (dry_run) {
        promoted.push({ ...evidence, action: 'would_promote', dry_run: true });
        continue;
      }

      try {
        // `activity` is a VIEW over `activity_template`; UPDATE on the view
        // `activity` is a VIEW and activity_template is empty. Use WHERE clause
        // to match by meta::id since backtick-notation UPDATE finds no records.
        await surrealDB.query(
          `UPDATE activity SET proposed = false, updated_at = time::now() WHERE meta::id(id) = $tid`,
          { tid: p.template_id },
        );
        promoted.push({ ...evidence, action: 'promoted' });

        // Audit trail: bus emit + durable mirror to promote_gate_evaluations
        // (decision: 'promote', source: 'auto_promoter')
        void (async () => {
          try {
            const { broadcaster } = await import('../websocket/broadcaster');
            broadcaster.emit({
              type: 'template.auto_promoted' as any,
              timestamp: new Date().toISOString(),
              data: {
                template_id: p.template_id,
                source_vessel_id: 'metabob-activity-api',
                promoter: 'autonomous',
                evidence,
                thresholds: { min_samples, min_success_rate },
              },
            });
            broadcaster.emit({
              type: 'activity_template.promoted' as any,
              timestamp: new Date().toISOString(),
              data: {
                template_id: p.template_id,
                source_vessel_id: 'metabob-activity-api',
                promoter: 'autonomous',
              },
            });
          } catch (err) {
            logger.warn('auto-promote bus emit failed', {
              template_id: p.template_id,
              error: (err as Error).message,
            });
          }
        })();

        // Durable mirror — joins the auto-promote stream into the same
        // promote_gate_evaluations audit table that operator-pulled
        // /promote uses (iter 21). decision='promote', reason='auto_promote'.
        void (async () => {
          try {
            await surrealDB.query(
              `CREATE promote_gate_evaluations CONTENT {
                template_id: $tid,
                decision: 'promote',
                reason: 'auto_promote',
                alpha_hat: $alpha,
                beta_hat: $beta,
                projected_mean: $mean,
                total_samples: $samples,
                k_neighbors: 0,
                threshold_mean: $threshold_mean,
                threshold_samples: $threshold_samples,
                neighbor_template_ids: [],
                source_vessel_id: 'metabob-activity-api',
                evaluated_at: time::now(),
                created_at: time::now()
              }`,
              {
                tid: p.template_id,
                alpha,
                beta,
                mean: empirical_mean,
                samples: Math.floor(empirical_samples),
                threshold_mean: min_success_rate,
                threshold_samples: min_samples,
              },
            );
          } catch (err) {
            logger.warn('auto-promote audit-trail write failed', {
              template_id: p.template_id,
              error: (err as Error).message,
            });
          }
        })();
      } catch (err) {
        skipped.push({ ...evidence, reason: 'update_failed', error: (err as Error).message });
      }
    }

    logger.info('Auto-promote complete', {
      considered: proposed.length,
      promoted: promoted.length,
      pruned: pruned.length,
      skipped: skipped.length,
      dry_run,
    });

    // Bulk-invalidate template caches for every row actually mutated (promoted
    // or pruned). Skip on dry-run — no DB mutation happened. Per-key
    // completeness rule — see src/utils/template-cache.ts.
    if (!dry_run && (promoted.length > 0 || pruned.length > 0)) {
      await invalidateTemplateCacheMany(
        [...promoted, ...pruned].map((p: any) => p.template_id).filter((id: any) => typeof id === 'string'),
      );
    }

    return c.json({
      success: true,
      promoted,
      pruned,
      considered: proposed.length,
      skipped,
      thresholds: { min_samples, min_success_rate, prune_failed_out, prune_min_samples },
      dry_run,
    });
  } catch (err) {
    logger.error('POST /v2/activities/templates/auto-promote failed', {
      error: (err as Error).message,
    });
    return c.json({
      success: false,
      error: (err as Error).message,
    }, 500);
  }
});

app.post('/templates/:templateId/promote', async (c) => {
  try {
    const templateId = c.req.param('templateId');
    if (!templateId || templateId.trim() === '') {
      return c.json({ error: 'templateId is required' }, 400);
    }

    // Strip activity: prefix + angle-bracket / backtick wrapping so we always
    // target the canonical bare-name record (same normalisation as the
    // POST /templates UPSERT).
    const cleanId = templateId.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '').trim();

    logger.info('POST /v2/activities/templates/:templateId/promote', {
      templateId: cleanId,
    });

    // Read first so we can return 404 cleanly. Use root because PERMISSIONS
    // on the activity table require $token, and the promote endpoint runs
    // under the standard API-key middleware (validateApiKeyWithFallback).
    const existing = await surrealDB.query<{
      id: string;
      proposed?: boolean;
      name?: string;
      tasks?: Array<{ id?: string; resolver?: string }>;
      input_shapes?: string[];
      output_shapes?: string[];
    }>(
      `SELECT id, proposed, name, tasks, input_shapes, output_shapes FROM activity:\`${cleanId}\` LIMIT 1`,
    );

    const row = Array.isArray(existing) && existing.length > 0 ? existing[0] : null;
    if (!row) {
      return c.json({
        success: false,
        error: 'template not found',
        templateId: cleanId,
      }, 404);
    }

    if (row.proposed !== true) {
      // Already promoted (or never proposed). Idempotent return.
      return c.json({
        success: true,
        templateId: cleanId,
        proposed: false,
        action: 'already_promoted',
      });
    }

    // Pre-promote validation: refuse to promote templates that reference
    // unregistered resolvers (audit F-134, inv-053 — proposal non-executability
    // with hallucinated resolver names). This is a §27.S.6 push-away point —
    // the substrate refuses an operator intervention with cited evidence
    // rather than silently registering a non-executable template.
    //
    // Allowlist = discovery-vessel advertised shapes ∪ ias-executor-ts built-ins.
    // The discovery-vessel endpoint returns all currently-advertised shapes
    // across all registered vessels; built-ins are hardcoded because they
    // aren't advertised through discovery.
    // Per audit F-139 (inv-054): the prior allowlist included CI/deployment
    // resolvers (helmfile_sync, docker_build_push, scaffold_vessel_skeleton)
    // that are NOT registered in the single-container substrate's goal-host.
    // A template referencing these names would pass promotion but fail
    // execution (resolver_not_registered at engine.ts). The fix narrows the
    // built-in set to resolvers ACTUALLY registered by goal-host on the
    // substrate (verified by reading hosts/goal-host.ts:598-655 +
    // goal-host-vessel/src/index.ts built-in registrations).
    //
    // For multi-substrate deployments that DO ship the CI resolvers, those
    // vessels can advertise them via discovery-vessel and the allowlist
    // picks them up from /registry/shapes — no source change needed.
    const builtInResolvers = new Set<string>([
      // Engine special token (not a resolver, dispatched by engine.ts directly)
      "compose",
      // ias-executor-ts resolvers actually registered in substrate goal-host
      "activity", "iteration", "llm-prompt", "impulse-resolve", "validation",
      "impulse_pool_selection", "producer_selection", "impulse_preparation",
      "wire_discovery_registration", "wire_auth_blueprint",
      "learning_signal_writer", "verify_three_invariants",
      // goal-host wiring (file_read, bash, llm)
      "file_read", "bash", "llm",
      // goal-host-vessel built-ins
      "activity_recommendation", "impulse_cooccurrence",
      // (Removed per F-139: helmfile_sync, docker_build_push,
      // scaffold_vessel_skeleton — these are CI/deployment resolvers
      // not registered in the local substrate's goal-host.)
    ]);

    const tasks = row.tasks ?? [];
    const taskResolvers = tasks
      .map((t) => (typeof t?.resolver === "string" ? t.resolver : ""))
      .filter((r) => r.length > 0);

    if (taskResolvers.length > 0) {
      // Fetch discovery-vessel registry shapes (the authoritative list of
      // resolvers advertised by any registered vessel).
      let discoveryShapes: Set<string> = new Set();
      try {
        const discoveryEndpoint = process.env.DISCOVERY_VESSEL_ENDPOINT ?? "http://127.0.0.1:8100";
        const discResp = await fetch(`${discoveryEndpoint}/registry/shapes`, {
          headers: { Authorization: `ApiKey ${process.env.METABOB_API_KEY ?? ""}` },
          signal: AbortSignal.timeout(2000),
        });
        if (discResp.ok) {
          const discData = await discResp.json() as { shapes?: string[] };
          discoveryShapes = new Set(discData.shapes ?? []);
        }
      } catch (err) {
        logger.warn("promote: discovery fetch failed; using built-ins only", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Strip vessel-prefixed forms ("development-vessel:foo" → "foo") since
      // dev-vessel proxy resolvers register both qualified and unqualified ids.
      const normalize = (r: string): string => r.includes(":") ? r.split(":").slice(-1)[0]! : r;
      const unregistered: Array<{ task_id: string; resolver: string }> = [];
      for (const t of tasks) {
        const r = typeof t?.resolver === "string" ? t.resolver : "";
        if (!r) continue;
        const bare = normalize(r);
        if (builtInResolvers.has(r) || builtInResolvers.has(bare)) continue;
        if (discoveryShapes.has(r) || discoveryShapes.has(bare)) continue;
        unregistered.push({ task_id: t.id ?? "?", resolver: r });
      }

      if (unregistered.length > 0) {
        const refusalData = {
          type: "hallucinated_resolvers_in_template" as const,
          template_id: cleanId,
          unregistered_resolvers: unregistered,
          discovery_shapes_examined: discoveryShapes.size,
          builtins_examined: builtInResolvers.size,
          reason:
            `Template '${cleanId}' references ${unregistered.length} resolver(s) not present in ` +
            `the discovery-vessel registry (${discoveryShapes.size} advertised shapes) nor in the ` +
            `ias-executor-ts built-in set. Promoting would land a non-executable template in ` +
            `Thompson selection. Push-away refusal per IAL §27.S.6.`,
          suggestion:
            `Replace the unregistered resolvers with registered equivalents, OR register a ` +
            `vessel that advertises these shapes, then retry promotion. ` +
            `See /v2/activities/templates/${cleanId} for the full template.`,
        };
        logger.info("promote: refused — hallucinated resolvers", {
          templateId: cleanId,
          unregistered_count: unregistered.length,
          unregistered: unregistered.slice(0, 5),
        });

        // Bus emit + durable write (same pattern as the recommend-refusal path)
        const refusedAtIso = new Date().toISOString();
        void (async () => {
          try {
            const { broadcaster } = await import("../websocket/broadcaster");
            broadcaster.emit({
              type: "intervention.refused" as any,
              timestamp: refusedAtIso,
              data: {
                source_vessel_id: "metabob-activity-api",
                refusal_type: refusalData.type,
                template_id: cleanId,
                unregistered_resolvers: refusalData.unregistered_resolvers,
                reason: refusalData.reason,
                suggestion: refusalData.suggestion,
              },
            });
          } catch (err) {
            logger.warn("promote refusal bus emit failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        void (async () => {
          try {
            // For the durable record we reuse refusal_events. We don't have
            // expected_output_shapes here — instead we attribute the refusal
            // to the template_id field and surface the unregistered resolver
            // list in the task_description summary so auditors can reconstruct.
            const summary = `template_id=${cleanId} unregistered=${unregistered.map(u => u.resolver).join(",")}`.slice(0, 200);
            await surrealDB.query(
              `CREATE refusal_events CONTENT {
                refusal_type: $refusal_type,
                source_vessel_id: 'metabob-activity-api',
                expected_output_shapes: $expected_output_shapes,
                candidates_examined: $candidates_examined,
                task_description: $task_description,
                reason: $reason,
                suggestion: $suggestion,
                refused_at: time::now()
              }`,
              {
                refusal_type: refusalData.type,
                expected_output_shapes: [], // not shape-related; field required by schema
                candidates_examined: discoveryShapes.size + builtInResolvers.size,
                task_description: summary,
                reason: refusalData.reason,
                suggestion: refusalData.suggestion,
              },
            );
          } catch (err) {
            logger.warn("promote refusal SurrealDB write failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();

        return c.json({
          success: false,
          action: "refused",
          templateId: cleanId,
          refusal: refusalData,
        }, 422);
      }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Promote-gate evaluation (audit inv-030, opus iter-015)
    //
    // After the resolver-existence check passes, project a forward-selection
    // success rate by averaging the Beta posteriors of the K=5 templates
    // most similar to this one (Jaccard on inputShapes ∪ outputShapes).
    // Refuse if the projected mean < 0.6 or total samples < 10 or K=0.
    //
    // Composes with iter 14 (hallucinated-resolver refusal) + iter 16
    // (thompson_posterior observability fields) using the same refusal
    // event + durable storage infrastructure from iter 8 + iter 13.
    //
    // Configurable via env (defaults from inv-030):
    //   PROMOTE_GATE_K (default 5)
    //   PROMOTE_GATE_THRESHOLD_MEAN (default 0.6)
    //   PROMOTE_GATE_THRESHOLD_SAMPLES (default 10)
    //   PROMOTE_GATE_DISABLED (default false; "true" → bypass gate; for shadow-mode tuning)
    // ──────────────────────────────────────────────────────────────────────
    const gateDisabled = (process.env.PROMOTE_GATE_DISABLED ?? "false").toLowerCase() === "true";
    if (!gateDisabled) {
      const K = parseInt(process.env.PROMOTE_GATE_K ?? "5", 10);
      const thresholdMean = parseFloat(process.env.PROMOTE_GATE_THRESHOLD_MEAN ?? "0.6");
      const thresholdSamples = parseInt(process.env.PROMOTE_GATE_THRESHOLD_SAMPLES ?? "10", 10);

      const probeShapes = new Set<string>([
        ...(row.input_shapes ?? []),
        ...(row.output_shapes ?? []),
      ]);

      let neighbors: Array<{
        template_id: string;
        similarity: number;
        alpha: number;
        beta: number;
        sample_count: number;
      }> = [];

      if (probeShapes.size > 0) {
        try {
          // Two queries (SurrealDB doesn't support relational joins with
          // table aliases at this grammar version):
          //   (a) activity rows with shapes
          //   (b) variant_performance_metrics rows with α/β/sample_count
          // Join in app code by template id. The metrics table is the
          // canonical source for posteriors per the thompson_posterior
          // resolver — the activity table's thompson_* fields aren't
          // updated by trace writes.
          // F-143 fix: use meta::id() to project a guaranteed bare-string
          // id, so candidate-template lookup against variant_performance_metrics
          // (whose activity_id/variant_id are already bare strings like
          // "development-vessel:coverage-tick") joins correctly. The prior
          // `String(a.id)` form returned a RecordId object stringification
          // that didn't match the bare-name keys, leading to K=0 always
          // (investigation-057 §F-143).
          const [activityRows, metricsRows] = await Promise.all([
            surrealDB.query<{
              tid: string;
              input_shapes?: string[];
              output_shapes?: string[];
            }>(
              `SELECT meta::id(id) AS tid, input_shapes, output_shapes
                FROM activity
                WHERE (proposed = false OR proposed IS NONE)
                  AND (retired = false OR retired IS NONE)
                  AND meta::id(id) != $cleanId`,
              { cleanId },
            ),
            surrealDB.query<{
              activity_id?: string;
              variant_id?: string;
              thompson_alpha?: number;
              thompson_beta?: number;
              total_executions?: number;
            }>(
              `SELECT activity_id, variant_id, thompson_alpha, thompson_beta, total_executions
                FROM variant_performance_metrics
                WHERE total_executions > 0`,
            ),
          ]);

          // Build lookup: template-id → (α, β, sample_count). Both
          // activity_id and variant_id keys map to the same row.
          const metricsById = new Map<string, { alpha: number; beta: number; sample_count: number }>();
          for (const m of metricsRows ?? []) {
            const aid = String(m.activity_id ?? "");
            const vid = String(m.variant_id ?? "");
            const entry = {
              alpha: m.thompson_alpha ?? 1,
              beta: m.thompson_beta ?? 1,
              sample_count: m.total_executions ?? 0,
            };
            if (aid) metricsById.set(aid, entry);
            if (vid) metricsById.set(vid, entry);
          }

          const candidates = (activityRows ?? []).map((a) => {
            const tid = String(a.tid ?? "");
            const m = metricsById.get(tid);
            return {
              id: tid,
              input_shapes: a.input_shapes,
              output_shapes: a.output_shapes,
              thompson_alpha: m?.alpha,
              thompson_beta: m?.beta,
              total_executions: m?.sample_count,
            };
          });

          // Compute Jaccard similarity, take templates with similarity > 0 and sample_count > 0
          const scored = (candidates ?? [])
            .map((c) => {
              const cShapes = new Set<string>([
                ...(c.input_shapes ?? []),
                ...(c.output_shapes ?? []),
              ]);
              if (cShapes.size === 0) return null;
              let intersection = 0;
              for (const s of probeShapes) if (cShapes.has(s)) intersection++;
              const union = probeShapes.size + cShapes.size - intersection;
              const similarity = union > 0 ? intersection / union : 0;
              if (similarity === 0) return null;
              const sampleCount = c.total_executions ?? 0;
              if (sampleCount === 0) return null;
              return {
                template_id: String(c.id ?? ""),
                similarity,
                alpha: c.thompson_alpha ?? 1,
                beta: c.thompson_beta ?? 1,
                sample_count: sampleCount,
              };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, K);
          neighbors = scored;
        } catch (err) {
          logger.warn("promote-gate: neighbor query failed; failing closed", {
            error: err instanceof Error ? err.message : String(err),
          });
          neighbors = []; // treat as cold-start (K=0)
        }
      }

      // Weighted Beta-Binomial projection with Jeffreys-baseline stripping:
      //   α̂ = 1 + Σ_i (w_i · (α_i − 1)) / Σ_i w_i
      //   β̂ = 1 + Σ_i (w_i · (β_i − 1)) / Σ_i w_i
      // The −1 strips the Beta(1,1) prior so we average EVIDENCE, not double-counted
      // priors. The leading +1 re-introduces a single Jeffreys baseline.
      let alphaHat = 1;
      let betaHat = 1;
      let totalSamples = 0;
      let weightSum = 0;
      let evidenceAlpha = 0;
      let evidenceBeta = 0;
      for (const n of neighbors) {
        weightSum += n.similarity;
        evidenceAlpha += n.similarity * (n.alpha - 1);
        evidenceBeta += n.similarity * (n.beta - 1);
        totalSamples += n.sample_count;
      }
      if (weightSum > 0) {
        alphaHat = 1 + evidenceAlpha / weightSum;
        betaHat = 1 + evidenceBeta / weightSum;
      }
      const projectedMean = alphaHat / (alphaHat + betaHat);

      // Decide
      let gateDecision: 'promote' | 'refused' = 'promote';
      let gateReason: string | null = null;
      if (neighbors.length === 0) {
        gateDecision = 'refused';
        gateReason = 'cold_start_no_similar';
      } else if (totalSamples < thresholdSamples) {
        gateDecision = 'refused';
        gateReason = 'insufficient_neighbor_evidence';
      } else if (projectedMean < thresholdMean) {
        gateDecision = 'refused';
        gateReason = 'projected_mean_below_threshold';
      }

      // Emit `promote_gate.evaluated` on EVERY promote attempt (allow AND
      // refuse paths). This is the audit-trail data inv-030 §7 calls for
      // and enables the §calibration experiment without needing a separate
      // shadow-mode run: subscribers (auditors, future analyzers) can
      // accumulate gate decisions and post-hoc-join against
      // variant_performance_metrics to compute the calibration table
      // (gate-said vs subsequent-success-rate). Fire-and-forget.
      const gateEvaluatedAtIso = new Date().toISOString();
      const gateEvaluation = {
        decision: gateDecision,
        reason: gateReason,
        template_id: cleanId,
        template_input_shapes: row.input_shapes ?? [],
        template_output_shapes: row.output_shapes ?? [],
        projection: {
          alpha_hat: Math.round(alphaHat * 1000) / 1000,
          beta_hat: Math.round(betaHat * 1000) / 1000,
          mean: Math.round(projectedMean * 1000) / 1000,
          total_samples: totalSamples,
          K: neighbors.length,
        },
        threshold: { mean: thresholdMean, samples: thresholdSamples },
        neighbors: neighbors.map((n) => ({
          template_id: n.template_id,
          similarity: Math.round(n.similarity * 1000) / 1000,
          alpha: n.alpha,
          beta: n.beta,
          sample_count: n.sample_count,
        })),
      };
      void (async () => {
        try {
          const { broadcaster } = await import('../websocket/broadcaster');
          broadcaster.emit({
            type: 'promote_gate.evaluated' as any,
            timestamp: gateEvaluatedAtIso,
            data: {
              source_vessel_id: 'metabob-activity-api',
              ...gateEvaluation,
            },
          });
        } catch (err) {
          logger.warn('promote-gate evaluation bus emit failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      // Durable mirror (migration 141, audit inv-030 §calibration). Same
      // hot/cold split as iter 13's refusal_events for intervention.refused:
      // bus is for live reactivity, table is for sustained-window post-hoc
      // analysis. Fire-and-forget; nulls are omitted to satisfy SurrealDB's
      // option<string> "no JSON null" quirk (same approach as refusal_events
      // write).
      void (async () => {
        try {
          const fields: string[] = [
            "template_id: $template_id",
            "decision: $decision",
            "alpha_hat: $alpha_hat",
            "beta_hat: $beta_hat",
            "projected_mean: $projected_mean",
            "total_samples: $total_samples",
            "k_neighbors: $k_neighbors",
            "threshold_mean: $threshold_mean",
            "threshold_samples: $threshold_samples",
            "neighbor_template_ids: $neighbor_template_ids",
            "source_vessel_id: 'metabob-activity-api'",
            "evaluated_at: time::now()",
          ];
          const params: Record<string, unknown> = {
            template_id: cleanId,
            decision: gateDecision,
            alpha_hat: gateEvaluation.projection.alpha_hat,
            beta_hat: gateEvaluation.projection.beta_hat,
            projected_mean: gateEvaluation.projection.mean,
            total_samples: gateEvaluation.projection.total_samples,
            k_neighbors: gateEvaluation.projection.K,
            threshold_mean: gateEvaluation.threshold.mean,
            threshold_samples: gateEvaluation.threshold.samples,
            neighbor_template_ids: gateEvaluation.neighbors.map((n) => n.template_id),
          };
          if (gateReason) {
            fields.push("reason: $reason");
            params.reason = gateReason;
          }
          const evalOrgId = getJwtAuthFromContext(c)?.orgId ?? null;
          if (evalOrgId) {
            fields.push("org_id: $org_id");
            params.org_id = evalOrgId;
          }
          await surrealDB.query(
            `CREATE promote_gate_evaluations CONTENT { ${fields.join(', ')} }`,
            params,
          );
        } catch (err) {
          logger.warn('promote-gate evaluation SurrealDB write failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      if (gateDecision === 'refused') {
        const refusedAtIso = new Date().toISOString();
        const gateRefusalData = {
          type: 'promote_gate_below_threshold' as const,
          template_id: cleanId,
          reason: gateReason ?? 'unknown',
          projection: {
            alpha_hat: Math.round(alphaHat * 1000) / 1000,
            beta_hat: Math.round(betaHat * 1000) / 1000,
            mean: Math.round(projectedMean * 1000) / 1000,
            total_samples: totalSamples,
            K: neighbors.length,
          },
          threshold: { mean: thresholdMean, samples: thresholdSamples },
          neighbors: neighbors.map((n) => ({
            template_id: n.template_id,
            similarity: Math.round(n.similarity * 1000) / 1000,
            alpha: n.alpha,
            beta: n.beta,
            sample_count: n.sample_count,
          })),
          notes:
            'Promote-gate refusal — IAL §27.S.6 push-away. Projected forward-selection mean ' +
            'falls below threshold under weighted Beta-Binomial projection over K nearest ' +
            'templates by Jaccard shape similarity. Cold-start (K=0) is also fail-closed.',
        };
        logger.info('promote: refused by gate', {
          templateId: cleanId,
          reason: gateReason,
          K: neighbors.length,
          projectedMean,
          totalSamples,
        });

        // Bus emit (existing infrastructure from iter 8)
        void (async () => {
          try {
            const { broadcaster } = await import('../websocket/broadcaster');
            broadcaster.emit({
              type: 'intervention.refused' as any,
              timestamp: refusedAtIso,
              data: {
                source_vessel_id: 'metabob-activity-api',
                refusal_type: gateRefusalData.type,
                template_id: cleanId,
                reason: gateRefusalData.reason,
                projection: gateRefusalData.projection,
                neighbors: gateRefusalData.neighbors.map(n => n.template_id),
              },
            });
          } catch (err) {
            logger.warn('promote-gate bus emit failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        // Durable write (existing refusal_events table from iter 13)
        void (async () => {
          try {
            const summary = `template_id=${cleanId} reason=${gateReason} K=${neighbors.length} mean=${Math.round(projectedMean * 1000) / 1000} samples=${totalSamples}`.slice(0, 200);
            await surrealDB.query(
              `CREATE refusal_events CONTENT {
                refusal_type: $refusal_type,
                source_vessel_id: 'metabob-activity-api',
                expected_output_shapes: $expected_output_shapes,
                candidates_examined: $candidates_examined,
                task_description: $task_description,
                reason: $reason,
                refused_at: time::now()
              }`,
              {
                refusal_type: gateRefusalData.type,
                expected_output_shapes: [...(row.output_shapes ?? [])],
                candidates_examined: neighbors.length,
                task_description: summary,
                reason: gateRefusalData.notes,
              },
            );
          } catch (err) {
            logger.warn('promote-gate refusal SurrealDB write failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();

        return c.json({
          success: false,
          action: 'refused',
          templateId: cleanId,
          refusal: gateRefusalData,
        }, 422);
      }
    }

    // Use WHERE clause — backtick-notation UPDATE finds no records on this table.
    await surrealDB.query(
      `UPDATE activity SET proposed = false, updated_at = time::now() WHERE meta::id(id) = $tid`,
      { tid: cleanId },
    );

    // Invalidate template caches — promote flips `proposed` on the row, so
    // both the per-template body and the LIST set need refresh. Per-key
    // completeness rule — see src/utils/template-cache.ts.
    await invalidateTemplateCache(cleanId);

    logger.info('Template promoted', { templateId: cleanId, name: row.name });

    // Bus emit (best-effort; ride the substrate event bus per
    // openspec/changes/2026-05-27-neutral-emitter-lifecycle-bus).
    void (async () => {
      try {
        const { broadcaster } = await import('../websocket/broadcaster');
        broadcaster.emit({
          type: 'activity_template.promoted' as any,
          timestamp: new Date().toISOString(),
          data: { template_id: cleanId, source_vessel_id: 'metabob-activity-api' },
        });
      } catch (err) {
        logger.warn('promote bus emit failed', { error: (err as Error).message });
      }
    })();

    return c.json({
      success: true,
      templateId: cleanId,
      proposed: false,
      action: 'promoted',
    });
  } catch (err) {
    logger.error('POST /templates/:templateId/promote failed', {
      error: (err as Error).message,
    });
    return c.json({
      success: false,
      error: (err as Error).message,
    }, 500);
  }
});

app.get('/templates/:templateId/metrics', async (c) => {
  try {
    const templateId = c.req.param('templateId');

    if (!templateId) {
      return c.json({ error: 'Missing template ID' }, 400);
    }

    logger.info('GET /v2/activities/templates/:templateId/metrics', { template_id: templateId });

    // Query execution metrics for this specific template
    const metricsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS successful_executions,
        count(IF success = false THEN 1 ELSE NONE END) AS failed_executions,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
        math::mean(duration_ms) AS avg_duration_ms,
        math::mean(cost_usd) AS avg_cost_usd,
        math::sum(cost_usd) AS total_cost_usd,
        time::max(executed_at) AS last_executed_at
      FROM v_paradigm_execution_traces
      WHERE activity_id = $template_id
      GROUP ALL
    `, { template_id: templateId });

    const stats = (metricsResult[0] as any) || {};

    const totalExecutions = stats.total_executions || 0;
    const successfulExecutions = stats.successful_executions || 0;
    const failedExecutions = stats.failed_executions || 0;

    // Thompson Sampling parameters
    const thompsonAlpha = successfulExecutions + 1;
    const thompsonBeta = failedExecutions + 1;
    const thompsonBelief = thompsonAlpha / (thompsonAlpha + thompsonBeta);

    // Query executions grouped by day
    const executionsByDayResult = await surrealDB.query(`
      SELECT
        time::format(executed_at, '%Y-%m-%d') AS date,
        count() AS count,
        count(IF success = true THEN 1 ELSE NONE END) AS success_count
      FROM v_paradigm_execution_traces
      WHERE activity_id = $template_id
      GROUP BY time::format(executed_at, '%Y-%m-%d')
      ORDER BY date DESC
      LIMIT 30
    `, { template_id: templateId });

    const executionsByDay = (executionsByDayResult as any[]) || [];

    const metrics = {
      template_id: templateId,
      total_executions: totalExecutions,
      successful_executions: successfulExecutions,
      failed_executions: failedExecutions,
      success_rate: stats.success_rate || 0,
      avg_duration_ms: Math.round(stats.avg_duration_ms || 0),
      avg_cost_usd: stats.avg_cost_usd || 0,
      total_cost_usd: stats.total_cost_usd || 0,
      thompson_alpha: thompsonAlpha,
      thompson_beta: thompsonBeta,
      thompson_belief: thompsonBelief,
      last_executed_at: stats.last_executed_at || null,
      executions_by_day: executionsByDay.map((row: any) => ({
        date: row.date,
        count: row.count || 0,
        success_count: row.success_count || 0,
      })),
    };

    logger.debug('Template metrics retrieved', { template_id: templateId, metrics });

    return c.json(metrics);

  } catch (error: any) {
    logger.error('GET /v2/activities/templates/:templateId/metrics failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch template metrics',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /metrics/aggregate
 *
 * Returns system-wide aggregate metrics including top templates.
 *
 * Returns:
 * {
 *   total_templates: number,
 *   templates_executed: number,
 *   templates_never_executed: number,
 *   total_executions: number,
 *   successful_executions: number,
 *   failed_executions: number,
 *   overall_success_rate: number,
 *   total_cost_usd: number,
 *   avg_cost_per_execution: number,
 *   top_templates_by_executions: Array<{template_id, execution_count, success_rate}>,
 *   top_templates_by_success_rate: Array<{template_id, success_rate, execution_count}>
 * }
 */
app.get('/metrics/aggregate', async (c) => {
  try {
    logger.info('GET /v2/activities/metrics/aggregate');

    // Query overall execution statistics
    const overallStatsResult = await surrealDB.query(`
      SELECT
        count() AS total_executions,
        count(IF success = true THEN 1 ELSE NONE END) AS successful_executions,
        count(IF success = false THEN 1 ELSE NONE END) AS failed_executions,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS overall_success_rate,
        math::sum(cost_usd) AS total_cost_usd
      FROM v_paradigm_execution_traces
      GROUP ALL
    `);

    const overallStats = (overallStatsResult[0] as any) || {};
    const totalExecutions = overallStats.total_executions || 0;
    const avgCostPerExecution = totalExecutions > 0
      ? (overallStats.total_cost_usd || 0) / totalExecutions
      : 0;

    // Count total templates
    const totalTemplatesResult = await surrealDB.query(`
      SELECT count() AS total
      FROM activity_template
      GROUP ALL
    `);
    const totalTemplates = ((totalTemplatesResult[0] as any)?.total) || 0;

    // Count templates that have been executed
    // Distinct count via subquery: array::distinct(activity_id) under GROUP ALL
    // receives a scalar per row (not a collected array) and throws
    // "Incorrect arguments for function array::distinct()". Group by activity_id
    // first (one row per distinct id), then count the rows.
    const executedTemplatesResult = await surrealDB.query(`
      SELECT count() AS executed_count FROM (
        SELECT activity_id FROM v_paradigm_execution_traces GROUP BY activity_id
      ) GROUP ALL
    `);
    const templatesExecuted = ((executedTemplatesResult[0] as any)?.executed_count) || 0;
    const templatesNeverExecuted = totalTemplates - templatesExecuted;

    // Query top templates by execution count
    const topByExecutionsResult = await surrealDB.query(`
      SELECT
        activity_id AS template_id,
        count() AS execution_count,
        math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate
      FROM v_paradigm_execution_traces
      GROUP BY activity_id
      ORDER BY execution_count DESC
      LIMIT 10
    `);

    // Query top templates by success rate (min 3 executions)
    // Note: SurrealDB 2.x does not support HAVING clause, using subquery pattern instead
    const topBySuccessRateResult = await surrealDB.query(`
      SELECT * FROM (
        SELECT
          activity_id AS template_id,
          math::mean(IF success = true THEN 1.0 ELSE 0.0 END) AS success_rate,
          count() AS execution_count
        FROM v_paradigm_execution_traces
        GROUP BY activity_id
      ) WHERE execution_count >= 3
      ORDER BY success_rate DESC, execution_count DESC
      LIMIT 10
    `);

    const metrics = {
      total_templates: totalTemplates,
      templates_executed: templatesExecuted,
      templates_never_executed: templatesNeverExecuted,
      total_executions: totalExecutions,
      successful_executions: overallStats.successful_executions || 0,
      failed_executions: overallStats.failed_executions || 0,
      overall_success_rate: overallStats.overall_success_rate || 0,
      total_cost_usd: overallStats.total_cost_usd || 0,
      avg_cost_per_execution: avgCostPerExecution,
      top_templates_by_executions: (topByExecutionsResult as any[]).map((row: any) => ({
        template_id: row.template_id,
        execution_count: row.execution_count || 0,
        success_rate: row.success_rate || 0,
      })),
      top_templates_by_success_rate: (topBySuccessRateResult as any[]).map((row: any) => ({
        template_id: row.template_id,
        success_rate: row.success_rate || 0,
        execution_count: row.execution_count || 0,
      })),
    };

    logger.debug('Aggregate metrics retrieved', metrics);

    return c.json(metrics);

  } catch (error: any) {
    logger.error('GET /v2/activities/metrics/aggregate failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch aggregate metrics',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /scores
 *
 * Get Thompson Sampling scores for all activities in the learned corpus.
 * Used by the Learned Corpus Dashboard to visualize activity beliefs.
 *
 * Query params:
 * - limit: number (default 100, max 500)
 * - min_executions: number (optional, filter activities with minimum executions)
 *
 * Returns: ActivityScoresResponse
 */
app.get('/scores', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    const limitStr = c.req.query('limit') || '100';
    let limit = parseInt(limitStr, 10);
    if (isNaN(limit) || limit < 1) limit = 100;
    limit = Math.min(limit, 500);

    const minExecutionsStr = c.req.query('min_executions');
    const minExecutions = minExecutionsStr ? parseInt(minExecutionsStr, 10) : undefined;

    logger.info('GET /v2/activities/scores', {
      orgId,
      limit,
      minExecutions,
    });

    // Use existing getActivityScores function from paradigm.ts.
    // Phase E: pass accountId so posteriors stay separate per account.
    const result = await getActivityScores(orgId, undefined, jwtAuth?.jwtToken, jwtAuth?.accountId ?? null);

    // Filter by min_executions if specified
    let scores = result.data;
    if (minExecutions && !isNaN(minExecutions)) {
      scores = scores.filter(s => s.total_executions >= minExecutions);
    }

    // Apply limit
    scores = scores.slice(0, limit);

    return c.json({
      scores,
      total: result.data.length,
      path: result.path === 'new' ? 'paradigm' : 'legacy',
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/scores failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity scores',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /corpus-summary
 *
 * Get aggregate metrics for the learned corpus.
 * Used by the Learned Corpus Dashboard to show corpus statistics.
 *
 * Returns: CorpusSummaryResponse
 */
app.get('/corpus-summary', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    logger.info('GET /v2/activities/corpus-summary', { orgId });

    // org_id in v_activity_score is stored as record ID (e.g., "organizations:metabob_internal")
    const fullOrgId = orgId.startsWith('organizations:') ? orgId : `organizations:${orgId}`;

    // Query aggregate metrics from v_activity_score
    // Note: org_id in the view is a record reference, so we use type::record() to convert
    const summaryResult = await surrealDB.query(`
      SELECT
        count() AS total_activities,
        math::sum(total_executions) AS total_executions,
        math::sum(successes) AS total_successes,
        math::sum(failures) AS total_failures,
        math::sum(total_cost_usd) AS total_cost_usd,
        math::mean(<float> alpha / (<float> alpha + <float> beta)) AS avg_belief,
        count(IF total_executions < 5 THEN 1 ELSE NONE END) AS exploration_count,
        count(IF total_executions >= 10 THEN 1 ELSE NONE END) AS exploitation_count
      FROM v_activity_score
      WHERE org_id = type::record($org_id)
      GROUP ALL
    `, { org_id: fullOrgId });

    const stats = summaryResult[0] as any || {};

    const totalExecutions = stats.total_executions || 0;
    const totalSuccesses = stats.total_successes || 0;

    return c.json({
      total_activities: stats.total_activities || 0,
      total_executions: totalExecutions,
      total_successes: totalSuccesses,
      total_failures: stats.total_failures || 0,
      overall_success_rate: totalExecutions > 0 ? totalSuccesses / totalExecutions : 0,
      total_cost_usd: stats.total_cost_usd || 0,
      avg_belief: stats.avg_belief || 0.5,
      exploration_count: stats.exploration_count || 0,
      exploitation_count: stats.exploitation_count || 0,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/corpus-summary failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch corpus summary',
      message: error.message,
    }, 500);
  }
});

// =============================================================================
// Variant Resolver Endpoints (variant-resolver-endpoints)
// =============================================================================

/**
 * GET /v2/activities/:id/variants
 * Get all variants of an activity (recursive family tree).
 *
 * Returns all activities where variant_of matches the base ID,
 * including recursive children up to 3 levels deep.
 *
 * Query params:
 * - None
 *
 * Returns: { variants: VariantInfo[], total: number }
 */
app.get('/:id/variants', async (c) => {
  try {
    const activityId = c.req.param('id');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    logger.info('GET /v2/activities/:id/variants', {
      activityId,
      orgId,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    // Phase E: pass accountId so cross-account variants stay isolated.
    const result = await getVariantFamily(activityId, orgId, jwtAuth?.jwtToken, jwtAuth?.accountId ?? null);

    return c.json({
      variants: result.data,
      total: result.data.length,
      path: result.path,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/:id/variants failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity variants',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/:id/variants
 * Manually trigger variant creation for a template.
 *
 * This endpoint allows users to explicitly request variant creation
 * without waiting for automatic creation from consecutive failures.
 *
 * Request body:
 * - reason: Optional reason for creating the variant (default: 'manual_improvement')
 *
 * Returns:
 * - variant_id: ID of the created variant
 * - variant_generation: Generation number
 * - modifications: Array of modifications made
 * - reason: Reason for variant creation
 */
app.post('/:id/variants', async (c) => {
  try {
    const activityId = c.req.param('id');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B4a: account_id only flows from JWT auth context (sessions
    // don't carry one). Null is valid; reads/writes fall back to org_id.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    // Parse optional request body
    let reason = 'manual_improvement';
    try {
      const body = await c.req.json();
      if (body.reason) {
        reason = body.reason;
      }
    } catch {
      // No body or invalid JSON, use default
    }

    logger.info('POST /v2/activities/:id/variants', {
      activityId,
      orgId,
      reason,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    // Import the createVariant function from variant-creator
    const { createVariant, shouldCreateVariant } = await import('../services/variant-creator');

    // Check current failure pattern to provide context
    // Phase B4a: dual-tenant scoping; pass accountId.
    const failurePattern = await shouldCreateVariant(activityId, orgId, accountId);

    // Create variant even if no failure pattern (manual improvement)
    const defaultFailurePattern = failurePattern || {
      templateId: activityId,
      consecutiveFailures: 0,
      totalExecutions: 0,
      successRate: 1.0,
      commonErrors: [],
      failedTasks: [],
    };

    const variantResult = await createVariant(
      activityId,
      defaultFailurePattern,
      orgId,
      reason,
      accountId
    );

    if (!variantResult) {
      return c.json({
        error: 'Failed to create variant',
        message: 'Variant creation returned null. Template may not exist or maximum variants reached.',
      }, 500);
    }

    // Invalidate Redis template cache so the new variant appears in LIST
    // GETs and any prior per-id stub is dropped. Per-key completeness rule
    // — see src/utils/template-cache.ts.
    await invalidateTemplateCache(variantResult.variantId);

    // Emit variant_created event via WebSocket
    // Phase G1 (2026-04-28): tenancy fields surfaced for filtering.
    broadcaster.emit({
      type: 'variant_created',
      timestamp: new Date().toISOString(),
      data: {
        parent_activity_id: activityId,
        variant_id: variantResult.variantId,
        variant_generation: variantResult.variantGeneration,
        reason: variantResult.reason,
        modifications: variantResult.modifications,
        org_id: orgId ?? null,
        account_id: accountId ?? null,
      },
    });

    return c.json({
      success: true,
      variant_id: variantResult.variantId,
      variant_generation: variantResult.variantGeneration,
      modifications: variantResult.modifications,
      reason: variantResult.reason,
    }, 201);

  } catch (error: any) {
    logger.error('POST /v2/activities/:id/variants failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to create variant',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/:id/variant-scores
 * Get per-variant Thompson Sampling scores.
 *
 * First fetches all variants in the family, then retrieves
 * alpha/beta parameters and metrics for each.
 *
 * Query params:
 * - None
 *
 * Returns: { scores: VariantScore[], total: number }
 */
app.get('/:id/variant-scores', async (c) => {
  try {
    const activityId = c.req.param('id');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    logger.info('GET /v2/activities/:id/variant-scores', {
      activityId,
      orgId,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    // First get all variants in the family.
    // Phase E: pass accountId so cross-account variants stay isolated.
    const accountIdForScopes = jwtAuth?.accountId ?? null;
    const familyResult = await getVariantFamily(activityId, orgId, jwtAuth?.jwtToken, accountIdForScopes);
    const variantIds = familyResult.data.map(v => v.id);

    if (variantIds.length === 0) {
      return c.json({
        scores: [],
        total: 0,
        path: 'new',
      });
    }

    // Then get scores for all variants (account-scoped).
    const scoresResult = await getVariantScores(variantIds, orgId, jwtAuth?.jwtToken, accountIdForScopes);

    return c.json({
      scores: scoresResult.data,
      total: scoresResult.data.length,
      path: scoresResult.path,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/:id/variant-scores failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch variant scores',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/family/:baseId
 * Get genealogy tree for an activity family.
 *
 * Returns a tree structure showing parent-child relationships
 * based on the variant_of field.
 *
 * Query params:
 * - max_depth: number (default: 5, max: 10) - Maximum tree depth
 *
 * Returns: { tree: VariantTreeNode | null, total_nodes: number }
 */
app.get('/family/:baseId', async (c) => {
  try {
    const baseId = c.req.param('baseId');
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;

    if (!orgId) {
      return c.json({ error: 'Organization ID required' }, 401);
    }

    // Parse max_depth parameter
    const maxDepthStr = c.req.query('max_depth') || '5';
    let maxDepth = parseInt(maxDepthStr, 10);
    if (isNaN(maxDepth) || maxDepth < 1) maxDepth = 5;
    maxDepth = Math.min(maxDepth, 10); // Cap at 10 levels

    logger.info('GET /v2/activities/family/:baseId', {
      baseId,
      orgId,
      maxDepth,
      authMethod: jwtAuth ? 'jwt' : 'session',
    });

    const tree = await buildVariantTree(baseId, orgId, maxDepth, jwtAuth?.jwtToken);

    // Count total nodes in tree
    function countNodes(node: VariantTreeNode | null): number {
      if (!node) return 0;
      return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
    }

    const totalNodes = countNodes(tree);

    return c.json({
      tree,
      total_nodes: totalNodes,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/family/:baseId failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch activity family tree',
      message: error.message,
    }, 500);
  }
});

// =============================================================================
// POST /feedback - Manual feedback on activity performance
// =============================================================================
/**
 * Record human feedback on activity performance (/teach and /warn commands)
 *
 * Positive feedback (teach):
 * - Multiplies alpha (success parameter) in Thompson Sampling
 * - Optionally boosts adjacent activities with reduced multiplier
 *
 * Negative feedback (warn):
 * - Multiplies beta (failure parameter) in Thompson Sampling
 * - Does NOT penalize adjacent activities (warnings are specific)
 *
 * Updates impulse_shape_activity_score table for all shapes the activity handles.
 */
app.post('/feedback', async (c) => {
  c.header('x-complexity-probe-feedback', '1');
  try {
    // Check for JWT auth
    const jwtAuth = getJwtAuthFromContext(c);

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B-followup: account_id only flows from JWT auth.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing organization context',
      }, 401);
    }

    // Parse and validate request body
    const body = await c.req.json();
    const validated = ActivityFeedbackRequestSchema.parse(body);

    logger.info('POST /v2/activities/feedback', {
      activity_id: validated.activity_id,
      direction: validated.direction,
      intensity: validated.intensity,
      include_adjacent: validated.include_adjacent,
      reason: validated.reason,
      orgId,
      accountId,
    });

    // Map intensity to multiplier (0=1.5x, 1=2x, 2=2.5x, 3=3x)
    const multiplier = 1.5 + (validated.intensity * 0.5);
    const increment = 1 + validated.intensity;

    // Verify activity exists - normalize ID format
    // SurrealDB uses three ID formats:
    // 1. Simple ID (e.g., "acquire-codebase-context")
    // 2. Angle-bracket wrapped (e.g., "⟨report-metrics⟩")
    // 3. Full record ID (e.g., "activity:report-metrics")
    const normalizedActivityId = validated.activity_id.includes('⟨') || validated.activity_id.includes('⟩')
      ? validated.activity_id
      : `⟨${validated.activity_id}⟩`;

    let activityLookup = await surrealDB.query<{ id: string; input_shapes?: string[] }>(
      `SELECT id, input_shapes FROM activity
       WHERE (meta::id(id) = $activity_id OR meta::id(id) = $normalized_id)
         AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
       LIMIT 1`,
      {
        activity_id: validated.activity_id,
        normalized_id: normalizedActivityId,
      }
    );

    // If not found, try treating activity_id as a full record ID (for activity:xyz format)
    if (activityLookup.length === 0 && validated.activity_id.includes(':')) {
      try {
        activityLookup = await surrealDB.query<{ id: string; input_shapes?: string[] }>(
          `SELECT id, input_shapes FROM activity
           WHERE id = type::record($activity_id)
             AND (execution_type = 'template' OR execution_type IS NONE OR execution_type IS NULL)
           LIMIT 1`,
          { activity_id: validated.activity_id }
        );
      } catch (recordError) {
        logger.debug('Record ID query failed for activity lookup', {
          activity_id: validated.activity_id,
          error: recordError
        });
      }
    }

    if (!activityLookup || activityLookup.length === 0 || !activityLookup[0]) {
      return c.json({
        error: 'Activity not found',
        message: `Activity ${validated.activity_id} does not exist`,
      }, 404);
    }

    const activity = activityLookup[0];
    const inputShapes = activity.input_shapes || [];

    // Find all shape scores for this activity
    // Phase B-followup: dual-tenant scoping; legacy rows match via the
    // org_id branch of accountIdScopedWhere().
    const shapesQuery = await surrealDB.query<ImpulseShapeActivityScore>(
      `SELECT * FROM impulse_shape_activity_score
       WHERE ${accountIdScopedWhere()} AND activity_id = $activity_id`,
      { org_id: orgId, account_id: accountId, activity_id: validated.activity_id }
    );

    const existingScores = shapesQuery || [];

    logger.debug('Found existing shape scores', {
      activity_id: validated.activity_id,
      count: existingScores.length,
      shapes: existingScores.map(s => s.shape),
    });

    // If no scores exist yet, initialize for all input shapes
    if (existingScores.length === 0 && inputShapes.length > 0) {
      logger.info('Initializing shape scores for new activity', {
        activity_id: validated.activity_id,
        shapes: inputShapes,
      });

      for (const shape of inputShapes) {
        // Phase B-followup: dual-write account_id + version on CREATE.
        await surrealDB.query(
          `CREATE impulse_shape_activity_score CONTENT {
            shape: $shape,
            activity_id: $activity_id,
            org_id: $org_id,
            account_id: $account_id ?? NONE,
            account_id_version: $account_id_version,
            success_count: 0,
            failure_count: 0,
            alpha: 1,
            beta: 1,
            updated_at: time::now(),
        created_at: time::now(),
            initialized_from_feedback: true
          }`,
          {
            shape,
            activity_id: validated.activity_id,
            org_id: orgId,
            account_id: accountId,
            account_id_version: 1,
          }
        );
      }

      // Re-fetch scores
      const refreshedScores = await surrealDB.query<ImpulseShapeActivityScore>(
        `SELECT * FROM impulse_shape_activity_score
         WHERE ${accountIdScopedWhere()} AND activity_id = $activity_id`,
        { org_id: orgId, account_id: accountId, activity_id: validated.activity_id }
      );
      existingScores.push(...(refreshedScores || []));
    }

    // Apply feedback multiplier to all shape scores
    const affectedActivities: string[] = [validated.activity_id];

    // Phase 10 P1: atomic bulk multiply on the server. Earlier per-shape
    // loop did SELECT-then-UPDATE over `existingScores`, which loses
    // increments under concurrent feedback (two writes read the same
    // alpha, both compute newAlpha, second UPDATE clobbers first).
    // Single bulk UPDATE computes server-side and is race-free at the row level; that race-freedom must be preserved. The update is ADDITIVE rather than multiplicative because a Beta posterior updates by adding one observation. Multiplying grew concentration exponentially in the evidence count, collapsing variance so Thompson stopped exploring, and it saturated int64 after ~48 observations, making every later feedback POST 500 with 'Cannot perform addition with '1' and '9223372036854775807''. math::min caps each parameter so a row can never saturate again.
    // computes server-side and is race-free at the row level.
    if (validated.direction === 'positive') {
      await surrealDB.query(
        `UPDATE impulse_shape_activity_score
         SET alpha = math::min(1000000, (alpha ?? 1) + $increment), updated_at = time::now()
         WHERE ${accountIdScopedWhere()}
           AND activity_id = $activity_id`,
        {
          multiplier,
          org_id: orgId,
          account_id: accountId,
          activity_id: validated.activity_id,
        }
      );

      logger.info('Applied positive-feedback multiplier to alpha', {
        activity_id: validated.activity_id,
        shapes: existingScores.map(s => s.shape),
        score_count: existingScores.length,
        multiplier,
      });

      // TODO: Handle include_adjacent for positive feedback
      // This would query the composition graph to find adjacent activities
      // and apply a reduced multiplier to their scores
      if (validated.include_adjacent && validated.session_id) {
        logger.debug('Adjacent activity boosting not yet implemented', {
          session_id: validated.session_id,
        });
      }

    } else {
      await surrealDB.query(
        `UPDATE impulse_shape_activity_score
         SET beta = math::min(1000000, (beta ?? 1) + $increment), updated_at = time::now()
         WHERE ${accountIdScopedWhere()}
           AND activity_id = $activity_id`,
        {
          multiplier,
          org_id: orgId,
          account_id: accountId,
          activity_id: validated.activity_id,
        }
      );

      logger.info('Applied negative-feedback multiplier to beta', {
        activity_id: validated.activity_id,
        shapes: existingScores.map(s => s.shape),
        score_count: existingScores.length,
        multiplier,
      });

      // Negative feedback is specific - don't penalize adjacent activities
    }

    // Also credit the activity's variant_performance_metrics posteriors.
    applyOutcomeToPosteriors(
      {
        activity_id: validated.activity_id,
        success: validated.direction === 'positive',
        failure_mode: null,
      },
      surrealDB,
      orgId,
    ).catch((err) => {
      logger.warn('applyOutcomeToPosteriors failed (non-blocking, /feedback)', {
        activity_id: validated.activity_id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Invalidate Redis cache for template recommendations
    try {
      const redisWrapper = RedisClient.getInstance();
      const redis = redisWrapper.getClient();
      if (redis) {
        // Invalidate all cached recommendations since scores changed
        const keys = await redis.keys(`${CACHE_KEY_PREFIX}*`);
        if (keys.length > 0) {
          await redis.del(...keys);
          logger.debug('Invalidated Redis cache after feedback', {
            keys_deleted: keys.length,
          });
        }
      }
    } catch (redisError) {
      logger.warn('Failed to invalidate Redis cache', {
        error: redisError instanceof Error ? redisError.message : String(redisError),
      });
      // Non-critical, continue
    }

    // Emit WebSocket event for dashboard updates
    // Phase G1 (2026-04-28): account_id surfaced alongside org_id for filtering.
    try {
      broadcaster.emit({
        type: 'feedback_recorded',
        timestamp: new Date().toISOString(),
        data: {
          activity_id: validated.activity_id,
          direction: validated.direction,
          intensity: validated.intensity,
          multiplier,
          affected_activities: affectedActivities,
          org_id: orgId,
          account_id: accountId ?? null,
        },
      });
    } catch (wsError) {
      logger.warn('Failed to emit WebSocket event', {
        error: wsError instanceof Error ? wsError.message : String(wsError),
      });
      // Non-critical, continue
    }

    // Log feedback for learning (optional audit trail)
    if (validated.reason) {
      logger.info('Feedback reason', {
        activity_id: validated.activity_id,
        direction: validated.direction,
        reason: validated.reason,
      });
    }

    const response: ActivityFeedbackResponse = {
      success: true,
      affected_activities: affectedActivities,
      multiplier,
      direction: validated.direction,
      message: `${validated.direction === 'positive' ? 'Positive' : 'Negative'} feedback applied with ${multiplier}x multiplier`,
    };

    return c.json(response, 200);

  } catch (error: any) {
    logger.error('POST /v2/activities/feedback failed', {
      error: error.message,
      stack: error.stack,
    });

    // Handle Zod validation errors
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation error',
        message: error.errors[0]?.message || 'Invalid request body',
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record feedback',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/discover-by-shapes
 * Discover activities by their input/output shapes
 *
 * Supports two modes:
 * - forward (default): Find activities that produce required_shapes (backward chaining - find producers)
 * - backward: Find activities that consume required_shapes (forward chaining - find consumers)
 *
 * Use case:
 * - Forward mode: "I need shape X, who can produce it?" (prerequisite discovery)
 * - Backward mode: "I have shape Y, what can consume it?" (next step discovery)
 */
app.post('/discover-by-shapes', async (c) => {
  c.header('x-complexity-probe-discover', '1');
    logger.debug('discover-by-shapes request received');
  try {
    const body = await c.req.json();
    // output_shapes: optional additive filter on backward mode — see OpenSpec change 2026-04-26-validators-and-failure-modes.
    const input = {
      required_shapes: body.required_shapes,
      mode: body.mode ?? 'forward',
      limit: body.limit ?? 10,
      current_shapes: body.current_shapes ?? [],
      output_shapes: body.output_shapes ?? [],
      predecessor_activity_id: body.predecessor_activity_id,
      // Successor-features readout (mechanism #7): goal direction (s, R).
      signature: body.signature,
      completion_shapes: body.completion_shapes,
      sf_scope: body.sf_scope,
    };

    const validationError = validateDiscoverByShapesInput(input);
    if (validationError) {
      return c.json({
        error: validationError.error,
        message: validationError.message,
      }, 400);
    }

    const result = await runDiscoverByShapes(input);

    return c.json({
      activities: result.activities,
      total: result.total,
    });

  } catch (error: any) {
    logger.error('POST /v2/activities/discover-by-shapes failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to discover activities by shapes',
      message: error.message,
    }, 500);
  }
});

export default app;
/**
 * POST /recommend
 *
 * Get activity recommendations using Thompson Sampling
 * 
 * Request body:
 * {
 *   task_description: string,
 *   category?: string,
 *   loaded_impulses?: string[],
 *   limit?: number
 * }
 * 
 * Returns:
 * {
 *   recommendations: [
 *     {
 *       template_id: string,
 *       selection_metadata: {
 *         method: "thompson_sampling",
 *         alpha: number,
 *         beta: number,
 *         sample: number,
 *         score: number
 *       }
 *     }
 *   ]
 * }
 */
app.post('/recommend', async (c) => {
  try {
    const body = await c.req.json();
    const {
      task_description,
      category,
      tags,           // NEW: Filter by exact tags
      tag_prefix,     // NEW: Filter by tag prefix (e.g., "feature" matches "feature.vessel")
      execution_type, // T8: Filter by execution type (template, tool, composition, vessel_function)
      loaded_impulses = [],
      impulse_shapes = [],  // Array of impulse shapes for schema filtering
      expected_output_shapes = [],  // Array of expected output shapes from goal enrichment
      limit = 3,
      exclude_activities = [],  // T4: Blacklist of activity IDs to exclude
      exclude_variant,          // G6.1.1: single variant to exclude (differential-solve)
      session_context,          // Spec 2/3/4: loaded impulse state with timestamps
      exploration_config: rawExplorationConfig,
      impulse_state_space,      // Phase 11: executor's loaded impulse pool (state-space-aware filtering)
      state_signature: callerStateSignature,  // C6 read-back: caller-supplied state-space signature (overrides server-side derivation for the cts lookup)
    repair_signature: callerRepairSignature, // D1 (REPAIR_SIGNATURE_CONSUME): failure-class signature of the attempt being retried
      completion_shapes = [],   // Mechanism #7: goal direction R for the successor-features look-ahead ⟨ψ(s,a),R⟩. When present + SF_BLEND on, ψ steers the ranking argmax.
      // NOTE: pointer_state_space is intentionally NOT destructured — derived server-side
    } = body;

    // Strip pointer_state_space if caller sent it (backward-compat warning)
    if ((body as any).pointer_state_space !== undefined) {
      logger.warn('POST /recommend: pointer_state_space in request body is ignored; derived server-side from ExecutionScope');
    }

    const exploration_config = {
      exploration_ratio: 0.2,
      min_observations_threshold: 5,
      ...(rawExplorationConfig ?? {}),
    };
    const exploration_ratio = Math.max(0, Math.min(1, exploration_config.exploration_ratio ?? 0.2));
    const min_observations_threshold = Math.max(0, Math.floor(exploration_config.min_observations_threshold ?? 5));

    if (session_context) {
      const sc = session_context as SessionContext;
      const len = sc.loaded_shapes?.length ?? 0;
      if (
        (sc.loaded_pointer_paths?.length ?? 0) !== len ||
        (sc.load_timestamps_ms?.length ?? 0) !== len
      ) {
        return c.json({ error: 'session_context arrays must be the same length' }, 400);
      }
    }

    logger.info('POST /recommend', {
      task_description: task_description?.substring(0, 100),
      category,
      tags,
      tag_prefix,
      execution_type,
      loaded_impulses,
      impulse_shapes,
      expected_output_shapes,
      limit
    });

    // Validate required fields
    if (!task_description) {
      return c.json({
        error: 'task_description is required',
      }, 400);
    }

    // SEMANTIC ANALYSIS: Extract tag prefixes and implied shapes from task description
    const semantics = analyzeTaskSemantics(task_description);

    // Use extracted tag prefixes if not explicitly provided
    const effectiveTagPrefix = tag_prefix || semantics.tagPrefixes[0] || null;
    const effectiveTags = tags || (semantics.tagPrefixes.length > 0 ? semantics.tagPrefixes.slice(0, 3) : null);

    // Augment impulse_shapes with semantically implied shapes
    const effectiveShapes = [...new Set([...impulse_shapes, ...semantics.impliedShapes])];

    logger.info('Semantic analysis', {
      extractedTags: semantics.tagPrefixes,
      impliedShapes: semantics.impliedShapes,
      primaryIntent: semantics.primaryIntent,
      effectiveTagPrefix,
      effectiveTags,
      effectiveShapes,
    });

    // Get session data for multi-tenant filtering
    const sessionData = (c.get as any)('session') as SessionData | undefined;
    const jwtAuth = getJwtAuthFromContext(c);
    const orgId = jwtAuth?.orgId || sessionData?.org_id || null;
    const projectId = jwtAuth?.projectId || sessionData?.project_id || null;

    // Build FTS query: augment task_description with session_context tokens when present.
    // Tier 1/2 (shape-based) are not affected — only the FTS (Tier 3) query is enriched.
    let ftsQuery = task_description;
    let contextDecayWeightsByShape: Map<string, number> = new Map();
    if (session_context) {
      const sc = session_context as SessionContext;
      const nowMs = Date.now();
      const { tokens: augmentTokens, decayWeightsByShape } = extractContextTokensWithDecay(sc, 3, nowMs);
      contextDecayWeightsByShape = decayWeightsByShape;
      if (augmentTokens.length > 0) {
        ftsQuery = `${task_description} ${augmentTokens.join(' ')}`;
        logger.debug('FTS query augmented with session_context tokens', {
          fts_query_augmented: ftsQuery.substring(0, 120),
          augment_tokens: augmentTokens,
          hot_count: 3,
        });
      }
    }

    // Compute context_bucket for per-context Thompson Sampling (Spec 3)
    const contextBucket = orgId
      ? computeContextBucket(task_description, effectiveShapes, orgId)
      : null;
    if (contextBucket) {
      logger.debug('context_bucket computed', { context_bucket: contextBucket });
    }

    // Query activities using tiered fallback strategy
    // Tier 1: Exact shape match, Tier 2: Compatible (no shapes), Tier 3: FTS on goal description
    const fallbackResult = await getActivitiesWithTieredFallback(
      effectiveShapes,
      category || null,
      ftsQuery,
      orgId,
      execution_type || null,
      limit,
      jwtAuth?.jwtToken || null
    );

    let templates: any[] = fallbackResult.activities;
    let fallbackTier: string | null | undefined = fallbackResult.tier;

    // Scaffold/gaming exclusion (2026-06-22): compose-* wrappers (compose-topology
    // -tick scaffold — record wrapper->child + hub edges, not genuine producer->
    // consumer composition) and genuine-edge-probe (λ₁-gaming machinery) are never
    // the right answer for a goal. They pollute selection — they keep being minted
    // fresh with Beta(1,1) priors so per-goal Thompson penalty can't keep up — and
    // are WHY goals select goal-irrelevant scaffold and never reach. Exclude them
    // at the candidate gate so genuine capability activities surface, goals reach,
    // and the action-space mesh connects. (Internal scaffold flows dispatch via
    // target_template_id, which bypasses /recommend, so this only affects
    // goal-driven selection.)
    {
      const beforeScaffold = templates.length;
      templates = templates.filter((t: any) => {
        // C7: PREFER a durable edge_kind/genuine tag when the candidate carries one
        // (forward-compatible — candidate rows joined with composition-edge data will
        // surface it); fall back to the template-id heuristic for untagged candidates
        // (the common case — recommend candidates are templates, not edge rows). A
        // candidate tagged hub/scaffold is excluded; one tagged genuine is kept even
        // if its id happens to match a marker substring.
        if (t && typeof t.genuine === 'boolean') return t.genuine;
        if (t && typeof t.edge_kind === 'string' && t.edge_kind.length > 0) return t.edge_kind === 'genuine';
        const id = String((t && (t.id || t.variant_id)) || '');
        return !id.includes('compose-') && !id.includes('genuine-edge-probe');
      });
      if (templates.length !== beforeScaffold) {
        logger.info('Scaffold exclusion applied to recommend candidates', {
          before: beforeScaffold, after: templates.length,
        });
      }
    }

    logger.info('Templates fetched for recommendation', {
      count: templates.length,
      fallback_tier: fallbackTier,
    });

    // T4: Filter out excluded activities (within-goal blacklisting) and G6.1.1 differential-solve variant
    // normalizeRecordId applied so callers can pass either raw or normalized IDs
    if ((exclude_activities && exclude_activities.length > 0) || exclude_variant) {
      const beforeCount = templates.length;
      const excludeSet = new Set([
        ...exclude_activities.map((id: string) => normalizeRecordId(id)),
        ...(exclude_variant ? [normalizeRecordId(exclude_variant)] : []),
      ]);
      templates = templates.filter((t: any) => !excludeSet.has(normalizeRecordId(t.id || t.variant_id)));
      logger.info('Blacklist filtering applied', {
        before: beforeCount,
        after: templates.length,
        excluded: exclude_activities,
        ...(exclude_variant ? { exclude_variant } : {}),
      });
    }

    // Get Thompson Sampling scores
    // Use shape-conditioned scores when impulse_shapes are provided (goal-aware recommendations)
    // This allows learning different success rates for different input contexts
    // Note: Use normalizeRecordId to convert SurrealDB RecordId objects to strings
    const activityIds = templates.map((t: any) =>
      normalizeRecordId(t.id || t.variant_id)
    );
    let scoresMap = new Map<string, ActivityScore>();
    let scoreMethod: 'shape_conditioned' | 'global' | 'legacy' = 'legacy';

    if (activityIds.length > 0 && orgId) {
      // Use shape-conditioned scores when shapes are provided (includes semantically implied shapes)
      // Phase E: pass accountId so posteriors stay separated per account.
      const recommendAccountId = jwtAuth?.accountId ?? null;
      if (effectiveShapes && effectiveShapes.length > 0) {
        const shapeScoresResult = await getShapeConditionedScores(
          orgId,
          activityIds,
          effectiveShapes,
          jwtAuth?.jwtToken,
          recommendAccountId
        );
        for (const score of shapeScoresResult.data) {
          scoresMap.set(score.activity_id, score);
        }
        // Check if we got shape-conditioned data or fell back to global
        const hasShapeData = shapeScoresResult.data.some(
          (s: any) => s.shape_signature && s.shape_signature.length > 0
        );
        scoreMethod = hasShapeData ? 'shape_conditioned' : 'global';
        logger.info('[paradigm] Shape-conditioned scores fetched', {
          count: shapeScoresResult.data.length,
          path: shapeScoresResult.path,
          scoreMethod,
          original_shapes: impulse_shapes,
          effective_shapes: effectiveShapes,
          semantic_additions: semantics.impliedShapes,
        });
      } else {
        // Fall back to global activity scores
        const scoresResult = await getActivityScores(orgId, activityIds, jwtAuth?.jwtToken, recommendAccountId);
        for (const score of scoresResult.data) {
          scoresMap.set(score.activity_id, score);
        }
        scoreMethod = 'global';
        logger.debug('[paradigm] Activity scores fetched (global)', {
          count: scoresResult.data.length,
          path: scoresResult.path,
        });
      }
    } else {
      // Fallback: Use enrichTemplatesWithMetrics for legacy path
      templates = await enrichTemplatesWithMetrics(templates);
    }

    // Selection-time posterior decay (openspec 2026-07-29-thompson-posterior-time-decay):
    // decay stored alpha/beta toward the neutral prior (1,1) by row staleness at READ
    // time, so a posterior poisoned during a transient outage (and then never selected,
    // hence never re-written) still heals. Mirrors the write-time decay in
    // posterior-update.ts; half-life is a shaped tuning row, read at use time.
    const decayHalfLifeDays = await resolveThompsonDecayHalfLifeDays();
    const decayNowMs = Date.now();
    const decayRow = (alpha: number, beta: number, lastUpdated: unknown): { alpha: number; beta: number } => {
      const ms = lastUpdated ? new Date(lastUpdated as any).getTime() : NaN;
      // No timestamp on the row -> leave counts untouched (never zero out blind rows at read).
      if (!Number.isFinite(ms)) return { alpha, beta };
      return decayedThompsonCounts(alpha, beta, ms, decayNowMs, decayHalfLifeDays);
    };

    // Lookup per-bucket Thompson scores (Spec 3)
    // Phase B1: dual-scope by account_id; legacy rows match via org_id.
    let contextScoresMap = new Map<string, { alpha: number; beta: number; n_observations: number }>();
    if (contextBucket && activityIds.length > 0) {
      try {
        const ctxResult = await surrealDB.query<any>(`
          SELECT template_id, alpha, beta, n_observations, last_updated_at
          FROM context_thompson_scores
          WHERE ${accountIdScopedWhere()} AND context_bucket = $bucket AND template_id IN $ids
        `, {
          org_id: orgId,
          account_id: jwtAuth?.accountId ?? null,
          bucket: contextBucket,
          ids: activityIds,
        });

        for (const row of (ctxResult || [])) {
          const decayedCtx = decayRow(row.alpha ?? 1, row.beta ?? 1, row.last_updated_at);
          contextScoresMap.set(row.template_id, {
            alpha: decayedCtx.alpha,
            beta: decayedCtx.beta,
            n_observations: row.n_observations ?? 0,
          });
        }
      } catch (ctxErr: any) {
        logger.warn('context_thompson_scores lookup failed (non-blocking)', {
          error: ctxErr.message,
        });
      }
    }

    // Phase 24 §4: conditional posterior lookup using v1 state-space signature
    // Queries signature_version=1 rows; overrides α/β when n_observations >= SIGNATURE_SAMPLING_FLOOR.
    const SIGNATURE_SAMPLING_FLOOR = parseInt(
      process.env.RECOMMEND_SIGNATURE_SAMPLING_FLOOR ?? '5', 10
    );
    // Cross-signature reputation penalty (2026-06-25 composition-gap lever 3).
    // Env-flag-gated, default OFF: when unset/falsey, the reputation factor is
    // always 1.0 (current behavior byte-for-byte preserved). See
    // applyReputationFactor() in services/thompson-sampling.ts.
    const CROSS_SIG_REPUTATION_PENALTY = (await getTuningParam("CROSS_SIG_REPUTATION_PENALTY", process.env.CROSS_SIG_REPUTATION_PENALTY, 0)) >= 1;
    const CROSS_SIG_MIN_GLOBAL_OBS = parseInt(
      process.env.CROSS_SIG_REPUTATION_MIN_GLOBAL_OBS ?? '5', 10
    );
    // Empirical-badness floor (2026-07-23 law-12 causal-discipline fix, default ON).
    // Full rationale at the per-template application in the recommendations map below.
    // Bars a template that is PROVEN-self-failing (>= MIN_OBS own runs, own-success rate
    // < MIN_RATE) from being SELECTED TO RUN, regardless of chain-credit-inflated alpha or
    // declared output-shape coverage. Reversible: EMPIRICAL_BADNESS_FLOOR=0 restores prior.
    const EMPIRICAL_BADNESS_FLOOR_ENABLED = (await getTuningParam("EMPIRICAL_BADNESS_FLOOR", process.env.EMPIRICAL_BADNESS_FLOOR, 1)) >= 1;
    const EMPIRICAL_BADNESS_MIN_OBS = parseInt(process.env.EMPIRICAL_BADNESS_MIN_OBS ?? '20', 10);
    const EMPIRICAL_BADNESS_MIN_RATE = parseFloat(process.env.EMPIRICAL_BADNESS_MIN_RATE ?? '0.02');
    // The floor's GLOBAL honest counts come from `template.metrics`
    // (successful_executions/failed_executions), populated by enrichTemplatesWithMetrics
    // from variant_performance_metrics — the SAME durable counters selection reads
    // thompson_alpha from. We deliberately do NOT read v_activity_score for this: it is
    // computed by counting live execution rows, so a template whose raw traces were reaped
    // shows an EMPTY row there (total_executions 0) even while variant_performance_metrics
    // still records thousands of failures — which is exactly the pollution case
    // (0 success / thousands fail, reaped). See the per-template application below.
    let stateSpaceSig: string | null = null;
    const sigScoresMap = new Map<string, { alpha: number; beta: number; n_observations: number }>();
    const repairScoresMap = new Map<string, number>();
    // D5 partial-pooling: cluster posteriors keyed by template_id, used ONLY for
    // templates whose leaf signature posterior is cold (n_signature < N_MIN).
    const SIGNATURE_VERSION = 1;
    const clusterScoresMap = new Map<string, { alpha: number; beta: number; n_observations: number }>();
    let clusterIdForSig: string | null = null;
    let clusterContaminated = false;
    // D5.3 — per-template partial-pooling decisions to emit as a cluster_shadow_decision.
    const clusterShadowDecisions: Array<{
      template_id: string;
      n_signature: number;
      used_scope: 'signature' | 'cluster' | 'fallback';
    }> = [];

    // C6: derive the v1 state-space signature SERVER-SIDE from effectiveShapes
    // (impulse_shapes ∪ implied) so conditional posteriors are keyed even when the
    // caller (e.g. goal-host) omits impulse_state_space. When impulse_state_space IS
    // supplied we still use it for provenance/shape detail (richer signature); otherwise
    // we fall back to the shape set already computed above. Same helper as the write
    // path (execution-traces.ts) so read/write keys match byte-for-byte.
    const hasStateSpace = Array.isArray(impulse_state_space) && impulse_state_space.length > 0;
    // C6 read-back: when the caller already knows the recorded state-space
    // signature (a 16-hex hash from computeStateSpaceSignature, e.g. threaded
    // back from a prior trace), use it DIRECTLY as the cts lookup key instead of
    // re-deriving it. This closes the read path for callers that carry the
    // signature forward; when absent we fall back to server-side derivation from
    // the shape pool (byte-identical to the write path) — preserving prior behavior.
    const callerSig =
      typeof callerStateSignature === 'string' && /^[0-9a-f]{16}$/.test(callerStateSignature)
        ? callerStateSignature
        : null;
    const sigShapes = hasStateSpace
      ? (impulse_state_space as any[]).map((e: any) => e.shape ?? e).filter(Boolean)
      : effectiveShapes;
    if ((callerSig || sigShapes.length > 0) && activityIds.length > 0) {
      try {
        stateSpaceSig = callerSig ?? computeStateSpaceSignature({
          shapes: sigShapes,
          provenance: hasStateSpace
            ? (impulse_state_space as any[])
                .filter((e: any) => e.produced_by || e.produced_at_task_id)
                .map((e: any) => ({ shape: e.shape ?? e, producedBy: e.produced_by ?? e.produced_at_task_id }))
            : [],
          missing: [],  // blocking_shapes computed later; signature uses present pool
        });

        const sigResult = await surrealDB.query<any>(`
          SELECT template_id, alpha, beta, n_observations, last_updated_at
          FROM context_thompson_scores
          WHERE org_id = $org_id AND signature_version = 1 AND context_bucket = $sig AND template_id IN $ids
        `, {
          org_id: orgId,
          sig: stateSpaceSig,
          ids: activityIds,
        });

        for (const row of (sigResult || [])) {
          if (row.template_id) {
            const decayedSig = decayRow(row.alpha ?? 1, row.beta ?? 1, row.last_updated_at);
            sigScoresMap.set(row.template_id, {
              alpha: decayedSig.alpha,
              beta: decayedSig.beta,
              n_observations: row.n_observations ?? 0,
            });
          }
        }

        const repairSigForBoost = (await getTuningParam("REPAIR_SIGNATURE_CONSUME", process.env.REPAIR_SIGNATURE_CONSUME, 0)) >= 1 ? validRepairSignature(callerRepairSignature) : null;
      if (repairSigForBoost) {
        try {
          const repairRows = await surrealDB.query<any>(`SELECT template_id, alpha, beta, n_observations FROM context_thompson_scores WHERE org_id = $org_id AND signature_version = 2 AND context_bucket = $sig AND template_id IN $ids`, { org_id: orgId, sig: repairSigForBoost, ids: activityIds });
          for (const [k, v] of repairBoostFromRows(repairRows || [])) repairScoresMap.set(k, v);
        } catch { /* non-fatal */ }
      }
      logger.debug('v1 conditional posterior lookup', {
          sig: stateSpaceSig,
          hits: sigScoresMap.size,
          floor: SIGNATURE_SAMPLING_FLOOR,
        });

        // D5.1 — partial-pooling read. When a leaf signature posterior is COLD
        // (n_signature = alpha+beta-2 < N_MIN), the selector falls back to the
        // well-sampled CLUSTER posterior instead of an uninformed Beta(1,1).
        //
        // CRITICAL SAFETY: this is a SHADOW pre-fetch only — entirely best-effort,
        // wrapped here AND inside the cluster-posterior helpers. Any error/miss
        // leaves sigScoresMap (the leaf path) untouched, so the well-sampled
        // (n_signature >= N_MIN) path is byte-for-byte unchanged. Contaminated
        // clusters are NEVER used.
        if (stateSpaceSig) {
          try {
            const assignment = await lookupAssignment(surrealDB, stateSpaceSig, SIGNATURE_VERSION);
            clusterIdForSig = assignment?.cluster_id ?? null;
            clusterContaminated = assignment?.contaminated === true;

            // Only consult the cluster for templates whose leaf is cold (or absent).
            const coldTemplateIds = activityIds.filter((tid: string) => {
              const leaf = sigScoresMap.get(tid);
              const nSig = leaf ? (leaf.alpha + leaf.beta - 2) : 0;
              return !leaf || nSig < SIGNATURE_CLUSTER_N_MIN;
            });

            if (assignment && !assignment.contaminated && assignment.cluster_id && coldTemplateIds.length > 0) {
              const clusterId = assignment.cluster_id;
              await Promise.all(
                coldTemplateIds.map(async (tid: string) => {
                  const clusterRow = await readClusterPosterior(
                    surrealDB, orgId, tid, SIGNATURE_VERSION, clusterId,
                  );
                  if (clusterRow) {
                    clusterScoresMap.set(tid, {
                      alpha: clusterRow.alpha,
                      beta: clusterRow.beta,
                      n_observations: clusterRow.n_observations,
                    });
                  }
                }),
              );
            }

            logger.debug('cluster partial-pooling pre-fetch', {
              sig: stateSpaceSig,
              cluster_id: clusterIdForSig,
              contaminated: clusterContaminated,
              cold_templates: coldTemplateIds.length,
              cluster_hits: clusterScoresMap.size,
              n_min: SIGNATURE_CLUSTER_N_MIN,
            });
          } catch (clusterErr: any) {
            // Best-effort: leaf/Beta(1,1) selection proceeds exactly as today.
            logger.warn('cluster partial-pooling pre-fetch failed (non-blocking)', {
              error: clusterErr?.message ?? String(clusterErr),
            });
          }
        }
      } catch (sigErr: any) {
        logger.warn('v1 conditional posterior lookup failed (non-blocking)', {
          error: sigErr.message,
        });
      }
    }

    // Calculate impulse relevancy boosts (with optional decay weights from session_context)
    const decayWeightsForRelevancy = contextDecayWeightsByShape.size > 0 ? contextDecayWeightsByShape : undefined;
    const impulseBoostsMap = await calculateImpulseRelevancyBoosts(activityIds, loaded_impulses, decayWeightsForRelevancy);

    // Discover missing impulses that would unlock better activities
    const missingImpulseSuggestions = await discoverMissingImpulses(activityIds, loaded_impulses, 5);

    if (missingImpulseSuggestions.length > 0) {
      logger.info('Missing impulse suggestions', {
        count: missingImpulseSuggestions.length,
        top_suggestion: missingImpulseSuggestions[0]?.impulse_id,
        suggestions: missingImpulseSuggestions.map(s => ({
          impulse: s.impulse_id,
          unlocks: s.unlocks_activities.length,
        })),
      });
    }

    // Filter out templates without a valid ID or that are retired before processing
    // Note: Use normalizeRecordId to handle SurrealDB RecordId objects
    const validTemplates = templates.filter((template: any) => {
      const templateId = normalizeRecordId(template.id || template.variant_id);
      if (!templateId || templateId.trim() === '') {
        logger.warn('Filtering out template without valid ID', {
          template_name: template.name || template.variant_name,
          template_id: normalizeRecordId(template.id),
          variant_id: template.variant_id,
        });
        return false;
      }

      // Filter out retired templates
      if (template.retired === true) {
        logger.debug('Filtering out retired template', {
          template_id: templateId,
          template_name: template.name || template.variant_name,
          retired_reason: template.retired_reason,
        });
        return false;
      }

      // Proposed templates are NOT filtered out here. They flow into the
      // exploration pool only (see exploitationPool partition below). This is
      // the substrate-autonomous lift path: substrate-authored templates get
      // selected for real execution under exploration weight, accumulate
      // empirical α/β, and the autonomous-promote endpoint (no operator action
      // required) flips proposed=false once empirical evidence clears the
      // threshold. Per operator directive 2026-05-27 — lift is gate-removal,
      // not gate-relocation.
      return true;
    });

    if (validTemplates.length < templates.length) {
      logger.info('Templates filtered for missing IDs', {
        before: templates.length,
        after: validTemplates.length,
        filtered: templates.length - validTemplates.length,
      });
    }

    // UCB: total org executions derived from already-fetched scoresMap — no extra DB query
    const total_org_executions = Math.max(1, [...scoresMap.values()].reduce((sum, s) => sum + (s.total_executions ?? 0), 0));

    function ucbScore(totalExecs: number, successes: number): number {
      const n = totalExecs;
      const mean = n === 0 ? 0 : successes / n;
      return mean + Math.sqrt(2 * Math.log(total_org_executions) / Math.max(n, 1));
    }

    // Apply Thompson Sampling with heuristic prior boosting
    const recommendations = validTemplates
      .map((template: any) => {
        // Try to get alpha/beta from v_activity_score first
        // Note: Use normalizeRecordId for consistent Map lookups and API output
        const activityId = normalizeRecordId(template.id || template.variant_id);
        // selector-unscored fix: the activity + shape-conditioned score maps are keyed by
        // the BARE activity id — getActivityScores/getShapeConditionedScores strip the
        // "activity:" prefix and ⟨⟩ brackets before matching and return `variant_id AS
        // activity_id`. This lookup used the PREFIXED RecordId form, so every get() MISSED
        // and alpha/beta fell back to the template's GLOBAL thompson metric — making
        // recommend rank by global sample mass, blind to the goal's shape signature (the
        // system's content-blind forward model). Try the bare key first; keep the prefixed
        // key as a fallback so behaviour is preserved if a map is ever keyed the other way.
        const scoreKey = normalizeActivityId(template.id || template.variant_id);
        const scores = scoresMap.get(scoreKey) ?? scoresMap.get(activityId);
        let alpha = scores?.alpha || template.metrics?.thompson_alpha || 1.0;
        let betaVal = scores?.beta || template.metrics?.thompson_beta || 1.0;
        // Selection-time decay of the global posterior (see decayRow above): the only
        // staleness anchor v_activity_score / legacy metrics carry is last_executed_at —
        // exactly the "has not run in a long time" signal the decay is for. Rows without
        // it (or metrics-fallback values) are left untouched.
        if (scores?.last_executed_at) {
          const decayedGlobal = decayRow(alpha, betaVal, scores.last_executed_at);
          alpha = decayedGlobal.alpha;
          betaVal = decayedGlobal.beta;
        }

        // HEURISTIC BOOSTS: Encode domain knowledge as informative priors
        const templateTags = template.tags || [];
        const templateShapes = template.input_shapes || [];
        let totalBoost = 0;

        // 1. Tag match quality boost (+0 to +10 based on match quality)
        // Higher weight ensures semantic relevance outweighs execution history
        const tagMatchQuality = semantics.getMatchQuality(templateTags);
        const tagBoost = Math.floor(tagMatchQuality * 10);
        totalBoost += tagBoost;

        // 2. Shape compatibility boost (+3 if input_shapes ⊆ available shapes)
        const shapeCompatible = templateShapes.length === 0 ||
          templateShapes.every((shape: string) => effectiveShapes.includes(shape));
        const shapeBoost = shapeCompatible ? 3 : 0;
        totalBoost += shapeBoost;

        // 3. Recency boost (+1 for templates created in last 30 days)
        const createdAt = template.created_at ? new Date(template.created_at) : null;
        const daysSinceCreation = createdAt ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24) : Infinity;
        const recencyBoost = daysSinceCreation < 30 ? 1 : 0;
        totalBoost += recencyBoost;

        // 4. Execution history boost (proven templates get +1 to +3)
        // Reduced weight prevents well-tested but irrelevant templates from dominating
        const executionCount = (scores?.successes || 0) + (scores?.failures || 0);
        const historyBoost = Math.min(3, Math.floor(executionCount / 20));
        totalBoost += historyBoost;

        // 5. Scope preference boost (+1 for org-specific templates)
        const scopeBoost = template.scope === 'org' || template.scope === 'project' ? 1 : 0;
        totalBoost += scopeBoost;

        // 6. Impulse relevancy boost (based on loaded impulses)
        const impulseBoost = impulseBoostsMap.get(activityId);
        const impulseAlphaBoost = impulseBoost?.alphaBoost || 0;
        const impulseBetaPenalty = impulseBoost?.betaPenalty || 0;
        totalBoost += impulseAlphaBoost;

        // 7. Category preference boost (soft, not hard filter)
        const templateCategory = template.category;
        let categoryBoost = 0;
        if (category && templateCategory === category) {
          categoryBoost = 3;  // Exact category match
        }
        totalBoost += categoryBoost;

        // 8. Output shape coverage boost (based on expected outcomes from goal enrichment)
        // Activities whose output_shapes cover expected outcomes get boosted
        const templateOutputShapes = template.output_shapes || [];
        const outputCoverage = calculateOutputShapeCoverage(expected_output_shapes, templateOutputShapes);
        // +0 to +4 based on coverage (0% = +0, 50% = +2, 100% = +4)
        const outputShapeBoost = Math.floor(outputCoverage * 4);
        totalBoost += outputShapeBoost;

        // 9. Shape mismatch penalty (penalize templates missing required shapes)
        // If we have expected shapes (from context/impulses), penalize activities that don't support them
        let shapeMismatchPenalty = 0;
        if (effectiveShapes && effectiveShapes.length > 0) {
          const missingShapes = effectiveShapes.filter(
            (shape: string) => !templateShapes.includes(shape)
          );
          shapeMismatchPenalty = missingShapes.length * -2;
          totalBoost += shapeMismatchPenalty;

          if (missingShapes.length > 0) {
            logger.debug('Shape mismatch penalty', {
              template_id: template.id,
              template_name: template.name,
              expected_shapes: effectiveShapes,
              template_shapes: templateShapes,
              missing_shapes: missingShapes,
              missing_count: missingShapes.length,
              penalty: shapeMismatchPenalty,
            });
          }
        }

        // Log boost calculation for debugging
        logger.debug('Thompson boost calculation', {
          template_id: activityId,
          template_name: template.name || template.variant_name,
          execution_boost: historyBoost,
          tag_boost: tagBoost,
          total_boost: totalBoost,
          boost_breakdown: {
            tag_match: tagBoost,
            shape_compatible: shapeBoost,
            recency: recencyBoost,
            execution_history: historyBoost,
            scope_preference: scopeBoost,
            impulse_relevancy: impulseAlphaBoost,
            category_match: categoryBoost,
            output_shape_coverage: outputShapeBoost,
            shape_mismatch_penalty: shapeMismatchPenalty,
          },
        });

        // Apply boosts and penalties
        alpha += totalBoost;
        const adjustedBeta = betaVal + impulseBetaPenalty;

        // Context-bucketed Thompson blend (Spec 3)
        const ctxRow = contextScoresMap.get(activityId);
        const nContext = ctxRow ? (ctxRow.alpha + ctxRow.beta - 2) : 0;
        const blendWeight = nContext >= 5 ? 0.7 : nContext >= 2 ? 0.3 : 0.0;
        let alphaBlended = blendWeight * (ctxRow?.alpha ?? 1) + (1 - blendWeight) * alpha;
        if (repairScoresMap.size > 0 && repairScoresMap.has(activityId)) alphaBlended += repairScoresMap.get(activityId)!;
        let betaBlended  = blendWeight * (ctxRow?.beta  ?? 1) + (1 - blendWeight) * adjustedBeta;

        // Phase 24 §4: v1 conditional posterior override
        // When state-space-signature row has enough observations, use it directly.
        let posteriorSource: string = blendWeight > 0 ? 'context_bucketed' : scoreMethod;
        const repairBoost = repairScoresMap.get(activityId) ?? 0;
        const sigRow = sigScoresMap.get(activityId);
        // C6: apply the conditional (signature-keyed) posterior only when it has
        // enough observations AND there are ≥2 candidates — so the signature
        // DIFFERENTIATES between arms, never collapses a single-candidate set onto
        // one posterior. Falls back to the global/context-bucketed posterior otherwise.
        // (leafConditionalActive also gates the D5 cluster fallback below — the
        // validTemplates≥2 guard applies to both paths.)
        const leafConditionalActive = !!(
          sigRow &&
          sigRow.n_observations >= SIGNATURE_SAMPLING_FLOOR &&
          validTemplates.length >= 2
        );
        if (leafConditionalActive && sigRow) {
          alphaBlended = sigRow.alpha + totalBoost;
          betaBlended  = sigRow.beta  + impulseBetaPenalty;
          posteriorSource = 'conditional';
        }

        // D5.1 — partial-pooling cluster fallback (PAYOFF). Engages ONLY for a
        // COLD leaf signature (n_signature = alpha+beta-2 < N_MIN). The well-sampled
        // branch above is left byte-for-byte unchanged; this block never runs when
        // the leaf already drove the override.
        //
        // Decision (per task D5.1):
        //   n_signature >= N_MIN AND leaf exists  -> used_scope='signature' (above)
        //   else if non-contaminated cluster row  -> used_scope='cluster'
        //   else                                  -> used_scope='fallback' (leaf/Beta(1,1))
        let usedScope: 'signature' | 'cluster' | 'fallback';
        const nSignature = sigRow ? (sigRow.alpha + sigRow.beta - 2) : 0;
        // CRITICAL: never disturb the well-sampled path. If the existing leaf
        // conditional override already fired (n_observations >= floor), OR the leaf
        // has n_signature >= N_MIN, treat it as 'signature' and leave alpha/beta as-is.
        // The cluster fallback engages ONLY for a genuinely cold leaf.
        if (leafConditionalActive || (sigRow && nSignature >= SIGNATURE_CLUSTER_N_MIN)) {
          // Leaf is well-sampled — keep whatever the conditional override decided.
          usedScope = 'signature';
        } else {
          // Cold (or absent) leaf: try the well-sampled cluster posterior.
          const clusterRow = (!clusterContaminated && clusterIdForSig)
            ? clusterScoresMap.get(activityId)
            : undefined;
          if (clusterRow) {
            alphaBlended = clusterRow.alpha + totalBoost;
            betaBlended  = clusterRow.beta  + impulseBetaPenalty;
            posteriorSource = 'cluster';
            usedScope = 'cluster';
          } else {
            // No usable cluster posterior — leaf / Beta(1,1) as today.
            usedScope = 'fallback';
          }
        }
        clusterShadowDecisions.push({
          template_id: activityId,
          n_signature: nSignature,
          used_scope: usedScope,
        });

        // Sample from Beta(alpha, beta) distribution for Thompson Sampling.
        // This enables exploration (high variance for uncertain templates) and
        // exploitation (high mean for proven templates) tradeoff.
        //
        // Phase 10 P5A — task 10.14: dual-compute path. The DB-side
        // `fn::beta_sample` (migration 104) is now live on canary, but we
        // can't call it inline here because the recommend hot path is
        // synchronous and async-batching every sample into a SurrealDB
        // round-trip would dominate latency. The dual-compute migration
        // strategy (per spec): app-side sampler stays the active path;
        // we log `sample_source` so canary observability can confirm.
        // 10.15 promotes DB-side as the source-of-truth once K-S parity
        // (10.13) is verified and the recommend query is restructured to
        // pull samples in the same batch as α/β.
        // M4 tier-restricted bandit: deterministic-only templates skip
        // Thompson sampling and dispatch with uniform priority. Their cells
        // have degenerate transition kernels; a Beta posterior on them
        // captures propagated upstream uncertainty, not cell-local signal.
        const tierClass = classifyTemplateTiers(template);
        let sample: number;
        let sampleSource: 'app_fallback' | 'tier_uniform';
        if (tierClass === 'all_deterministic') {
          sample = 1.0;
          sampleSource = 'tier_uniform';
        } else {
          sample = betaSample(alphaBlended, betaBlended);
          sampleSource = 'app_fallback';
        }

        // Cross-signature reputation penalty (lever 3). Re-inject the
        // signature-agnostic global reputation proportional to how much the
        // context blend discounted it, damping the gamed-signature escape
        // without double-damping the fresh-signature regime. No-op (factor 1.0)
        // when the env flag is off, when blendWeight==0, or when the global
        // posterior is missing / below the observation floor. `scores` holds
        // the per-template, per-org global aggregate from v_activity_score —
        // no extra DB read.
        const reputationFactor = applyReputationFactor(
          blendWeight,
          scores?.alpha,
          scores?.beta,
          { enabled: CROSS_SIG_REPUTATION_PENALTY, minObs: CROSS_SIG_MIN_GLOBAL_OBS }
        );
        if (CROSS_SIG_REPUTATION_PENALTY && reputationFactor < 1.0) {
          const muG = (scores?.alpha != null && scores?.beta != null && (scores.alpha + scores.beta) > 0)
            ? scores.alpha / (scores.alpha + scores.beta)
            : null;
          logger.debug('Cross-signature reputation penalty applied', {
            template_id: activityId,
            blendWeight,
            mu_g: muG,
            reputationFactor,
          });
          sample = sample * reputationFactor;
        }

        // EMPIRICAL-BADNESS FLOOR (2026-07-23, law-12 causal-discipline fix).
        // The alpha read for selection is thompson_alpha, which CHAIN-CREDIT inflates for a
        // template that is merely a useful ANCESTOR of other reached walks
        // (posterior-update.ts propagateChainCredit) — the SAME column that also holds this
        // template's own leaf failures. So a template that is ~0-success / thousands-fail
        // when RUN ITSELF still samples ~0.5 AND, worse, wins the output-shape-coverage
        // resort below on DECLARED outputs it never actually produces. Run-selection must
        // key on a template's OWN empirical success, not its pathway/declared value. Derive
        // an own-success gate from the HONEST counts (successes/failures from
        // v_activity_score, NOT alpha) and use it to (a) zero the Thompson sample and
        // (b) hard-demote in every ranking regime below. Conservative + reversible: fires
        // only with enough own-runs to judge and a near-zero self-success rate; leaves the
        // template, its chain-credit, and the exploration budget otherwise intact.
        let empiricallyBroken = false;
        if (EMPIRICAL_BADNESS_FLOOR_ENABLED) {
          // Judge on the STRONGEST available honest evidence. Two sources:
          //  - per-signature scores (scores.successes/failures) when a live row exists;
          //  - the DURABLE global counters on template.metrics
          //    (successful_executions/failed_executions), which enrichTemplatesWithMetrics
          //    fills from variant_performance_metrics. This is the authoritative arm: it is
          //    the same object selection reads thompson_alpha from, and it SURVIVES
          //    execution-row reaping (v_activity_score does NOT — a reaped template shows an
          //    empty row there while still carrying thousands of durable failures, which is
          //    precisely the pollution case: 0 success / thousands fail, alpha ~10k).
          // Broken if EITHER source shows enough own-runs and a near-zero self-success rate.
          const isBroken = (succ: number, fail: number): boolean => {
            const obs = succ + fail;
            return obs >= EMPIRICAL_BADNESS_MIN_OBS && (succ / obs) < EMPIRICAL_BADNESS_MIN_RATE;
          };
          const durSucc = template.metrics?.successful_executions ?? 0;
          const durFail = template.metrics?.failed_executions ?? 0;
          const sigBroken = isBroken(scores?.successes ?? 0, scores?.failures ?? 0);
          const durableBroken = isBroken(durSucc, durFail);
          if (sigBroken || durableBroken) {
            empiricallyBroken = true;
            logger.debug('Empirical-badness floor: template self-failing, demoting from run-selection', {
              template_id: activityId, sig_broken: sigBroken, durable_broken: durableBroken,
              sig_successes: scores?.successes ?? 0, sig_failures: scores?.failures ?? 0,
              durable_successes: durSucc, durable_failures: durFail,
              sample_before: sample,
            });
            sample = 0;
          }
        }

        const rawTotalExecs = scores?.total_executions ?? 0;
        const rawSuccesses = scores?.successes ?? 0;
        const computed_ucb_score = ucbScore(rawTotalExecs, rawSuccesses);

        return {
          template_id: activityId,
          template_name: template.name || template.variant_name,
          category: template.category,
          tags: template.tags || [],
          tag_prefixes: template.tag_prefixes || [],
          input_shapes: template.input_shapes || [],
          output_shapes: template.output_shapes || [],
          input_schema: template.input_schema || null,
          output_schema: template.output_schema || null,
          _ucb_score: computed_ucb_score,
          _total_executions: rawTotalExecs,
          _proposed: template.proposed === true,
          _empirically_broken: empiricallyBroken,
          // Topology-exploration signal (Change 2 — additive observability).
          // `exploration` is patched to true after pool partitioning when the
          // recommendation lands in the explorationPool (low observations or
          // proposed template). `pool_signature` is the v1 state-space hash
          // computed from impulse_state_space; null when caller omits it.
          // `signature_observations` is how many times this (template ×
          // pool-signature) pair has been tried; 0 means first contact.
          exploration: false, // patched after pool partitioning
          pool_signature: stateSpaceSig ?? null,
          signature_observations: sigRow?.n_observations ?? 0,
          selection_metadata: {
            method: 'thompson_sampling',
            score_source: posteriorSource,
            _posterior_source: posteriorSource,
            alpha: alphaBlended,
            beta: betaBlended,
            original_beta: betaVal,
            sample,
            // Phase 10 P5A 10.14: surface the sampler source so canary
            // observability can stratify recommend latency / accuracy by
            // origin. Today every recommend call uses 'app_fallback'.
            // After 10.15 promotes DB-side, this label flips to 'db'
            // (or stays 'app_fallback' on the explicit override path).
            sample_source: sampleSource,
            tier_class: tierClass,
            score: sample,
            ucb_score: computed_ucb_score,
            exploration_slot: false, // patched after pool partitioning
            proposed_template: false, // patched after pool partitioning
            // Semantic matching quality
            tag_match_quality: tagMatchQuality,
            heuristic_boost: totalBoost,
            boost_breakdown: {
              tag_match: tagBoost,
              shape_compatible: shapeBoost,
              recency: recencyBoost,
              execution_history: historyBoost,
              scope_preference: scopeBoost,
              impulse_relevancy: impulseAlphaBoost,
              category_match: categoryBoost,
              output_shape_coverage: outputShapeBoost,
              shape_mismatch_penalty: shapeMismatchPenalty,
            },
            // Context-bucketed Thompson metadata (Spec 3)
            ...(contextBucket ? {
              context_bucket: contextBucket,
              context_blend_weight: blendWeight,
              context_n_observations: nContext,
            } : {}),
            // Phase 24 §4: conditional posterior metadata
            ...(sigRow ? {
              conditional_sig: stateSpaceSig,
              conditional_n_observations: sigRow.n_observations,
              conditional_active: sigRow.n_observations >= SIGNATURE_SAMPLING_FLOOR,
            } : {}),
            // D5 — partial-pooling (cluster shadow) metadata
            ...(stateSpaceSig ? {
              cluster_id: clusterIdForSig,
              cluster_contaminated: clusterContaminated,
              n_signature: nSignature,
              used_scope: usedScope,
            } : {}),
            // Output shape analysis
            output_shape_analysis: expected_output_shapes.length > 0 ? {
              expected_shapes: expected_output_shapes,
              activity_output_shapes: templateOutputShapes,
              coverage: outputCoverage,
              boost: outputShapeBoost,
            } : null,
            // Impulse relevancy details
            impulse_analysis: impulseBoost ? {
              alpha_boost: impulseBoost.alphaBoost,
              beta_penalty: impulseBoost.betaPenalty,
              relevant_impulses: impulseBoost.relevantImpulses,
              missing_critical_impulses: impulseBoost.missingCriticalImpulses,
              details: impulseBoost.details,
            } : null,
            // Include shape signature if shape-conditioned
            ...(scoreMethod === 'shape_conditioned' && scores && 'shape_signature' in scores
              ? { shape_signature: (scores as any).shape_signature }
              : {}),
          },
        };
      })
      // Final defensive filter: ensure all recommendations have valid template_id
      .filter((rec: any) => {
        if (!rec.template_id || typeof rec.template_id !== 'string' || rec.template_id.trim() === '') {
          logger.error('Filtering out recommendation with invalid template_id (should not happen)', {
            template_name: rec.template_name,
            template_id: rec.template_id,
          });
          return false;
        }
        return true;
      });

    // ── Mechanism #7 CONSUMER LOOP: blend ⟨ψ(s,a),R⟩ into the selection argmax ──
    // ψ (successor features) is the cell's discounted shape-occupancy; R is the
    // goal's completion_shapes. ⟨ψ,R⟩ is the LOOK-AHEAD transfer value — how much
    // of the goal direction this cell's trace-continuation is expected to occupy,
    // INDEPENDENT of its Beta reward. The Thompson sample stays the BASE; ψ is an
    // additive, weighted, normalized bonus. Fully reversible: when SF_BLEND is off
    // (default) `_sf_blended` is never set and every sort below falls back to the
    // exact prior Thompson key (`selection_metadata.score`). When on, the blended
    // key is `thompson_sample + SF_BLEND_WEIGHT * v/(1+v)`.
    let sfBlendApplied = false;
    if (
      successorFeaturesEnabled() &&
      (await successorBlendEnabled()) &&
      typeof stateSpaceSig === 'string' &&
      (stateSpaceSig as string).length > 0 &&
      Array.isArray(completion_shapes) &&
      (completion_shapes as string[]).length > 0 &&
      recommendations.length > 0
    ) {
      try {
        const sfScope = typeof (body as any).sf_scope === 'string' ? (body as any).sf_scope : 'org';
        const reward = rewardFromCompletionShapes(completion_shapes as string[]);
        const sfWeight = successorBlendWeight();
        const templateIds = recommendations
          .map((r: any) => r.template_id)
          .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0);
        const cells = await fetchSuccessorFeatureCells(
          surrealDB as any,
          stateSpaceSig as string,
          templateIds,
          sfScope,
        );
        for (const rec of recommendations as any[]) {
          const cell = cells.get(successorFeatureCellKey(stateSpaceSig as string, rec.template_id));
          const rawV = cell ? successorValue(cell.vector, reward) : 0;
          const normV = normalizeSuccessorValue(rawV);
          const base = rec.selection_metadata?.score ?? 0;
          rec._sf_blended = base + sfWeight * normV;
          rec._sf_successor_value = rawV;
          rec.selection_metadata = {
            ...(rec.selection_metadata ?? {}),
            successor_value: {
              value: rawV,
              normalized: normV,
              blend_weight: sfWeight,
              blended_score: rec._sf_blended,
              signature: stateSpaceSig,
              scope: cell?.scope ?? sfScope,
              sample_count: cell?.sample_count ?? 0,
              informed: !!cell,
            },
          };
        }
        sfBlendApplied = true;
        logger.info('successor-features blend applied to recommend ranking', {
          signature: stateSpaceSig,
          completion_shapes,
          blend_weight: sfWeight,
          informed_cells: recommendations.filter((r: any) => (r.selection_metadata as any)?.successor_value?.informed).length,
          candidates: recommendations.length,
        });
      } catch (err) {
        logger.warn('successor-features blend failed (non-blocking, ranking falls back to Thompson)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Ranking key used by the argmax sorts below. When the ψ blend is active it
    // returns thompson_sample + weighted-ψ; otherwise the pure Thompson sample.
    const rankKey = (c: any): number =>
      sfBlendApplied && typeof c._sf_blended === 'number'
        ? c._sf_blended
        : (c.selection_metadata?.score ?? 0);

    // UCB pool partitioning: split into exploration/exploitation, assemble final list
    const reserved = exploration_ratio > 0 ? Math.max(1, Math.floor(limit * exploration_ratio)) : 0;
    // Proposed templates are exploration-only — they may have any
    // _total_executions but stay out of the exploitation pool until the
    // autonomous-promote endpoint flips proposed=false based on real
    // empirical evidence.
    const explorationPool = recommendations.filter((c: any) =>
      c._proposed === true || c._total_executions < min_observations_threshold
    );
    const exploitationPool = recommendations.filter((c: any) =>
      c._proposed !== true && c._total_executions >= min_observations_threshold
    );
    explorationPool.sort((a: any, b: any) => {
      // Empirical-badness floor: a proven-self-failing template sinks below every
      // working alternative before any other key (UCB, ψ-blend, tiebreaks).
      if (!!a._empirically_broken !== !!b._empirically_broken) return a._empirically_broken ? 1 : -1;
      // When the ψ blend is active, the look-ahead leads the ranking; UCB is the
      // tiebreak. Off (default), this is the prior UCB-then-Thompson order exactly.
      if (sfBlendApplied) {
        const sfDiff = rankKey(b) - rankKey(a);
        if (sfDiff !== 0) return sfDiff;
        return b._ucb_score - a._ucb_score;
      }
      const ucbDiff = b._ucb_score - a._ucb_score;
      if (ucbDiff !== 0) return ucbDiff;
      // Tiebreak by combined heuristic score so expected_output_shapes boosts surface to the top.
      return (b.selection_metadata?.score ?? 0) - (a.selection_metadata?.score ?? 0);
    });
    exploitationPool.sort((a: any, b: any) => {
      // Empirical-badness floor: a proven-self-failing template sinks below every
      // working alternative before the UCB / ψ-blend argmax.
      if (!!a._empirically_broken !== !!b._empirically_broken) return a._empirically_broken ? 1 : -1;
      // ψ look-ahead enters the exploitation argmax (the actual Thompson pick) when
      // SF_BLEND is on; UCB tiebreaks. Off, this is the prior pure-UCB order exactly.
      if (sfBlendApplied) {
        const sfDiff = rankKey(b) - rankKey(a);
        if (sfDiff !== 0) return sfDiff;
        return b._ucb_score - a._ucb_score;
      }
      return b._ucb_score - a._ucb_score;
    });
    const headSlots = limit - reserved;
    const head = exploitationPool.slice(0, headSlots);
    const tail = explorationPool.slice(0, reserved);
    const tailFill = exploitationPool.slice(headSlots, headSlots + (reserved - tail.length));
    // Cold-start backfill: head slots unfilled (no exploited templates yet) → pull next-best from explorationPool
    const headColdFill = head.length < headSlots
      ? explorationPool.slice(reserved, reserved + (headSlots - head.length))
      : [];
    let finalRecommendations = [...head, ...headColdFill, ...tail, ...tailFill].slice(0, limit);

    // When expected_output_shapes are specified, re-sort the final list by combined
    // score so shape-boosted templates surface to the top, overriding pool-partition
    // ordering which places the exploration slot last by construction.
    if (expected_output_shapes.length > 0) {
      finalRecommendations.sort((a: any, b: any) => {
        // Empirical-badness floor is the HARDEST key here: a proven-self-failing producer
        // is useless no matter how completely it DECLARES the wanted output shape. This is
        // the regime that let the 0/thousands learned composition win producer-selection.
        if (!!a._empirically_broken !== !!b._empirically_broken) return a._empirically_broken ? 1 : -1;
        const bOsCov = b.selection_metadata?.boost_breakdown?.output_shape_coverage ?? 0;
        const aOsCov = a.selection_metadata?.boost_breakdown?.output_shape_coverage ?? 0;
        if (bOsCov !== aOsCov) return bOsCov - aOsCov;
        // Shape coverage is the hard primary; ψ look-ahead is the tiebreak when the
        // blend is active, else the prior pure-Thompson tiebreak. Reversible.
        return rankKey(b) - rankKey(a);
      });
    }

    // INTERPOSABLE SELECTION (SUBSTRATE_AS_REPRESENTATION §1: "selection = choosing a
    // tangent direction within A(s)"). The default Thompson path above is UNCHANGED
    // (behavior-preserving — the live loop never sees a difference). When the caller
    // opts in with `selector` (any registered strategy other than 'thompson'), project
    // the candidates into the uniform ChoiceSet and let an INTERPOSED reasoning process
    // (cost-minimizer, greedy-exploit, deterministic, or a composed selector) RE-RANK
    // them. This is the swap point that makes the selection mechanism self-assembling:
    // the choice of HOW to choose is itself a pluggable, composable activity.
    const requestedSelector =
      typeof (body as Record<string, unknown>).selector === 'string'
        ? ((body as Record<string, unknown>).selector as string)
        : null;
    if (requestedSelector && requestedSelector !== 'thompson' && finalRecommendations.length > 1) {
      try {
        const { projectToChoice, select } = await import('../lib/selection/choice');
        const choiceSet = {
          goal: typeof (body as Record<string, unknown>).goal === 'string'
            ? ((body as Record<string, unknown>).goal as string) : undefined,
          required_shapes: expected_output_shapes,
          state_signature: stateSpaceSig ?? null,
          available_shapes: Array.isArray(impulse_state_space)
            ? (impulse_state_space as Array<Record<string, unknown>>).map((e) => (e.shape ?? e) as string).filter(Boolean)
            : [],
          choices: finalRecommendations.map((r: Record<string, unknown>) => projectToChoice(r)),
          generated_at: new Date().toISOString(),
        };
        const ranked = select(choiceSet, requestedSelector);
        if (ranked.length > 0) {
          const order = new Map(ranked.map((rc, i) => [rc.choice.id, i]));
          finalRecommendations.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
            (order.get(a.template_id as string) ?? 1e9) - (order.get(b.template_id as string) ?? 1e9));
          for (const r of finalRecommendations as Array<Record<string, unknown>>) {
            const rc = ranked.find((x) => x.choice.id === r.template_id);
            if (rc) {
              r.selection_metadata = {
                ...(r.selection_metadata as Record<string, unknown>),
                interposed_selector: requestedSelector,
                interposed_score: rc.score,
                interposed_rationale: rc.rationale,
              };
            }
          }
          logger.info('Interposed selector applied', { selector: requestedSelector, top: ranked[0]?.choice.id });
        }
      } catch (selErr) {
        logger.warn('interposed selector failed (non-blocking, kept thompson order)', {
          selector: requestedSelector,
          error: selErr instanceof Error ? selErr.message : String(selErr),
        });
      }
    }

    // Patch exploration_slot and clean up internal fields
    const explorationSet = new Set(explorationPool);
    for (const rec of finalRecommendations) {
      const isExploration = explorationSet.has(rec);
      rec.selection_metadata.exploration_slot = isExploration;
      // Surface the proposed-template marker so traces can identify
      // exploration selections that landed on substrate-authored templates.
      // The autonomous-promote endpoint uses real empirical α/β
      // (variant_performance_metrics) accumulated by these selections.
      rec.selection_metadata.proposed_template = (rec as any)._proposed === true;
      // Patch the top-level exploration signal (Change 2 — topology observability).
      // Mirrors exploration_slot but lives at the top level so callers (goal-host,
      // Obsidian dashboard) can read it without inspecting selection_metadata.
      (rec as any).exploration = isExploration;
      delete (rec as any)._ucb_score;
      delete (rec as any)._total_executions;
      delete (rec as any)._proposed;
    }

    // Generate correlation IDs for selection-to-execution linkage
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    finalRecommendations.forEach((rec: any, index: number) => {
      rec.correlation_id = `sel_${timestamp}_${randomSuffix}_${index}`;
    });

    logger.info('Recommendations generated', {
      count: finalRecommendations.length,
      top: finalRecommendations[0]?.template_id,
      correlationIds: finalRecommendations.map((r: any) => r.correlation_id),
      scoreMethod,
      fallbackTier,
      explorationRatio: exploration_ratio,
      // Log selection details for top recommendation
      topRecommendation: finalRecommendations[0] ? {
        template_id: finalRecommendations[0].template_id,
        thompson_sample: finalRecommendations[0].selection_metadata.sample,
        alpha: finalRecommendations[0].selection_metadata.alpha,
        beta: finalRecommendations[0].selection_metadata.beta,
        ucb_score: finalRecommendations[0].selection_metadata.ucb_score,
        exploration_slot: finalRecommendations[0].selection_metadata.exploration_slot,
        output_shapes: finalRecommendations[0].output_shapes,
      } : null,
    });

    // D5.3 — emit a `cluster_shadow_decision` impulse summarising the partial-pooling
    // decision for this selector call: { signature, cluster_id, n_signature, used_scope }.
    // OBSERVABILITY ONLY — fire-and-forget on the existing impulse-write path
    // (`INSERT INTO impulse`, same table the /v2/impulses endpoint uses), never
    // blocks/affects selection. SAMPLED: per-call impulse emission is too heavy for
    // the recommend hot path, so we emit at CLUSTER_SHADOW_SAMPLE_RATE (default 1.0;
    // lower it under load). One impulse per call carries the signature-level decision
    // plus the per-template breakdown in metadata.
    const CLUSTER_SHADOW_SAMPLE_RATE = parseFloat(process.env.CLUSTER_SHADOW_SAMPLE_RATE ?? '1.0');
    if (orgId && stateSpaceSig && clusterShadowDecisions.length > 0 && Math.random() < CLUSTER_SHADOW_SAMPLE_RATE) {
      // Signature-level used_scope: 'signature' if any template used the leaf, else
      // 'cluster' if any used the cluster, else 'fallback'.
      const sigUsedScope: 'signature' | 'cluster' | 'fallback' =
        clusterShadowDecisions.some((d) => d.used_scope === 'signature') ? 'signature'
        : clusterShadowDecisions.some((d) => d.used_scope === 'cluster') ? 'cluster'
        : 'fallback';
      // n_signature is per-template; surface the min (the coldest leaf, which is what
      // actually triggers the fallback) at the signature level.
      const minNSignature = clusterShadowDecisions.reduce(
        (m, d) => Math.min(m, d.n_signature), Number.POSITIVE_INFINITY,
      );
      const shadowBody = {
        signature: stateSpaceSig,
        cluster_id: clusterIdForSig,
        cluster_contaminated: clusterContaminated,
        n_signature: Number.isFinite(minNSignature) ? minNSignature : 0,
        used_scope: sigUsedScope,
        n_min: SIGNATURE_CLUSTER_N_MIN,
        decisions: clusterShadowDecisions,
      };
      surrealDB.query(`
        INSERT INTO impulse {
          id: $id,
          shape: 'cluster_shadow_decision',
          pointer: { type: 'memo' },
          summary: $summary,
          metadata: $metadata,
          token_estimate: 0,
          org_id: $org_id,
          account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
          account_id_version: 1,
          created_at: time::now()
        }
      `, {
        id: `cluster-shadow-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        summary: `cluster_shadow_decision sig=${stateSpaceSig.slice(0, 12)} scope=${sigUsedScope}`.slice(0, 100),
        metadata: shadowBody,
        org_id: orgId,
        account_id: jwtAuth?.accountId ?? null,
      }).catch((err: any) => {
        // Advisory: a dropped observability impulse never affects selection.
        logger.debug('cluster_shadow_decision emit failed (non-blocking)', {
          error: err?.message ?? String(err),
        });
      });
    }

    // Log Thompson Sampling selections for explainability (non-blocking)
    // Only log if we have an org context and recommendations
    if (orgId && finalRecommendations.length > 0) {
      // Log each selection to thompson_selection_log for explainability
      const selectionLogs = finalRecommendations.map((rec: any, index: number) => ({
        correlation_id: rec.correlation_id, // Link to execution via correlation_id
        execution_id: `recommend-${timestamp}-${index}`, // Placeholder until actual execution
        activity_id: rec.template_id,
        thompson_sample: rec.selection_metadata.sample,
        alpha: rec.selection_metadata.alpha,
        beta: rec.selection_metadata.beta,
        selection_method: 'thompson_sampling',
        candidates_count: templates.length,
        exploration_slot: rec.selection_metadata.exploration_slot,
      }));

      // Guard the all-or-nothing FOR batch: one row violating a schema ASSERT
      // (alpha>0, beta>0, thompson_sample in [0,1], non-empty correlation/exec/
      // activity ids) aborts the ENTIRE insert, and SurrealDB returns the
      // statement error rather than throwing, so the .catch never fires — which
      // is how thompson_selection_log (and v_selection_outcomes) stayed
      // permanently empty. Drop invalid rows so valid selections still land.
      const validSelectionLogs = selectionLogs.filter((l: any) =>
        typeof l.correlation_id === 'string' && l.correlation_id.length > 0 &&
        typeof l.execution_id === 'string' && l.execution_id.length > 0 &&
        typeof l.activity_id === 'string' && l.activity_id.length > 0 &&
        typeof l.thompson_sample === 'number' && l.thompson_sample >= 0 && l.thompson_sample <= 1 &&
        typeof l.alpha === 'number' && l.alpha > 0 &&
        typeof l.beta === 'number' && l.beta > 0,
      );
      if (validSelectionLogs.length !== selectionLogs.length) {
        logger.debug('thompson_selection_log: dropped invalid selection rows before insert', {
          total: selectionLogs.length, kept: validSelectionLogs.length,
        });
      }

      // Insert selection logs (fire-and-forget for performance)
      // Use FOR loop to handle array inserts properly
      // NOTE: org_id is STRING type in schema, not a record
      // Phase B1: dual-write account_id + account_id_version on each log row.
      surrealDB.query(`
        FOR $log IN $logs {
          CREATE thompson_selection_log CONTENT {
            selected_at: time::now(),
            correlation_id: $log.correlation_id,
            execution_id: $log.execution_id,
            activity_id: $log.activity_id,
            thompson_sample: $log.thompson_sample,
            alpha: $log.alpha,
            beta: $log.beta,
            selection_method: $log.selection_method,
            candidates_count: $log.candidates_count,
            exploration_slot: $log.exploration_slot,
            org_id: $org_name,
            account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
            account_id_version: 1,
            project_id: IF $project_name IS NOT NONE AND $project_name IS NOT NULL THEN type::record('projects', $project_name) ELSE NONE END
          }
        }
      `, {
        logs: validSelectionLogs,
        org_name: orgId, // Plain string org_id
        account_id: jwtAuth?.accountId ?? null,
        project_name: projectId, // project_id can be record or string
      }).catch((err: any) => {
        logger.warn('Failed to log Thompson selections', { error: err.message });
      });

      // Increment total_selections for recommended activities
      // Phase B1: dual-scope WHERE — match account_id-tagged rows first, fall
      // back to legacy org_id-only rows.
      const activityIds = finalRecommendations.map((r: any) => r.template_id);
      surrealDB.query(`
        UPDATE variant_performance_metrics
        SET total_selections = total_selections + 1,
            updated_at = time::now()
        WHERE variant_id IN $activity_ids
          AND ${accountIdScopedWhere()}
      `, {
        activity_ids: activityIds,
        org_id: orgId,
        account_id: accountIdRecordRef(jwtAuth?.accountId ?? null),
      }).catch((err: any) => {
        logger.warn('Failed to update total_selections', { error: err.message });
      });

      logger.debug('Selection metrics queued for persistence', {
        selectionCount: selectionLogs.length,
        activityIds,
      });
    }

    // Phase 11: state-space-aware filtering and pointer recommendations
    const parsedImpulseStateSpace = Array.isArray(impulse_state_space) && impulse_state_space.length > 0
      ? impulse_state_space as ImpulseStateEntry[]
      : undefined;

    let filteredRecommendations = finalRecommendations;
    let pointerRecommendations: unknown[] = [];
    let blockingShapes: unknown[] = [];

    if (parsedImpulseStateSpace !== undefined) {
      const executionScope = getExecutionScopeFromContext(c);
      const pointerStateSpace = await buildPointerStateSpace(
        executionScope?.accessible_account_ids ?? []
      );
      // Re-rank by compatibility then strip internal _compatibility_score field
      const reranked = applyCompatibilityFilter(
        finalRecommendations.map((r: any) => ({
          ...r,
          // applyCompatibilityFilter uses alpha/beta from selection_metadata
          alpha: r.selection_metadata?.alpha,
          beta: r.selection_metadata?.beta,
          input_shapes: r.input_shapes,
        })),
        parsedImpulseStateSpace,
        pointerStateSpace,
      );
      // Rebuild filteredRecommendations in the reranked order, without _compatibility_score
      filteredRecommendations = reranked.map(({ _compatibility_score: _, ...rest }) => {
        // Drop the shadow copy of alpha/beta we injected; the originals are in selection_metadata
        const { alpha: _a, beta: _b, ...clean } = rest as any;
        // Find the original finalRecommendations entry by template_id
        return finalRecommendations.find((r: any) => r.template_id === clean.template_id) ?? clean;
      });

      blockingShapes = identifyBlockingShapes(
        filteredRecommendations.slice(0, 5).map((r: any) => ({
          template_id: r.template_id,
          input_shapes: r.input_shapes,
        })),
        parsedImpulseStateSpace,
        pointerStateSpace,
      );

      pointerRecommendations = generatePointerRecommendations(
        pointerStateSpace,
        parsedImpulseStateSpace,
        finalRecommendations.slice(0, 20).map((r: any) => ({
          template_id: r.template_id,
          template_name: r.template_name,
          input_shapes: r.input_shapes,
          alpha: r.selection_metadata?.alpha,
          beta: r.selection_metadata?.beta,
        })),
      );

      logger.info('Phase 11: state-space filtering applied', {
        impulse_state_space_count: parsedImpulseStateSpace.length,
        pointer_state_space_count: pointerStateSpace.length,
        blocking_shapes_count: blockingShapes.length,
        pointer_recommendations_count: pointerRecommendations.length,
      });
    }

    // Refusal guard (push-away closure, IAL §27.S.6): if the caller specified
    // expected_output_shapes AND no candidate template's output_shapes intersects
    // with the request, refuse rather than silently fall back to the highest-α
    // template. Without this guard, the recommender returns a confidently-wrong
    // pick from prior-on-everything posterior (validated by operator probe
    // 2026-05-27 "Disrupt application" — selected probe-reachable-unlearned
    // for a document-QA goal with shapes the catalogue had no producer for).
    //
    // Semantic: a refusal is a structured "no producer" response. The caller
    // (goal-host, observer, operator tool) is expected to:
    //   - propagate as a goal failure rather than dispatching, OR
    //   - emit a human_in_the_loop_required impulse, OR
    //   - seed the missing templates via create-shape-provider-goal.
    //
    // Compatible with existing callers: `recommendations` is set to [] which
    // triggers the existing "no template id returned" error path in goal-host
    // (hosts/goal-host.ts:runGoal). Callers that read the `refusal` field get
    // structured rationale; legacy callers see an empty recommendations array
    // and an explicit `fallback_tier: "refused"`.
    let refusal: {
      type: string;
      expected_output_shapes: string[];
      reason: string;
      candidates_examined: number;
      suggestion: string;
    } | null = null;

    if (expected_output_shapes.length > 0) {
      // Refusal triggers only when NO template IN THE FULL CANDIDATE POOL emits
      // any of the requested shapes. Checking just finalRecommendations would
      // wrongly refuse when a real producer exists but didn't make the limit=N
      // top slice. validTemplates is the full pre-ranking pool.
      const expectedSet = new Set(expected_output_shapes);
      const anyProducerInPool = validTemplates.some((t: any) => {
        const shapes = (t.output_shapes ?? []) as string[];
        return shapes.some((s) => expectedSet.has(s));
      });
      if (!anyProducerInPool) {
        refusal = {
          type: 'no_producer_for_expected_shapes',
          expected_output_shapes,
          reason:
            'No template in the full candidate pool emits any of the requested output_shapes. ' +
            'Selector refused rather than falling back to highest-α prior, which would ' +
            'produce a confidently-wrong execution (push-away closure, IAL §27.S.6).',
          candidates_examined: validTemplates.length,
          suggestion:
            'Seed a producer template for the requested shapes, or supply a ' +
            'targetTemplateId to bypass recommendation, or escalate via ' +
            'create-shape-provider-goal for recursive shape production.',
        };
        // Empty the recommendations so existing callers fail rather than dispatch.
        finalRecommendations = [];
        filteredRecommendations = [];
        fallbackTier = 'refused';
        logger.info('Recommendation refused — no producer for expected shapes', {
          expected_output_shapes,
          candidates_examined: refusal.candidates_examined,
        });

        // Audit-grade emit: publish the refusal as a substrate-bus event so
        // auditors can count, attribute, and verify refusals over time. Per
        // audit F-129 (inv-052): IAL §27.S.6 requires active substrate refusal
        // via auditable events with cited evidence, not just a JSON field on
        // an HTTP response. This makes the refusal queryable on the bus and
        // turns it into an observable closure-property signal — counting
        // refusals over a sustained window is the §27.S.6 push-away measure.
        //
        // F-129 full closure (audit inv-053): durable SurrealDB write to
        // refusal_events table runs alongside the bus emit. Bus is hot
        // (live subscribers), DB is cold (post-hoc queryable). Together
        // they cover both ephemeral reactivity and sustained-window
        // measurement.
        const refusalForEmit = refusal;
        const refusedAtIso = new Date().toISOString();
        const taskDescForRecord = typeof task_description === 'string'
          ? task_description.slice(0, 200)
          : null;

        // Bus emit — ephemeral, hot reactivity signal
        void (async () => {
          try {
            const { broadcaster } = await import('../websocket/broadcaster');
            broadcaster.emit({
              type: 'intervention.refused' as any,
              timestamp: refusedAtIso,
              data: {
                source_vessel_id: 'metabob-activity-api',
                refusal_type: refusalForEmit.type,
                expected_output_shapes: refusalForEmit.expected_output_shapes,
                candidates_examined: refusalForEmit.candidates_examined,
                task_description: taskDescForRecord,
                reason: refusalForEmit.reason,
                suggestion: refusalForEmit.suggestion,
                org_id: orgId,
              },
            });
          } catch (err) {
            logger.warn('refusal bus emit failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();

        // Durable write — post-hoc queryable, sustained-window measurement.
        // SurrealDB's option<string> rejects literal NULL — omit nullable
        // fields when their value is null rather than sending JSON null.
        const accountIdForRecord = getJwtAuthFromContext(c)?.accountId ?? null;
        void (async () => {
          try {
            const fields: string[] = [
              "refusal_type: $refusal_type",
              "source_vessel_id: 'metabob-activity-api'",
              "expected_output_shapes: $expected_output_shapes",
              "candidates_examined: $candidates_examined",
              "refused_at: time::now()",
            ];
            const params: Record<string, unknown> = {
              refusal_type: refusalForEmit.type,
              expected_output_shapes: refusalForEmit.expected_output_shapes,
              candidates_examined: refusalForEmit.candidates_examined,
            };
            if (taskDescForRecord !== null) {
              fields.push("task_description: $task_description");
              params.task_description = taskDescForRecord;
            }
            if (refusalForEmit.reason) {
              fields.push("reason: $reason");
              params.reason = refusalForEmit.reason;
            }
            if (refusalForEmit.suggestion) {
              fields.push("suggestion: $suggestion");
              params.suggestion = refusalForEmit.suggestion;
            }
            if (orgId) {
              fields.push("org_id: $org_id");
              params.org_id = orgId;
            }
            if (accountIdForRecord) {
              fields.push("account_id: $account_id");
              params.account_id = accountIdForRecord;
            }
            await surrealDB.query(
              `CREATE refusal_events CONTENT { ${fields.join(", ")} }`,
              params,
            );
          } catch (err) {
            logger.warn('refusal SurrealDB write failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      }
    }

    // Phase G5.1.1: build decision_record for the winning call.
    // Includes winner + up to K=5 runners-up so callers can record the full
    // selection context alongside the trace task (G5.1.2).
    const DECISION_RECORD_K = 5;
    const decisionCandidates = finalRecommendations
      .slice(0, DECISION_RECORD_K + 1)
      .map((rec: any, idx: number) => ({
        activity_id: rec.template_id,
        rrf_rank: idx + 1,
        thompson_alpha: rec.selection_metadata?.alpha ?? null,
        thompson_beta: rec.selection_metadata?.beta ?? null,
        thompson_sample: rec.selection_metadata?.sample ?? null,
        shape_compatible: (rec.input_shapes ?? []).length === 0 ||
          (rec.input_shapes ?? []).every((s: string) => effectiveShapes.includes(s)),
        exploration_slot: rec.selection_metadata?.exploration_slot ?? false,
        score_source: rec.selection_metadata?._posterior_source ?? null,
      }));
    const decisionRecord = {
      candidates: decisionCandidates,
      selected_activity_id: filteredRecommendations[0]?.template_id ?? null,
      rationale_tier: refusal
        ? 'refused'
        : filteredRecommendations.length === 0
          ? 'fallback_improvise'
          : filteredRecommendations[0]?.selection_metadata?.exploration_slot
            ? 'exploration'
            : 'thompson_sample',
      fallback_tier: fallbackTier ?? null,
      total_candidates: finalRecommendations.length,
    };

    return c.json({
      recommendations: filteredRecommendations,
      // Include fallback tier to indicate which matching strategy was used
      fallback_tier: fallbackTier,
      // Push-away closure: present when selector refused rather than dispatch
      // a wrong template. See IAL §27.S.6 + operator probe 2026-05-27.
      ...(refusal ? { refusal } : {}),
      // G5.1.1: decision record for upstream trace persistence (per §F.1)
      decision_record: decisionRecord,
      // Include missing impulse suggestions if any were found
      ...(missingImpulseSuggestions.length > 0 ? {
        missing_impulses: missingImpulseSuggestions.map(s => ({
          impulse_id: s.impulse_id,
          reason: s.reason,
          unlocks_activities: s.unlocks_activities.length,
          avg_relevance_boost: s.avg_relevance_boost,
        })),
      } : {}),
      // Phase 11: state-space output fields (only present when impulse_state_space provided)
      ...(parsedImpulseStateSpace !== undefined ? {
        pointer_recommendations: pointerRecommendations,
        blocking_shapes: blockingShapes,
      } : {}),
    });
  } catch (error: any) {
    logger.error('POST /recommend failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to generate recommendations',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/create-goal-seeking
 * 
 * Create new activity template from goal description (improvisation/self-learning).
 * Used by MiniBob GoalProcessor when recommended activities fail.
 * 
 * Request body:
 * {
 *   goal_description: string,
 *   template_name: string,
 *   category: string,
 *   variables: Record<string, unknown>,
 *   impulse_refs?: string[],
 *   constraints?: {
 *     max_tasks?: number,
 *     max_cost?: number,
 *     prefer_composition?: boolean
 *   }
 * }
 * 
 * Response:
 * {
 *   status: "success" | "error",
 *   template_id?: string,
 *   error?: string
 * }
 */
app.post('/create-goal-seeking', async (c) => {
  try {
    const body = await c.req.json();
    const {
      goal_description,
      template_name,
      category,
      variables = {},
      impulse_refs = [],
      constraints = {},
    } = body;

    logger.info('POST /v2/activities/create-goal-seeking', {
      goal_description: goal_description?.substring(0, 100),
      template_name,
      category,
    });

    // Validate required fields
    if (!goal_description || !template_name || !category) {
      return c.json({
        status: 'error',
        error: 'goal_description, template_name, and category are required',
      }, 400);
    }

    // Get session data for multi-tenant support
    const sessionData = (c.get as any)('session') as SessionData | undefined;
    // Phase B1: account_id flows from JWT auth context.
    const goalSeekingJwtAuth = getJwtAuthFromContext(c);
    const orgId = goalSeekingJwtAuth?.orgId || sessionData?.org_id || null;
    const accountId: string | null = goalSeekingJwtAuth?.accountId ?? null;
    const projectId = goalSeekingJwtAuth?.projectId || sessionData?.project_id || null;

    // Generate activity template
    const generated = await generateActivity({
      goalDescription: goal_description,
      templateName: template_name,
      category,
      variables,
      impulseRefs: impulse_refs,
      constraints: {
        maxTasks: constraints.max_tasks || 5,
        maxCost: constraints.max_cost || 5.0,
        preferComposition: constraints.prefer_composition !== false,
      },
    });

    // Insert template into database (activity is the canonical table)
    // Use canonical field names from GeneratedActivity interface
    const templateRecord: Record<string, any> = {
      id: generated.id,
      name: generated.name,
      description: generated.description,
      execution_type: generated.execution_type,
      category: generated.category,
      tasks: generated.tasks,
      scope: generated.scope,
    };

    if (orgId) {
      templateRecord.org_id = orgId;
    }
    if (projectId) {
      templateRecord.project_id = projectId;
    }
    // Phase B1: dual-write account_id + version=1 marker on the new template.
    // Only set when non-null — SurrealDB 3.x option<string> rejects JSON null.
    if (accountId != null) {
      templateRecord.account_id = accountId;
    }
    templateRecord.account_id_version = 1;

    const fields = Object.keys(templateRecord).map(k => `${k}: $${k}`).join(',\n        ');
    // Use UPSERT to handle re-registration and orphaned index entries
    const upsertTemplateQuery = `
      UPSERT activity:\`${generated.id}\` CONTENT {
        ${fields},
        created_at: time::now(),
        updated_at: time::now()
      }
    `;

    try {
      await surrealDB.query(upsertTemplateQuery, templateRecord);
      logger.debug('Generated template upserted into activity table', {
        id: generated.id,
      });
    } catch (upsertError: any) {
      // Re-throw errors
      throw upsertError;
    }

    // Initialize Thompson Sampling metrics (UPSERT to handle re-registration)
    // Use deterministic record ID format for idempotent upserts.
    // Phase E: record-id is account-keyed when accountId is present so
    // different accounts in the same org keep separate posteriors.
    const metricsRecordId = variantMetricsRecordId(generated.id, accountId);
    const insertMetricsQuery = `
      UPSERT variant_performance_metrics:\`${metricsRecordId}\` SET
        variant_id = $activity_id,
        activity_id = $activity_id,
        account_id = $account_id,
        account_id_version = 1,
        total_executions = total_executions ?? 0,
        successful_executions = successful_executions ?? 0,
        failed_executions = failed_executions ?? 0,
        success_rate = success_rate ?? 0.0,
        avg_duration_ms = avg_duration_ms ?? 0.0,
        avg_cost_usd = avg_cost_usd ?? 0.0,
        thompson_alpha = thompson_alpha ?? 1.0,
        thompson_beta  = thompson_beta  ?? 1.0,
        total_selections = total_selections ?? 0,
        created_at = created_at ?? time::now(),
        updated_at = time::now()
    `;

    const generatedMetricsAccountId = accountIdRecordRef(accountId);
    await surrealDB.query(insertMetricsQuery, {
      activity_id: generated.id,
      ...(generatedMetricsAccountId != null ? { account_id: generatedMetricsAccountId } : {}),
    });

    logger.info('Created improvised activity template', {
      id: generated.id,
      category: generated.category,
    });

    // Invalidate cache — both LIST and per-template key (in case an id
    // collision overwrites an existing entry). Per-key completeness rule.
    await invalidateTemplateCache(generated.id);

    return c.json({
      status: 'success',
      template_id: generated.id,
    });
  } catch (error) {
    logger.error('Failed to create goal-seeking activity', { error });
    return c.json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/activities/composition
 * 
 * Record activity composition edge (parent activity called child activity).
 * This endpoint implements the learning loop for activity composition graphs:
 * 1. Check if edge (parent → child) exists
 * 2. If exists: increment execution_count, update success_count, recalculate weight
 * 3. If new: create edge with execution_count=1, weight based on success
 * 4. Return updated edge data
 * 
 * Weight calculation: weight = success_count / execution_count
 * This represents P(success | parent calls child)
 */
app.post('/composition', async (c) => {
  try {
    const body = await c.req.json();
    const validated = CompositionRecordRequestSchema.parse(body);

    // Defense-in-depth: never persist an edge with a missing/blank parent or child id.
    // The SCHEMAFULL `child_activity_id`/`parent_activity_id ASSERT $value != NONE`
    // does NOT reject "" or whitespace, and a NONE that slips in aborts the whole
    // composition-edge-reconcile run on first read ("Found NONE for field
    // child_activity_id ... expected a string"). Skip-and-warn instead of writing
    // a corrupt edge. (2026-06-26)
    if (!validated.parent_activity_id?.trim() || !validated.child_activity_id?.trim()) {
      logger.warn('Skipping composition edge with missing parent/child id', {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        execution_id: validated.execution_id,
      });
      return c.json({ success: false, skipped: true, reason: 'missing parent or child activity id' }, 400);
    }

    // Phase B1: pull account_id from JWT auth context for dual-write.
    const compositionJwtAuth = getJwtAuthFromContext(c);
    const compositionAccountId: string | null = compositionJwtAuth?.accountId ?? null;
    // org_id is REQUIRED by the schema (org_id ... ASSERT $value != NONE) and its
    // VALUE default `<string> $auth.org_id` resolves to NONE here: surrealDB.query
    // runs on the ROOT connection, so there is no JWT $auth in the DB session. A
    // new-edge CREATE that omits org_id is swallowed by the assert and never
    // persists. Thread an explicit org_id, defaulting to this substrate's canonical
    // org (matches every existing edge). Existing-row UPDATEs are unaffected.
    const compositionSession = (c.get as any)('session') as SessionData | undefined;
    const compositionOrgId: string =
      compositionJwtAuth?.orgId || compositionSession?.org_id || 'organizations:substrate';

    logger.info('POST /v2/activities/composition', {
      parent: validated.parent_activity_id,
      child: validated.child_activity_id,
      success: validated.success,
      inputShapes: validated.input_impulse_shapes?.length || 0,
      outputShapes: validated.output_impulse_shapes?.length || 0,
    });

    // Check if edge exists
    const checkQuery = `
      SELECT * FROM activity_composition_graph
      WHERE parent_activity_id = $parent_activity_id
        AND child_activity_id = $child_activity_id
      LIMIT 1
    `;

    const existing = await surrealDB.query<CompositionEdge[]>(checkQuery, {
      parent_activity_id: validated.parent_activity_id,
      child_activity_id: validated.child_activity_id,
    });

    let edge: CompositionEdge;
    // Generate edge_id for composition_impulse_flow records
    const edgeId = `${validated.parent_activity_id}:${validated.child_activity_id}`;

    // C7: classify the edge at write time so readers prefer the persisted column.
    // Recurrence-gate 'genuine': project the post-write counts from the existing row
    // (a brand-new edge is 0+1 → unproven → 'scaffold' until it recurs with success).
    const _curEc = Number((existing && existing[0] && (existing[0] as any).execution_count) || 0);
    const _curSc = Number((existing && existing[0] && (existing[0] as any).success_count) || 0);
    const compositionEdgeKind = classifyCompositionEdge(
      validated.parent_activity_id,
      validated.child_activity_id,
      { executionCount: _curEc + 1, successCount: _curSc + (validated.success ? 1 : 0) },
    );
    const compositionEdgeIsGenuine = compositionEdgeKind === 'genuine';

    if (existing && existing.length > 0 && existing[0]) {
      // Update existing edge
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing issue
      const newExecutionCount = (current.execution_count || 0) + 1;
      // @ts-ignore - SurrealDB query typing issue
      const newSuccessCount = (current.success_count || 0) + (validated.success ? 1 : 0);
      const newWeight = newSuccessCount / newExecutionCount;

      // Build SET clauses dynamically to avoid SCHEMAFULL field errors
      // Phase B1: refresh account_id_version on every update so legacy rows
      // get tagged on first write, and re-stamp account_id when caller carries one.
      const setClauses: string[] = [
        'execution_count = $execution_count',
        'success_count = $success_count',
        'weight = $weight',
        'updated_at = time::now()',
        'input_impulse_shapes = $input_impulse_shapes',
        'output_impulse_shapes = $output_impulse_shapes',
        'account_id = $account_id',
        'account_id_version = 1',
        'edge_kind = $edge_kind',
        'genuine = $genuine',
      ];

      const updateParams: Record<string, any> = {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_count: newExecutionCount,
        success_count: newSuccessCount,
        weight: newWeight,
        input_impulse_shapes: validated.input_impulse_shapes || [],
        output_impulse_shapes: validated.output_impulse_shapes || [],
        account_id: compositionAccountId,
        edge_kind: compositionEdgeKind,
        genuine: compositionEdgeIsGenuine,
      };

      // Add optional fields only if they have values
      if (validated.duration_ms !== undefined && validated.duration_ms !== null) {
        setClauses.push('duration_ms = $duration_ms');
        updateParams.duration_ms = validated.duration_ms;
      }
      if (validated.cost_usd !== undefined && validated.cost_usd !== null) {
        setClauses.push('cost_usd = $cost_usd');
        updateParams.cost_usd = validated.cost_usd;
      }
      if (validated.tokens_input !== undefined && validated.tokens_input !== null) {
        setClauses.push('tokens_input = $tokens_input');
        updateParams.tokens_input = validated.tokens_input;
      }
      if (validated.tokens_output !== undefined && validated.tokens_output !== null) {
        setClauses.push('tokens_output = $tokens_output');
        updateParams.tokens_output = validated.tokens_output;
      }
      if (validated.depth !== undefined && validated.depth !== null) {
        setClauses.push('depth = $depth');
        updateParams.depth = validated.depth;
      }
      if (validated.composition_chain && validated.composition_chain.length > 0) {
        setClauses.push('composition_chain = $composition_chain');
        updateParams.composition_chain = validated.composition_chain;
      }

      const updateQuery = `
        UPDATE activity_composition_graph
        SET ${setClauses.join(',\n          ')}
        WHERE parent_activity_id = $parent_activity_id
          AND child_activity_id = $child_activity_id
        RETURN AFTER
      `;

      const updated = await surrealDB.query<CompositionEdge[]>(updateQuery, updateParams);

      // @ts-ignore - SurrealDB query typing issue
      edge = updated && updated.length > 0 ? updated[0] : current;
      logger.info('Updated composition edge', {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        execution_count: newExecutionCount,
        weight: newWeight,
      });
    } else {
      // Create new edge with impulse flow fields
      // Build params object dynamically to avoid SCHEMAFULL field errors
      // Phase B1: dual-write account_id + version=1 marker on the new edge.
      const params: Record<string, any> = {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_id: validated.execution_id,
        org_id: compositionOrgId,
        goal_context: validated.goal_context || '',
        success: validated.success,
        success_count: validated.success ? 1 : 0,
        weight: validated.success ? 1.0 : 0.0,
        input_impulse_shapes: validated.input_impulse_shapes || [],
        output_impulse_shapes: validated.output_impulse_shapes || [],
        ...(compositionAccountId != null ? { account_id: compositionAccountId } : {}),
        account_id_version: 1,
        edge_kind: compositionEdgeKind,
        genuine: compositionEdgeIsGenuine,
      };

      // Add optional fields only if they have values
      // This prevents SCHEMAFULL errors when fields aren't in the schema yet
      if (validated.duration_ms !== undefined && validated.duration_ms !== null) {
        params.duration_ms = validated.duration_ms;
      }
      if (validated.cost_usd !== undefined && validated.cost_usd !== null) {
        params.cost_usd = validated.cost_usd;
      }
      if (validated.tokens_input !== undefined && validated.tokens_input !== null) {
        params.tokens_input = validated.tokens_input;
      }
      if (validated.tokens_output !== undefined && validated.tokens_output !== null) {
        params.tokens_output = validated.tokens_output;
      }
      if (validated.depth !== undefined && validated.depth !== null) {
        params.depth = validated.depth;
      }
      if (validated.composition_chain && validated.composition_chain.length > 0) {
        params.composition_chain = validated.composition_chain;
      }

      // Build field list dynamically from params
      const fieldEntries = Object.keys(params).map(k => `${k}: $${k}`);
      const fieldsStr = fieldEntries.join(',\n          ');

      const createQuery = `
        CREATE activity_composition_graph CONTENT {
          ${fieldsStr},
          execution_count: 1,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const created = await surrealDB.query<CompositionEdge[]>(createQuery, params);

      // @ts-ignore - SurrealDB query typing issue
      edge = created && created.length > 0 ? created[0] : {
        parent_activity_id: validated.parent_activity_id,
        child_activity_id: validated.child_activity_id,
        execution_id: validated.execution_id,
        goal_context: validated.goal_context || '',
        success: validated.success,
        execution_count: 1,
        success_count: validated.success ? 1 : 0,
        weight: validated.success ? 1.0 : 0.0,
        input_impulse_shapes: validated.input_impulse_shapes || [],
        output_impulse_shapes: validated.output_impulse_shapes || [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      logger.info('Created composition edge', {
        parent: validated.parent_activity_id,
        child: validated.child_activity_id,
        weight: edge.weight,
      });
    }

    // Record detailed impulse flow if impulse IDs are provided
    if (validated.input_impulse_ids?.length || validated.output_impulse_ids?.length) {
      const flowRecords: any[] = [];

      // Create input flow records
      if (validated.input_impulse_ids && validated.input_impulse_shapes) {
        for (let i = 0; i < validated.input_impulse_ids.length; i++) {
          flowRecords.push({
            edge_id: edgeId,
            execution_id: validated.execution_id,
            impulse_id: validated.input_impulse_ids[i],
            direction: 'input',
            shape: validated.input_impulse_shapes[i] || 'unknown',
            execution_succeeded: validated.success,
          });
        }
      }

      // Create output flow records
      if (validated.output_impulse_ids && validated.output_impulse_shapes) {
        for (let i = 0; i < validated.output_impulse_ids.length; i++) {
          flowRecords.push({
            edge_id: edgeId,
            execution_id: validated.execution_id,
            impulse_id: validated.output_impulse_ids[i],
            direction: 'output',
            shape: validated.output_impulse_shapes[i] || 'unknown',
            execution_succeeded: validated.success,
          });
        }
      }

      // Insert flow records
      if (flowRecords.length > 0) {
        const flowInsertQuery = `
          INSERT INTO composition_impulse_flow $records
        `;
        await surrealDB.query(flowInsertQuery, { records: flowRecords });
        logger.info('Recorded composition impulse flows', {
          edge_id: edgeId,
          flow_count: flowRecords.length,
        });
      }
    }

    return c.json({
      success: true,
      edge,
    });
  } catch (error: any) {
    logger.error('POST /v2/activities/composition failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record composition',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/graph
 * Query activity composition graph
 * 
 * Query parameters:
 * - activity_id: Filter edges where activity is parent OR child
 * - min_weight: Filter edges with weight >= min_weight
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 * 
 * Returns edges sorted by weight (strongest compositions first)
 */
app.get('/composition/graph', async (c) => {
  try {
    const query = c.req.query();
    const validated = CompositionGraphQuerySchema.parse({
      activity_id: query.activity_id,
      min_weight: query.min_weight ? parseFloat(query.min_weight) : undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });

    logger.info('GET /v2/activities/composition/graph', validated);

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };

    if (validated.activity_id) {
      whereClauses.push(`(parent_activity_id = $activity_id OR child_activity_id = $activity_id)`);
      params.activity_id = validated.activity_id;
    }

    if (validated.min_weight !== undefined) {
      whereClauses.push(`weight >= $min_weight`);
      params.min_weight = validated.min_weight;
    }

    let edgesQuery = `SELECT * FROM activity_composition_graph`;
    if (whereClauses.length > 0) {
      edgesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    edgesQuery += ` ORDER BY weight DESC LIMIT $limit START $offset`;

    let countQuery = `SELECT count() as total FROM activity_composition_graph`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [edgesResult, countResult] = await Promise.all([
      surrealDB.query<CompositionEdge[]>(edgesQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);

    // @ts-ignore - SurrealDB query typing issue
    const response: CompositionGraphResponse = {
      edges: (edgesResult && Array.isArray(edgesResult) ? edgesResult.flat() : []),
      // @ts-ignore - SurrealDB query typing issue
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };

    logger.info('Composition graph query result', {
      edges: response.edges.length,
      total: response.total,
    });

    return c.json(response);
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/graph failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to query composition graph',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/state-transitions
 * Query state transitions in the composition graph
 *
 * Analyzes how shapes flow through activity compositions, showing:
 * - Which shapes are produced by each activity
 * - Which shapes are consumed by downstream activities
 * - Success rates for specific shape transformations
 *
 * Query parameters:
 * - from_shapes: Array of input shapes to analyze
 * - to_shapes: Array of desired output shapes
 * - activity_id: Filter by specific activity
 * - limit: Max results (default: 50)
 */
app.get('/composition/state-transitions', async (c) => {
  try {
    const query = c.req.query();
    const fromShapes = query.from_shapes ? JSON.parse(query.from_shapes) : undefined;
    const toShapes = query.to_shapes ? JSON.parse(query.to_shapes) : undefined;
    const activityId = query.activity_id;
    const limit = query.limit ? parseInt(query.limit) : 50;

    logger.info('GET /v2/activities/composition/state-transitions', {
      from_shapes: fromShapes,
      to_shapes: toShapes,
      activity_id: activityId,
      limit,
    });

    const whereClauses: string[] = [];
    const params: Record<string, any> = { limit };

    if (activityId) {
      whereClauses.push(`(parent_activity_id = $activity_id OR child_activity_id = $activity_id)`);
      params.activity_id = activityId;
    }

    if (fromShapes && Array.isArray(fromShapes) && fromShapes.length > 0) {
      whereClauses.push(`array::len(array::intersect(input_impulse_shapes, $from_shapes)) > 0`);
      params.from_shapes = fromShapes;
    }

    if (toShapes && Array.isArray(toShapes) && toShapes.length > 0) {
      whereClauses.push(`array::len(array::intersect(output_impulse_shapes, $to_shapes)) > 0`);
      params.to_shapes = toShapes;
    }

    let transitionsQuery = `
      SELECT
        parent_activity_id,
        child_activity_id,
        input_impulse_shapes,
        output_impulse_shapes,
        weight,
        execution_count,
        success_count,
        math::mean(duration_ms) AS avg_duration_ms,
        math::mean(cost_usd) AS avg_cost_usd
      FROM activity_composition_graph
    `;

    if (whereClauses.length > 0) {
      transitionsQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    transitionsQuery += `
      ORDER BY weight DESC, execution_count DESC
      LIMIT $limit
    `;

    const transitions = await surrealDB.query(transitionsQuery, params);

    // Aggregate shape transformation statistics
    const shapeTransformations = new Map<string, {
      from_shapes: Set<string>;
      to_shapes: Set<string>;
      activities: Set<string>;
      total_executions: number;
      successful_executions: number;
      avg_duration_ms: number;
      avg_cost_usd: number;
    }>();

    if (transitions && Array.isArray(transitions)) {
      for (const edge of transitions.flat()) {
        const key = `${edge.parent_activity_id}->${edge.child_activity_id}`;
        const existing = shapeTransformations.get(key);

        if (existing) {
          edge.input_impulse_shapes?.forEach((s: string) => existing.from_shapes.add(s));
          edge.output_impulse_shapes?.forEach((s: string) => existing.to_shapes.add(s));
          existing.total_executions += edge.execution_count || 0;
          existing.successful_executions += edge.success_count || 0;
        } else {
          shapeTransformations.set(key, {
            from_shapes: new Set(edge.input_impulse_shapes || []),
            to_shapes: new Set(edge.output_impulse_shapes || []),
            activities: new Set([edge.parent_activity_id, edge.child_activity_id]),
            total_executions: edge.execution_count || 0,
            successful_executions: edge.success_count || 0,
            avg_duration_ms: edge.avg_duration_ms || 0,
            avg_cost_usd: edge.avg_cost_usd || 0,
          });
        }
      }
    }

    // Convert to array for response
    const stateTransitions = Array.from(shapeTransformations.entries()).map(([key, stats]) => ({
      transition: key,
      from_shapes: Array.from(stats.from_shapes),
      to_shapes: Array.from(stats.to_shapes),
      activities: Array.from(stats.activities),
      success_rate: stats.total_executions > 0
        ? stats.successful_executions / stats.total_executions
        : 0,
      total_executions: stats.total_executions,
      avg_duration_ms: stats.avg_duration_ms,
      avg_cost_usd: stats.avg_cost_usd,
    }));

    logger.info('State transitions query result', {
      transitions: stateTransitions.length,
    });

    return c.json({
      state_transitions: stateTransitions,
      total: stateTransitions.length,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/state-transitions failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query state transitions',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/successors
 * Query composition successors for an activity
 *
 * Returns activities that have historically followed the given activity
 * with their success rates, costs, and durations. Used for post-execution
 * recommendations.
 *
 * Query parameters:
 * - activity_id: Activity to get successors for (required)
 * - min_weight: Minimum edge weight (default: 0.5 = 50% success rate)
 * - limit: Max results (default: 10)
 *
 * Returns array of successor activities sorted by weight (success rate)
 */
app.get('/composition/successors', async (c) => {
  try {
    const query = c.req.query();
    const activityId = query.activity_id;
    const minWeight = query.min_weight ? parseFloat(query.min_weight) : 0.5;
    const limit = query.limit ? parseInt(query.limit) : 10;

    if (!activityId) {
      return c.json({
        error: 'Validation failed',
        message: 'activity_id is required',
      }, 400);
    }

    logger.info('GET /v2/activities/composition/successors', {
      activityId,
      minWeight,
      limit,
    });

    // Query composition graph for edges where this activity is parent
    const successorsQuery = `
      SELECT
        child_activity_id,
        weight,
        avg_duration_ms,
        avg_cost_usd,
        success_count,
        total_count
      FROM activity_composition_graph
      WHERE parent_activity_id = $activity_id
        AND weight >= $min_weight
      ORDER BY weight DESC
      LIMIT $limit
    `;

    const result = await surrealDB.query(successorsQuery, {
      activity_id: activityId,
      min_weight: minWeight,
      limit,
    });

    const successors = (result && Array.isArray(result) ? result.flat() : []);

    logger.info('Composition successors query result', {
      activityId,
      successorCount: successors.length,
    });

    return c.json({
      successors,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/successors failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query composition successors',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/composition/impulse-success
 * Query impulse-conditioned success rates from composition data
 *
 * This endpoint enables queries like:
 * - "Success rate when parent X calls child Y with shape Z loaded"
 * - "Which input shapes correlate with composition success?"
 * - "Which output shapes indicate successful completion?"
 *
 * Query parameters:
 * - edge_id: Filter by specific composition edge (parent:child)
 * - shape: Filter by specific impulse shape
 * - direction: Filter by 'input' or 'output'
 * - min_count: Minimum count for statistical significance (default: 3)
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 *
 * Returns success rates grouped by edge, shape, and direction
 */
app.get('/composition/impulse-success', async (c) => {
  try {
    const query = c.req.query();

    const edgeId = query.edge_id;
    const shape = query.shape;
    const direction = query.direction as 'input' | 'output' | undefined;
    const minCount = query.min_count ? parseInt(query.min_count) : 3;
    const limit = query.limit ? parseInt(query.limit) : 100;
    const offset = query.offset ? parseInt(query.offset) : 0;

    logger.info('GET /v2/activities/composition/impulse-success', {
      edge_id: edgeId,
      shape,
      direction,
      min_count: minCount,
      limit,
      offset,
    });

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
      min_count: minCount,
    };

    if (edgeId) {
      whereClauses.push(`edge_id = $edge_id`);
      params.edge_id = edgeId;
    }

    if (shape) {
      whereClauses.push(`shape = $shape`);
      params.shape = shape;
    }

    if (direction) {
      whereClauses.push(`direction = $direction`);
      params.direction = direction;
    }

    // Query from the view (v_composition_impulse_success) or aggregate directly
    // Note: SurrealDB 2.x does not support HAVING clause, using subquery with WHERE instead
    let ratesQuery = `
      SELECT * FROM (
        SELECT
          edge_id,
          shape,
          direction,
          count() as total_count,
          count(IF execution_succeeded = true THEN 1 ELSE NONE END) as success_count,
          (count(IF execution_succeeded = true THEN 1 ELSE NONE END) * 1.0 / count()) as success_rate
        FROM composition_impulse_flow
    `;

    if (whereClauses.length > 0) {
      ratesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    ratesQuery += `
        GROUP BY edge_id, shape, direction
      ) WHERE total_count >= $min_count
      ORDER BY success_rate DESC
      LIMIT $limit START $offset
    `;

    // Count query for total
    // Note: SurrealDB 2.x does not support HAVING clause, using nested subquery with WHERE instead
    let countQuery = `
      SELECT count() as total FROM (
        SELECT * FROM (
          SELECT edge_id, shape, direction, count() as cnt
          FROM composition_impulse_flow
          ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
          GROUP BY edge_id, shape, direction
        ) WHERE cnt >= $min_count
      )
    `;

    const [ratesResult, countResult] = await Promise.all([
      surrealDB.query<any[]>(ratesQuery, params),
      surrealDB.query<any[]>(countQuery, params),
    ]);

    const rates = ratesResult && Array.isArray(ratesResult) ? ratesResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : rates.length;

    logger.info('Composition impulse success query result', {
      rates_count: rates.length,
      total,
    });

    return c.json({
      rates,
      total,
    });
  } catch (error: any) {
    logger.error('GET /v2/activities/composition/impulse-success failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query impulse success rates',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/validate-composition
 *
 * Validate a composition graph for cycles and impulse shape compatibility.
 * Used by the composition builder UI to provide real-time validation feedback.
 *
 * Request body:
 * - nodes: Array of { activity_id: string, output_shapes?: string[] }
 * - edges: Array of { from: string, to: string }
 *
 * Returns:
 * - valid: boolean
 * - errors: Array of validation errors
 *   - { type: 'cycle', path: string[] } for cycles
 *   - { type: 'shape_mismatch', from: string, to: string, details: string } for incompatible shapes
 */
app.post('/validate-composition', async (c) => {
  try {
    const body = await c.req.json();

    if (!body.nodes || !Array.isArray(body.nodes) || !body.edges || !Array.isArray(body.edges)) {
      return c.json({
        error: 'Invalid request body',
        required: { nodes: 'array', edges: 'array' },
      }, 400);
    }

    const { nodes, edges } = body;
    const errors: Array<{ type: string; [key: string]: any }> = [];

    // Build adjacency list for cycle detection
    const adjacencyList = new Map<string, string[]>();
    for (const node of nodes) {
      if (!adjacencyList.has(node.activity_id)) {
        adjacencyList.set(node.activity_id, []);
      }
    }
    for (const edge of edges) {
      const neighbors = adjacencyList.get(edge.from) || [];
      neighbors.push(edge.to);
      adjacencyList.set(edge.from, neighbors);
    }

    // Cycle detection using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycleDetected: string[][] = [];

    function detectCycle(nodeId: string, path: string[]): boolean {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      path.push(nodeId);

      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (detectCycle(neighbor, [...path])) {
            return true;
          }
        } else if (recursionStack.has(neighbor)) {
          // Found a cycle
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart >= 0) {
            cycleDetected.push([...path.slice(cycleStart), neighbor]);
          }
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    }

    for (const node of nodes) {
      if (!visited.has(node.activity_id)) {
        detectCycle(node.activity_id, []);
      }
    }

    if (cycleDetected.length > 0) {
      for (const cycle of cycleDetected) {
        errors.push({
          type: 'cycle',
          path: cycle,
          message: `Cycle detected: ${cycle.join(' → ')}`,
        });
      }
    }

    // Shape compatibility validation
    // Fetch activity templates to get input/output shapes
    const activityIds = nodes.map((n: any) => n.activity_id);
    if (activityIds.length > 0) {
      try {
        const templatesQuery = `
          SELECT id, input_shapes, output_shapes FROM activity
          WHERE id IN $activity_ids
        `;
        const templatesResult = await surrealDB.query<Array<{
          id: string;
          input_shapes?: string[];
          output_shapes?: string[];
        }>>(templatesQuery, { activity_ids: activityIds });

        // surrealDB.query returns an array of result sets, take the first one
        const templates = templatesResult[0] || [];

        const shapeMap = new Map<string, { input: string[]; output: string[] }>();
        for (const template of templates) {
          shapeMap.set(template.id, {
            input: template.input_shapes || [],
            output: template.output_shapes || [],
          });
        }

        // Check each edge for shape compatibility
        for (const edge of edges) {
          const fromShapes = shapeMap.get(edge.from);
          const toShapes = shapeMap.get(edge.to);

          if (!fromShapes || !toShapes) {
            continue; // Skip if template not found
          }

          // Check if any output shape from 'from' activity matches input shapes of 'to' activity
          if (toShapes.input.length > 0 && fromShapes.output.length > 0) {
            const hasCompatibleShape = fromShapes.output.some((outputShape: string) =>
              toShapes.input.includes(outputShape)
            );

            if (!hasCompatibleShape) {
              errors.push({
                type: 'shape_mismatch',
                from: edge.from,
                to: edge.to,
                fromOutputShapes: fromShapes.output,
                toInputShapes: toShapes.input,
                message: `No compatible shapes between ${edge.from} (outputs: ${fromShapes.output.join(', ')}) and ${edge.to} (inputs: ${toShapes.input.join(', ')})`,
              });
            }
          }
        }
      } catch (dbError) {
        logger.error('Failed to fetch activity templates for shape validation', {
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
        errors.push({
          type: 'validation_error',
          message: 'Failed to validate shapes - database error',
        });
      }
    }

    const valid = errors.length === 0;

    logger.info('POST /v2/activities/validate-composition', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      valid,
      errorCount: errors.length,
    });

    return c.json({
      valid,
      errors,
      summary: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        cyclesDetected: cycleDetected.length,
        shapeMismatches: errors.filter(e => e.type === 'shape_mismatch').length,
      },
    });

  } catch (error) {
    logger.error('POST /v2/activities/validate-composition failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to validate composition',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * POST /v2/activities/similar-state
 * Query executions with similar available shapes (Task #29)
 *
 * Finds past executions that had similar impulse state (available shapes)
 * to the current state. Uses Jaccard similarity on shape sets.
 *
 * Request body:
 * - state_signature: State signature hash
 * - available_shapes: Array of shapes currently available
 * - min_similarity: Minimum similarity threshold (0.0-1.0, default: 0.5)
 * - limit: Maximum results (default: 10)
 *
 * Returns executions sorted by similarity score descending.
 */
/**
 * POST /v2/activities/shape-gap-resolution
 *
 * Phase 10 P4.5 of 2026-04-26-impulse-activity-loop. Records (or
 * updates the usage counters of) a resolution for a previously
 * missing impulse shape. Called by activity-api itself when a
 * goal-seeking sub-tree completes successfully, or by MiniBob's
 * slot-binding meta-activity via the `shapeGapResolution_write`
 * impulse-resolve resolver.
 *
 * Body:
 *   shape, resolved_by, resolution_type ∈ {activity, vessel, subgoal,
 *     manual_seed}, escalation_depth (≥ 0), cost_usd (≥ 0),
 *     account_id?, required_scope?
 *
 * Behaviour:
 *   - UPSERT keyed on (shape, account_id, resolved_by, resolution_type)
 *     so an identical resolution increments times_used + folds the new
 *     cost into a running mean rather than creating a duplicate row.
 *   - last_used_at refreshed on every write; first_seen_at is set
 *     on creation only.
 *
 * Multi-tenant: PERMISSIONS on the table (migration 105) enforce
 * org / account scoping at the row level when JWT auth is active.
 */
app.post('/shape-gap-resolution', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const callerAccountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({
        error: 'Unauthorized',
        message: 'Missing organization context',
      }, 401);
    }

    const body = await c.req.json();
    const {
      shape,
      account_id,
      resolved_by,
      resolution_type,
      required_scope,
      escalation_depth,
      cost_usd,
    } = body;

    if (typeof shape !== 'string' || shape.length === 0) {
      return c.json({ error: 'shape is required (non-empty string)' }, 400);
    }
    if (typeof resolved_by !== 'string' || resolved_by.length === 0) {
      return c.json({ error: 'resolved_by is required (non-empty string)' }, 400);
    }
    const validTypes = new Set(['activity', 'vessel', 'subgoal', 'manual_seed']);
    if (!validTypes.has(resolution_type)) {
      return c.json({
        error: `resolution_type must be one of: ${[...validTypes].join(', ')}`,
      }, 400);
    }
    const escDepth = typeof escalation_depth === 'number' && escalation_depth >= 0
      ? Math.floor(escalation_depth) : 0;
    const costSafe = typeof cost_usd === 'number' && cost_usd >= 0 ? cost_usd : 0;
    // Body's account_id wins over the caller's; falls back to the
    // caller's accountId when the body doesn't specify, lets cross-
    // account rows pass through with explicit null.
    const rowAccountId = account_id !== undefined ? account_id : callerAccountId;

    // UPSERT keyed on the resolution identity. WHERE matches a row
    // representing the same way we resolved this gap; if found,
    // increment + recompute average; otherwise CREATE.
    const upsertQuery = `
      LET $existing = (
        SELECT id, times_used, cost_usd
        FROM shape_gap_resolution
        WHERE shape = $shape
          AND org_id = $org_id
          AND (account_id IS NONE AND $account_id IS NONE OR account_id = $account_id)
          AND resolved_by = $resolved_by
          AND resolution_type = $resolution_type
        LIMIT 1
      )[0];
      IF $existing != NONE THEN (
        UPDATE type::record('shape_gap_resolution', record::id($existing.id))
        SET
          times_used = (times_used ?? 0) + 1,
          cost_usd = (((cost_usd ?? 0) * (times_used ?? 0)) + $cost_usd) / ((times_used ?? 0) + 1),
          last_used_at = time::now(),
          escalation_depth = math::min([escalation_depth, $escalation_depth]),
          required_scope = $required_scope
        RETURN AFTER
      ) ELSE (
        CREATE shape_gap_resolution CONTENT {
          shape: $shape,
          account_id: $account_id,
          account_id_version: 1,
          org_id: $org_id,
          resolved_by: $resolved_by,
          required_scope: $required_scope,
          resolution_type: $resolution_type,
          escalation_depth: $escalation_depth,
          cost_usd: $cost_usd,
          times_used: 1,
          first_seen_at: time::now(),
          last_used_at: time::now()
        }
      ) END;
    `;
    const params = {
      shape,
      org_id: orgId,
      account_id: rowAccountId,
      resolved_by,
      resolution_type,
      required_scope: required_scope ?? null,
      escalation_depth: escDepth,
      cost_usd: costSafe,
    };

    const result = jwtAuth?.jwtToken
      ? await queryWithAuth<any>(jwtAuth.jwtToken, upsertQuery, params)
      : await surrealDB.query<any>(upsertQuery, params);
    const row = (Array.isArray(result) ? result.flat()[0] : result) ?? null;

    return c.json({
      success: true,
      shape,
      account_id: rowAccountId,
      row,
    });
  } catch (error: any) {
    logger.error('POST /v2/activities/shape-gap-resolution failed', {
      error: error.message,
    });
    return c.json({ error: error.message }, 500);
  }
});

app.post('/similar-state', async (c) => {
  try {
    const body = await c.req.json();
    const {
      state_signature,
      available_shapes,
      min_similarity = 0.5,
      limit = 10,
    } = body;

    logger.info('POST /v2/activities/similar-state', {
      state_signature,
      shapes_count: available_shapes?.length || 0,
      min_similarity,
      limit,
    });

    if (!available_shapes || !Array.isArray(available_shapes)) {
      return c.json({
        error: 'available_shapes is required and must be an array',
      }, 400);
    }

    // Fast path: Check for exact state_signature match using indexed field
    // This enables instant retrieval of executions with identical state
    if (state_signature) {
      logger.debug('Attempting fast path: exact state_signature match', { state_signature });

      const exactQuery = `
        SELECT
          id,
          activity_id,
          success,
          duration_ms,
          cost_usd,
          input_impulses,
          output_impulses
        FROM execution
        WHERE state_signature = $state_signature
        ORDER BY created_at DESC
        LIMIT $limit
      `;

      const exactResults = await surrealDB.query<any[]>(exactQuery, {
        state_signature,
        limit,
      });

      const exactMatches = exactResults && Array.isArray(exactResults) ? exactResults.flat() : [];

      if (exactMatches.length > 0) {
        logger.info('Fast path hit: exact state_signature matches found', {
          count: exactMatches.length,
          state_signature,
        });

        // Return exact matches with similarity score of 1.0
        const formatted = exactMatches.map((exec: any) => ({
          execution_id: exec.id,
          activity_id: exec.activity_id,
          similarity: 1.0,
          success: exec.success || false,
          duration_ms: exec.duration_ms || 0,
          cost_usd: exec.cost_usd || 0,
          input_shapes: exec.input_impulses || [],
          output_shapes: exec.output_impulses || [],
        }));

        return c.json({
          executions: formatted,
          total: formatted.length,
          fast_path: true,
        });
      }

      logger.debug('Fast path miss: no exact state_signature matches, falling back to similarity', {
        state_signature,
      });
    }

    // Fallback path: Jaccard similarity on shapes
    // Query executions that have input shapes overlapping with available shapes
    // Use CONTAINSANY to find executions with at least one matching shape
    const similarityQuery = `
      SELECT
        id,
        activity_id,
        success,
        duration_ms,
        cost_usd,
        input_impulses,
        output_impulses
      FROM execution
      WHERE input_impulses CONTAINSANY $available_shapes
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const results = await surrealDB.query<any[]>(similarityQuery, {
      available_shapes,
    });

    const executions = results && Array.isArray(results) ? results.flat() : [];

    // Calculate Jaccard similarity for each execution
    const availableSet = new Set(available_shapes);
    const withSimilarity = executions.map((exec: any) => {
      const execShapes = exec.input_impulses || [];
      const execSet = new Set(execShapes);

      // Calculate intersection
      const intersection = new Set(
        [...execSet].filter(shape => availableSet.has(shape))
      );

      // Calculate union
      const union = new Set([...execSet, ...availableSet]);

      // Jaccard similarity
      const similarity = union.size > 0 ? intersection.size / union.size : 0;

      return {
        execution_id: exec.id,
        activity_id: exec.activity_id,
        similarity,
        success: exec.success || false,
        duration_ms: exec.duration_ms || 0,
        cost_usd: exec.cost_usd || 0,
        input_shapes: execShapes,
        output_shapes: exec.output_impulses || [],
      };
    });

    // Filter by minimum similarity and sort by similarity descending
    const filtered = withSimilarity
      .filter(exec => exec.similarity >= min_similarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    logger.info('Similarity fallback query result', {
      total_executions: executions.length,
      filtered_count: filtered.length,
      top_similarity: filtered[0]?.similarity,
    });

    return c.json({
      executions: filtered,
      total: filtered.length,
      fast_path: false,
    });
  } catch (error: any) {
    logger.error('POST /v2/activities/similar-state failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to query similar executions',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /v2/activities/impulse-relevance
 * Record impulse usage and outcome for relevance learning
 *
 * This endpoint implements Bayesian learning for impulse relevance:
 * - Track: was impulse loaded? did execution succeed?
 * - Learn: P(success | impulse present) vs P(success | impulse absent)
 * - Optimize: Skip loading irrelevant impulses (save tokens)
 *
 * Bayesian calculation:
 * relevance_score = P(success | loaded) = times_execution_succeeded / times_loaded
 * irrelevance_score = P(success | not loaded) = times_not_loaded_succeeded / times_not_loaded
 *
 * Decision rule:
 * - If relevance_score >> irrelevance_score → impulse is critical
 * - If relevance_score ≈ irrelevance_score → impulse is irrelevant
 * - If relevance_score << irrelevance_score → impulse is harmful
 */
app.post('/impulse-relevance', async (c) => {
  try {
    const body = await c.req.json();
    // Legacy-field coercion: legacy callers (e.g. minibob mcp.ts) send
    // `activity_id`, but the schema requires `activity_variant_id`. Map the
    // legacy field to the canonical one when the canonical one is absent.
    // Explicit `activity_variant_id` always wins. Remove once all callers are
    // updated.
    if (body && body.activity_id && !body.activity_variant_id) {
      logger.warn(
        "[impulse-relevance] caller using deprecated 'activity_id' field; use 'activity_variant_id'. Coercion applied.",
        { activity_id: body.activity_id },
      );
      body.activity_variant_id = body.activity_id;
    }
    const validated = ImpulseRelevanceRecordRequestSchema.parse(body);

    // Phase E: pull tenant context from JWT auth so the (impulse, variant,
    // task) aggregation key becomes (impulse, variant, task, account|org).
    // Pre-Phase-E rows have no org/account scoping at all — they aggregated
    // across the whole platform. From this point on, two callers in different
    // accounts maintain separate Bayesian posteriors for the same
    // (impulse, variant, task) triple.
    const relevanceJwtAuth = getJwtAuthFromContext(c);
    const sessionForRelevance = (c.get as any)('session') as SessionData | undefined;
    // When invoked through the internal write-delegation path
    // (POST /v2/impulses/resolve → impulseRelevance_write), the inner sub-router
    // has no auth middleware, so getJwtAuthFromContext() returns null here.
    // delegateWriteToRouter injects the outer ApiKey-resolved org into body.org_id;
    // honour it before falling back to null, otherwise the CREATE writes a NULL
    // org_id and SurrealDB rejects it against the non-optional TYPE string field
    // (the ribosome replay-observer path 500s 100% of the time without this).
    const relevanceOrgId =
      relevanceJwtAuth?.orgId ??
      sessionForRelevance?.org_id ??
      (typeof body?.org_id === 'string' ? body.org_id : null);
    const relevanceAccountId: string | null =
      relevanceJwtAuth?.accountId ?? null;

    logger.info('POST /v2/activities/impulse-relevance', {
      impulse_id: validated.impulse_id,
      activity: validated.activity_variant_id,
      was_loaded: validated.was_loaded,
      success: validated.execution_succeeded,
      org_id: relevanceOrgId,
      account_id: relevanceAccountId,
      // M3: surface replay provenance on the log line so the audit trail
      // is searchable even before persistence-side migration lands.
      ...(validated.source ? { source: validated.source } : {}),
      ...(validated.replay_trace_id ? { replay_trace_id: validated.replay_trace_id } : {}),
      ...(validated.replay_weight !== undefined ? { replay_weight: validated.replay_weight } : {}),
    });

    // Check if metric exists for this (impulse, variant, task, tenant) tuple.
    // Phase E: tenant is part of the de-facto unique key. accountIdScopedWhere
    // returns rows that match account_id when present, falling back to
    // org_id when account_id IS NONE — so legacy rows still increment.
    const checkQuery = `
      SELECT * FROM impulse_relevance_metrics
      WHERE impulse_id = $impulse_id
        AND activity_variant_id = $activity_variant_id
        AND (task_id = $task_id OR (task_id IS NULL AND $task_id IS NULL))
        AND ${accountIdScopedWhere()}
      LIMIT 1
    `;

    const existing = await surrealDB.query<ImpulseRelevanceMetric[]>(checkQuery, {
      impulse_id: validated.impulse_id,
      activity_variant_id: validated.activity_variant_id,
      task_id: validated.task_id ?? undefined,
      org_id: relevanceOrgId,
      account_id: relevanceAccountId,
    });

    let metric: ImpulseRelevanceMetric;

    if (existing && existing.length > 0 && existing[0]) {
      // Update existing metric
      const current = existing[0];
      
      // @ts-ignore - SurrealDB typing
      let newTimesLoaded = current.times_loaded || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesExecutionSucceeded = current.times_execution_succeeded || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesExecutionFailed = current.times_execution_failed || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesNotLoadedSucceeded = current.times_not_loaded_succeeded || 0;
      // @ts-ignore - SurrealDB typing
      let newTimesNotLoadedFailed = current.times_not_loaded_failed || 0;

      if (validated.was_loaded) {
        newTimesLoaded++;
        if (validated.execution_succeeded) {
          newTimesExecutionSucceeded++;
        } else {
          newTimesExecutionFailed++;
        }
      } else {
        if (validated.execution_succeeded) {
          newTimesNotLoadedSucceeded++;
        } else {
          newTimesNotLoadedFailed++;
        }
      }

      // Calculate Bayesian scores
      const relevanceScore = newTimesLoaded > 0
        ? newTimesExecutionSucceeded / newTimesLoaded
        : 0;
      const irrelevanceScore = (newTimesNotLoadedSucceeded + newTimesNotLoadedFailed) > 0
        ? newTimesNotLoadedSucceeded / (newTimesNotLoadedSucceeded + newTimesNotLoadedFailed)
        : 0;
      const netValueScore = Math.max(-1, Math.min(1, relevanceScore - irrelevanceScore * 0.5));

      // Update average content size
      // @ts-ignore - SurrealDB typing
      const totalSizeSamples = current.times_loaded || 0;
      // @ts-ignore - SurrealDB typing
      const currentAvgSize = current.avg_content_size_tokens || 0;
      const newAvgSize = validated.content_size_tokens !== undefined
        ? Math.floor((currentAvgSize * totalSizeSamples + validated.content_size_tokens) / (totalSizeSamples + 1))
        : currentAvgSize;

      // Update resolver tracking metrics (resolver-tier-tracking)
      // @ts-ignore - SurrealDB typing
      const currentResolverSuccessCount = current.resolver_success_count || 0;
      // @ts-ignore - SurrealDB typing
      const currentResolverFailureCount = current.resolver_failure_count || 0;
      // @ts-ignore - SurrealDB typing
      const currentAvgLatency = current.avg_resolution_latency_ms || 0;
      const totalResolutions = currentResolverSuccessCount + currentResolverFailureCount;

      const newResolverSuccessCount = validated.was_loaded && validated.execution_succeeded
        ? currentResolverSuccessCount + 1
        : currentResolverSuccessCount;
      const newResolverFailureCount = validated.was_loaded && !validated.execution_succeeded
        ? currentResolverFailureCount + 1
        : currentResolverFailureCount;

      // Update average latency if resolution latency provided
      const newAvgLatency = validated.resolution_latency_ms !== undefined && totalResolutions > 0
        ? Math.floor((currentAvgLatency * totalResolutions + validated.resolution_latency_ms) / (totalResolutions + 1))
        : currentAvgLatency;

      // Phase E: dual-tenant WHERE so the UPDATE only touches the row
      // belonging to this account (or the legacy row when accountId is null).
      // Without this, two accounts in the same org would race over the same
      // row's scores.
      const updateQuery = `
        UPDATE impulse_relevance_metrics
        SET
          times_loaded = $times_loaded,
          times_execution_succeeded = $times_execution_succeeded,
          times_execution_failed = $times_execution_failed,
          times_not_loaded_succeeded = $times_not_loaded_succeeded,
          times_not_loaded_failed = $times_not_loaded_failed,
          relevance_score = $relevance_score,
          irrelevance_score = $irrelevance_score,
          net_value_score = $net_value_score,
          avg_content_size_tokens = $avg_content_size_tokens,
          typical_pointer_type = $typical_pointer_type,
          resolver_tier = $resolver_tier,
          resolver_name = $resolver_name,
          avg_resolution_latency_ms = $avg_resolution_latency_ms,
          resolver_success_count = $resolver_success_count,
          resolver_failure_count = $resolver_failure_count,
          updated_at = time::now()
        WHERE impulse_id = $impulse_id
          AND activity_variant_id = $activity_variant_id
          AND (task_id = $task_id OR (task_id IS NULL AND $task_id IS NULL))
          AND ${accountIdScopedWhere()}
        RETURN AFTER
      `;

      const updated = await surrealDB.query<ImpulseRelevanceMetric[]>(updateQuery, {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        org_id: relevanceOrgId,
        account_id: relevanceAccountId,
        times_loaded: newTimesLoaded,
        times_execution_succeeded: newTimesExecutionSucceeded,
        times_execution_failed: newTimesExecutionFailed,
        times_not_loaded_succeeded: newTimesNotLoadedSucceeded,
        times_not_loaded_failed: newTimesNotLoadedFailed,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        net_value_score: netValueScore,
        avg_content_size_tokens: newAvgSize,
        // @ts-ignore - SurrealDB typing
        typical_pointer_type: validated.pointer_type ?? current.typical_pointer_type,
        // Resolver tracking fields (use most recent values)
        // @ts-ignore - SurrealDB typing
        resolver_tier: validated.resolver_tier ?? current.resolver_tier,
        // @ts-ignore - SurrealDB typing
        resolver_name: validated.resolver_name ?? current.resolver_name,
        avg_resolution_latency_ms: newAvgLatency,
        resolver_success_count: newResolverSuccessCount,
        resolver_failure_count: newResolverFailureCount,
      });

      // @ts-ignore - SurrealDB typing
      metric = updated && updated.length > 0 ? updated[0] : current;

      logger.info('Updated impulse relevance metric', {
        impulse_id: validated.impulse_id,
        activity: validated.activity_variant_id,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
      });
    } else {
      // Create new metric.
      // Phase E: dual-write account_id + org_id + version=1 marker so future
      // reads via accountIdScopedWhere() find this row, and a Phase F
      // backfill pass can identify rows already tagged.
      // I2.4 sibling guard: account_id is option<string> per the deployed
      // schema; SurrealDB 3.x rejects JSON `null` (see I2.4 + I2.4 followup).
      // Coerce on the SQL side so the JS-side `?? null` shape stays unchanged.
      const createQuery = `
        CREATE impulse_relevance_metrics CONTENT {
          impulse_id: $impulse_id,
          activity_variant_id: $activity_variant_id,
          task_id: $task_id,
          org_id: $org_id,
          account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
          account_id_version: 1,
          times_loaded: $times_loaded,
          times_execution_succeeded: $times_execution_succeeded,
          times_execution_failed: $times_execution_failed,
          times_not_loaded_succeeded: $times_not_loaded_succeeded,
          times_not_loaded_failed: $times_not_loaded_failed,
          relevance_score: $relevance_score,
          irrelevance_score: $irrelevance_score,
          net_value_score: $net_value_score,
          avg_content_size_tokens: $avg_content_size_tokens,
          typical_pointer_type: $typical_pointer_type,
          resolver_tier: $resolver_tier,
          resolver_name: $resolver_name,
          avg_resolution_latency_ms: $avg_resolution_latency_ms,
          resolver_success_count: $resolver_success_count,
          resolver_failure_count: $resolver_failure_count,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const relevanceScore = validated.was_loaded && validated.execution_succeeded ? 1.0 : 0.0;
      const irrelevanceScore = !validated.was_loaded && validated.execution_succeeded ? 1.0 : 0.0;
      const netValueScore = Math.max(-1, Math.min(1, relevanceScore - irrelevanceScore * 0.5));

      const created = await surrealDB.query<ImpulseRelevanceMetric[]>(createQuery, {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        org_id: relevanceOrgId,
        account_id: relevanceAccountId,
        times_loaded: validated.was_loaded ? 1 : 0,
        times_execution_succeeded: validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_execution_failed: validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        times_not_loaded_succeeded: !validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_not_loaded_failed: !validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        net_value_score: netValueScore,
        avg_content_size_tokens: validated.content_size_tokens || 0,
        // Resolver tracking fields (resolver-tier-tracking)
        resolver_tier: validated.resolver_tier ?? undefined,
        resolver_name: validated.resolver_name ?? undefined,
        avg_resolution_latency_ms: validated.resolution_latency_ms || 0,
        resolver_success_count: validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        resolver_failure_count: validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        typical_pointer_type: validated.pointer_type || '',
      });

      // @ts-ignore - SurrealDB typing
      metric = created && created.length > 0 ? created[0] : {
        impulse_id: validated.impulse_id,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id,
        times_loaded: validated.was_loaded ? 1 : 0,
        times_execution_succeeded: validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_execution_failed: validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        times_not_loaded_succeeded: !validated.was_loaded && validated.execution_succeeded ? 1 : 0,
        times_not_loaded_failed: !validated.was_loaded && !validated.execution_succeeded ? 1 : 0,
        relevance_score: relevanceScore,
        irrelevance_score: irrelevanceScore,
        net_value_score: netValueScore,
        avg_content_size_tokens: validated.content_size_tokens || 0,
        typical_pointer_type: validated.pointer_type || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      logger.info('Created impulse relevance metric', {
        impulse_id: validated.impulse_id,
        activity: validated.activity_variant_id,
      });
    }

    return c.json({
      success: true,
      metric,
    });
  } catch (error: any) {
    logger.error('POST /v2/activities/impulse-relevance failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record impulse relevance',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /v2/activities/impulse-relevance
 * Query impulse relevance metrics
 * 
 * Query parameters:
 * - impulse_id: Filter by specific impulse
 * - activity_variant_id: Filter by specific activity
 * - min_relevance_score: Filter metrics with relevance >= threshold
 * - max_irrelevance_score: Filter metrics with irrelevance <= threshold
 * - limit: Max results (default: 100)
 * - offset: Pagination offset (default: 0)
 * 
 * Use cases:
 * 1. Find irrelevant impulses: max_irrelevance_score=0.3 (high success without impulse)
 * 2. Find critical impulses: min_relevance_score=0.8 (high success only with impulse)
 * 3. Optimize activity: Get all metrics for activity_variant_id, skip low-relevance
 */
app.get('/impulse-relevance', async (c) => {
  try {
    const query = c.req.query();
    const validated = ImpulseRelevanceQuerySchema.parse({
      impulse_id: query.impulse_id,
      activity_variant_id: query.activity_variant_id,
      min_relevance_score: query.min_relevance_score ? parseFloat(query.min_relevance_score) : undefined,
      max_irrelevance_score: query.max_irrelevance_score ? parseFloat(query.max_irrelevance_score) : undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });

    // Phase E: scope reads by tenant. Pre-Phase-E rows had no scoping at all
    // (account_id IS NONE AND org_id IS NONE), so the dual-tenant WHERE will
    // miss them — but those rows are platform-wide aggregates that are
    // semantically wrong to return to a specific tenant anyway. Going forward
    // every new row carries org_id + account_id.
    const relevanceJwtAuth = getJwtAuthFromContext(c);
    const sessionForRelevance = (c.get as any)('session') as SessionData | undefined;
    const relevanceOrgId =
      relevanceJwtAuth?.orgId ?? sessionForRelevance?.org_id ?? null;
    const relevanceAccountId: string | null =
      relevanceJwtAuth?.accountId ?? null;

    logger.info('GET /v2/activities/impulse-relevance', {
      ...validated,
      org_id: relevanceOrgId,
      account_id: relevanceAccountId,
    });

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };

    if (validated.impulse_id) {
      whereClauses.push(`impulse_id = $impulse_id`);
      params.impulse_id = validated.impulse_id;
    }

    if (validated.activity_variant_id) {
      whereClauses.push(`activity_variant_id = $activity_variant_id`);
      params.activity_variant_id = validated.activity_variant_id;
    }

    if (validated.min_relevance_score !== undefined) {
      whereClauses.push(`relevance_score >= $min_relevance_score`);
      params.min_relevance_score = validated.min_relevance_score;
    }

    if (validated.max_irrelevance_score !== undefined) {
      whereClauses.push(`irrelevance_score <= $max_irrelevance_score`);
      params.max_irrelevance_score = validated.max_irrelevance_score;
    }

    // Phase E: tenant scoping. Always present so unauthenticated callers
    // get an empty result set (their org_id is null, account_id is null,
    // and the dual-tenant WHERE matches no rows by design).
    if (relevanceOrgId !== null || relevanceAccountId !== null) {
      whereClauses.push(accountIdScopedWhere());
      params.org_id = relevanceOrgId;
      params.account_id = relevanceAccountId;
    }

    let metricsQuery = `SELECT * FROM impulse_relevance_metrics`;
    if (whereClauses.length > 0) {
      metricsQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    metricsQuery += ` ORDER BY relevance_score DESC LIMIT $limit START $offset`;

    let countQuery = `SELECT count() as total FROM impulse_relevance_metrics`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [metricsResult, countResult] = await Promise.all([
      surrealDB.query<ImpulseRelevanceMetric[]>(metricsQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);

    // @ts-ignore - SurrealDB typing
    const response: ImpulseRelevanceResponse = {
      metrics: (metricsResult && Array.isArray(metricsResult) ? metricsResult.flat() : []),
      // @ts-ignore - SurrealDB typing
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };

    logger.info('Impulse relevance query result', {
      metrics: response.metrics.length,
      total: response.total,
    });

    return c.json(response);
  } catch (error: any) {
    logger.error('GET /v2/activities/impulse-relevance failed', {
      error: error.message,
      stack: error.stack,
    });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to query impulse relevance',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /tool-usage
 * 
 * Records tool usage during activity execution to learn:
 * - Which tools are required vs optional for each activity
 * - Success correlation between tool usage and activity outcomes
 * - Usage probability patterns
 * 
 * Learning metrics computed:
 * - usage_probability = times_used / total_executions
 * - is_required = (times_activity_succeeded_without_tool == 0)
 * - is_optional = (times_used < total_executions)
 * - success_correlation = correlation(tool_used, activity_succeeded)
 */
app.post('/tool-usage', async (c) => {
  try {
    const body = await c.req.json();

    // Phase B-followup: pull tenant context from JWT/session. tool_usage_patterns
    // historically had NO org_id field; migration 097 added option<string>
    // org_id + account_id so this route can dual-write going forward.
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Validate request body
    const validated = ToolUsageRecordRequestSchema.parse(body);
    logger.info('Recording tool usage', {
      tool: validated.tool_name,
      activity: validated.activity_variant_id,
      execution: validated.execution_id,
      orgId,
      accountId,
    });

    // Check if pattern exists.
    // Phase B-followup: dual-tenant scoping; legacy rows (no org_id) match
    // when both bound params are NONE/null via accountIdScopedWhere().
    const checkQuery = `
      SELECT * FROM tool_usage_patterns
      WHERE activity_variant_id = $activity_variant_id
        AND tool_name = $tool_name
        ${validated.task_id ? 'AND task_id = $task_id' : 'AND task_id IS NONE'}
        AND ${accountIdScopedWhere()}
      LIMIT 1
    `;

    const existing = await surrealDB.query<ToolUsagePattern[]>(checkQuery, {
      activity_variant_id: validated.activity_variant_id,
      tool_name: validated.tool_name,
      task_id: validated.task_id ?? undefined,
      org_id: orgId,
      account_id: accountId,
    });
    
    let pattern: ToolUsagePattern;
    
    if (existing && existing.length > 0 && existing[0]) {
      // Update existing pattern
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing issue
      const newTimesUsed = (current.times_used || 0) + 1;
      // @ts-ignore - SurrealDB query typing issue
      const newTimesSucceeded = (current.times_succeeded || 0) + (validated.tool_succeeded ? 1 : 0);
      // @ts-ignore - SurrealDB query typing issue
      const newTimesFailed = (current.times_failed || 0) + (validated.tool_succeeded ? 0 : 1);
      // @ts-ignore - SurrealDB query typing issue
      const newTimesActivitySucceededWithTool = (current.times_activity_succeeded_with_tool || 0) + (validated.activity_succeeded ? 1 : 0);
      
      // Get total activity executions to compute usage probability
      // @ts-ignore - SurrealDB query typing issue
      const timesActivitySucceededWithoutTool = current.times_activity_succeeded_without_tool || 0;
      const totalExecutions = newTimesUsed + timesActivitySucceededWithoutTool;
      const usageProbability = totalExecutions > 0 ? newTimesUsed / totalExecutions : 0;
      
      // Tool is required if activity NEVER succeeded without it
      const isRequired = timesActivitySucceededWithoutTool === 0 && newTimesActivitySucceededWithTool > 0;
      
      // Tool is optional if not always used
      const isOptional = newTimesUsed < totalExecutions;
      
      // Simple success correlation: (successes_with_tool / uses) - (successes_without_tool / non_uses)
      const successRateWithTool = newTimesUsed > 0 ? newTimesActivitySucceededWithTool / newTimesUsed : 0;
      const successRateWithoutTool = timesActivitySucceededWithoutTool > 0 && totalExecutions > newTimesUsed
        ? timesActivitySucceededWithoutTool / (totalExecutions - newTimesUsed)
        : 0;
      const successCorrelation = successRateWithTool - successRateWithoutTool;
      
      // Update avg params complexity (rolling average)
      // @ts-ignore - SurrealDB query typing issue
      const currentAvg = current.avg_params_complexity || 0;
      // @ts-ignore - SurrealDB query typing issue
      const currentCount = current.times_used || 0;
      const avgParamsComplexity = validated.params_complexity !== undefined
        ? (currentAvg * currentCount + validated.params_complexity) / newTimesUsed
        : currentAvg;
      
      const typicalErrorRate = newTimesUsed > 0 ? newTimesFailed / newTimesUsed : 0;
      
      // Phase B-followup: dual-tenant WHERE; sticky-write account_id + org_id
      // so legacy rows (NONE/NONE) get backfilled on first touch.
      const updateQuery = `
        UPDATE tool_usage_patterns
        SET
          times_used = $times_used,
          times_succeeded = $times_succeeded,
          times_failed = $times_failed,
          times_activity_succeeded_with_tool = $times_activity_succeeded_with_tool,
          usage_probability = $usage_probability,
          success_correlation = $success_correlation,
          is_required = $is_required,
          is_optional = $is_optional,
          avg_params_complexity = $avg_params_complexity,
          typical_error_rate = $typical_error_rate,
          org_id = $org_id,
          account_id = $account_id,
          account_id_version = $account_id_version,
          updated_at = time::now()
        WHERE activity_variant_id = $activity_variant_id
          AND tool_name = $tool_name
          ${validated.task_id ? 'AND task_id = $task_id' : 'AND task_id IS NONE'}
          AND ${accountIdScopedWhere()}
        RETURN AFTER
      `;

      const updated = await surrealDB.query<ToolUsagePattern[]>(updateQuery, {
        activity_variant_id: validated.activity_variant_id,
        tool_name: validated.tool_name,
        task_id: validated.task_id ?? undefined,
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
        times_used: newTimesUsed,
        times_succeeded: newTimesSucceeded,
        times_failed: newTimesFailed,
        times_activity_succeeded_with_tool: newTimesActivitySucceededWithTool,
        usage_probability: usageProbability,
        success_correlation: Math.max(-1, Math.min(1, successCorrelation)), // Clamp to [-1, 1]
        is_required: isRequired,
        is_optional: isOptional,
        avg_params_complexity: avgParamsComplexity,
        typical_error_rate: typicalErrorRate,
      });
      
      // @ts-ignore - SurrealDB query typing issue
      pattern = updated && updated.length > 0 ? updated[0] : current;
      logger.info('Updated tool usage pattern', {
        tool: validated.tool_name,
        activity: validated.activity_variant_id,
        usageProbability,
        isRequired,
        successCorrelation,
      });
    } else {
      // Create new pattern
      const usageProbability = 1.0; // First execution, tool was used
      const isRequired = validated.activity_succeeded; // Required if first use succeeded
      const isOptional = false; // Not optional yet (only 1 execution)
      const successCorrelation = validated.tool_succeeded && validated.activity_succeeded ? 1.0 : 0.0;
      
      // Phase B-followup: dual-write account_id + version (and org_id, the
      // first multi-tenant key for this table) on CREATE.
      // tool_usage_patterns.account_id is option<string> per the deployed
      // schema; SurrealDB 3.x rejects JSON `null` against `TYPE none | string`.
      // Use IF..THEN..ELSE..END to coerce null → NONE on the SQL side so we
      // don't have to branch the CREATE template here.
      const createQuery = `
        CREATE tool_usage_patterns CONTENT {
          tool_name: $tool_name,
          activity_variant_id: $activity_variant_id,
          task_id: $task_id,
          times_used: 1,
          times_succeeded: $times_succeeded,
          times_failed: $times_failed,
          times_activity_succeeded_with_tool: $times_activity_succeeded_with_tool,
          times_activity_succeeded_without_tool: 0,
          usage_probability: $usage_probability,
          success_correlation: $success_correlation,
          is_required: $is_required,
          is_optional: $is_optional,
          avg_params_complexity: $avg_params_complexity,
          typical_error_rate: $typical_error_rate,
          org_id: $org_id,
          account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
          account_id_version: $account_id_version,
          created_at: time::now(),
          updated_at: time::now()
        }
      `;

      const created = await surrealDB.query<ToolUsagePattern[]>(createQuery, {
        tool_name: validated.tool_name,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id ?? undefined,
        times_succeeded: validated.tool_succeeded ? 1 : 0,
        times_failed: validated.tool_succeeded ? 0 : 1,
        times_activity_succeeded_with_tool: validated.activity_succeeded ? 1 : 0,
        usage_probability: usageProbability,
        success_correlation: successCorrelation,
        is_required: isRequired,
        is_optional: isOptional,
        avg_params_complexity: validated.params_complexity || 0,
        typical_error_rate: validated.tool_succeeded ? 0 : 1,
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
      });
      
      // @ts-ignore - SurrealDB query typing issue
      pattern = created && created.length > 0 ? created[0] : {
        tool_name: validated.tool_name,
        activity_variant_id: validated.activity_variant_id,
        task_id: validated.task_id || '',
        times_used: 1,
        times_succeeded: validated.tool_succeeded ? 1 : 0,
        times_failed: validated.tool_succeeded ? 0 : 1,
        times_activity_succeeded_with_tool: validated.activity_succeeded ? 1 : 0,
        times_activity_succeeded_without_tool: 0,
        usage_probability: usageProbability,
        success_correlation: successCorrelation,
        is_required: isRequired,
        is_optional: isOptional,
        avg_params_complexity: validated.params_complexity || 0,
        typical_error_rate: validated.tool_succeeded ? 0 : 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      logger.info('Created new tool usage pattern', {
        tool: validated.tool_name,
        activity: validated.activity_variant_id,
      });
    }
    
    return c.json({ 
      success: true,
      message: 'Tool usage recorded successfully',
    });
    
  } catch (error: any) {
    logger.error('Failed to record tool usage', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to record tool usage',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /tool-usage
 * 
 * Query tool usage patterns with filtering:
 * - tool_name: Filter by specific tool
 * - activity_variant_id: Filter by activity
 * - is_required: Filter to only required tools
 * - min_usage_probability: Filter by usage frequency
 * 
 * Use cases:
 * - Pre-flight checks: "Does this vessel have required tools?"
 * - Optimization: "Can we skip loading this optional tool?"
 * - Discovery: "What tools does add-feature-complete typically need?"
 */
app.get('/tool-usage', async (c) => {
  try {
    const query = c.req.query();

    // Phase B-followup: pull tenant context so we can dual-bind the
    // tool_usage_patterns read alongside org_id (added by migration 097).
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Validate query params
    const validated = ToolUsageQuerySchema.parse({
      tool_name: query.tool_name,
      activity_variant_id: query.activity_variant_id,
      is_required: query.is_required === 'true' ? true : query.is_required === 'false' ? false : undefined,
      min_usage_probability: query.min_usage_probability ? parseFloat(query.min_usage_probability) : undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });

    logger.info('GET /v2/activities/tool-usage', validated);

    // Phase B-followup: always dual-bind tenant context.
    const whereClauses: string[] = [accountIdScopedWhere()];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
      org_id: orgId,
      account_id: accountId,
    };

    if (validated.tool_name) {
      whereClauses.push(`tool_name = $tool_name`);
      params.tool_name = validated.tool_name;
    }

    if (validated.activity_variant_id) {
      whereClauses.push(`activity_variant_id = $activity_variant_id`);
      params.activity_variant_id = validated.activity_variant_id;
    }

    if (validated.is_required !== undefined) {
      whereClauses.push(`is_required = $is_required`);
      params.is_required = validated.is_required;
    }

    if (validated.min_usage_probability !== undefined) {
      whereClauses.push(`usage_probability >= $min_usage_probability`);
      params.min_usage_probability = validated.min_usage_probability;
    }

    let patternsQuery = `SELECT * FROM tool_usage_patterns`;
    if (whereClauses.length > 0) {
      patternsQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    patternsQuery += ` ORDER BY usage_probability DESC LIMIT $limit START $offset`;

    let countQuery = `SELECT count() as total FROM tool_usage_patterns`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    
    const [patternsResult, countResult] = await Promise.all([
      surrealDB.query<ToolUsagePattern[]>(patternsQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);
    
    // @ts-ignore - SurrealDB typing
    const response: ToolUsageResponse = {
      patterns: (patternsResult && Array.isArray(patternsResult) ? patternsResult.flat() : []),
      // @ts-ignore - SurrealDB typing
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };
    
    logger.info('Tool usage query result', {
      patterns: response.patterns.length,
      total: response.total,
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to query tool usage patterns', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to query tool usage patterns',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /execution-sequences
 * 
 * Records execution sequences - which activities ran together in a session.
 * This enables learning:
 * - Typical sequences for achieving goals
 * - Success patterns (which sequences work well together)
 * - Failure patterns (which sequences fail)
 * - Sequence optimization (shorter successful paths)
 * 
 * Use cases:
 * - "For goal 'add authentication', what's the typical sequence?"
 * - "After activity A, what usually comes next?"
 * - "What's the success rate of sequence [A, B, C]?"
 */
app.post('/execution-sequences', async (c) => {
  try {
    const body = await c.req.json();
    
    // Validate request body
    const validated = ExecutionSequenceRecordRequestSchema.parse(body);
    logger.info('Recording execution sequence', {
      session: validated.session_id,
      activities: validated.sequence.length,
      outcome: validated.outcome,
    });
    
    // Compute aggregates
    const totalDuration = validated.sequence.reduce((sum, item) => sum + item.duration_ms, 0);
    const totalCost = validated.sequence.reduce((sum, item) => sum + item.cost_usd, 0);
    const totalActivities = validated.sequence.length;
    
    // Create record
    const createQuery = `
      CREATE execution_sequences CONTENT {
        session_id: $session_id,
        goal_context: $goal_context,
        sequence: $sequence,
        outcome: $outcome,
        total_duration_ms: $total_duration_ms,
        total_cost_usd: $total_cost_usd,
        total_activities: $total_activities,
        created_at: time::now(),
        updated_at: time::now()
      }
    `;
    
    const created = await surrealDB.query<ExecutionSequence[]>(createQuery, {
      session_id: validated.session_id,
      goal_context: validated.goal_context || '',
      sequence: validated.sequence,
      outcome: validated.outcome,
      total_duration_ms: totalDuration,
      total_cost_usd: totalCost,
      total_activities: totalActivities,
    });
    
    // @ts-ignore - SurrealDB query typing issue
    const sequence: ExecutionSequence = created && created.length > 0 ? created[0] : {
      session_id: validated.session_id,
      goal_context: validated.goal_context || '',
      sequence: validated.sequence,
      outcome: validated.outcome,
      total_duration_ms: totalDuration,
      total_cost_usd: totalCost,
      total_activities: totalActivities,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    
    logger.info('Execution sequence recorded', {
      session: validated.session_id,
      activities: totalActivities,
      duration: totalDuration,
      outcome: validated.outcome,
    });
    
    return c.json({
      success: true,
      sequence,
    });
    
  } catch (error: any) {
    logger.error('Failed to record execution sequence', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to record execution sequence',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /execution-sequences
 * 
 * Query execution sequences with filtering:
 * - session_id: Get sequences from specific session
 * - goal_context: Fuzzy match on goal description
 * - outcome: Filter by success/partial/failure
 * - min_activities/max_activities: Filter by sequence length
 * 
 * Use cases:
 * - Session analysis: "What did I do in session X?"
 * - Goal patterns: "What sequences achieve goal Y?"
 * - Success analysis: "What successful sequences exist for similar goals?"
 * - Failure analysis: "What sequences failed and why?"
 */
app.get('/execution-sequences', async (c) => {
  try {
    const query = c.req.query();
    
    // Validate query params
    const validated = ExecutionSequenceQuerySchema.parse({
      session_id: query.session_id,
      goal_context: query.goal_context,
      min_activities: query.min_activities ? parseInt(query.min_activities) : undefined,
      max_activities: query.max_activities ? parseInt(query.max_activities) : undefined,
      outcome: query.outcome as 'success' | 'partial' | 'failure' | undefined,
      limit: query.limit ? parseInt(query.limit) : 100,
      offset: query.offset ? parseInt(query.offset) : 0,
    });
    
    logger.info('GET /v2/activities/execution-sequences', validated);
    
    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit: validated.limit,
      offset: validated.offset,
    };
    
    if (validated.session_id) {
      whereClauses.push(`session_id = $session_id`);
      params.session_id = validated.session_id;
    }
    
    if (validated.goal_context) {
      // Fuzzy match on goal context
      whereClauses.push(`goal_context CONTAINS $goal_context`);
      params.goal_context = validated.goal_context;
    }
    
    if (validated.outcome) {
      whereClauses.push(`outcome = $outcome`);
      params.outcome = validated.outcome;
    }
    
    if (validated.min_activities !== undefined) {
      whereClauses.push(`total_activities >= $min_activities`);
      params.min_activities = validated.min_activities;
    }
    
    if (validated.max_activities !== undefined) {
      whereClauses.push(`total_activities <= $max_activities`);
      params.max_activities = validated.max_activities;
    }
    
    let sequencesQuery = `SELECT * FROM execution_sequences`;
    if (whereClauses.length > 0) {
      sequencesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    sequencesQuery += ` ORDER BY created_at DESC LIMIT $limit START $offset`;
    
    let countQuery = `SELECT count() as total FROM execution_sequences`;
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    
    const [sequencesResult, countResult] = await Promise.all([
      surrealDB.query<ExecutionSequence[]>(sequencesQuery, params),
      surrealDB.query<{total: number}[]>(countQuery, params),
    ]);
    
    // @ts-ignore - SurrealDB typing
    const response: ExecutionSequenceResponse = {
      sequences: (sequencesResult && Array.isArray(sequencesResult) ? sequencesResult.flat() : []),
      // @ts-ignore - SurrealDB typing
      total: (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : 0,
    };
    
    logger.info('Execution sequences query result', {
      sequences: response.sequences.length,
      total: response.total,
    });
    
    return c.json(response);
    
  } catch (error: any) {
    logger.error('Failed to query execution sequences', { error: error.message });
    
    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }
    
    return c.json({
      error: 'Failed to query execution sequences',
      message: error.message,
    }, 500);
  }
});

// =============================================================================
// Tag Endpoints
// =============================================================================

/**
 * GET /tags/suggest
 *
 * Get tag suggestions based on a prefix
 *
 * Query params:
 *   prefix?: string - The prefix to match (e.g., "feat" matches "feature", "feature.vessel")
 *   limit?: number - Maximum suggestions to return (default: 20)
 *
 * Returns:
 * {
 *   suggestions: string[],
 *   total: number
 * }
 */
app.get('/tags/suggest', async (c) => {
  try {
    const prefix = c.req.query('prefix') || '';
    const limit = parseInt(c.req.query('limit') || '20', 10);

    logger.info('GET /tags/suggest', { prefix, limit });

    // Query tag prefixes (deduplication happens in code)
    const query = `
      SELECT tag_prefixes FROM activity
      WHERE array::len(tag_prefixes) > 0
      LIMIT 1000
    `;

    const result = await surrealDB.query(query);

    // Flatten and dedupe all tag_prefixes, filtering by prefix
    const allPrefixes = new Set<string>();
    for (const row of (result || [])) {
      if (row.tag_prefixes && Array.isArray(row.tag_prefixes)) {
        for (const p of row.tag_prefixes) {
          if (!prefix || p.startsWith(prefix)) {
            allPrefixes.add(p);
          }
        }
      }
    }

    // Sort and limit
    const suggestions = Array.from(allPrefixes)
      .sort()
      .slice(0, limit);

    return c.json({
      suggestions,
      total: allPrefixes.size,
      prefix: prefix || null,
    });

  } catch (error: any) {
    logger.error('Failed to get tag suggestions', { error: error.message });
    return c.json({
      error: 'Failed to get tag suggestions',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /tags/stats
 *
 * Get tag usage statistics
 *
 * Query params:
 *   prefix?: string - Filter to tags with this prefix
 *
 * Returns:
 * {
 *   stats: { tag: string, count: number }[],
 *   total_templates: number
 * }
 */
app.get('/tags/stats', async (c) => {
  try {
    const prefix = c.req.query('prefix') || '';

    logger.info('GET /tags/stats', { prefix });

    // Query templates and count tag occurrences
    const query = `
      SELECT tags FROM activity
      WHERE array::len(tags) > 0
    `;

    const result = await surrealDB.query(query);

    // Count tag occurrences
    const tagCounts = new Map<string, number>();
    let totalTemplates = 0;

    for (const row of (result || [])) {
      if (row.tags && Array.isArray(row.tags)) {
        totalTemplates++;
        for (const tag of row.tags) {
          if (!prefix || tag.startsWith(prefix)) {
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
          }
        }
      }
    }

    // Convert to sorted array
    const stats = Array.from(tagCounts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    return c.json({
      stats,
      total_templates: totalTemplates,
      prefix: prefix || null,
    });

  } catch (error: any) {
    logger.error('Failed to get tag stats', { error: error.message });
    return c.json({
      error: 'Failed to get tag stats',
      message: error.message,
    }, 500);
  }
});

// =============================================================================
// Tool Argument Pattern Endpoints
// =============================================================================

/**
 * POST /tool-argument-patterns
 *
 * Records tool argument patterns observed during activity execution.
 * Implements upsert logic: if a pattern with the same argument_hash exists,
 * increments times_used and conditionally times_succeeded, updates rolling
 * average for execution_ms.
 *
 * Learning metrics:
 * - times_used: Total times this exact argument pattern was used
 * - times_succeeded: How many of those executions succeeded
 * - avg_execution_ms: Rolling average execution time
 * - success_rate: Computed as times_succeeded / times_used
 *
 * Use cases:
 * - Pattern deduplication: Identify repeated argument patterns
 * - Learning: Which argument patterns lead to success
 * - Recommendations: Suggest proven arguments for new executions
 */
app.post('/tool-argument-patterns', async (c) => {
  try {
    const body = await c.req.json();

    // Phase B-followup: pull tenant context from JWT/session so we can
    // dual-bind account_id alongside the existing org_id-derived scope.
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Validate request body
    const validated = ToolArgumentPatternRecordRequestSchema.parse(body);
    logger.info('Recording tool argument pattern', {
      activity: validated.activity_id,
      tool: validated.tool_name,
      shape: validated.argument_shape,
      hash: validated.argument_hash.substring(0, 16) + '...',
      succeeded: validated.execution_succeeded,
      failureType: validated.failure_type,
      orgId,
      accountId,
    });

    // Check if pattern exists.
    // Phase B-followup: dual-tenant scoping; legacy rows match via the
    // org_id branch of accountIdScopedWhere().
    const checkQuery = `
      SELECT * FROM tool_argument_pattern
      WHERE argument_hash = $hash AND ${accountIdScopedWhere()}
      LIMIT 1
    `;

    const existing = await surrealDB.query<any[]>(checkQuery, {
      hash: validated.argument_hash,
      org_id: orgId,
      account_id: accountId,
    });

    let pattern: any;

    if (existing && existing.length > 0 && existing[0]) {
      // Update existing pattern with rolling average for execution_ms
      const current = existing[0];
      // @ts-ignore - SurrealDB query typing issue
      const currentTimesUsed = current.times_used || 0;
      const successIncrement = validated.execution_succeeded ? 1 : 0;
      const failureIncrement = validated.execution_succeeded ? 0 : 1;

      // Update failure counts breakdown if failure type is provided
      // @ts-ignore - SurrealDB query typing issue
      const currentFailureCounts = current.failure_counts || {};
      if (!validated.execution_succeeded && validated.failure_type) {
        currentFailureCounts[validated.failure_type] = (currentFailureCounts[validated.failure_type] || 0) + 1;
      }

      // Phase B-followup: dual-tenant WHERE; account_id stays sticky on the
      // row but is also explicitly written to bring legacy rows forward.
      const updateQuery = `
        UPDATE tool_argument_pattern
        SET
          times_used = times_used + 1,
          times_succeeded = times_succeeded + $success_increment,
          times_failed = (times_failed OR 0) + $failure_increment,
          avg_execution_ms = (avg_execution_ms * $current_times_used + $execution_ms) / ($current_times_used + 1),
          last_used_at = time::now(),
          updated_at = time::now(),
          failure_type = $failure_type,
          failure_reason = $failure_reason,
          tool_succeeded = $tool_succeeded,
          validation_error = $validation_error,
          failure_counts = $failure_counts,
          account_id = IF $account_id IS NULL THEN NONE ELSE $account_id END,
          account_id_version = $account_id_version
        WHERE argument_hash = $hash AND ${accountIdScopedWhere()}
        RETURN AFTER
      `;

      const updateResult = await surrealDB.query<any[]>(updateQuery, {
        hash: validated.argument_hash,
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
        success_increment: successIncrement,
        failure_increment: failureIncrement,
        current_times_used: currentTimesUsed,
        execution_ms: validated.execution_ms,
        failure_type: validated.failure_type || undefined,
        failure_reason: validated.failure_reason || undefined,
        tool_succeeded: validated.tool_succeeded ?? undefined,
        validation_error: validated.validation_error || undefined,
        failure_counts: currentFailureCounts,
      });

      pattern = updateResult && updateResult.length > 0 ? updateResult[0] : current;

      logger.info('Updated existing tool argument pattern', {
        hash: validated.argument_hash.substring(0, 16) + '...',
        times_used: pattern.times_used,
        times_succeeded: pattern.times_succeeded,
        times_failed: pattern.times_failed,
        failureType: validated.failure_type,
      });
    } else {
      // Create new pattern with failure tracking fields
      const initialFailureCounts: Record<string, number> = {};
      if (!validated.execution_succeeded && validated.failure_type) {
        initialFailureCounts[validated.failure_type] = 1;
      }

      // Phase B-followup: dual-write account_id + version on CREATE; org_id
      // is also written explicitly so the row is no longer dependent on
      // SurrealDB-level $auth defaulting.
      // I2.4 sibling guard: account_id is option<string> per the deployed
      // schema; SurrealDB 3.x rejects JSON `null` (see I2.4 + I2.4 followup).
      // Coerce on the SQL side so the JS-side `?? null` shape stays unchanged.
      const createQuery = `
        CREATE tool_argument_pattern SET
          activity_id = $activity_id,
          tool_name = $tool_name,
          argument_shape = $argument_shape,
          argument_hash = $argument_hash,
          arguments = $arguments,
          times_used = 1,
          times_succeeded = $success_increment,
          times_failed = $failure_increment,
          avg_execution_ms = $execution_ms,
          last_used_at = time::now(),
          failure_type = $failure_type,
          failure_reason = $failure_reason,
          tool_succeeded = $tool_succeeded,
          validation_error = $validation_error,
          failure_counts = $failure_counts,
          org_id = $org_id,
          account_id = IF $account_id IS NULL THEN NONE ELSE $account_id END,
          account_id_version = $account_id_version
      `;

      const createResult = await surrealDB.query<any[]>(createQuery, {
        activity_id: validated.activity_id,
        tool_name: validated.tool_name,
        argument_shape: validated.argument_shape,
        argument_hash: validated.argument_hash,
        arguments: validated.arguments,
        success_increment: validated.execution_succeeded ? 1 : 0,
        failure_increment: validated.execution_succeeded ? 0 : 1,
        execution_ms: validated.execution_ms,
        failure_type: validated.failure_type || undefined,
        failure_reason: validated.failure_reason || undefined,
        tool_succeeded: validated.tool_succeeded ?? undefined,
        validation_error: validated.validation_error || undefined,
        failure_counts: initialFailureCounts,
        org_id: orgId,
        account_id: accountId,
        account_id_version: 1,
      });

      pattern = createResult && createResult.length > 0 ? createResult[0] : {
        activity_id: validated.activity_id,
        tool_name: validated.tool_name,
        argument_shape: validated.argument_shape,
        argument_hash: validated.argument_hash,
        times_used: 1,
        times_succeeded: validated.execution_succeeded ? 1 : 0,
        times_failed: validated.execution_succeeded ? 0 : 1,
        avg_execution_ms: validated.execution_ms,
        failure_type: validated.failure_type,
        failure_reason: validated.failure_reason,
        failure_counts: initialFailureCounts,
      };

      logger.info('Created new tool argument pattern', {
        hash: validated.argument_hash.substring(0, 16) + '...',
        tool: validated.tool_name,
        shape: validated.argument_shape,
        failureType: validated.failure_type,
      });
    }

    return c.json({
      success: true,
      pattern,
    });

  } catch (error: any) {
    logger.error('Failed to record tool argument pattern', { error: error.message });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to record tool argument pattern',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /tool-argument-recommendations
 *
 * Returns recommended argument patterns for a given activity from
 * the v_argument_recommendations view. This view filters for patterns
 * with sufficient usage (>=3) and high success rate (>=80%).
 *
 * Query params:
 *   activity_id: string (required) - The activity to get recommendations for
 *
 * Returns:
 * {
 *   patterns: [{
 *     argument_shape: string,
 *     argument_hash: string,
 *     arguments: object,
 *     success_rate: number,
 *     times_used: number,
 *     avg_execution_ms: number,
 *     tool_name: string
 *   }]
 * }
 *
 * Use cases:
 * - Pre-populate tool arguments with proven patterns
 * - Suggest successful argument combinations
 * - Reduce exploration when reliable patterns exist
 */
app.get('/tool-argument-recommendations', async (c) => {
  try {
    const query = c.req.query();

    // Validate query params
    const validated = ToolArgumentRecommendationsQuerySchema.parse({
      activity_id: query.activity_id,
    });

    logger.info('GET /v2/activities/tool-argument-recommendations', { activity_id: validated.activity_id });

    // Query the v_argument_recommendations view
    const patternsQuery = `
      SELECT * FROM v_argument_recommendations
      WHERE activity_id = $activity_id
        AND org_id = <string>$auth.org_id
      ORDER BY success_rate DESC, times_used DESC
      LIMIT 20
    `;

    const patternsResult = await surrealDB.query<ToolArgumentPattern[]>(patternsQuery, {
      activity_id: validated.activity_id,
    });

    const patterns = patternsResult && Array.isArray(patternsResult) ? patternsResult.flat() : [];

    const response: ToolArgumentRecommendationsResponse = {
      patterns,
    };

    logger.info('Tool argument recommendations query result', {
      activity_id: validated.activity_id,
      patterns_found: patterns.length,
    });

    return c.json(response);

  } catch (error: any) {
    logger.error('Failed to get tool argument recommendations', { error: error.message });

    if (error.name === 'ZodError') {
      return c.json({
        error: 'Validation failed',
        message: error.message,
        details: error.errors,
      }, 400);
    }

    return c.json({
      error: 'Failed to get tool argument recommendations',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /failure-patterns
 *
 * Returns failure patterns for analysis and debugging.
 * Surfaces patterns that frequently fail to help identify:
 * - Problematic argument combinations
 * - Common validation failures
 * - Execution issues
 *
 * Query params:
 *   activity_id?: string - Filter by activity
 *   tool_name?: string - Filter by tool
 *   failure_type?: 'validation' | 'execution' | 'tool_failure' | 'timeout' - Filter by failure type
 *   min_failures?: number - Minimum failure count (default: 1)
 *   limit?: number - Max results (default: 100)
 *   offset?: number - Pagination offset (default: 0)
 *
 * Returns:
 * {
 *   patterns: [{
 *     activity_id: string,
 *     tool_name: string,
 *     argument_shape: string,
 *     argument_hash: string,
 *     arguments: object,
 *     success_rate: number,
 *     failure_rate: number,
 *     times_used: number,
 *     times_succeeded: number,
 *     times_failed: number,
 *     failure_type?: string,
 *     failure_reason?: string,
 *     validation_error?: string,
 *     failure_counts?: object
 *   }],
 *   total: number
 * }
 *
 * Use cases:
 * - Identify argument patterns that fail validation
 * - Debug execution failures
 * - Learn what to avoid in recommendations
 */
app.get('/failure-patterns', async (c) => {
  try {
    const query = c.req.query();

    // Phase B-followup: pull tenant context so we can dual-bind the
    // tool_argument_pattern read alongside org_id.
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    const accountId: string | null = jwtAuth?.accountId ?? null;

    const activityId = query.activity_id;
    const toolName = query.tool_name;
    const failureType = query.failure_type as 'validation' | 'execution' | 'tool_failure' | 'timeout' | undefined;
    const minFailures = query.min_failures ? parseInt(query.min_failures) : 1;
    const limit = query.limit ? parseInt(query.limit) : 100;
    const offset = query.offset ? parseInt(query.offset) : 0;

    logger.info('GET /v2/activities/failure-patterns', {
      activity_id: activityId,
      tool_name: toolName,
      failure_type: failureType,
      min_failures: minFailures,
      limit,
      offset,
      orgId,
      accountId,
    });

    const whereClauses: string[] = ['times_failed >= $min_failures'];
    const params: Record<string, any> = {
      min_failures: minFailures,
      limit,
      offset,
      org_id: orgId,
      account_id: accountId,
    };

    if (activityId) {
      whereClauses.push(`activity_id = $activity_id`);
      params.activity_id = activityId;
    }

    if (toolName) {
      whereClauses.push(`tool_name = $tool_name`);
      params.tool_name = toolName;
    }

    if (failureType) {
      whereClauses.push(`failure_type = $failure_type`);
      params.failure_type = failureType;
    }

    // Query failure patterns from v_failure_patterns view or tool_argument_pattern table
    const patternsQuery = `
      SELECT
        activity_id,
        tool_name,
        argument_shape,
        argument_hash,
        arguments,
        (times_succeeded * 1.0 / times_used) as success_rate,
        (times_failed * 1.0 / times_used) as failure_rate,
        times_used,
        times_succeeded,
        times_failed,
        avg_execution_ms,
        failure_type,
        failure_reason,
        validation_error,
        failure_counts,
        org_id
      FROM tool_argument_pattern
      WHERE ${whereClauses.join(' AND ')}
        AND ${accountIdScopedWhere()}
      ORDER BY times_failed DESC, failure_rate DESC
      LIMIT $limit START $offset
    `;

    // Count query
    const countQuery = `
      SELECT count() as total FROM tool_argument_pattern
      WHERE ${whereClauses.join(' AND ')}
        AND ${accountIdScopedWhere()}
    `;

    const [patternsResult, countResult] = await Promise.all([
      surrealDB.query<any[]>(patternsQuery, params),
      surrealDB.query<any[]>(countQuery, params),
    ]);

    const patterns = patternsResult && Array.isArray(patternsResult) ? patternsResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = (countResult && countResult.length > 0 && countResult[0]) ? (countResult[0].total || 0) : patterns.length;

    logger.info('Failure patterns query result', {
      patterns_found: patterns.length,
      total,
    });

    return c.json({
      patterns,
      total,
    });

  } catch (error: any) {
    logger.error('Failed to get failure patterns', { error: error.message });

    return c.json({
      error: 'Failed to get failure patterns',
      message: error.message,
    }, 500);
  }
});

// =============================================================================
// Emergent Shape Network Endpoints
// =============================================================================
// These endpoints expose the emergent shape statistics from v_shape_* views.
// Shapes are discovered through usage, not predefined - these views reveal
// the network topology that emerges from activity definitions and executions.
// =============================================================================

/**
 * Shape network edge representing a transformation from input to output shape
 */
interface ShapeNetworkEdge {
  input_shape: string;
  output_shape: string;
  edge_weight: number;
  activities: string[];
}

/**
 * Shape usage statistics by role (input or output)
 */
interface ShapeUsage {
  shape: string;
  role: 'input' | 'output';
  activity_count: number;
  activities: string[];
}

/**
 * Shape suggestion for autocomplete
 */
interface ShapeAutocomplete {
  shape: string;
  total_uses: number;
  roles: string[];
}

/**
 * GET /shapes/network
 *
 * Returns the emergent shape transformation graph showing how shapes
 * transform from inputs to outputs across activities.
 *
 * Query params:
 *   input_shape?: string - Filter to edges from this input shape
 *   output_shape?: string - Filter to edges producing this output shape
 *   min_weight?: number - Filter to edges with weight >= this value
 *   limit?: number - Maximum edges to return (default: 100)
 *   offset?: number - Pagination offset (default: 0)
 *
 * Returns:
 * {
 *   edges: ShapeNetworkEdge[],
 *   total: number
 * }
 */
app.get('/shapes/network', async (c) => {
  try {
    const inputShape = c.req.query('input_shape');
    const outputShape = c.req.query('output_shape');
    const minWeight = c.req.query('min_weight') ? parseInt(c.req.query('min_weight')!, 10) : undefined;
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    logger.info('GET /shapes/network', { inputShape, outputShape, minWeight, limit, offset });

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    if (inputShape) {
      whereClauses.push('input_shape = $input_shape');
      params.input_shape = inputShape;
    }

    if (outputShape) {
      whereClauses.push('output_shape = $output_shape');
      params.output_shape = outputShape;
    }

    if (minWeight !== undefined) {
      whereClauses.push('edge_weight >= $min_weight');
      params.min_weight = minWeight;
    }

    let edgesQuery = 'SELECT * FROM v_shape_network';
    if (whereClauses.length > 0) {
      edgesQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    edgesQuery += ' ORDER BY edge_weight DESC LIMIT $limit START $offset';

    let countQuery = 'SELECT count() as total FROM v_shape_network';
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [edgesResult, countResult] = await Promise.all([
      surrealDB.query<ShapeNetworkEdge[]>(edgesQuery, params),
      surrealDB.query<{ total: number }[]>(countQuery, params),
    ]);

    const edges = edgesResult && Array.isArray(edgesResult) ? edgesResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = countResult && countResult.length > 0 && countResult[0] ? (countResult[0].total || 0) : 0;

    logger.info('Shape network query result', { edges: edges.length, total });

    return c.json({
      edges,
      total,
    });

  } catch (error: any) {
    logger.error('GET /shapes/network failed', { error: error.message, stack: error.stack });
    return c.json({
      error: 'Failed to query shape network',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /shapes/usage
 *
 * Returns shape frequency statistics showing how often each shape
 * appears as an input or output across activities.
 *
 * Query params:
 *   shape?: string - Filter to a specific shape
 *   role?: 'input' | 'output' - Filter to a specific role
 *   limit?: number - Maximum results to return (default: 100)
 *   offset?: number - Pagination offset (default: 0)
 *
 * Returns:
 * {
 *   usage: ShapeUsage[],
 *   total: number
 * }
 */
app.get('/shapes/usage', async (c) => {
  try {
    const shape = c.req.query('shape');
    const role = c.req.query('role');
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    logger.info('GET /shapes/usage', { shape, role, limit, offset });

    const whereClauses: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    if (shape) {
      whereClauses.push('shape = $shape');
      params.shape = shape;
    }

    if (role && (role === 'input' || role === 'output')) {
      whereClauses.push('role = $role');
      params.role = role;
    }

    let usageQuery = 'SELECT * FROM v_shape_usage';
    if (whereClauses.length > 0) {
      usageQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    usageQuery += ' ORDER BY activity_count DESC LIMIT $limit START $offset';

    let countQuery = 'SELECT count() as total FROM v_shape_usage';
    if (whereClauses.length > 0) {
      countQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    const [usageResult, countResult] = await Promise.all([
      surrealDB.query<ShapeUsage[]>(usageQuery, params),
      surrealDB.query<{ total: number }[]>(countQuery, params),
    ]);

    const usage = usageResult && Array.isArray(usageResult) ? usageResult.flat() : [];
    // @ts-ignore - SurrealDB query typing issue
    const total = countResult && countResult.length > 0 && countResult[0] ? (countResult[0].total || 0) : 0;

    logger.info('Shape usage query result', { usage: usage.length, total });

    return c.json({
      usage,
      total,
    });

  } catch (error: any) {
    logger.error('GET /shapes/usage failed', { error: error.message, stack: error.stack });
    return c.json({
      error: 'Failed to query shape usage',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /shape-scores
 *
 * Update impulse_shape_activity_score table with execution outcomes.
 * Used for shape-based Thompson Sampling activity selection.
 *
 * For each shape in the request:
 * - UPSERT into impulse_shape_activity_score
 * - Increment success_count or failure_count based on outcome
 * - Compute alpha = success_count + 1, beta = failure_count + 1
 *
 * Uses atomic UPSERT operations to prevent race conditions.
 *
 * Request body:
 * {
 *   activity_id: string,
 *   shapes: string[],
 *   success: boolean,
 *   org_id?: string  // Optional, inferred from auth context
 * }
 *
 * Returns:
 * {
 *   success: boolean,
 *   updated_count: number,
 *   message?: string
 * }
 */
app.post('/shape-scores', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);

    // Extract session from context (set by auth middleware)
    const session = (c.get as any)('session') as SessionData | undefined;

    // Use JWT auth claims if available, otherwise fall back to session
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B-followup: account_id only flows from JWT auth.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    // Parse and validate request body
    const body = await c.req.json();
    const validated = ShapeScoreUpdateRequestSchema.parse(body);

    // Use provided org_id or fall back to auth context
    const effectiveOrgId = validated.org_id || orgId;

    if (!effectiveOrgId) {
      return c.json({
        success: false,
        updated_count: 0,
        message: 'Organization ID required (provide org_id or authenticate)',
      }, 401);
    }

    logger.info('POST /v2/activities/shape-scores', {
      activity_id: validated.activity_id,
      shapes: validated.shapes,
      success: validated.success,
      org_id: effectiveOrgId,
      account_id: accountId,
    });

    // Update shape scores atomically using UPSERT
    // For each shape, either create a new record or update existing counts
    let updatedCount = 0;

    for (const shape of validated.shapes) {
      try {
        // Determine which counter to increment
        const successIncrement = validated.success ? 1 : 0;
        const failureIncrement = validated.success ? 0 : 1;

        // UPSERT: Create if not exists, otherwise update atomically
        // SurrealDB UPSERT with ON DUPLICATE KEY semantics using MERGE
        //
        // Phase B-followup: dual-write account_id + version on the MERGE.
        // Record id stays keyed on (org_id, shape, activity_id) so legacy
        // and dual-tenant rows continue to map to the same composite slot.
        const upsertQuery = `
          UPSERT impulse_shape_activity_score:[$org_id, $shape, $activity_id]
          MERGE {
            shape: $shape,
            activity_id: $activity_id,
            org_id: $org_id,
            account_id: $account_id,
            account_id_version: $account_id_version,
            success_count: (
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $success_increment,
            failure_count: (
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $failure_increment,
            alpha: (
              SELECT VALUE success_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $success_increment + 1,
            beta: (
              SELECT VALUE failure_count FROM ONLY impulse_shape_activity_score:[$org_id, $shape, $activity_id]
            ) ?? 0 + $failure_increment + 1,
            updated_at: time::now()
          };
        `;

        await surrealDB.query(upsertQuery, {
          shape,
          activity_id: validated.activity_id,
          org_id: effectiveOrgId,
          account_id: accountId,
          account_id_version: 1,
          success_increment: successIncrement,
          failure_increment: failureIncrement,
        });

        updatedCount++;

        logger.debug('Shape score updated', {
          shape,
          activity_id: validated.activity_id,
          org_id: effectiveOrgId,
          success: validated.success,
        });
      } catch (shapeError: any) {
        // Log error but continue with other shapes
        logger.warn('Failed to update shape score', {
          shape,
          activity_id: validated.activity_id,
          error: shapeError.message,
        });
      }
    }

    logger.info('Shape scores updated', {
      activity_id: validated.activity_id,
      requested_shapes: validated.shapes.length,
      updated_count: updatedCount,
      success: validated.success,
    });

    const response: ShapeScoreUpdateResponse = {
      success: updatedCount > 0,
      updated_count: updatedCount,
      message: `Updated ${updatedCount} of ${validated.shapes.length} shape scores`,
    };

    return c.json(response, updatedCount > 0 ? 200 : 500);

  } catch (error: any) {
    logger.error('POST /v2/activities/shape-scores failed', {
      error: error.message,
      stack: error.stack,
    });

    // Check if it's a validation error
    if (error.name === 'ZodError') {
      return c.json({
        success: false,
        updated_count: 0,
        message: `Validation failed: ${error.message}`,
      }, 400);
    }

    return c.json({
      success: false,
      updated_count: 0,
      message: error.message,
    }, 500);
  }
});

/**
 * GET /shapes/autocomplete
 *
 * Returns shape suggestions for UI autocomplete, sorted by frequency.
 * Shapes emerge from observed usage - this is not a predefined list.
 *
 * Query params:
 *   prefix?: string - Filter shapes starting with this prefix
 *   limit?: number - Maximum suggestions to return (default: 50)
 *
 * Returns:
 * {
 *   suggestions: ShapeAutocomplete[],
 *   total: number
 * }
 */
app.get('/shapes/autocomplete', async (c) => {
  try {
    const prefix = c.req.query('prefix') || '';
    const limit = parseInt(c.req.query('limit') || '50', 10);

    logger.info('GET /shapes/autocomplete', { prefix, limit });

    // Query the autocomplete view
    // Note: SurrealDB views don't support LIKE, so we filter in code for prefix matching
    const query = `
      SELECT * FROM v_shapes_for_autocomplete
      ORDER BY total_uses DESC
      LIMIT 1000
    `;

    const result = await surrealDB.query<ShapeAutocomplete[]>(query);
    const allShapes = result && Array.isArray(result) ? result.flat() : [];

    // Filter by prefix if provided
    const filtered = prefix
      ? allShapes.filter(s => s.shape && s.shape.toLowerCase().startsWith(prefix.toLowerCase()))
      : allShapes;

    // Apply limit
    const suggestions = filtered.slice(0, limit);

    logger.info('Shape autocomplete query result', {
      prefix: prefix || null,
      suggestions: suggestions.length,
      total: filtered.length,
    });

    return c.json({
      suggestions,
      total: filtered.length,
    });

  } catch (error: any) {
    logger.error('GET /shapes/autocomplete failed', { error: error.message, stack: error.stack });
    return c.json({
      error: 'Failed to get shape suggestions',
      message: error.message,
    }, 500);
  }
});

/**
 * GET /scores
 * Get Thompson Sampling scores for all templates
 * Returns alpha, beta, confidence intervals, and selection probabilities
 */
app.get('/scores', async (c) => {
  try {
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = session?.org_id || null;
    const limitStr = c.req.query('limit') || '50';
    const limit = Math.min(Math.max(parseInt(limitStr, 10), 1), 100);

    logger.info('GET /v2/activities/scores', { limit, orgId });

    // Query activity_metrics table for Thompson Sampling scores
    let query = `
      SELECT
        activity_id,
        thompson_alpha AS alpha,
        thompson_beta AS beta,
        total_executions,
        successful_executions,
        failed_executions,
        success_rate,
        avg_duration_ms,
        avg_cost_usd,
        total_selections,
        last_executed_at,
        updated_at
      FROM activity_metrics
      WHERE 1=1
    `;
    const params: Record<string, any> = {};

    // Multi-tenant filtering
    if (orgId) {
      query += ' AND (org_id = $org_id OR org_id = NONE)';
      params.org_id = orgId;
    }

    // Order by total executions (show most used templates first)
    query += ' ORDER BY total_executions DESC';
    query += ' LIMIT $limit';
    params.limit = limit;

    const result = await surrealDB.query(query, params);
    const scores = Array.isArray(result) ? result : [];

    // Enrich with confidence intervals and selection probability
    const enrichedScores = scores.map((score: any) => {
      const alpha = score.alpha || 1;
      const beta = score.beta || 1;
      const mean = alpha / (alpha + beta);

      // 95% confidence interval (approximate)
      const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
      const stdDev = Math.sqrt(variance);
      const confidenceInterval = {
        lower: Math.max(0, mean - 1.96 * stdDev),
        upper: Math.min(1, mean + 1.96 * stdDev),
      };

      // Confidence level (higher is better)
      const confidence = alpha + beta; // Total observations

      return {
        ...score,
        mean_score: mean,
        confidence_interval: confidenceInterval,
        confidence_level: confidence,
        exploring: confidence < 10, // Low confidence = still exploring
      };
    });

    logger.info('Thompson Sampling scores retrieved', { count: enrichedScores.length });

    return c.json({
      scores: enrichedScores,
      total: enrichedScores.length,
    });

  } catch (error: any) {
    logger.error('GET /v2/activities/scores failed', {
      error: error.message,
      stack: error.stack,
    });

    return c.json({
      error: 'Failed to fetch Thompson Sampling scores',
      message: error.message,
    }, 500);
  }
});

/**
 * POST /relevance-feedback
 *
 * Explicit relevance signal for a template recommendation.
 * was_selected=true increments alpha; false increments beta in both
 * variant_performance_metrics and (if context_bucket provided) context_thompson_scores.
 * Returns 204 No Content immediately — all DB writes are fire-and-forget.
 */
app.post('/relevance-feedback', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const session = (c.get as any)('session') as SessionData | undefined;
    const orgId = jwtAuth?.orgId || session?.org_id || null;
    // Phase B1: account_id flows from JWT auth.
    const accountId: string | null = jwtAuth?.accountId ?? null;

    if (!orgId) {
      return c.json({ error: 'Unauthorized', message: 'Missing organization context' }, 401);
    }

    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { template_id, was_selected, context_bucket, reason, correlation_id } = body;

    if (!template_id || typeof template_id !== 'string' || typeof was_selected !== 'boolean') {
      return c.json({ error: 'template_id (string) and was_selected (boolean) are required' }, 400);
    }

    const alpha_delta = was_selected ? 1 : 0;
    const beta_delta = was_selected ? 0 : 1;

    // Normalize template_id to plain form before write — wrapped vs plain
    // forms must collapse to the same row (UNIQUE index on variant_id is
    // plain string equality). See variant_performance_metrics UPSERT comment
    // in /executions handler.
    const normalizedTemplateId = normalizeActivityId(template_id);

    // Upsert variant_performance_metrics Thompson params.
    // Phase E: account-keyed record-id slug so different accounts in the
    // same org keep separate posteriors when relevance feedback fires.
    const relevanceMetricsRecordSlug = variantMetricsRecordId(normalizedTemplateId, accountId);
    surrealDB.query(`
      INSERT INTO variant_performance_metrics {
        id: type::thing('variant_performance_metrics', $record_id_slug),
        variant_id: $variant_id,
        activity_id: $variant_id,
        org_id: $org_id,
        account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
        account_id_version: 1,
        total_executions: 0,
        successful_executions: 0,
        failed_executions: 0,
        success_rate: 0,
        avg_duration_ms: 0,
        avg_cost_usd: 0,
        thompson_alpha: $alpha_delta + 1,
        thompson_beta: $beta_delta + 1,
        total_selections: 0,
        last_executed_at: time::now(),
        created_at: time::now(),
        updated_at: time::now()
      }
      ON DUPLICATE KEY UPDATE
        thompson_alpha += $alpha_delta,
        thompson_beta += $beta_delta,
        updated_at = time::now()
    `, {
      record_id_slug: relevanceMetricsRecordSlug,
      variant_id: normalizedTemplateId,
      org_id: orgId,
      account_id: accountIdRecordRef(accountId),
      alpha_delta,
      beta_delta,
    }).catch((err: any) => {
      logger.warn('relevance-feedback: variant_performance_metrics upsert failed', { error: err.message });
    });

    // Upsert context_thompson_scores when context_bucket is provided
    // Phase B1: dual-write account_id alongside org_id.
    if (context_bucket && typeof context_bucket === 'string') {
      surrealDB.query(`
        INSERT INTO context_thompson_scores {
          template_id: $template_id,
          org_id: $org_id,
          account_id: $account_id,
          account_id_version: 1,
          context_bucket: $bucket,
          alpha: $alpha_delta + 1,
          beta: $beta_delta + 1,
          n_observations: 1,
          last_updated_at: time::now(),
          created_at: time::now()
        }
        ON DUPLICATE KEY UPDATE
          alpha += $alpha_delta,
          beta += $beta_delta,
          n_observations += 1,
          last_updated_at = time::now()
      `, {
        template_id,
        org_id: orgId,
        account_id: accountId,
        bucket: context_bucket,
        alpha_delta,
        beta_delta,
      }).catch((err: any) => {
        logger.warn('relevance-feedback: context_thompson_scores upsert failed', { error: err.message });
      });
    }

    // Persist the feedback record for audit / future learning
    // SurrealDB 3.x distinguishes NONE (undefined) from NULL; `none | string` fields
    // reject JavaScript null. Pass undefined so the driver sends NONE.
    // Phase B1: dual-write account_id (undefined when absent so driver sends NONE).
    surrealDB.query(`
      CREATE relevance_feedback CONTENT {
        template_id: $template_id,
        org_id: $org_id,
        account_id: $account_id,
        account_id_version: 1,
        was_selected: $was_selected,
        context_bucket: $context_bucket,
        reason: $reason,
        correlation_id: $correlation_id,
        created_at: time::now()
      }
    `, {
      template_id,
      org_id: orgId,
      account_id: accountId ?? undefined,
      was_selected,
      context_bucket: context_bucket ?? undefined,
      reason: reason ?? undefined,
      correlation_id: correlation_id ?? undefined,
    }).catch((err: any) => {
      logger.warn('relevance-feedback: feedback record insert failed', { error: err.message });
    });

    logger.info('POST /v2/activities/relevance-feedback', {
      template_id,
      was_selected,
      context_bucket: context_bucket ?? null,
      correlation_id: correlation_id ?? null,
      orgId,
    });

    return c.body(null, 204);
  } catch (error: any) {
    logger.error('POST /v2/activities/relevance-feedback failed', {
      error: error.message,
      stack: error.stack,
    });
    return c.json({
      error: 'Failed to record relevance feedback',
      message: error.message,
    }, 500);
  }
});

// ============================================================================
// POST /v2/activities/internal/fts-rebuild
// Trigger a background REBUILD of all three FTS indexes. Used by integration
// tests (18.1.x) to warm the BM25 scorer after inserting test fixtures.
// Returns 202 immediately — REBUILD runs in the background (~6 min for all 3
// indexes against the full corpus). The gateway would time out waiting for a
// synchronous rebuild response (sequential REBUILD blocks for each index until
// SurrealDB confirms completion). Fire-and-forget avoids the gateway timeout.
// Requires standard API-key auth (no admin scope needed — rebuild is read-safe).
// ============================================================================
app.post('/internal/fts-rebuild', async (c) => {
  // Use the shared rebuild job so the HTTP endpoint and the periodic scheduler
  // (index.ts setInterval) share the same in-process concurrency guard.
  // If a rebuild is already running this returns 202 without starting a second
  // one — preventing partial-rebuild races that leave some indexes cold.
  const { rebuildFtsIndexes, isFtsRebuildInProgress } = await import('../jobs/fts-rebuild');

  if (isFtsRebuildInProgress()) {
    logger.info('POST /v2/activities/internal/fts-rebuild: rebuild already in progress');
    return c.json({ ok: true, message: 'rebuild already in progress', estimated_ms: 360_000 }, 202);
  }

  // Fire-and-forget: return 202 immediately so the HTTP gateway does not time
  // out. The rebuild runs asynchronously — poll GET /v2/activities/templates?q=
  // for non-zero fts_score values to confirm the scorer is warm.
  void rebuildFtsIndexes()
    .then(() => logger.info('POST /v2/activities/internal/fts-rebuild complete (async)'))
    .catch(err => logger.error('POST /v2/activities/internal/fts-rebuild failed (async)', { error: String(err) }));

  return c.json({ ok: true, message: 'rebuild started', estimated_ms: 360_000 }, 202);
});

// --- parity-gated seam extraction: moved decls now live in ./activities.scoring ---
import { betaSample, normalizeSuccessorValue, successorBlendEnabled, successorBlendWeight, updateShapeScoresFromExecution, variantMetricsRecordId } from "./activities.scoring";
export { variantMetricsRecordId } from "./activities.scoring";

// --- parity-gated seam extraction: moved decls now live in ./activities.composition ---
import { classifyCompositionEdge } from "./activities.composition";
export type { CompositionEdgeKind } from "./activities.composition";
export { classifyCompositionEdge } from "./activities.composition";

// --- parity-gated seam extraction: moved decls now live in ./activities.templates-db ---
import { ActivityTemplate, accountIdScopedWhere, countAllTemplatesFromDB, enrichTemplatesWithMetrics, ensureOutputShapes, listAllTemplatesFromDB, listPublicTemplatesFromDB } from "./activities.templates-db";
export { accountIdScopedWhere } from "./activities.templates-db";
