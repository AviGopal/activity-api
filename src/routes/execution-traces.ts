/**
 * Execution Traces Routes
 *
 * Provides endpoints for retrieving execution traces with full state information
 * Used by dashboard to display execution history timeline
 */

import { Hono } from 'hono';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import type { SessionData } from '../models/schemas';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';
import { config } from '../config';
import { insertExecution, isDualWriteEnabled, normalizeActivityId, updateShapeActivityScores, type ParadigmExecution } from '../db/paradigm';
import {
  extractOutputShapes,
  validateOutputShapes,
  computeThompsonSamplingUpdates,
  type ShapeMatchMetadata,
} from '../services/thompson-sampling';

const app = new Hono();

/**
 * Normalize a minibob-sent task object into the persisted shape. Preserves
 * per-task impulse grouping (`input_impulse_ids`, `output_impulse_ids`) so
 * `executionTraceWithSignatures` can surface task-scoped signal to the
 * co-occurrence extractor.
 *
 * The canonical wire shape (emitted by minibob's `serializeTasksForTrace`)
 * uses snake_case. We also accept camelCase and the richer
 * `inputState.impulses` / `outputState.impulses` shapes as fallbacks so
 * payloads from older minibob builds keep writing cleanly.
 *
 * Exported for tests — see `execution-traces.test.ts`.
 */
/**
 * Extract per-task impulse-ID arrays from a minibob-emitted task object.
 *
 * Priority order (matches `serializeTasksForTrace` canonical wire shape):
 *   1. snake_case `input_impulse_ids` / `output_impulse_ids` (canonical)
 *   2. camelCase `inputImpulseIds` / `outputImpulseIds` (legacy minibob)
 *   3. richer `inputState.impulses` / `outputState.impulses` containers
 *      (improviser path, ExecutedTask shape)
 *   4. `[]` (no source) — never undefined
 *
 * Used by both `normalizePersistedTask` (write/persist path) and the
 * broadcaster's `task.completed` payload constructor so the persisted shape
 * and the live broadcast carry identical impulse-ID arrays for the same
 * task. Single source of truth for the priority order.
 *
 * Exported for tests — see `execution-traces.test.ts`.
 */
export function extractTaskImpulseIds(task: any): {
  input_impulse_ids: string[];
  output_impulse_ids: string[];
} {
  const input_impulse_ids: string[] = Array.isArray(task?.input_impulse_ids)
    ? task.input_impulse_ids
    : Array.isArray(task?.inputImpulseIds)
      ? task.inputImpulseIds
      : Array.isArray(task?.inputState?.impulses)
        ? task.inputState.impulses
        : [];
  const output_impulse_ids: string[] = Array.isArray(task?.output_impulse_ids)
    ? task.output_impulse_ids
    : Array.isArray(task?.outputImpulseIds)
      ? task.outputImpulseIds
      : Array.isArray(task?.outputState?.impulses)
        ? task.outputState.impulses
        : [];
  return { input_impulse_ids, output_impulse_ids };
}

export function normalizePersistedTask(task: any): {
  task_id: string;
  description?: string;
  status?: string;
  duration_ms?: number;
  tool_calls: unknown[] | null;
  input_impulse_ids: string[];
  output_impulse_ids: string[];
  resolver_id?: string;
  resolver_tier?: string;
  success?: boolean;
  cost_usd?: number;
} {
  const { input_impulse_ids: inputImpulseIds, output_impulse_ids: outputImpulseIds } =
    extractTaskImpulseIds(task);

  // Per-task resolver attribution (canonical six-field shape from minibob's
  // serializeTasksForTrace). The `tasks` column is FLEXIBLE so these can ride
  // through without a schema bump. Only emit a key when a value is present so
  // SurrealDB stores `null` only where minibob explicitly set it.
  const out: ReturnType<typeof normalizePersistedTask> = {
    task_id: task?.taskId || task?.task_id,
    description: task?.description,
    status: task?.status,
    duration_ms: task?.duration ?? task?.duration_ms,
    tool_calls: Array.isArray(task?.toolCalls)
      ? task.toolCalls
      : Array.isArray(task?.tool_calls)
        ? task.tool_calls
        : null,
    input_impulse_ids: inputImpulseIds,
    output_impulse_ids: outputImpulseIds,
  };

  if (typeof task?.resolver_id === 'string' && task.resolver_id.length > 0) {
    out.resolver_id = task.resolver_id;
  }
  if (typeof task?.resolver_tier === 'string' && task.resolver_tier.length > 0) {
    out.resolver_tier = task.resolver_tier;
  }
  if (typeof task?.success === 'boolean') {
    out.success = task.success;
  }
  if (typeof task?.cost_usd === 'number') {
    out.cost_usd = task.cost_usd;
  }

  return out;
}

/**
 * Resolve the set of activity_template ids that should receive a Thompson
 * Sampling update for a given trace.
 *
 * Direct executions (variant_id is the dispatched template) collapse to a
 * single id. Meta-trace failures emitted from minibob's `emitMetaTrace` carry
 * a synthetic variant_id (`_goal_resolve` / `_activity_execute`) plus the
 * real dispatched template id in `metadata.template_id` — both rows need the
 * outcome propagated, otherwise the dispatched template's beta never moves
 * when an upstream goal aborts.
 *
 * Returns a de-duplicated list with `variant_id` first (so it's logged as the
 * primary update) and `metadata.template_id` appended only when distinct.
 *
 * IDs are normalized to plain string form (strips `activity:` prefix and
 * `⟨...⟩` brackets) before deduplication. The wrapped `activity:⟨name⟩` form
 * and the plain `name` form must collapse to the same row in
 * `variant_performance_metrics` — otherwise the UNIQUE index on `variant_id`
 * treats them as separate records and Thompson Sampling sees split α/β.
 * Mirrors the read-path normalization in `enrichTemplatesWithMetrics` (see
 * `routes/activities.ts`) and the `getVariantFamily` fix in `db/paradigm.ts`.
 *
 * Exported for tests.
 */
export function resolveTemplateIdsForUpdate(args: {
  variantId: string;
  metadata?: Record<string, unknown> | null;
}): string[] {
  const { variantId, metadata } = args;
  const metadataTemplateId =
    metadata && typeof (metadata as { template_id?: unknown }).template_id === 'string'
      ? ((metadata as { template_id: string }).template_id)
      : undefined;
  const candidates = [
    variantId,
    ...(metadataTemplateId && metadataTemplateId !== variantId ? [metadataTemplateId] : []),
  ]
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => normalizeActivityId(id))
    .filter((id) => id.length > 0);
  return Array.from(new Set(candidates));
}

interface ExecutionTrace {
  execution_id: string;
  variant_id: string;
  activity_id: string;
  success: boolean;
  duration_ms: number;
  cost: number;
  tokens: {
    input: number;
    output: number;
    cache: number;
  };
  error_message?: string;
  error_type?: string;
  failed_task_id?: string;
  impulses_used?: string[];
  component_changes?: Array<{
    file_path: string;
    component_name: string;
    component_type: string;
    change_type: 'added' | 'modified' | 'deleted';
    reason?: string;
  }>;
  tasks?: Array<{
    task_id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    duration_ms?: number;
    tool_calls?: Array<{
      tool: string;
      duration_ms: number;
      success: boolean;
    }>;
  }>;
  state_snapshot?: {
    input_state: {
      filesAvailable?: string[];
      environment?: Record<string, string>;
      impulses?: string[];
      variables?: Record<string, unknown>;
    };
    output_state: {
      filesModified?: string[];
      filesCreated?: string[];
      filesDeleted?: string[];
      exitCode?: number;
      stderr?: string;
    };
    stateTransition?: {
      before?: Record<string, string>;
      after?: Record<string, string>;
      workingDirectory?: string;
    };
  };
  org_id: string | null;
  project_id: string | null;
  vessel_id?: string;
  resolved_by_vessel_id?: string;
  vessel_version?: string;
  // Per-impulse resolver attribution (canonical six-field shape from minibob).
  // See migration 086 for the persisted form.
  impulse_resolutions?: Array<{
    impulse_id: string;
    resolver_id: string;
    resolver_tier: string;
    vessel_id: string;
    latency_ms: number;
    cost_usd: number;
  }>;
  composition_chain?: string[];
  executed_at: string;
  created_at: string;
  // Edge learning fields
  improvisation?: boolean;
  input_impulse_shapes?: string[];
  output_impulse_shapes?: string[];
  output_impulses?: Array<{ shape: string; pointer: Record<string, unknown> }>;
  metadata?: Record<string, unknown>;
}

interface ListExecutionTracesResponse {
  executions: ExecutionTrace[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Forward co-change event to analysis-api learning service (async/non-blocking)
 * This updates co-change patterns based on files modified in execution traces.
 *
 * M4.2: Wire Activity API to Learning
 */
async function forwardToLearning(
  sessionId: string,
  changedFiles: string[],
  projectId: string | null
): Promise<void> {
  // Only forward if we have at least 2 files changed (co-change requires pairs)
  if (changedFiles.length < 2) {
    logger.debug('Skipping learning forward - less than 2 files changed', {
      session_id: sessionId,
      files_count: changedFiles.length,
    });
    return;
  }

  const analysisApiUrl = config.analysisApi.url;
  const endpoint = `${analysisApiUrl}/v2/analysis/learning/cochange`;

  try {
    // Fire and forget - don't await the response
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-ID': sessionId,
      },
      body: JSON.stringify({
        session_id: sessionId,
        changed_files: changedFiles,
        project_id: projectId || 'default',
      }),
      // Short timeout since this is non-blocking
      signal: AbortSignal.timeout(config.analysisApi.timeout),
    }).then(async (response) => {
      if (response.ok) {
        logger.info('[learning] Co-change event forwarded successfully', {
          session_id: sessionId,
          files_count: changedFiles.length,
        });
      } else {
        const errorText = await response.text();
        logger.warn('[learning] Co-change forward failed', {
          session_id: sessionId,
          status: response.status,
          error: errorText,
        });
      }
    }).catch((error) => {
      // Log but don't fail - learning is non-critical
      logger.warn('[learning] Co-change forward error (non-blocking)', {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    // Catch synchronous errors (shouldn't happen with fetch)
    logger.warn('[learning] Co-change forward setup error', {
      session_id: sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * GET /v2/activities/execution-traces
 *
 * List execution traces with filtering and pagination
 *
 * Query params:
 * - variant_id: Filter by variant ID
 * - activity_id: Filter by activity ID
 * - success: Filter by success status (true/false)
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 * - start_date: Filter executions after this ISO timestamp
 * - end_date: Filter executions before this ISO timestamp
 */
app.get('/', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Session may be undefined for internal/unauthenticated calls
    const session = ((c.get as any)('session') as SessionData | undefined) || {
      session_id: 'internal', org_id: null, project_id: null, api_key: null, latest_job_id: null
    };

    // Parse query params
    const variantId = c.req.query('variant_id');
    const activityId = c.req.query('activity_id');
    const successParam = c.req.query('success');
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);
    const startDate = c.req.query('start_date');
    const endDate = c.req.query('end_date');
    const includeSelection = c.req.query('include_selection') === 'true';

    // Validate and cap limit
    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build SurrealDB query dynamically
    let whereConditions: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    // Multi-tenant filtering (skip when using JWT - RBAC handles it via PERMISSIONS)
    if (!useJwtAuth) {
      if (session.org_id) {
        whereConditions.push('(org_id = $org_id OR org_id = NULL)');
        params.org_id = session.org_id;
      }

      if (session.project_id) {
        whereConditions.push('(project_id = $project_id OR project_id = NULL)');
        params.project_id = session.project_id;
      }
    }

    // Filter by variant_id
    if (variantId) {
      whereConditions.push('variant_id = $variant_id');
      params.variant_id = variantId;
    }

    // Filter by activity_id
    if (activityId) {
      whereConditions.push('activity_id = $activity_id');
      params.activity_id = activityId;
    }

    // Filter by success status
    if (successParam !== undefined) {
      const success = successParam === 'true';
      whereConditions.push('success = $success');
      params.success = success;
    }

    // Filter by date range
    if (startDate) {
      whereConditions.push('executed_at >= $start_date');
      params.start_date = startDate;
    }

    if (endDate) {
      whereConditions.push('executed_at <= $end_date');
      params.end_date = endDate;
    }

    // Filter by parent_execution_id — returns only direct child executions of the given parent.
    // The stored field may be a bare ID ("act_...") or a full record ID
    // ("activity_execution_traces:act_..."). Accept both forms so callers can pass
    // either without knowing the storage format.
    const parentExecutionId = c.req.query('parent_execution_id');
    if (parentExecutionId) {
      // Strip table prefix if present so we compare bare IDs consistently
      const bareId = parentExecutionId.includes(':')
        ? parentExecutionId.split(':').slice(1).join(':')
        : parentExecutionId;
      whereConditions.push(
        '(parent_execution_id = $parent_execution_id OR parent_execution_id = $parent_execution_id_prefixed)'
      );
      params.parent_execution_id = bareId;
      params.parent_execution_id_prefixed = `activity_execution_traces:${bareId}`;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // Query execution traces (ordered by most recent first)
    const query = `
      SELECT * FROM activity_execution_traces
      ${whereClause}
      ORDER BY executed_at DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching execution traces', {
      whereClause,
      params,
      query,
      authMethod: useJwtAuth ? 'jwt' : 'session',
    });

    // Execute query with appropriate auth method
    let executions: ExecutionTrace[];
    let countResult: { total: number }[];

    // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      // JWT AUTH PATH: Use RBAC-enforced query
      executions = await queryWithAuth<ExecutionTrace>(jwtAuth.jwtToken, query, params);
      const countQuery = `
        SELECT count() as total FROM activity_execution_traces
        ${whereClause}
        GROUP ALL
      `;
      countResult = await queryWithAuth<{ total: number }>(jwtAuth.jwtToken, countQuery, params);
    } else {
      // LEGACY PATH: Direct query with application-level filtering
      executions = await surrealDB.query<ExecutionTrace>(query, params);
      const countQuery = `
        SELECT count() as total FROM activity_execution_traces
        ${whereClause}
        GROUP ALL
      `;
      countResult = await surrealDB.query<{ total: number }>(countQuery, params);
    }

    logger.info('Raw executions result from SurrealDB', {
      executionsType: typeof executions,
      executionsIsArray: Array.isArray(executions),
      executionsLength: executions?.length || 0,
      firstExecution: executions?.[0] || null,
      rbacEnforced: useJwtAuth,
    });

    const total = countResult?.[0]?.total || 0;

    logger.info('Execution traces fetched', {
      count: executions?.length || 0,
      total,
      limit,
      offset,
      includeSelection,
    });

    // If include_selection is true, fetch selection data for each trace
    let executionsWithSelection = executions || [];
    if (includeSelection && executionsWithSelection.length > 0) {
      // Collect correlation_ids from traces that have them
      const correlationIds = executionsWithSelection
        .filter((e: any) => e.correlation_id)
        .map((e: any) => e.correlation_id);

      // Collect activity_ids for traces without correlation_id
      const activityIds = executionsWithSelection
        .filter((e: any) => !e.correlation_id)
        .map((e: any) => e.activity_id || e.variant_id);

      // Batch fetch selection data
      let selectionByCorrelation = new Map<string, any>();
      let selectionByActivity = new Map<string, any>();

      try {
        // Fetch by correlation_id (exact match)
        if (correlationIds.length > 0) {
          const correlationQuery = `
            SELECT
              correlation_id,
              thompson_sample,
              alpha,
              beta,
              selection_method,
              candidates_count,
              selected_at
            FROM thompson_selection_log
            WHERE correlation_id IN $correlation_ids
          `;
          const correlationResults = await surrealDB.query<any>(correlationQuery, {
            correlation_ids: correlationIds,
          });
          for (const sel of correlationResults || []) {
            selectionByCorrelation.set(sel.correlation_id, sel);
          }
        }

        // Fetch most recent by activity_id (fallback for traces without correlation_id)
        if (activityIds.length > 0) {
          const activityQuery = `
            SELECT
              activity_id,
              thompson_sample,
              alpha,
              beta,
              selection_method,
              candidates_count,
              selected_at,
              correlation_id
            FROM thompson_selection_log
            WHERE activity_id IN $activity_ids
            ORDER BY selected_at DESC
          `;
          const activityResults = await surrealDB.query<any>(activityQuery, {
            activity_ids: [...new Set(activityIds)], // Dedupe
          });
          // Take most recent per activity
          for (const sel of activityResults || []) {
            if (!selectionByActivity.has(sel.activity_id)) {
              selectionByActivity.set(sel.activity_id, sel);
            }
          }
        }

        // Attach selection_attribution to each trace
        executionsWithSelection = executionsWithSelection.map((trace: any) => {
          let selectionData = null;
          let matchType: 'exact' | 'activity_fallback' | null = null;

          if (trace.correlation_id && selectionByCorrelation.has(trace.correlation_id)) {
            const sel = selectionByCorrelation.get(trace.correlation_id);
            selectionData = {
              selection_probability: sel.thompson_sample,
              selection_method: sel.selection_method,
              alpha_at_selection: sel.alpha,
              beta_at_selection: sel.beta,
              candidates_count: sel.candidates_count,
              selected_at: sel.selected_at,
              match_type: 'exact' as const,
            };
          } else {
            const activityKey = trace.activity_id || trace.variant_id;
            if (selectionByActivity.has(activityKey)) {
              const sel = selectionByActivity.get(activityKey);
              selectionData = {
                selection_probability: sel.thompson_sample,
                selection_method: sel.selection_method,
                alpha_at_selection: sel.alpha,
                beta_at_selection: sel.beta,
                candidates_count: sel.candidates_count,
                selected_at: sel.selected_at,
                match_type: 'activity_fallback' as const,
              };
            }
          }

          return {
            ...trace,
            selection_attribution: selectionData,
          };
        });

        logger.info('Selection attribution added to traces', {
          byCorrelation: selectionByCorrelation.size,
          byActivity: selectionByActivity.size,
          totalTraces: executionsWithSelection.length,
        });
      } catch (selectionError) {
        logger.warn('Failed to fetch selection data for list', {
          error: selectionError instanceof Error ? selectionError.message : String(selectionError),
        });
        // Continue without selection data
      }
    }

    // Ensure execution_id is populated (use SurrealDB id as fallback for legacy data)
    const executionsNormalized = executionsWithSelection.map((trace: any) => ({
      ...trace,
      execution_id: trace.execution_id || trace.id?.toString().split(':')[1] || trace.id,
    }));

    // F-37/F-40 read-time fallback (2026-04-26): when stored chain is empty
    // but parent_execution_id is set, walk on the fly. Read-only.
    // Per-request memoization cache: sibling rows with the same parent
    // collapse to a single DB walk per distinct parent_execution_id.
    const chainCache: CompositionChainCache = new Map();
    const executionsWithChain = await Promise.all(
      executionsNormalized.map((t: any) => applyChainFallback(t, chainCache)),
    );

    const response: ListExecutionTracesResponse = {
      executions: executionsWithChain,
      total,
      limit,
      offset,
    };

    return c.json(response);

  } catch (error) {
    logger.error('Failed to list execution traces', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to list execution traces',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/:executionId
 *
 * Get detailed information about a specific execution trace
 * Enhanced with Thompson Sampling selection data for explainability (M4.2)
 */
app.get('/:executionId', async (c) => {
  try {
    const executionId = c.req.param('executionId');

    // Fetch execution trace
    const traceQuery = `
      SELECT * FROM activity_execution_traces
      WHERE execution_id = $execution_id
      LIMIT 1
    `;

    const result = await surrealDB.query<ExecutionTrace>(traceQuery, {
      execution_id: executionId,
    });

    logger.info('GET execution trace query result', {
      executionId,
      resultLength: result?.length || 0,
      result: result,
    });

    if (!result || result.length === 0) {
      logger.warn('Execution trace not found in database', {
        executionId,
        params: { execution_id: executionId },
      });
      return c.json({
        error: 'Execution trace not found',
        execution_id: executionId,
      }, 404);
    }

    const trace = result[0];

    // M4.2: Fetch Thompson Sampling selection data for explainability
    // Priority: 1) correlation_id (exact match), 2) activity_id (approximate/most recent)
    let selectionData = null;
    try {
      let selectionResult: {
        thompson_sample: number;
        alpha: number;
        beta: number;
        selection_method: string;
        candidates_count: number | null;
        selected_at: string;
        correlation_id?: string;
      }[] = [];

      // First try exact match by correlation_id if the trace has one
      if ((trace as any).correlation_id) {
        const correlationQuery = `
          SELECT
            thompson_sample,
            alpha,
            beta,
            selection_method,
            candidates_count,
            selected_at,
            correlation_id
          FROM thompson_selection_log
          WHERE correlation_id = $correlation_id
          LIMIT 1
        `;
        selectionResult = await surrealDB.query(correlationQuery, {
          correlation_id: (trace as any).correlation_id,
        });
      }

      // Fall back to activity_id match (most recent selection for this activity)
      if (!selectionResult || selectionResult.length === 0) {
        const activityQuery = `
          SELECT
            thompson_sample,
            alpha,
            beta,
            selection_method,
            candidates_count,
            selected_at,
            correlation_id
          FROM thompson_selection_log
          WHERE activity_id = $activity_id
          ORDER BY selected_at DESC
          LIMIT 1
        `;
        selectionResult = await surrealDB.query(activityQuery, {
          activity_id: trace.activity_id || trace.variant_id,
        });
      }

      if (selectionResult && selectionResult.length > 0) {
        const sel = selectionResult[0];
        selectionData = {
          selection_probability: sel.thompson_sample,
          selection_method: sel.selection_method,
          alpha_at_selection: sel.alpha,
          beta_at_selection: sel.beta,
          candidates_count: sel.candidates_count,
          selected_at: sel.selected_at,
          // Include match type for debugging
          match_type: (trace as any).correlation_id && sel.correlation_id === (trace as any).correlation_id
            ? 'exact' : 'activity_fallback',
        };
      }
    } catch (selectionError) {
      // Don't fail the request if selection data fetch fails
      logger.warn('Failed to fetch selection data', {
        executionId,
        error: selectionError instanceof Error ? selectionError.message : String(selectionError),
      });
    }

    // Return trace with optional selection data
    // Ensure execution_id is populated (use SurrealDB id as fallback for legacy data)
    const traceNormalized: any = {
      ...trace,
      execution_id: trace.execution_id || (trace as any).id?.toString().split(':')[1] || (trace as any).id,
      selection_attribution: selectionData,
    };

    // F-37/F-40 read-time fallback (2026-04-26): same contract as list handler.
    const traceWithChain = await applyChainFallback(traceNormalized);

    return c.json(traceWithChain);

  } catch (error) {
    logger.error('Failed to get execution trace', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to get execution trace',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/selection-events
 *
 * List Thompson Sampling selection events for explainability dashboard (M4.1)
 *
 * Query params:
 * - activity_id: Filter by activity ID
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 * - start_date: Filter selections after this ISO timestamp
 * - end_date: Filter selections before this ISO timestamp
 */
app.get('/selection-events', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Parse query params
    const activityId = c.req.query('activity_id');
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);
    const startDate = c.req.query('start_date');
    const endDate = c.req.query('end_date');

    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build query
    const whereConditions: string[] = [];
    const params: Record<string, any> = { limit, offset };

    if (activityId) {
      whereConditions.push('activity_id = $activity_id');
      params.activity_id = activityId;
    }

    if (startDate) {
      whereConditions.push('selected_at >= $start_date');
      params.start_date = startDate;
    }

    if (endDate) {
      whereConditions.push('selected_at <= $end_date');
      params.end_date = endDate;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const query = `
      SELECT * FROM thompson_selection_log
      ${whereClause}
      ORDER BY selected_at DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching selection events', { whereClause, params });

    let events: any[];
    let countResult: { total: number }[];

    // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      events = await queryWithAuth(jwtAuth.jwtToken, query, params);
      const countQuery = `
        SELECT count() as total FROM thompson_selection_log
        ${whereClause}
        GROUP ALL
      `;
      countResult = await queryWithAuth(jwtAuth.jwtToken, countQuery, params);
    } else {
      events = await surrealDB.query(query, params);
      const countQuery = `
        SELECT count() as total FROM thompson_selection_log
        ${whereClause}
        GROUP ALL
      `;
      countResult = await surrealDB.query(countQuery, params);
    }

    const total = countResult?.[0]?.total || 0;

    logger.info('Selection events fetched', {
      count: events?.length || 0,
      total,
    });

    return c.json({
      events: events || [],
      total,
      limit,
      offset,
    });

  } catch (error) {
    logger.error('Failed to list selection events', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to list selection events',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * Denormalize the composition_chain at trace-insert time.
 *
 * F-37 fix (2026-04-26): every execution trace on canary had
 * `composition_chain: []` despite `parent_execution_id` being set
 * correctly. The denormalization step that should compute the chain by
 * reading the parent's chain at insert time was missing entirely; clients
 * (minibob) compute it for L3 template runs but L1/L2 meta-traces fall
 * through without populating it. Phase 8 criterion 2 (recursive escalation
 * auditing) was effectively blind because chain-depth queries always
 * returned 0 traces.
 *
 * Strategy: when a parent is referenced, look it up and compute
 *   composition_chain = parent.composition_chain.concat(parent.execution_id)
 * (root-first ordering — matches the contract in migration 081 and
 * `composition-chain.ts` in minibob). When parent isn't found (orphan or
 * race-condition), return an empty array so the trace lands as root-like.
 *
 * Trust client-provided non-empty chains (callers that already compute it
 * client-side stay authoritative). Only compute when the field is missing
 * or empty.
 *
 * Exported for tests.
 */
export async function denormalizeCompositionChain(
  parentExecutionId: string,
): Promise<string[]> {
  if (!parentExecutionId || typeof parentExecutionId !== 'string') return [];
  try {
    const parentResult = await surrealDB.query<{
      execution_id?: string;
      composition_chain?: string[] | null;
    }>(
      `
        SELECT execution_id, composition_chain FROM activity_execution_traces
        WHERE execution_id = $parent_execution_id
        LIMIT 1
      `,
      { parent_execution_id: parentExecutionId },
    );
    if (!parentResult || parentResult.length === 0) {
      // Orphan parent — could be a race (parent trace lands after child)
      // or a parent in a different store. Leave chain empty; root-like.
      return [];
    }
    const parent = parentResult[0] as
      | { execution_id?: string; composition_chain?: string[] | null }
      | undefined;
    const parentChain: string[] = Array.isArray(parent?.composition_chain)
      ? (parent!.composition_chain as string[])
      : [];
    // Use the parent's stored execution_id when present, else fall back
    // to the id we were given (defensive — they should be equal).
    const parentId =
      typeof parent?.execution_id === 'string' && parent.execution_id.length > 0
        ? parent.execution_id
        : parentExecutionId;
    return [...parentChain, parentId];
  } catch (err) {
    logger.warn('[F-37] Failed to denormalize composition_chain — leaving empty', {
      parent_execution_id: parentExecutionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Backfill `composition_chain` on already-inserted children of a just-inserted
 * trace. Closes the write-order race in F-37.
 *
 * F-40 (2026-04-26): F-37 computes the chain at insert time by reading the
 * parent. That works for L3 template runs but breaks for minibob's L1/L2
 * synthetic meta-traces (`emitMetaTrace` for `_goal_resolve` /
 * `_activity_execute`) which insert AFTER their children — the meta-trace
 * wraps the entire goal flow and emits at the end. F-37's parent-lookup at
 * child-insert time finds nothing, the child lands with empty chain, and
 * Phase 8 chain-depth audits stay blind.
 *
 * Strategy: after a successful insert, run a single best-effort UPDATE that
 * sets `composition_chain` on every existing row whose `parent_execution_id`
 * matches the inserted row's `execution_id` AND whose chain is currently
 * empty/none. The new chain is `[...inserted.composition_chain, inserted.execution_id]`,
 * which collapses to `[inserted.execution_id]` for root-level inserts.
 *
 * Idempotent: the WHERE clause excludes children that already have a
 * non-empty chain, so a duplicate insert is a no-op for backfill purposes.
 *
 * Best-effort: we swallow errors and log. Losing the backfill on a transient
 * DB error is acceptable; failing the insert that already succeeded is not.
 *
 * Scope: this only walks one level (direct children). We deliberately do NOT
 * recursively walk grandchildren — see comment in the route handler. In
 * practice traces arrive in approximately top-down or bottom-up order; the
 * insert-time helper handles top-down, and this backfill handles bottom-up.
 * Mixed/interleaved orders are rare enough that one-shot migration is the
 * right tool, not an O(depth²) recursive walk on every insert.
 *
 * Exported for tests.
 */
export async function backfillChildCompositionChains(
  insertedExecutionId: string,
  insertedCompositionChain: string[],
): Promise<void> {
  if (!insertedExecutionId || typeof insertedExecutionId !== 'string') return;
  // newChain = parent's chain + parent's own id (root-first ordering, matches
  // migration 081 + minibob composition-chain.ts contract).
  const newChain: string[] = [...insertedCompositionChain, insertedExecutionId];
  try {
    // Single statement. SurrealQL handles the row scan; no app-side loop.
    // The `composition_chain IS NONE OR array::len(composition_chain) = 0`
    // clause is the idempotency guard — we never overwrite a populated
    // chain (those children already had a parent at their insert time and
    // the F-37 helper resolved them correctly).
    await surrealDB.query(
      `
        UPDATE activity_execution_traces
        SET composition_chain = $new_chain
        WHERE parent_execution_id = $parent_execution_id
          AND (composition_chain IS NONE OR array::len(composition_chain) = 0)
      `,
      {
        parent_execution_id: insertedExecutionId,
        new_chain: newChain,
      },
    );
  } catch (err) {
    logger.warn('[F-40] Failed to backfill child composition_chains — leaving empty', {
      inserted_execution_id: insertedExecutionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read-time fallback for F-37/F-40: walk `parent_execution_id` chain on the
 * fly when the stored `composition_chain` is empty. F-37 + F-40 are write-time
 * fixes; traces inserted before they landed can still expose
 * `composition_chain: []` despite a valid `parent_execution_id`. This helper
 * closes the audit-time gap (Phase 8 criterion 2 — recursive escalation
 * auditing).
 *
 * Walks upward, prepending each step. On the first non-empty
 * `composition_chain` encountered, prepends it as the base and stops
 * (early-exit — parent's chain already covers everything above). Capped at
 * `maxDepth` and guarded with a visited-set against cycles. Returns `[]` on
 * any DB error. Read-only — never writes back. Cost is at most `maxDepth`
 * queries; typically 1-3 for L3 trees.
 *
 * Exported for tests.
 */
export async function walkCompositionChain(
  executionId: string,
  maxDepth = 16,
): Promise<string[]> {
  if (!executionId || typeof executionId !== 'string') return [];
  const accumulator: string[] = [];
  let cursor: string | undefined = executionId;
  const visited = new Set<string>();
  try {
    for (let depth = 0; depth < maxDepth && cursor; depth++) {
      if (visited.has(cursor)) break; // cycle guard
      visited.add(cursor);

      const result = await surrealDB.query<{
        execution_id?: string;
        parent_execution_id?: string | null;
        composition_chain?: string[] | null;
      }>(
        `
          SELECT execution_id, parent_execution_id, composition_chain FROM activity_execution_traces
          WHERE execution_id = $execution_id
          LIMIT 1
        `,
        { execution_id: cursor },
      );
      if (!result || result.length === 0) {
        // Orphan / missing parent. Mid-walk this means we have an
        // incomplete picture (real parent row never landed, or lives in a
        // different store). Log once at warn level so the gap is visible
        // but never throw — return whatever the walk accumulated so far.
        if (accumulator.length > 0) {
          logger.warn('[F-37/F-40 read-time] orphan parent mid-walk — returning partial chain', {
            origin_execution_id: executionId,
            missing_parent_execution_id: cursor,
            partial_chain_length: accumulator.length,
          });
        }
        return accumulator;
      }
      const row = result[0] as {
        execution_id?: string;
        parent_execution_id?: string | null;
        composition_chain?: string[] | null;
      };
      const rowChain: string[] = Array.isArray(row?.composition_chain)
        ? (row.composition_chain as string[])
        : [];
      const rowExecId =
        typeof row?.execution_id === 'string' && row.execution_id.length > 0
          ? row.execution_id
          : cursor;

      if (rowChain.length > 0) {
        // Early-exit: parent's chain covers everything above it.
        return [...rowChain, rowExecId, ...accumulator];
      }

      accumulator.unshift(rowExecId);
      cursor =
        typeof row?.parent_execution_id === 'string' && row.parent_execution_id.length > 0
          ? row.parent_execution_id
          : undefined;
    }
    return accumulator;
  } catch (err) {
    logger.warn('[F-37/F-40 read-time] walkCompositionChain failed — returning []', {
      execution_id: executionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * In-request memoization cache for chain resolution. Use one cache per
 * incoming HTTP request (see `applyChainFallback` callers in the GET list
 * handler and `runExecutionTraceWithSignatures`); siblings with the same
 * parent reuse the same walk. Out-of-band, the cache stays scoped to the
 * promise graph that owns it — no cross-request leakage.
 */
export type CompositionChainCache = Map<string, Promise<string[]>>;

/**
 * Resolve the composition chain for a parent execution id with optional
 * in-request memoization. Wraps `walkCompositionChain`; the cache is keyed
 * by the executionId argument and stores the in-flight promise so concurrent
 * calls share one DB walk. No global state — caller passes a fresh `Map`
 * per request and discards it on response.
 *
 * Exported for tests.
 */
export async function resolveCompositionChain(
  executionId: string,
  cache?: CompositionChainCache,
  maxDepth = 16,
): Promise<string[]> {
  if (!executionId || typeof executionId !== 'string') return [];
  if (!cache) return walkCompositionChain(executionId, maxDepth);
  const cached = cache.get(executionId);
  if (cached) return cached;
  const promise = walkCompositionChain(executionId, maxDepth);
  cache.set(executionId, promise);
  return promise;
}

/**
 * Apply the F-37/F-40 read-time fallback to a single trace: when the stored
 * `composition_chain` is empty but a `parent_execution_id` is set, walk on
 * the fly via `resolveCompositionChain`. Returns the trace unchanged when the
 * chain is already populated, when no parent reference exists, or when the
 * walk yields nothing. Read-only — never writes back.
 *
 * Pass an optional `cache` (a fresh `Map` per request) to memoize repeated
 * walks across siblings — large list responses with many traces sharing a
 * common ancestor collapse to one DB walk per distinct parent.
 *
 * Exported for tests.
 */
export async function applyChainFallback<T extends Record<string, any>>(
  trace: T,
  cache?: CompositionChainCache,
): Promise<T> {
  const storedChain: unknown = trace?.composition_chain;
  if (Array.isArray(storedChain) && storedChain.length > 0) return trace;
  const parentId =
    typeof trace?.parent_execution_id === 'string' && trace.parent_execution_id.length > 0
      ? (trace.parent_execution_id as string)
      : null;
  if (!parentId) return trace;
  const computed = await resolveCompositionChain(parentId, cache);
  if (computed.length === 0) return trace;
  return { ...trace, composition_chain: computed };
}

/**
 * POST /v2/activities/execution-traces
 *
 * Store execution trace for future reference (debugging, ribosome, impulses)
 */
app.post('/', async (c) => {
  try {
    // Check for JWT auth first (MiniBob instances)
    const jwtAuth = getJwtAuthFromContext(c);

    // Session may be undefined for internal/unauthenticated calls
    const session = ((c.get as any)('session') as SessionData | undefined) || { session_id: 'internal', org_id: null, project_id: null, api_key: null, latest_job_id: null };

    const body = await c.req.json();

    // Validate required fields
    if (!body.execution_id || !body.template_id) {
      logger.warn('Missing required fields in execution trace', { body });
      return c.json({
        error: 'Missing required fields',
        required: ['execution_id', 'template_id'],
        received: Object.keys(body),
      }, 400);
    }

    // FIX: Use org_id from request body if provided, otherwise fall back to JWT/session
    // This allows MiniBob to explicitly set org_id when sending traces
    const traceOrgId = body.org_id || jwtAuth?.orgId || session?.org_id || 'public';
    const traceProjectId = body.project_id || jwtAuth?.projectId || session?.project_id || null;

    logger.debug('[TRACE DEBUG] Determining org_id for trace', {
      body_org_id: body.org_id,
      jwt_org_id: jwtAuth?.orgId,
      session_org_id: session?.org_id,
      final_org_id: traceOrgId,
    });

    // F-37 (2026-04-26): denormalize composition_chain when client didn't.
    // When a parent is referenced but the client didn't supply a chain (or
    // supplied an empty one), look the parent up and compute
    //   chain = parent.composition_chain.concat(parent.execution_id)
    // so audit queries on chain depth work without walking parents one-by-one.
    // Client-supplied non-empty chains are trusted (backward-compat).
    const clientCompositionChain: string[] | null =
      Array.isArray(body.composition_chain) && body.composition_chain.length > 0
        ? body.composition_chain
        : null;
    const resolvedCompositionChain: string[] =
      clientCompositionChain !== null
        ? clientCompositionChain
        : body.parent_execution_id
          ? await denormalizeCompositionChain(body.parent_execution_id)
          : [];

    // Map MiniBob's field names to database schema
    // MiniBob sends: template_id, we store as: variant_id + activity_id
    const success = body.status === 'completed' || body.success === true;
    const trace = {
      execution_id: body.execution_id,
      variant_id: body.template_id, // MiniBob's template_id maps to variant_id
      activity_id: body.activity_id || body.template_id, // Default to template_id
      success,
      status: success ? 'success' : 'failure', // Derived status for backward compatibility
      duration_ms: body.duration_ms || 0,
      cost_usd: body.cost_usd || body.cost || 0,
      // Token counts (separate fields, not nested object)
      tokens_input: body.tokens?.input || body.total_tokens || 0,
      tokens_output: body.tokens?.output || 0,
      tokens_cache: body.tokens?.cache || 0,
      // Optional string fields - only include if set (avoid NULL vs NONE issues in SurrealDB)
      ...(body.error_message ? { error_message: body.error_message } : {}),
      ...(body.error_type ? { error_type: body.error_type } : {}),
      ...(body.failed_task_id ? { failed_task_id: body.failed_task_id } : {}),
      // Only include arrays if they have content (avoid NULL vs NONE issues in SurrealDB)
      ...(body.impulses_used && body.impulses_used.length > 0 ? { impulses_used: body.impulses_used } : {}),
      ...(body.component_changes && body.component_changes.length > 0 ? { component_changes: body.component_changes } : {}),

      // Extract task details from execution_trace if available.
      //
      // Per-task impulse grouping (`input_impulse_ids`, `output_impulse_ids`)
      // is the canonical snake_case shape emitted by minibob's
      // `serializeTasksForTrace` (see repos/minibob/src/mcp.ts). The read
      // resolver in `execution-trace-with-signatures.ts` reads these fields
      // to surface task-scoped signal to the co-occurrence extractor.
      tasks: body.execution_trace?.tasks && body.execution_trace.tasks.length > 0
        ? body.execution_trace.tasks.map(normalizePersistedTask)
        : null,

      // Extract state snapshot from execution_trace
      state_snapshot: body.execution_trace
        ? {
            input_state: body.execution_trace.tasks?.[0]?.inputState || {},
            output_state: body.execution_trace.tasks?.[body.execution_trace.tasks?.length - 1]?.outputState || {},
            stateTransition: body.execution_trace.tasks?.[body.execution_trace.tasks?.length - 1]?.stateTransition || {},
          }
        : null,

      // Multi-tenancy (use org_id from request body if provided)
      org_id: traceOrgId,
      project_id: traceProjectId,

      // Timestamps (SurrealDB datetime type)
      executed_at: new Date(),
      created_at: new Date(),
      stored_at: new Date(),

      // Edge learning fields (from improvisation traces)
      ...(body.improvisation ? { improvisation: body.improvisation } : {}),
      ...(body.input_impulse_shapes && body.input_impulse_shapes.length > 0
        ? { input_impulse_shapes: body.input_impulse_shapes } : {}),
      ...(body.output_impulse_shapes && body.output_impulse_shapes.length > 0
        ? { output_impulse_shapes: body.output_impulse_shapes } : {}),
      ...(body.output_impulses && body.output_impulses.length > 0
        ? { output_impulses: body.output_impulses } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}),

      // Selection-to-execution correlation (from /recommend endpoint)
      ...(body.correlation_id ? { correlation_id: body.correlation_id } : {}),

      // Composition tracking (three-level activity tracing):
      //   parent_execution_id → direct parent in the composition tree
      //   composition_chain   → denormalized ancestor chain, ordered root-first,
      //                         so consumers can reconstruct trees in one read
      ...(body.parent_execution_id ? { parent_execution_id: body.parent_execution_id } : {}),
      ...(resolvedCompositionChain.length > 0
        ? { composition_chain: resolvedCompositionChain } : {}),

      // Vessel attribution + per-impulse resolver tracking (minibob 6f8c727+).
      // See migration 086. The legacy table is SCHEMAFULL, so unknown keys are
      // dropped silently — this block ensures we round-trip what minibob
      // actually sends on the wire.
      ...(body.vessel_id ? { vessel_id: body.vessel_id } : {}),
      ...(body.resolved_by_vessel_id ? { resolved_by_vessel_id: body.resolved_by_vessel_id } : {}),
      ...(body.vessel_version ? { vessel_version: body.vessel_version } : {}),
      ...(Array.isArray(body.impulse_resolutions) && body.impulse_resolutions.length > 0
        ? { impulse_resolutions: body.impulse_resolutions } : {}),
    };

    // ========================================================================
    // TASK #3: Activity Shape Validation
    // Validate that output_impulses match the activity's declared output_shapes
    // ========================================================================
    if (trace.success && trace.output_impulses && trace.output_impulses.length > 0) {
      try {
        // Fetch activity template to get declared output_shapes
        // Use record::id(id) to extract the ID part from full record ID for matching
        const activityQuery = `
          SELECT output_shapes FROM activity_template
          WHERE record::id(id) = $activity_id OR record::id(id) = $variant_id
          LIMIT 1
        `;
        const activityResult = await surrealDB.query(activityQuery, {
          activity_id: trace.activity_id,
          variant_id: trace.variant_id,
        });

        if (activityResult && activityResult.length > 0 && activityResult[0]?.output_shapes) {
          const declaredShapes: string[] = activityResult[0].output_shapes;
          const actualShapes: string[] = trace.output_impulses.map((imp: any) =>
            typeof imp === 'string' ? imp : (imp?.shape || 'unknown')
          );

          // Compare declared vs actual
          const shapeMismatch = {
            declared: declaredShapes,
            actual: actualShapes,
            missing: declaredShapes.filter(s => !actualShapes.includes(s)),
            unexpected: actualShapes.filter(s => !declaredShapes.includes(s)),
          };

          if (shapeMismatch.missing.length > 0 || shapeMismatch.unexpected.length > 0) {
            logger.warn('[Shape Validation] Output impulse shapes do not match activity declaration', {
              execution_id: trace.execution_id,
              activity_id: trace.activity_id,
              variant_id: trace.variant_id,
              shape_mismatch: shapeMismatch,
            });

            // Store mismatch in trace metadata for learning
            if (!trace.metadata) {
              trace.metadata = {};
            }
            (trace.metadata as any).shape_validation = {
              passed: false,
              mismatch: shapeMismatch,
              validated_at: new Date().toISOString(),
            };
          } else {
            logger.info('[Shape Validation] Output impulse shapes match activity declaration', {
              execution_id: trace.execution_id,
              shapes: actualShapes,
            });

            // Store validation success in metadata
            if (!trace.metadata) {
              trace.metadata = {};
            }
            (trace.metadata as any).shape_validation = {
              passed: true,
              shapes: actualShapes,
              validated_at: new Date().toISOString(),
            };
          }
        }
      } catch (validationError) {
        // Don't fail the trace insertion if validation fails - just log
        logger.error('[Shape Validation] Failed to validate output shapes', {
          execution_id: trace.execution_id,
          error: validationError instanceof Error ? validationError.message : String(validationError),
        });
      }
    }

    // Insert into database
    // Build query dynamically to avoid NULL vs NONE issues for optional fields
    const optionalFields: string[] = [];
    // Optional string fields
    if (trace.error_message) optionalFields.push('error_message: $error_message');
    if (trace.error_type) optionalFields.push('error_type: $error_type');
    if (trace.failed_task_id) optionalFields.push('failed_task_id: $failed_task_id');
    // Optional array/object fields
    if (trace.impulses_used) optionalFields.push('impulses_used: $impulses_used');
    if (trace.component_changes) optionalFields.push('component_changes: $component_changes');
    if (trace.tasks) optionalFields.push('tasks: $tasks');
    if (trace.state_snapshot) optionalFields.push('state_snapshot: $state_snapshot');
    // Edge learning fields
    if (trace.improvisation) optionalFields.push('improvisation: $improvisation');
    if (trace.input_impulse_shapes) optionalFields.push('input_impulse_shapes: $input_impulse_shapes');
    if (trace.output_impulse_shapes) optionalFields.push('output_impulse_shapes: $output_impulse_shapes');
    if (trace.output_impulses) optionalFields.push('output_impulses: $output_impulses');
    if (trace.metadata) optionalFields.push('metadata: $metadata');
    // Selection-to-execution correlation
    if ((trace as any).correlation_id) optionalFields.push('correlation_id: $correlation_id');
    // Composition tracking (from three-level activity tracing)
    if ((trace as any).parent_execution_id) optionalFields.push('parent_execution_id: $parent_execution_id');
    if ((trace as any).composition_chain) optionalFields.push('composition_chain: $composition_chain');
    // Vessel attribution + per-impulse resolver tracking (migration 086)
    if ((trace as any).vessel_id) optionalFields.push('vessel_id: $vessel_id');
    if ((trace as any).resolved_by_vessel_id) optionalFields.push('resolved_by_vessel_id: $resolved_by_vessel_id');
    if ((trace as any).vessel_version) optionalFields.push('vessel_version: $vessel_version');
    if ((trace as any).impulse_resolutions) optionalFields.push('impulse_resolutions: $impulse_resolutions');
    // Project ID - only include if set (MiniBob instances may not have projects)
    if (trace.project_id) optionalFields.push('project_id: $project_id');

    const optionalFieldsStr = optionalFields.length > 0 ? `,\n        ${optionalFields.join(',\n        ')}` : '';

    // NOTE: org_id is a STRING field in schema (not a record link)
    // project_id is optional - only included in query if set (handled in optionalFields)
    const query = `
      INSERT INTO activity_execution_traces {
        execution_id: $execution_id,
        variant_id: $variant_id,
        activity_id: $activity_id,
        success: $success,
        status: $status,
        duration_ms: $duration_ms,
        cost_usd: $cost_usd,
        tokens_input: $tokens_input,
        tokens_output: $tokens_output,
        tokens_cache: $tokens_cache,
        org_id: $org_id,
        executed_at: $executed_at,
        created_at: $created_at,
        stored_at: $stored_at${optionalFieldsStr}
      }
    `;

    // Ensure org_id is always a non-null string (schema requirement)
    if (!trace.org_id || typeof trace.org_id !== 'string') {
      logger.info('Fixing org_id for execution trace', {
        original_org_id: trace.org_id,
        org_id_type: typeof trace.org_id
      });
      trace.org_id = 'public';
    }

    logger.debug('Executing trace query', {
      execution_id: trace.execution_id,
      org_id: trace.org_id,
      org_id_type: typeof trace.org_id
    });

    const result = await surrealDB.query(query, trace);

    // Verify INSERT succeeded
    if (!result || result.length === 0) {
      logger.error('INSERT returned no results', {
        execution_id: trace.execution_id,
        query_result: result,
      });
      return c.json({
        success: false,
        error: 'Failed to insert execution trace - no results returned',
        execution_id: trace.execution_id,
      }, 500);
    }

    logger.info('Execution trace stored', {
      execution_id: trace.execution_id,
      variant_id: trace.variant_id,
      success: trace.success,
      task_count: body.execution_trace?.tasks?.length || 0,
      db_result: result[0],
    });

    // F-40 (2026-04-26): backfill composition_chain on any already-inserted
    // children of this trace. Handles minibob's L1/L2 meta-trace write-order
    // race where children land before parent. Single best-effort UPDATE — we
    // never fail the just-succeeded insert on a backfill error.
    await backfillChildCompositionChains(
      trace.execution_id,
      resolvedCompositionChain,
    );

    // Emit fine-grained WebSocket events for real-time execution visualization
    if (body.execution_trace?.tasks && Array.isArray(body.execution_trace.tasks)) {
      const { broadcaster } = await import('../websocket/broadcaster');

      for (let taskIndex = 0; taskIndex < body.execution_trace.tasks.length; taskIndex++) {
        const task = body.execution_trace.tasks[taskIndex];
        const taskId = task.id || task.taskId || `task-${taskIndex}`;

        // Emit task.started event
        broadcaster.emit({
          type: 'task.started',
          timestamp: new Date().toISOString(),
          data: {
            execution_id: trace.execution_id,
            task_id: taskId,
            task_index: taskIndex,
            description: task.description || '',
            started_at: new Date().toISOString(),
          },
        });

        // Emit tool.call events for each tool call in the task
        if (task.toolCalls && Array.isArray(task.toolCalls)) {
          for (const toolCall of task.toolCalls) {
            broadcaster.emit({
              type: 'tool.call',
              timestamp: new Date().toISOString(),
              data: {
                execution_id: trace.execution_id,
                task_id: taskId,
                tool_name: toolCall.name || 'unknown',
                resolver_tier: toolCall.resolver_tier || 'llm',
                latency_ms: toolCall.duration_ms || 0,
                cost_usd: toolCall.cost_usd || 0,
                timestamp: new Date().toISOString(),
              },
            });
          }
        }

        // Emit task.completed event. Per-task impulse arrays are derived
        // from the same task object that `normalizePersistedTask` consumes
        // (via the shared `extractTaskImpulseIds` helper) so the broadcast
        // and persisted shape are perfectly symmetric. Always emit arrays
        // (possibly empty) — never undefined — so consumers can
        // unconditionally call .length / iterate.
        const taskSuccess = task.result?.status === 'success';
        const { input_impulse_ids, output_impulse_ids } = extractTaskImpulseIds(task);
        broadcaster.emit({
          type: 'task.completed',
          timestamp: new Date().toISOString(),
          data: {
            execution_id: trace.execution_id,
            task_id: taskId,
            task_index: taskIndex,
            success: taskSuccess,
            duration_ms: task.duration || task.duration_ms || 0,
            completed_at: new Date().toISOString(),
            error: taskSuccess ? undefined : (task.result?.error || task.error),
            input_impulse_ids,
            output_impulse_ids,
          },
        });
      }

      // Emit impulse.resolved events — one per impulse_resolutions[] entry.
      // F-9 resolution (2026-04-26): formalises the broadcaster contract so
      // workbench's `routeValidationResultImpulse` no longer has to defend
      // against an undocumented event body. Canonical fields ride flat;
      // `body` is optional (sourced from a matching output_impulses[] entry
      // when minibob included one — typically validation_result shapes).
      // See `src/websocket/types.ts` (ImpulseResolvedMessage) and
      // `docs/API_PHASE1_ENDPOINTS.md` for the formal contract.
      const impulseResolutions = (trace as any).impulse_resolutions;
      if (Array.isArray(impulseResolutions) && impulseResolutions.length > 0) {
        // Build a lookup of output_impulses by impulse_id (when minibob includes it)
        // so we can attach resolved-impulse content to the matching event.
        const outputImpulses = trace.output_impulses;
        const bodyByImpulseId = new Map<string, unknown>();
        if (Array.isArray(outputImpulses)) {
          for (const oi of outputImpulses) {
            if (!oi || typeof oi !== 'object') continue;
            const impulseId = (oi as any).impulse_id ?? (oi as any).id;
            const body = (oi as any).body ?? (oi as any).content;
            if (typeof impulseId === 'string' && impulseId.length > 0 && body !== undefined) {
              bodyByImpulseId.set(impulseId, body);
            }
          }
        }

        // Map from impulse_id → owning task_id by scanning per-task output arrays.
        // Falls back to undefined when the resolution isn't task-scoped.
        const taskIdByImpulseId = new Map<string, string>();
        const tasks = body.execution_trace?.tasks;
        if (Array.isArray(tasks)) {
          for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            const tId = t?.id || t?.taskId || `task-${i}`;
            const { output_impulse_ids: outIds, input_impulse_ids: inIds } =
              extractTaskImpulseIds(t);
            for (const id of [...outIds, ...inIds]) {
              if (!taskIdByImpulseId.has(id)) taskIdByImpulseId.set(id, tId);
            }
          }
        }

        for (const r of impulseResolutions) {
          if (!r || typeof r !== 'object') continue;
          const impulseId: string | undefined =
            typeof (r as any).impulse_id === 'string' ? (r as any).impulse_id : undefined;
          const resolverId: string | undefined =
            typeof (r as any).resolver_id === 'string' ? (r as any).resolver_id : undefined;
          if (!impulseId || !resolverId) continue;

          const resolverTierRaw = (r as any).resolver_tier;
          const resolverTier: 'deterministic' | 'pattern' | 'llm' =
            resolverTierRaw === 'deterministic' || resolverTierRaw === 'pattern' || resolverTierRaw === 'llm'
              ? resolverTierRaw
              : 'llm';
          const vesselId: string =
            typeof (r as any).vessel_id === 'string' ? (r as any).vessel_id : (trace.vessel_id ?? 'unknown');
          const latencyMs: number =
            typeof (r as any).latency_ms === 'number' ? (r as any).latency_ms : 0;
          const costUsd: number =
            typeof (r as any).cost_usd === 'number' ? (r as any).cost_usd : 0;

          // Derive shape from the matching output_impulses entry when present.
          let shape: string | undefined;
          if (Array.isArray(outputImpulses)) {
            for (const oi of outputImpulses) {
              if (!oi || typeof oi !== 'object') continue;
              const oiId = (oi as any).impulse_id ?? (oi as any).id;
              if (oiId === impulseId && typeof (oi as any).shape === 'string') {
                shape = (oi as any).shape;
                break;
              }
            }
          }

          const resolvedBody = bodyByImpulseId.get(impulseId);
          const owningTaskId = taskIdByImpulseId.get(impulseId);

          // Canonical flat payload — see ImpulseResolvedMessage in
          // src/websocket/types.ts for the formal contract.
          const data: Record<string, unknown> = {
            execution_id: trace.execution_id,
            impulse_id: impulseId,
            resolver_id: resolverId,
            resolver_tier: resolverTier,
            vessel_id: vesselId,
            latency_ms: latencyMs,
            cost_usd: costUsd,
            timestamp: new Date().toISOString(),
          };
          if (owningTaskId) data.task_id = owningTaskId;
          if (shape) data.shape = shape;

          // Include body for all shapes with 50 KB size guard
          if (resolvedBody !== undefined) {
            try {
              const serialized = JSON.stringify(resolvedBody);
              data.body = serialized.length > 50_000
                ? { truncated: true, summary: (resolvedBody as Record<string, unknown>)?.summary ?? null }
                : resolvedBody;
            } catch {
              // Non-serializable body — omit
            }
          }

          broadcaster.emit({
            type: 'impulse.resolved',
            timestamp: new Date().toISOString(),
            data,
          });
        }
      }
    }

    // DUAL-WRITE: Also insert into new paradigm execution table (schema-paradigm-alignment)
    // v_activity_score view computes Thompson Sampling from execution table automatically
    // P4.1: Feature flag controlled
    if (isDualWriteEnabled()) {
      try {
        // Use new fields from MiniBob (P3.1) or fallback to legacy extraction
      const inputImpulses = body.input_impulses || trace.impulses_used || [];
      // Paradigm table expects array<string> for output_impulses (impulse IDs)
      // Convert full impulse objects to shape strings for compatibility
      const rawOutputImpulses = body.output_impulses || body.execution_trace?.impulsesCreated || [];
      const outputImpulses: string[] = rawOutputImpulses.map((imp: any) =>
        typeof imp === 'string' ? imp : (imp?.shape || 'unknown')
      );

      const paradigmExecution: Partial<ParadigmExecution> = {
        id: trace.execution_id,
        activity_id: trace.variant_id,
        input_impulses: inputImpulses,
        output_impulses: outputImpulses,
        success: trace.success,
        error: trace.error_message ? {
          message: trace.error_message,
          type: trace.error_type,
          task_id: trace.failed_task_id,
        } : undefined,
        duration_ms: trace.duration_ms,
        cost_usd: trace.cost_usd,
        tokens_in: trace.tokens_input,
        tokens_out: trace.tokens_output,
        parent_execution_id: body.parent_execution_id,
        // F-37: prefer the denormalized chain (computed above) so the
        // paradigm dual-write also lands with a populated chain.
        composition_chain: resolvedCompositionChain.length > 0
          ? resolvedCompositionChain
          : undefined,
        trace: {
          tasks: trace.tasks,
          state_snapshot: trace.state_snapshot,
        },
        org_id: typeof trace.org_id === 'string' ? trace.org_id : undefined,
        project_id: typeof trace.project_id === 'string' ? trace.project_id : undefined,
        vessel_id: body.vessel_id || body.pod_name,
        vessel_version: body.vessel_version,
      };

      const paradigmResult = await insertExecution(paradigmExecution, jwtAuth?.jwtToken);
      if (paradigmResult) {
        logger.info('[paradigm] Execution trace also written to execution table', {
          id: trace.execution_id,
          activity_id: trace.variant_id,
          path: 'dual-write',
        });
      }
      } catch (paradigmError) {
        // Don't fail the request if paradigm write fails - legacy write succeeded
        logger.warn('[paradigm] Dual-write to execution table failed (non-blocking)', {
          execution_id: trace.execution_id,
          error: paradigmError instanceof Error ? paradigmError.message : String(paradigmError),
        });
      }
    } // end isDualWriteEnabled()

    // ========================================================================
    // FIX 2: Update Thompson Sampling scores in activity table
    // Enhanced with shape match scoring for quality-aware learning
    // Enables real-time learning loop: execute → update scores → recommend
    // ========================================================================
    try {
      // Fetch activity template to get declared output_shapes
      // Try both id and name matching since variant_id may be either format
      // Use record::id(id) to extract the ID part from full record ID for matching
      // e.g., activity_template:`add-feature-complete` -> 'add-feature-complete'
      const activityQuery = `
        SELECT output_shapes FROM activity_template
        WHERE record::id(id) = $activity_id OR name = $activity_id
        LIMIT 1
      `;
      const activityResult = await surrealDB.query(activityQuery, {
        activity_id: trace.variant_id,
      });

      // Extract actual output shapes from execution
      const actualShapes = extractOutputShapes({
        output_impulses: trace.output_impulses,
        output_impulse_shapes: trace.output_impulse_shapes,
      });

      // Compute shape match score and weighted success
      let shapeMatchMetadata: ShapeMatchMetadata | null = null;
      let alphaDelta = trace.success ? 1 : 0;
      let betaDelta = trace.success ? 0 : 1;

      if (activityResult && activityResult.length > 0 && activityResult[0]?.output_shapes) {
        const declaredShapes: string[] = activityResult[0].output_shapes;

        // Validate shapes and compute match score
        shapeMatchMetadata = validateOutputShapes(declaredShapes, actualShapes, trace.success);

        // Compute Thompson Sampling updates with shape match weighting
        const tsUpdates = computeThompsonSamplingUpdates(trace.success, shapeMatchMetadata.shapeMatchScore);
        alphaDelta = tsUpdates.alphaDelta;
        betaDelta = tsUpdates.betaDelta;

        logger.info('[Thompson Sampling] Using shape-weighted updates', {
          execution_id: trace.execution_id,
          activity_id: trace.variant_id,
          executionSuccess: trace.success,
          shapeMatchScore: shapeMatchMetadata.shapeMatchScore,
          weightedScore: tsUpdates.weightedScore,
          alphaDelta,
          betaDelta,
        });

        // Store shape match metadata in trace for analysis
        if (!trace.metadata) {
          trace.metadata = {};
        }
        (trace.metadata as any).shape_match = shapeMatchMetadata;
      } else {
        logger.debug('[Thompson Sampling] No output_shapes in template, using binary success', {
          execution_id: trace.execution_id,
          activity_id: trace.variant_id,
        });
      }

      // Use record::id(id) to extract the ID part from full record ID for matching
      // e.g., activity_template:`add-feature-complete` -> 'add-feature-complete'
      //
      // Match org_id against both the plain string ("metabob") and the record-id-style
      // form ("organizations:metabob") because templates registered through different
      // code paths land with different formats. Without this dual match, a failed
      // trace whose body.org_id arrives plain but whose template was stored with a
      // prefixed org_id silently updates 0 rows — and beta never increments.
      const updateQuery = `
        UPDATE activity_template
        SET
          thompson_alpha = (thompson_alpha ?? 1) + $alpha_delta,
          thompson_beta = (thompson_beta ?? 1) + $beta_delta,
          total_executions = (total_executions ?? 0) + 1,
          successful_executions = (successful_executions ?? 0) + $success_delta,
          failed_executions = (failed_executions ?? 0) + $failure_delta,
          last_executed_at = time::now()
        WHERE (record::id(id) = $activity_id OR name = $activity_id)
          AND (org_id = $org_id OR org_id = $org_id_alt)
        RETURN {
          id,
          thompson_alpha,
          thompson_beta,
          total_executions
        }
      `;

      // Validate org_id is set (defined at line 737 with session fallback)
      if (!traceOrgId || traceOrgId === 'undefined') {
        logger.error('[learning] Cannot update Thompson Sampling - org_id is undefined', {
          execution_id: trace.execution_id,
          variant_id: trace.variant_id,
          trace_org_id: trace.org_id,
          jwt_org_id: jwtAuth?.orgId,
        });
        throw new Error('org_id is required for Thompson Sampling updates');
      }

      // Resolve the dispatched template id(s).
      //
      // Failed traces emitted from minibob's meta-trace path (mcp.ts
      // `emitMetaTrace`) carry a synthetic variant_id like `_goal_resolve` or
      // `_activity_execute`, with the real dispatched template surfaced in
      // metadata.template_id (e.g. `goal-processing-activity-driven`). Without
      // surfacing that, a goal-level abort on a recommended template never
      // increments beta — the system learns from successes only. We update
      // BOTH the variant_id row and the metadata.template_id row when they
      // differ, so both the synthetic meta-trace bucket and the real
      // dispatched template see the failure. See resolveTemplateIdsForUpdate.
      const metadataTemplateId =
        body.metadata && typeof body.metadata.template_id === 'string'
          ? body.metadata.template_id
          : undefined;

      const candidateIds = resolveTemplateIdsForUpdate({
        variantId: trace.variant_id,
        metadata: body.metadata,
      });

      // Pre-compute alt org_id form once per loop. Mirrors getActivityScores
      // (paradigm.ts:412): we accept either format because templates landed
      // with both at different points in history.
      const orgIdAlt = traceOrgId.startsWith('organizations:')
        ? traceOrgId.replace(/^organizations:/, '')
        : `organizations:${traceOrgId}`;

      let primaryUpdateMatched = false;

      for (const candidateId of candidateIds) {
        const updateParams = {
          activity_id: candidateId,
          org_id: traceOrgId,
          org_id_alt: orgIdAlt,
          alpha_delta: alphaDelta,
          beta_delta: betaDelta,
          success_delta: trace.success ? 1 : 0,
          failure_delta: trace.success ? 0 : 1,
        };

        // Use JWT auth if available for RBAC enforcement
        const updateResult = jwtAuth?.jwtToken
          ? await queryWithAuth(jwtAuth.jwtToken, updateQuery, updateParams)
          : await surrealDB.query(updateQuery, updateParams);

        if (updateResult && updateResult.length > 0) {
          if (candidateId === trace.variant_id) {
            primaryUpdateMatched = true;
          }
          logger.info('[learning] Thompson Sampling scores updated', {
            execution_id: trace.execution_id,
            activity_id: candidateId,
            via_metadata_template_id: candidateId !== trace.variant_id,
            success: trace.success,
            new_alpha: updateResult[0].thompson_alpha,
            new_beta: updateResult[0].thompson_beta,
            total_executions: updateResult[0].total_executions,
          });

          // FIX 3: Invalidate Redis cache to ensure fresh scores in next recommendation
          try {
            const { RedisClient } = await import('../db/redis');
            const redis = RedisClient.getInstance();

            // Invalidate both the specific template cache and the template list cache
            const CACHE_KEY_PREFIX = 'activity:template:';
            const CACHE_LIST_KEY = 'activity:templates:list';

            await redis.del(`${CACHE_KEY_PREFIX}${candidateId}`);
            await redis.del(CACHE_LIST_KEY);

            logger.debug('[learning] Redis cache invalidated after score update', {
              activity_id: candidateId,
            });
          } catch (cacheError) {
            // Non-critical - scores will eventually propagate when cache expires
            logger.warn('[learning] Failed to invalidate Redis cache (non-blocking)', {
              execution_id: trace.execution_id,
              error: cacheError instanceof Error ? cacheError.message : String(cacheError),
            });
          }
        } else {
          logger.warn('[learning] Thompson Sampling score update returned no results', {
            execution_id: trace.execution_id,
            activity_id: candidateId,
            query_params: updateParams,
          });
        }
      }

      // Surface the case where the primary variant_id matched nothing but a
      // metadata.template_id fanout DID — useful for observing meta-trace
      // failures that propagate to a real dispatched template.
      if (!primaryUpdateMatched && candidateIds.length > 1) {
        logger.info('[learning] Primary variant_id had no matching template; metadata.template_id used as fallback', {
          execution_id: trace.execution_id,
          variant_id: trace.variant_id,
          metadata_template_id: metadataTemplateId,
        });
      }
    } catch (scoreUpdateError) {
      // Don't fail the request if score update fails - trace is already stored
      logger.error('[learning] Failed to update Thompson Sampling scores (non-blocking)', {
        execution_id: trace.execution_id,
        activity_id: trace.variant_id,
        error: scoreUpdateError instanceof Error ? scoreUpdateError.message : String(scoreUpdateError),
      });
    }

    // Context-bucketed Thompson update (Spec 3)
    // Derive context_bucket from metadata if present, or re-derive from input_impulse_shapes.
    const rawContextBucket: unknown =
      body.metadata?.context_bucket ??
      body.selection_metadata?.context_bucket;

    const isValidBucket = (v: unknown): v is string =>
      typeof v === 'string' && /^[0-9a-f]{8}$/.test(v);

    if (isValidBucket(rawContextBucket)) {
      try {
        const ctxAlphaDelta = trace.success ? 1 : 0;
        const ctxBetaDelta  = trace.success ? 0 : 1;

        await surrealDB.query(`
          LET $existing = (SELECT * FROM context_thompson_scores
            WHERE org_id = $org_id AND template_id = $template_id AND context_bucket = $bucket
            LIMIT 1);
          IF array::len($existing) > 0 THEN
            UPDATE context_thompson_scores
            SET alpha = alpha + $alpha_delta,
                beta  = beta  + $beta_delta,
                n_observations = n_observations + 1,
                last_updated_at = time::now()
            WHERE org_id = $org_id AND template_id = $template_id AND context_bucket = $bucket
          ELSE
            CREATE context_thompson_scores CONTENT {
              org_id: $org_id,
              template_id: $template_id,
              context_bucket: $bucket,
              alpha: 1.0 + $alpha_delta,
              beta:  1.0 + $beta_delta,
              n_observations: 1,
              last_updated_at: time::now(),
              created_at: time::now()
            }
          END
        `, {
          org_id: traceOrgId,
          template_id: trace.variant_id,
          bucket: rawContextBucket,
          alpha_delta: ctxAlphaDelta,
          beta_delta: ctxBetaDelta,
        });

        logger.debug('[learning] context_thompson_scores updated', {
          execution_id: trace.execution_id,
          context_bucket: rawContextBucket,
          success: trace.success,
        });
      } catch (ctxErr: any) {
        logger.warn('[learning] context_thompson_scores update failed (non-blocking)', {
          execution_id: trace.execution_id,
          error: ctxErr.message,
        });
      }
    } else if (
      !rawContextBucket &&
      body.input_impulse_shapes &&
      Array.isArray(body.input_impulse_shapes) &&
      body.input_impulse_shapes.length > 0
    ) {
      // Re-derive bucket when caller didn't embed it but shapes are known
      try {
        const { computeContextBucket } = await import('../utils/session-context');
        const taskDesc = body.metadata?.task_description ?? body.execution_trace?.goalContext?.goal ?? '';
        const rederived = computeContextBucket(taskDesc, body.input_impulse_shapes, traceOrgId);
        const rdAlphaDelta = trace.success ? 1 : 0;
        const rdBetaDelta  = trace.success ? 0 : 1;

        await surrealDB.query(`
          LET $existing = (SELECT * FROM context_thompson_scores
            WHERE org_id = $org_id AND template_id = $template_id AND context_bucket = $bucket
            LIMIT 1);
          IF array::len($existing) > 0 THEN
            UPDATE context_thompson_scores
            SET alpha = alpha + $alpha_delta,
                beta  = beta  + $beta_delta,
                n_observations = n_observations + 1,
                last_updated_at = time::now()
            WHERE org_id = $org_id AND template_id = $template_id AND context_bucket = $bucket
          ELSE
            CREATE context_thompson_scores CONTENT {
              org_id: $org_id,
              template_id: $template_id,
              context_bucket: $bucket,
              alpha: 1.0 + $alpha_delta,
              beta:  1.0 + $beta_delta,
              n_observations: 1,
              last_updated_at: time::now(),
              created_at: time::now()
            }
          END
        `, {
          org_id: traceOrgId,
          template_id: trace.variant_id,
          bucket: rederived,
          alpha_delta: rdAlphaDelta,
          beta_delta: rdBetaDelta,
        });
      } catch (ctxRederiveErr: any) {
        logger.warn('[learning] context_thompson_scores re-derive update failed (non-blocking)', {
          execution_id: trace.execution_id,
          error: ctxRederiveErr.message,
        });
      }
    }

    // DUAL-WRITE: Update variant_performance_metrics for dashboard compatibility
    // Dashboard queries this table for Thompson Sampling scores, so we need to maintain it
    // in addition to the activity_template updates above.
    //
    // Same metadata.template_id fanout as the activity_template update above:
    // when a meta-trace failure (variant_id `_goal_resolve` / `_activity_execute`)
    // names a real dispatched template in metadata.template_id, the dispatched
    // template's metrics row also needs the failure recorded — otherwise its
    // beta never moves.
    try {
      const variantMetricsUpsert = `
        INSERT INTO variant_performance_metrics {
          variant_id: $variant_id,
          activity_id: $variant_id,
          org_id: $org_id,
          total_executions: 1,
          successful_executions: $success_delta,
          failed_executions: $failure_delta,
          success_rate: $success_delta,
          avg_duration_ms: $duration_ms,
          avg_cost_usd: $cost,
          thompson_alpha: $success_delta + 1,
          thompson_beta: $failure_delta + 1,
          total_selections: 0,
          last_executed_at: time::now(),
          created_at: time::now(),
          updated_at: time::now()
        }
        ON DUPLICATE KEY UPDATE
          total_executions += 1,
          successful_executions += $input.successful_executions,
          failed_executions += $input.failed_executions,
          success_rate = successful_executions / total_executions,
          avg_duration_ms = ((avg_duration_ms * (total_executions - 1)) + $input.avg_duration_ms) / total_executions,
          avg_cost_usd = ((avg_cost_usd * (total_executions - 1)) + $input.avg_cost_usd) / total_executions,
          thompson_alpha = successful_executions + 1,
          thompson_beta = failed_executions + 1,
          last_executed_at = time::now(),
          updated_at = time::now()
        RETURN AFTER;
      `;

      const metricsCandidateIds = resolveTemplateIdsForUpdate({
        variantId: trace.variant_id,
        metadata: body.metadata,
      });

      for (const candidateId of metricsCandidateIds) {
        const variantMetricsParams = {
          variant_id: candidateId,
          org_id: traceOrgId,
          success_delta: trace.success ? 1 : 0,
          failure_delta: trace.success ? 0 : 1,
          duration_ms: trace.duration_ms || 0,
          cost: trace.cost_usd || 0,
        };

        const variantMetricsResult = jwtAuth?.jwtToken
          ? await queryWithAuth(jwtAuth.jwtToken, variantMetricsUpsert, variantMetricsParams)
          : await surrealDB.query(variantMetricsUpsert, variantMetricsParams);

        if (variantMetricsResult && variantMetricsResult.length > 0) {
          const updatedMetrics = variantMetricsResult[0];
          logger.info('[learning] Variant performance metrics updated (dual-write)', {
            execution_id: trace.execution_id,
            variant_id: candidateId,
            via_metadata_template_id: candidateId !== trace.variant_id,
            total_executions: updatedMetrics.total_executions,
            success_rate: updatedMetrics.success_rate,
            thompson_alpha: updatedMetrics.thompson_alpha,
            thompson_beta: updatedMetrics.thompson_beta,
          });
        } else {
          logger.warn('[learning] Variant metrics UPSERT returned no results', {
            execution_id: trace.execution_id,
            variant_id: candidateId,
            query_params: variantMetricsParams,
          });
        }
      }
    } catch (variantMetricsError) {
      // Don't fail the request if variant metrics update fails - trace is already stored
      logger.error('[learning] Failed to update variant_performance_metrics (non-blocking)', {
        execution_id: trace.execution_id,
        variant_id: trace.variant_id,
        error: variantMetricsError instanceof Error ? variantMetricsError.message : String(variantMetricsError),
      });
    }

    // Update impulse shape activity scores for shape-conditioned Thompson Sampling
    // Extract input shapes from the execution trace
    const inputShapes: string[] = body.input_impulse_shapes
      || trace.input_impulse_shapes
      || (trace.metadata as any)?.inputShapes
      || (trace.metadata as any)?.input_shapes
      || [];

    if (inputShapes.length > 0 && trace.variant_id && traceOrgId) {
      // Fire and forget - don't block the response
      updateShapeActivityScores(trace.variant_id, inputShapes, trace.success, traceOrgId)
        .catch(err => logger.warn('[paradigm] Shape score update failed (non-blocking)', {
          execution_id: trace.execution_id,
          error: err instanceof Error ? err.message : String(err),
        }));
    }

    // M4.2: Forward to learning service (async/non-blocking)
    // Extract modified files from execution trace
    const filesModified: string[] = [];

    // From state_snapshot output_state
    if (trace.state_snapshot?.output_state?.filesModified) {
      filesModified.push(...trace.state_snapshot.output_state.filesModified);
    }
    if (trace.state_snapshot?.output_state?.filesCreated) {
      filesModified.push(...trace.state_snapshot.output_state.filesCreated);
    }

    // From execution_trace.filesModified (MiniBob format)
    if (body.execution_trace?.filesModified) {
      filesModified.push(...body.execution_trace.filesModified);
    }

    // From component_changes (if available)
    if (trace.component_changes) {
      const componentFiles = trace.component_changes
        .filter((cc: any) => cc.change_type !== 'deleted')
        .map((cc: any) => cc.file_path);
      filesModified.push(...componentFiles);
    }

    // Deduplicate
    const uniqueFiles = [...new Set(filesModified)];

    // Forward to learning (non-blocking, don't await)
    if (uniqueFiles.length >= 2) {
      const sessionId = c.req.header('X-Session-ID') || session.session_id || 'unknown';
      forwardToLearning(sessionId, uniqueFiles, traceProjectId);
    }

    return c.json({
      success: true,
      execution_id: trace.execution_id,
      stored: true,
      trace: result[0],
    });

  } catch (error) {
    logger.error('Failed to store execution trace', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return c.json({
      error: 'Failed to store execution trace',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/selection-outcomes
 *
 * Query selection-to-execution correlation data (Task 15)
 * Joins thompson_selection_log with activity_execution_traces via correlation_id
 *
 * Query params:
 * - activity_id: Filter by activity ID
 * - attribution_type: Filter by attribution type ('exact' | 'pending')
 * - success: Filter by execution success (true/false)
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 * - start_date: Filter selections after this ISO timestamp
 * - end_date: Filter selections before this ISO timestamp
 */
app.get('/selection-outcomes', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Parse query params
    const activityId = c.req.query('activity_id');
    const attributionType = c.req.query('attribution_type');
    const successParam = c.req.query('success');
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);
    const startDate = c.req.query('start_date');
    const endDate = c.req.query('end_date');

    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build selection query conditions
    const selectionConditions: string[] = [];
    const params: Record<string, any> = { limit, offset };

    if (activityId) {
      selectionConditions.push('sel.activity_id = $activity_id');
      params.activity_id = activityId;
    }

    if (startDate) {
      selectionConditions.push('sel.selected_at >= $start_date');
      params.start_date = startDate;
    }

    if (endDate) {
      selectionConditions.push('sel.selected_at <= $end_date');
      params.end_date = endDate;
    }

    const selectionWhereClause = selectionConditions.length > 0
      ? `WHERE ${selectionConditions.join(' AND ')}`
      : '';

    // Step 1: Get selections from thompson_selection_log
    const selectionsQuery = `
      SELECT
        correlation_id,
        activity_id,
        thompson_sample AS selection_probability,
        alpha AS alpha_at_selection,
        beta AS beta_at_selection,
        selection_method,
        candidates_count,
        selected_at,
        org_id,
        <float> alpha / (<float> alpha + <float> beta) AS expected_success_rate
      FROM thompson_selection_log AS sel
      ${selectionWhereClause}
      ORDER BY sel.selected_at DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching selection outcomes', { selectionWhereClause, params });

    let selections: any[];
    // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      selections = await queryWithAuth(jwtAuth.jwtToken, selectionsQuery, params);
    } else {
      selections = await surrealDB.query(selectionsQuery, params);
    }

    // Step 2: Fetch execution data for correlation_ids
    const correlationIds = (selections || [])
      .filter((s: any) => s.correlation_id)
      .map((s: any) => s.correlation_id);

    let executionsByCorrelation = new Map<string, any>();

    if (correlationIds.length > 0) {
      const executionsQuery = `
        SELECT
          correlation_id,
          execution_id,
          success,
          duration_ms,
          cost_usd,
          tokens_input,
          tokens_output,
          error_type,
          executed_at
        FROM activity_execution_traces
        WHERE correlation_id IN $correlation_ids
      `;

      let executions: any[];
      // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
        executions = await queryWithAuth(jwtAuth.jwtToken, executionsQuery, { correlation_ids: correlationIds });
      } else {
        executions = await surrealDB.query(executionsQuery, { correlation_ids: correlationIds });
      }

      for (const exec of executions || []) {
        executionsByCorrelation.set(exec.correlation_id, exec);
      }
    }

    // Step 3: Merge selection and execution data
    let outcomes = (selections || []).map((sel: any) => {
      const exec = executionsByCorrelation.get(sel.correlation_id);
      const hasExecution = exec !== undefined;

      return {
        // Selection data
        correlation_id: sel.correlation_id,
        activity_id: sel.activity_id,
        selection_probability: sel.selection_probability,
        alpha_at_selection: sel.alpha_at_selection,
        beta_at_selection: sel.beta_at_selection,
        selection_method: sel.selection_method,
        candidates_count: sel.candidates_count,
        selected_at: sel.selected_at,
        org_id: sel.org_id,
        expected_success_rate: sel.expected_success_rate,

        // Execution data (may be null if not yet executed)
        execution_id: exec?.execution_id || null,
        execution_success: exec?.success ?? null,
        execution_duration_ms: exec?.duration_ms || null,
        execution_cost_usd: exec?.cost_usd || null,
        execution_tokens_in: exec?.tokens_input || null,
        execution_tokens_out: exec?.tokens_output || null,
        execution_error_type: exec?.error_type || null,
        executed_at: exec?.executed_at || null,

        // Computed fields
        attribution_type: hasExecution ? 'exact' : 'pending',
        selection_to_execution_delay: hasExecution && exec.executed_at && sel.selected_at
          ? new Date(exec.executed_at).getTime() - new Date(sel.selected_at).getTime()
          : null,
      };
    });

    // Step 4: Apply post-filters (attribution_type, success)
    if (attributionType) {
      outcomes = outcomes.filter((o: any) => o.attribution_type === attributionType);
    }

    if (successParam !== undefined) {
      const success = successParam === 'true';
      outcomes = outcomes.filter((o: any) => o.execution_success === success);
    }

    // Get total count for pagination
    const countQuery = `
      SELECT count() as total FROM thompson_selection_log AS sel
      ${selectionWhereClause}
      GROUP ALL
    `;

    let countResult: { total: number }[];
    // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      countResult = await queryWithAuth(jwtAuth.jwtToken, countQuery, params);
    } else {
      countResult = await surrealDB.query(countQuery, params);
    }

    const total = countResult?.[0]?.total || 0;

    logger.info('Selection outcomes fetched', {
      count: outcomes?.length || 0,
      total,
      withExecutions: executionsByCorrelation.size,
    });

    return c.json({
      outcomes: outcomes || [],
      total,
      limit,
      offset,
    });

  } catch (error) {
    logger.error('Failed to fetch selection outcomes', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to fetch selection outcomes',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/selection-calibration
 *
 * Get Thompson Sampling calibration metrics per activity (Task 15)
 * Computes calibration error: |predicted_success_rate - actual_success_rate|
 *
 * Query params:
 * - activity_id: Filter by activity ID
 * - min_executions: Filter activities with at least N executions (default: 1)
 * - limit: Max records to return (default: 50, max: 500)
 * - offset: Pagination offset (default: 0)
 */
app.get('/selection-calibration', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Parse query params
    const activityId = c.req.query('activity_id');
    const minExecutions = parseInt(c.req.query('min_executions') || '1', 10);
    const limitParam = parseInt(c.req.query('limit') || '50', 10);
    const offsetParam = parseInt(c.req.query('offset') || '0', 10);

    const limit = Math.min(Math.max(limitParam, 1), 500);
    const offset = Math.max(offsetParam, 0);

    // Build activity filter
    const activityFilter = activityId ? 'AND sel.activity_id = $activity_id' : '';
    const params: Record<string, any> = { limit, offset, min_executions: minExecutions };
    if (activityId) {
      params.activity_id = activityId;
    }

    // Query: Aggregate selection+execution data per activity
    // This computes calibration metrics at query time
    const query = `
      SELECT
        sel.activity_id AS activity_id,
        sel.org_id AS org_id,
        count(sel.correlation_id) AS total_selections,
        count(exec.execution_id) AS executed_selections,
        count(sel.correlation_id) - count(exec.execution_id) AS pending_selections,
        count(IF exec.success = true THEN 1 ELSE NONE END) AS successful_executions,
        count(IF exec.success = false THEN 1 ELSE NONE END) AS failed_executions,
        math::mean(<float> sel.alpha / (<float> sel.alpha + <float> sel.beta)) AS avg_predicted_success,
        IF count(exec.execution_id) > 0
          THEN <float> count(IF exec.success = true THEN 1 ELSE NONE END) / <float> count(exec.execution_id)
          ELSE NONE
        END AS actual_success_rate,
        math::mean(sel.thompson_sample) AS avg_thompson_sample,
        math::mean(<float> exec.duration_ms) AS avg_duration_ms,
        math::mean(<float> exec.cost_usd) AS avg_cost_usd,
        time::min(sel.selected_at) AS first_selection_at,
        time::max(sel.selected_at) AS last_selection_at,
        time::max(exec.executed_at) AS last_execution_at
      FROM thompson_selection_log AS sel
      LEFT JOIN activity_execution_traces AS exec ON sel.correlation_id = exec.correlation_id
      WHERE 1=1 ${activityFilter}
      GROUP BY sel.activity_id, sel.org_id
      HAVING count(exec.execution_id) >= $min_executions
      ORDER BY count(exec.execution_id) DESC
      LIMIT $limit
      START $offset
    `;

    logger.info('Fetching selection calibration', { activityId, minExecutions, limit, offset });

    let calibrationRaw: any[];

    // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      calibrationRaw = await queryWithAuth(jwtAuth.jwtToken, query, params);
    } else {
      calibrationRaw = await surrealDB.query(query, params);
    }

    // Compute calibration error for each activity
    const calibration = (calibrationRaw || []).map((row: any) => {
      const predicted = row.avg_predicted_success || 0;
      const actual = row.actual_success_rate;
      const calibrationError = actual !== null && actual !== undefined
        ? Math.abs(predicted - actual)
        : null;

      return {
        ...row,
        calibration_error: calibrationError,
      };
    });

    // Sort by calibration error (worst first)
    calibration.sort((a: any, b: any) => {
      if (a.calibration_error === null) return 1;
      if (b.calibration_error === null) return -1;
      return b.calibration_error - a.calibration_error;
    });

    // Get total count
    const countQuery = `
      SELECT count() AS total FROM (
        SELECT sel.activity_id
        FROM thompson_selection_log AS sel
        LEFT JOIN activity_execution_traces AS exec ON sel.correlation_id = exec.correlation_id
        WHERE 1=1 ${activityFilter}
        GROUP BY sel.activity_id
        HAVING count(exec.execution_id) >= $min_executions
      )
      GROUP ALL
    `;

    let countResult: { total: number }[];
    // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      countResult = await queryWithAuth(jwtAuth.jwtToken, countQuery, params);
    } else {
      countResult = await surrealDB.query(countQuery, params);
    }

    const total = countResult?.[0]?.total || 0;

    logger.info('Selection calibration fetched', {
      count: calibration?.length || 0,
      total,
    });

    return c.json({
      calibration: calibration || [],
      total,
      limit,
      offset,
    });

  } catch (error) {
    logger.error('Failed to fetch selection calibration', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to fetch selection calibration',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

/**
 * GET /v2/activities/execution-traces/calibration-summary
 *
 * Get org-level Thompson Sampling calibration health summary (Task 15)
 * Aggregates calibration metrics across all activities
 */
app.get('/calibration-summary', async (c) => {
  try {
    const jwtAuth = getJwtAuthFromContext(c);
    const useJwtAuth = hasJwtAuth(c);

    // Query: Org-level aggregate of selection + execution correlation
    const query = `
      SELECT
        sel.org_id AS org_id,
        count(DISTINCT sel.activity_id) AS total_activities,
        count(sel.correlation_id) AS total_selections,
        count(exec.execution_id) AS total_executions,
        count(IF exec.success = true THEN 1 ELSE NONE END) AS total_successes,
        count(IF exec.success = false THEN 1 ELSE NONE END) AS total_failures,
        IF count(exec.execution_id) > 0
          THEN <float> count(IF exec.success = true THEN 1 ELSE NONE END) / <float> count(exec.execution_id)
          ELSE NONE
        END AS org_success_rate,
        math::mean(<float> sel.alpha / (<float> sel.alpha + <float> sel.beta)) AS avg_predicted_success,
        math::sum(<float> exec.cost_usd) AS total_cost_usd,
        time::min(sel.selected_at) AS first_selection_at,
        time::max(sel.selected_at) AS last_selection_at
      FROM thompson_selection_log AS sel
      LEFT JOIN activity_execution_traces AS exec ON sel.correlation_id = exec.correlation_id
      GROUP BY sel.org_id
      LIMIT 1
    `;

    logger.info('Fetching calibration summary');

    let summaryRaw: any[];

    // F-36: API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      summaryRaw = await queryWithAuth(jwtAuth.jwtToken, query, {});
    } else {
      summaryRaw = await surrealDB.query(query, {});
    }

    if (!summaryRaw || summaryRaw.length === 0) {
      return c.json({
        summary: null,
        message: 'No calibration data available yet',
      });
    }

    const row = summaryRaw[0];
    const predicted = row.avg_predicted_success || 0;
    const actual = row.org_success_rate;
    const avgCalibrationError = actual !== null && actual !== undefined
      ? Math.abs(predicted - actual)
      : null;

    const summary = {
      ...row,
      avg_calibration_error: avgCalibrationError,
      // Pending selections (not yet executed)
      pending_selections: (row.total_selections || 0) - (row.total_executions || 0),
      // Execution rate
      execution_rate: row.total_selections > 0
        ? row.total_executions / row.total_selections
        : null,
    };

    logger.info('Calibration summary fetched', { summary });

    return c.json({
      summary,
    });

  } catch (error) {
    logger.error('Failed to fetch calibration summary', {
      error: error instanceof Error ? error.message : String(error),
    });

    return c.json({
      error: 'Failed to fetch calibration summary',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
});

export default app;
