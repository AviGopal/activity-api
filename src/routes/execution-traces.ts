/**
 * Execution Traces Routes
 *
 * Provides endpoints for retrieving execution traces with full state information
 * Used by dashboard to display execution history timeline
 */

import { validRepairSignature, priorRepairDelta } from '../lib/repair-signature-consume';
import { Hono } from 'hono';
import { surrealDB, queryWithAuth } from '../db/surreal';
import { logger } from '../utils/logger';
import type { SessionData } from '../models/schemas';
import { getJwtAuthFromContext, hasJwtAuth } from '../middleware/jwtAuth';
import { config } from '../config';
import { insertExecution, isDualWriteEnabled, normalizeActivityId, updateShapeActivityScores, type ParadigmExecution } from '../db/paradigm';
// Phase B2: dual-tenant helpers (defined in routes/activities.ts in B1).
// Reuse so we don't duplicate the `accountIdScopedWhere()` fragment or the
// `accountIdRecordRef()` record-id formatter across route modules.
import { accountIdScopedWhere, variantMetricsRecordId } from './activities';
import {
  extractOutputShapes,
  validateOutputShapes,
  computeThompsonSamplingUpdates,
  type ShapeMatchMetadata,
} from '../services/thompson-sampling';
import { resolveLearningTrack, type LearningTrack } from '../lib/learning-track';
import { incrementExemplarBurstCounter } from '../services/exemplar-selector';
import { incrementTraceStoreCounter } from '../lib/trace-store-counters';
import { applyOutcomeToPosteriors } from '../lib/posterior-update';
import { classifyReach } from '../lib/reach-classify';
import { updateSuccessorFeatures } from '../lib/successor-features';
import { applyClusterPosterior } from '../lib/cluster-posterior';

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
/**
 * Failure modes that mean the execution did NOT run to completion.
 *
 * Deliberately narrow. `budget_exhausted` is excluded: a walk can legitimately
 * reach its goal and then exceed a budget on the way out, and treating that as
 * unreached would erase real successes — the opposite failure from the one this
 * guards. Only add a type here when "this ran to completion" is false BY
 * DEFINITION of the type.
 */
const NON_COMPLETING_FAILURE_MODES = new Set(['execution_error']);

/**
 * Reconcile a claimed reach verdict against the execution's own failure mode.
 *
 * Task #55, 2026-08-10: `reached: true` was persisted on executions whose trace
 * reported `failure_mode.type = 'execution_error'` and produced zero shapes. The
 * two fields were written side by side and never compared, so the store recorded
 * a self-contradicting row that every downstream reader — reach rate, Thompson
 * credit, the ribosome's extraction filter — then trusted.
 *
 * The execution's testimony wins over the claim: a throw is mechanical, whereas
 * the verdict may come from a grader that never saw it. An undefined verdict
 * stays undefined (ungraded is not a negative), and a `false` claim stays false.
 */
export function reachedVerdict(
  claimed: boolean | undefined,
  failureModeType: string | undefined,
): boolean | undefined {
  if (claimed !== true) return claimed;
  if (failureModeType != null && NON_COMPLETING_FAILURE_MODES.has(failureModeType)) return false;
  return true;
}

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

/**
 * C6: best-effort recovery of the input shape-set for v1 state-space signature
 * derivation. The canonical source is `input_impulse_shapes`, but that field is
 * populated on only ~4% of traces — which starved `context_thompson_scores` of
 * conditional posteriors. This widens coverage by falling back, in priority
 * order, to shape sets already present on the trace:
 *   1. `input_impulse_shapes` (canonical — the decision-time pool)
 *   2. per-task `tasks[].input_impulse_shapes` / `inputShapes` (decision-time, per-task)
 *   3. `output_impulse_shapes` + `output_impulses[].shape` + per-task output shapes
 *      (the produced pool — a proxy when no input pool was recorded)
 * Returns a de-duplicated array; empty when nothing usable is found. Pure /
 * non-throwing; callers wrap the signature compute in try/catch regardless.
 */
export function deriveSignatureShapes(trace: any): string[] {
  const collect = (...arrs: unknown[]): string[] => {
    const out: string[] = [];
    for (const a of arrs) {
      if (Array.isArray(a)) {
        for (const s of a) if (typeof s === 'string' && s.length > 0) out.push(s);
      }
    }
    return out;
  };
  const dedupe = (arr: string[]): string[] => [...new Set(arr)];
  const tasks: any[] = Array.isArray(trace?.tasks) ? trace.tasks : [];

  // 1. canonical input pool
  const directInput = collect(trace?.input_impulse_shapes);
  if (directInput.length > 0) return dedupe(directInput);

  // 2. per-task input shapes
  const taskInput = collect(
    ...tasks.map((t: any) => t?.input_impulse_shapes),
    ...tasks.map((t: any) => t?.inputShapes),
  );
  if (taskInput.length > 0) return dedupe(taskInput);

  // 3. produced pool (output shapes) as a proxy
  const produced = collect(
    trace?.output_impulse_shapes,
    Array.isArray(trace?.output_impulses)
      ? trace.output_impulses.map((o: any) => o?.shape)
      : [],
    ...tasks.map((t: any) => t?.output_impulse_shapes),
    ...tasks.map((t: any) => t?.outputShapes),
  );
  return dedupe(produced);
}

/** Trust-boundary cap on a single task's stored resolved_config, in serialized chars.
 *  Sized to admit real resolver arguments (paths, urls, jq expressions, small bodies)
 *  while refusing a blob that would bloat the FLEXIBLE tasks column — traces are already
 *  under retention pressure from the ceiling valve. */
/** Short-TTL page cache for the trace list. See the cache-read block in the list handler for
 *  why this exists and why the key must carry the tenant. Keyed org-first so a missing org
 *  identity cannot collide with a real one. */
const TRACE_LIST_CACHE_TTL_MS = 10_000;
const TRACE_LIST_CACHE_MAX = 200;
const traceListCache = new Map<string, { body: unknown; expiresAt: number }>();

const RESOLVED_CONFIG_MAX_CHARS = 4000;

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
  consumed_from_task_ids?: string[];
  child_activity_id?: string;
  input_shapes?: string[];
  output_shapes?: string[];
  resolved_config?: Record<string, unknown>;
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
  // Option-B placeholder-provenance (FLEXIBLE tasks column rides these through):
  // which producer tasks this task consumed via {{placeholders}}, and the
  // activity a dispatch task ran. Feeds the composition-edge reconcile's
  // genuine producer->consumer edge derivation.
  if (Array.isArray(task?.consumed_from_task_ids) && task.consumed_from_task_ids.length > 0) {
    out.consumed_from_task_ids = task.consumed_from_task_ids.filter((x: unknown) => typeof x === 'string');
  }
  if (typeof task?.child_activity_id === 'string' && task.child_activity_id.length > 0) {
    out.child_activity_id = task.child_activity_id;
  }
  // Per-task SHAPES (2026-08-13): preserve the shape sequence into the stored task
  // so a composite trace does NOT read ∅ → ∅ back — the ribosome's
  // acquire_trace_signature needs the shape→shape sequence to extract a recipe, and
  // dropping it here made every walk-composite mint synthesize nothing (hub 404).
  // Accept the sink's snake_case or a raw trace's camelCase.
  const _inShapes = Array.isArray(task?.input_shapes) ? task.input_shapes : Array.isArray(task?.inputShapes) ? task.inputShapes : null;
  if (_inShapes) out.input_shapes = _inShapes.filter((x: unknown) => typeof x === 'string');
  const _outShapes = Array.isArray(task?.output_shapes) ? task.output_shapes : Array.isArray(task?.outputShapes) ? task.outputShapes : null;
  if (_outShapes) out.output_shapes = _outShapes.filter((x: unknown) => typeof x === 'string');

  // Per-task RESOLVED CONFIG (2026-08-17): the arguments the resolver was actually
  // called with, post-interpolation. This is the same defect class as the shapes fix
  // directly above — a per-task field dropped by this whitelist starves the ribosome —
  // but with a sharper consequence: without it every extracted composition carries
  // config:{} and CANNOT BE REPLAYED. Measured: 98 of 98 tasks across the 26 stored
  // learned compositions had no arguments, and replaying them produced
  // "paths[0] … got undefined" (fs_read, 18x), "invalid URL: undefined" (http_fetch, 8x)
  // and "undefined is not an object (path.split)" (json_path_extract). Those
  // compositions completed 6 of 61 runs.
  //
  // The producer (ias-executor's redactResolvedConfig) already redacts secrets by key
  // name and bounds value length. The cap here is a SECOND, independent bound at the
  // trust boundary: this endpoint accepts writes from any vessel, and a per-task blob
  // rides the FLEXIBLE tasks column straight into the row. Oversize configs are dropped
  // whole rather than truncated — a half-serialized config would replay as a subtly
  // WRONG call, which is worse than an honestly absent one.
  const _rc = task?.resolvedConfig ?? task?.resolved_config;
  if (_rc && typeof _rc === 'object' && !Array.isArray(_rc)) {
    try {
      const encoded = JSON.stringify(_rc);
      if (encoded !== undefined && encoded.length <= RESOLVED_CONFIG_MAX_CHARS) {
        out.resolved_config = _rc as Record<string, unknown>;
      }
    } catch {
      // Cyclic or non-serializable config: store nothing. An absent config is a
      // recoverable gap; a config that breaks the row's write is not.
    }
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

interface SystemTraceParams {
  execution_id: string;
  activity_id: string;
  success: boolean;
  duration_ms: number;
  cost_usd: number;
  parent_execution_id: string | null;
  org_id: string;
  executed_at: Date;
}

/**
 * Write a slim digest row co-produced alongside each AET row (Phase B dual-write).
 * Enables fast exemplar recall without loading the full 16KB AET payload.
 */
async function insertTraceDigest(trace: any, body: any, jwtToken?: string): Promise<void> {
  const taskSummaries = Array.isArray(trace.tasks)
    ? trace.tasks.map((t: any) => ({
        id: t.id,
        status: t.success === false ? 'failure' : 'success',
        duration_ms: t.duration_ms ?? 0,
        resolver_tier: t.resolver_tier ?? null,
      }))
    : null;

  // Build dynamically to avoid passing null for option<X> fields — SurrealDB 3.x
  // rejects JSON null against these types; omit entirely so the field defaults to NONE.
  const optFields: string[] = [];
  const p: Record<string, unknown> = {
    execution_id: trace.execution_id,
    activity_id: trace.activity_id,
    success: trace.success,
    duration_ms: trace.duration_ms ?? 0,
    cost_usd: trace.cost_usd ?? 0,
    org_id: trace.org_id,
    executed_at: trace.executed_at,
  };

  const failureModeType = body.failure_mode?.type;
  if (failureModeType != null) { optFields.push('failure_mode_type: $failure_mode_type'); p.failure_mode_type = failureModeType; }
  if (Array.isArray(trace.output_impulse_shapes) && trace.output_impulse_shapes.length > 0) {
    optFields.push('output_impulse_shapes: $output_impulse_shapes');
    p.output_impulse_shapes = trace.output_impulse_shapes;
  }
  if (taskSummaries !== null) { optFields.push('task_summaries: $task_summaries'); p.task_summaries = taskSummaries; }

  const optStr = optFields.length > 0 ? ',\n      ' + optFields.join(',\n      ') : '';
  const q = `
    INSERT INTO trace_digest {
      execution_id: $execution_id,
      activity_id: $activity_id,
      success: $success,
      duration_ms: $duration_ms,
      cost_usd: $cost_usd,
      org_id: $org_id,
      executed_at: $executed_at${optStr}
    }
  `;
  // Root path: trace_digest FOR create uses $auth.org_id (JWT only populates $token).
  // Auth validated at HTTP layer; root path is safe and consistent with AET INSERT.
  await surrealDB.query(q, p);
}

/**
 * Write the content row co-produced alongside each AET row (Phase B dual-write).
 * Splits out large FLEXIBLE fields so metadata reads don't load blob payloads.
 */
async function insertTraceContent(trace: any, jwtToken?: string): Promise<void> {
  // Only bother if there is actual content to store
  if (!trace.tasks && !trace.state_snapshot && !(trace as any).impulse_resolutions && !(trace as any).output_impulses) return;

  // Build dynamically to avoid passing null for TYPE none|array<object> fields.
  // SurrealDB 3.x rejects JSON null against option<X> coercion; omit entirely so
  // the field defaults to NONE.
  const optFields: string[] = [];
  const p: Record<string, unknown> = {
    execution_id: trace.execution_id,
    org_id: trace.org_id,
  };
  if (trace.tasks) { optFields.push('tasks: $tasks'); p.tasks = trace.tasks; }
  if (trace.state_snapshot) { optFields.push('state_snapshot: $state_snapshot'); p.state_snapshot = trace.state_snapshot; }
  if ((trace as any).impulse_resolutions) { optFields.push('impulse_resolutions: $impulse_resolutions'); p.impulse_resolutions = (trace as any).impulse_resolutions; }
  if ((trace as any).output_impulses) { optFields.push('output_impulses: $output_impulses'); p.output_impulses = (trace as any).output_impulses; }

  const optStr = optFields.length > 0 ? ',\n      ' + optFields.join(',\n      ') : '';
  const q = `
    INSERT INTO execution_trace_content {
      execution_id: $execution_id,
      org_id: $org_id${optStr}
    }
  `;
  // Root path: execution_trace_content FOR create uses $auth.org_id (JWT only
  // populates $token). Auth validated at HTTP layer; root path is safe.
  //
  // IDEMPOTENT ON THE UNIQUE INDEX. execution_trace_content carries a UNIQUE index on
  // execution_id, and this content row is written from more than one path (the dual-write
  // sink and trace re-posts), so a second write for an execution whose content is already
  // stored throws:
  //
  //   Database index `idx_etc_execution_id` already contains 'exec_6ye6gde7',
  //   with record `execution_trace_content:7f1ptdw6kjw1lcdhl25c`
  //
  // Measured on the hub: 556 of these in 90 minutes, ~6/min, and the SAME execution ids
  // recur seconds apart — so the caller treats the throw as retryable and comes back. Each
  // attempt is a write transaction the store has to open and roll back, and each one logs a
  // multi-kilobyte error carrying the full task array, against a DB already under pressure.
  //
  // The row existing IS the desired end state, so a duplicate is success, not failure.
  // Swallowing it here stops the retry at its source. Any OTHER error still throws: a
  // blanket catch would hide real write failures, which is how a trace store silently stops
  // recording.
  try {
    await surrealDB.query(q, p);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (msg.includes('idx_etc_execution_id') && msg.includes('already contains')) {
      logger.debug('[trace-content] content row already stored for this execution — treating duplicate as success', {
        execution_id: trace.execution_id,
      });
      return;
    }
    throw err;
  }
}

/**
 * Write a minimal row to execution_system_traces for activities on the
 * 'system' learning_track. Intentionally slim — these rows are excluded
 * from Thompson posterior updates and kept separate from the learning corpus.
 */
async function insertSystemTrace(params: SystemTraceParams, jwtToken?: string): Promise<void> {
  const optionals: string[] = [];
  if (params.parent_execution_id) optionals.push('parent_execution_id: $parent_execution_id');

  const query = `
    INSERT INTO execution_system_traces {
      execution_id: $execution_id,
      activity_id: $activity_id,
      success: $success,
      duration_ms: $duration_ms,
      cost_usd: $cost_usd,
      org_id: $org_id,
      executed_at: $executed_at${optionals.length > 0 ? `,\n      ${optionals.join(',\n      ')}` : ''}
    }
  `;

  const p: Record<string, unknown> = {
    execution_id: params.execution_id,
    activity_id: params.activity_id,
    success: params.success,
    duration_ms: params.duration_ms,
    cost_usd: params.cost_usd,
    org_id: params.org_id,
    executed_at: params.executed_at,
  };
  if (params.parent_execution_id) p.parent_execution_id = params.parent_execution_id;

  // Root path: same $auth/$token PERMISSIONS reason as AET INSERT.
  await surrealDB.query(query, p);
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
    // `start_date` is the canonical param; `since` is an alias honored for
    // callers (boredom-vessel's idle/analysis queries) that pass a recency
    // bound. Both accept an ISO-8601 datetime OR an epoch value (ms or s),
    // since boredom sends `Date.now() - window` (epoch millis). Coercing here
    // keeps the hot-path query bounded to a NARROW recent window instead of
    // silently dropping the filter and scanning the full 30-day default
    // window (~all rows) — the loop's rate limiter. SurrealDB does not
    // index-optimize `executed_at >= X ORDER BY executed_at DESC` (it
    // range-scans then sorts), so a narrow window is what keeps this fast.
    const coerceToIso = (raw: string | undefined): string | undefined => {
      if (!raw) return undefined;
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        // < 1e12 → looks like epoch seconds; otherwise epoch millis.
        const ms = n < 1e12 ? n * 1000 : n;
        return new Date(ms).toISOString();
      }
      return trimmed; // already ISO (or a value SurrealDB will reject loudly)
    };
    const startDate = coerceToIso(c.req.query('start_date') ?? c.req.query('since') ?? c.req.query('since_iso'));
    const endDate = coerceToIso(c.req.query('end_date'));
    const includeSelection = c.req.query('include_selection') === 'true';
    // Opt-in narrow projection for the list view (2026-06-21). The DEFAULT
    // projection is left WIDE and unchanged — many autonomous consumers
    // (development-vessel resolvers, boredom-vessel) read `metadata`,
    // `composition_chain`, `failure_mode`, and `input/output_impulse_shapes`
    // off this list response, so narrowing the default would silently break
    // them. Callers that only need a list summary (id/status/timing) can pass
    // `?fields=summary` (alias `?detail=false`) to skip per-row hydration of
    // the fat JSONB columns. Measured ~13% faster on a 30-day/20-row page
    // (8.4s → 7.3s); the residual cost is the 30-day window iteration, which
    // is intentional (OOMKill bound) and out of scope here.
    const fieldsParam = c.req.query('fields');
    const detailParam = c.req.query('detail');
    const summaryProjection =
      fieldsParam === 'summary' || detailParam !== 'true';

    // Validate and cap limit
    const limit = Math.min(Math.max(limitParam, 1), 100);
    const offset = Math.max(offsetParam, 0);

    // Build SurrealDB query dynamically
    let whereConditions: string[] = [];
    const params: Record<string, any> = {
      limit,
      offset,
    };

    // Multi-tenant filtering.
    // JWT path: RBAC via PERMISSIONS handles org scoping at the DB level.
    // API-key / legacy path: must add org_id to WHERE so the index is used —
    // without it the query fetches all orgs then filters in application code,
    // which causes full-table scans and OOMKills (F-N-perf, 2026-04-30).
    const needsWhereOrgFilter = !useJwtAuth || jwtAuth?.authType === 'apikey';
    // For API-key auth, session is never populated (org_id: null). Fall back
    // to jwtAuth.orgId which carries the org from identity-vessel validation.
    const effectiveOrgId = session.org_id || jwtAuth?.orgId || null;
    const effectiveAccountId = (session as any).account_id ?? null;
    if (needsWhereOrgFilter) {
      if (effectiveOrgId) {
        if (effectiveAccountId) {
          // Account-scoped path: match account records + untagged org records.
          whereConditions.push(`(${accountIdScopedWhere()} OR org_id = NULL)`);
          params.org_id = effectiveOrgId;
          params.account_id = effectiveAccountId;
        } else {
          // Org-scoped path (API-key, no account_id): use plain equality so
          // the composite (org_id, executed_at) index is used instead of the
          // single-field executed_at index that requires a full org scan +
          // sort (F-130, 2026-05-05: 9.5s → 1.3s on 21k-row org).
          whereConditions.push('org_id = $org_id');
          params.org_id = effectiveOrgId;
        }
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
      whereConditions.push('executed_at >= type::datetime($start_date)');
      params.start_date = startDate;
    } else {
      // ★ THIS GUARD DID NOT FAIL — IT ERODED. It was written as "last 30 days ... instead of
      //   scanning all 25k+ historical rows (OOMKill prevention)", and at 25k rows spanning
      //   more than a month that genuinely bounded the scan.
      //
      //   Measured on the hub 2026-08-18: the table holds 473,176 rows spanning TWENTY-FIVE
      //   DAYS. The oldest row is 2026-07-24; the default asked for >= 2026-07-19. The
      //   predicate therefore excluded ZERO rows, and every request sorted the entire view.
      //   SurrealDB 2.3.3 answers `ORDER BY ... LIMIT n` with a MemoryOrderedLimit collector —
      //   it materialises every matching row into a sort BEFORE applying the LIMIT — so a
      //   filter that excludes nothing means an O(table) sort per request. ~40 of those ran
      //   concurrently and pinned all 8 DB workers at ~96% with 0.0% iowait, taking the whole
      //   fleet to 30s query latency.
      //
      // ★ A CALENDAR WINDOW IS THE WRONG SHAPE OF GUARD FOR A GROWING TABLE. It bounds the
      //   scan only while ingest stays slow enough that 30 days is less than all of history.
      //   Cross that line — as this fleet did somewhere between 111k and 473k rows — and the
      //   bound silently becomes a no-op while still LOOKING like a bound. Nothing errors, and
      //   the comment above it keeps asserting protection it no longer provides.
      //
      //   The durable answer is an index-satisfiable ordering (migration 172 gets exactly that
      //   on the UNSCOPED branch: `Iterate Index` + `ReverseOrder`, 129ms) so the engine walks
      //   the index and stops at LIMIT without sorting anything. The org-scoped branch the
      //   dashboard uses does not get that plan from this engine version, so until it does,
      //   the window has to genuinely narrow.
      //
      //   24 hours is chosen against the measured ingest rate (473k rows / 25 days ~= 19k per
      //   day), which puts a default page over ~19k rows instead of 473k — a ~25x smaller
      //   sort — while still covering what a "recent traces" view is for. It is deliberately
      //   expressed in hours so the next person who has to shrink it does not have to
      //   re-derive why. Clients needing history pass ?start_date=<iso> explicitly and get the
      //   old behaviour on demand rather than by default.
      const windowHours = Number(process.env.TRACE_LIST_DEFAULT_WINDOW_HOURS ?? '24');
      const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : 24;
      const windowStart = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      whereConditions.push('executed_at >= type::datetime($start_date)');
      params.start_date = windowStart;
    }

    if (endDate) {
      whereConditions.push('executed_at <= type::datetime($end_date)');
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
    // Perf: project only summary fields for the list view — avoids loading
    // multi-KB tasks[], impulse_resolutions[], and composition_chain[] arrays
    // per row. Individual traces are fetched fully on demand via the single-
    // trace endpoint. This is the primary contributor to OOMKills when the
    // table grows large (SELECT * scans all JSONB columns into memory).
    //
    // `array::len(tasks ?? [])` / `array::len(impulse_resolutions ?? [])` were
    // REMOVED from this projection: array::len forces SurrealDB to deserialize
    // the full multi-KB `tasks` and `impulse_resolutions` JSONB arrays for
    // every candidate row — re-introducing exactly the per-row JSONB load this
    // projection was built to avoid (measured ~3.5s on a narrow window where
    // execution_id-only is 35ms). The counts are instead read cheaply from the
    // denormalised `metadata.task_count` the executor already writes; callers
    // needing exact impulse counts use the single-trace endpoint.
    // Narrow (opt-in) projection drops the fat JSONB columns — `metadata`,
    // `composition_chain`, `failure_mode` (replaced by a scalar
    // `failure_mode_type` summary), and the `*_impulse_shapes` arrays — so the
    // DB does not hydrate them per row. `failure_mode.type` is kept as a cheap
    // scalar so summary consumers can still bucket by failure category.
    const selectFields = summaryProjection
      ? `
        id, execution_id, activity_id, variant_id, org_id, account_id,
        status, success, error, executed_at, duration_ms, cost_usd,
        error_message, failed_task_id,
        parent_execution_id,
        vessel_id, vessel_version, tags,
        failure_mode.type AS failure_mode_type,
        (metadata.task_count ?? 0) AS task_count`
      : `
        id, execution_id, activity_id, variant_id, org_id, account_id,
        status, success, error, executed_at, duration_ms, cost_usd,
        error_message, failed_task_id,
        parent_execution_id, composition_chain,
        vessel_id, vessel_version,
        failure_mode, metadata, tags,
        output_impulse_shapes, input_impulse_shapes,
        (metadata.task_count ?? 0) AS task_count`;
    const query = `
      SELECT${selectFields}
      FROM v_paradigm_execution_traces
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

    // COLLAPSE IDENTICAL POLLS INTO ONE QUERY. Measured on the hub 2026-08-18: this route
    // received 50 requests in 3 minutes from a browser dashboard whose global 5s
    // refetchInterval reached it, and SurrealDB 2.3.3 answers each one by materialising all
    // 473,176 rows of v_paradigm_execution_traces into a sort BEFORE applying the LIMIT.
    // ~40 such sorts ran concurrently and pinned all 8 DB workers at ~96% with 0.0% iowait,
    // taking the whole fleet to 30s query latency — including the substrate's own learning
    // writes, which timed out and were lost.
    //
    // The client-side fix (dashboard 3f5e35e) is correct and cannot help a browser already
    // running the old bundle, so the server has to be able to defend itself. A 10s TTL turns
    // a 5s poll into one query per 10s per distinct page — the cost stops scaling with the
    // number of open tabs, which is the property that was missing.
    //
    // ★ THE KEY MUST CARRY THE TENANT, OR THIS IS A DATA LEAK RATHER THAN A CACHE. The JWT
    //   path calls queryWithAuth, where row visibility is enforced by the DATABASE against
    //   the caller's token — so two orgs can issue a byte-identical query+params and are
    //   entitled to different rows. Keying on the SQL alone would serve one org's page to
    //   another. effectiveOrgId (line ~725) is the explicit discriminator, and when it is
    //   absent this refuses to cache at all rather than guessing a key.
    //
    // Deliberately in-memory and tiny: this is one process, the entries are one page each,
    // and a 10s TTL bounds staleness well under the human perception the dashboard wanted.
    // ★ THE KEY MUST NOT CONTAIN A VALUE THAT CHANGES EVERY REQUEST. The first version of
    //   this keyed on JSON.stringify(params) directly and NEVER HIT ONCE — measured 0 hits
    //   against 60 queries in three minutes on a process that definitely had the code.
    //   `start_date` defaults to now-30d computed per request, to the millisecond:
    //       2026-07-19T02:43:30.542Z / :35.152Z / :40.350Z  — 73 distinct values in 4 minutes.
    //   So every poll minted a fresh key and the cache was pure overhead.
    //
    //   Quantising it to the TTL boundary makes consecutive polls share a key while keeping
    //   any genuinely different range (a user picking a window) distinct — 10s granularity is
    //   far finer than any range a human selects. The QUERY still receives the exact
    //   timestamp; only the key is bucketed, so this cannot change which rows are returned.
    const keyParams = { ...params } as Record<string, unknown>;
    if (typeof keyParams.start_date === 'string') {
      const t = Date.parse(keyParams.start_date);
      keyParams.start_date = Number.isNaN(t)
        ? keyParams.start_date
        : Math.floor(t / TRACE_LIST_CACHE_TTL_MS) * TRACE_LIST_CACHE_TTL_MS;
    }
    const cacheKey = effectiveOrgId
      ? `${effectiveOrgId}|${useJwtAuth ? 'jwt' : 'session'}|${query}|${JSON.stringify(keyParams)}`
      : null;
    if (cacheKey) {
      const hit = traceListCache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        logger.info('execution traces served from cache', {
          event: 'trace_list_cache_hit',
          org_id: effectiveOrgId,
          age_ms: TRACE_LIST_CACHE_TTL_MS - (hit.expiresAt - Date.now()),
        });
        return c.json(hit.body);
      }
    }

    // Execute query with appropriate auth method
    let executions: ExecutionTrace[];
    let countResult: { total: number }[];

    // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
    // 3.x interprets as a record reference and rejects with "access method
    // cannot be used". Skip JWT path for API-key auth and fall back to root
    // creds + manual org_id filtering. Same pattern as routes/activities.ts.
    if (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey') {
      // JWT AUTH PATH: Use RBAC-enforced query
      executions = await queryWithAuth<ExecutionTrace>(jwtAuth.jwtToken, query, params);
    } else {
      // LEGACY PATH: Direct query with application-level filtering
      executions = await surrealDB.query<ExecutionTrace>(query, params);
    }
    // COUNT query omitted — full table scan with GROUP ALL causes OOMKills on
    // tables >25k rows. Clients receive the page size via executions.length;
    // total is returned as -1 to signal "unknown count" without an extra scan.
    // COUNT is OPT-IN (`?include_total=true`). The default stays -1 = "unknown":
    // an unconditional count doubles DB work on this hot path on this hot path (the learning loop
    // reads this route on every dispatch), which is the OOM class the count was
    // disabled for. When asked, count the SAME bounded row set the page came from
    // — whereClause always carries an executed_at bound, and the executed_at index
    // makes it a range walk over narrow scalar rows: no JSONB hydration, no ORDER
    // BY, no LIMIT materialise. A count FAILURE must never be swallowed into a
    // plausible 0 — it falls back to the -1 sentinel and logs loudly. So total=0
    // means "genuinely zero rows in the window" and total=-1 means "not counted
    // or count failed"; conflating those two is the exact mistake this endpoint
    // currently forces on every caller.
    countResult = [{ total: -1 }];
    if (c.req.query('include_total') === 'true') {
      const countQuery = `SELECT count() AS total FROM v_paradigm_execution_traces ${whereClause} GROUP ALL`;
      try {
        const countRows = (useJwtAuth && jwtAuth?.jwtToken && jwtAuth.authType !== 'apikey')
          ? await queryWithAuth<{ total: number }>(jwtAuth.jwtToken, countQuery, params)
          : await surrealDB.query<{ total: number }>(countQuery, params);
        countResult = [{ total: Number(countRows?.[0]?.total ?? 0) }];
        logger.info('[traces-count] include_total served', { total: countResult[0].total, whereClause });
      } catch (countErr) {
        logger.error('[traces-count] include_total COUNT failed — returning -1 sentinel, NOT 0', {
          error: countErr instanceof Error ? countErr.message : String(countErr),
          whereClause,
        });
      }
    }

    logger.info('Raw executions result from SurrealDB', {
      executionsType: typeof executions,
      executionsIsArray: Array.isArray(executions),
      executionsLength: executions?.length || 0,
      firstExecution: executions?.[0] || null,
      rbacEnforced: useJwtAuth,
    });

    let total = countResult?.[0]?.total || 0;

    // Always union the paradigm execution table when parent_execution_id is set.
    // activity_execution_traces stores wrappers (aexec_, act_); the paradigm
    // execution table stores lifecycle hook executions (exec_). Both can have
    // children of the same parent — querying only one table silently drops the other.
    // Deduplication key is execution_id; activity_execution_traces version takes
    // precedence when the same ID appears in both tables (it's more complete).
    if (parentExecutionId) {
      try {
        const bareId = params.parent_execution_id as string;
        const paradigmQuery = `
          SELECT * FROM execution
          WHERE (
            parent_execution_id = $pid
            OR parent_execution_id = $pid_prefixed
            OR parent_execution_id = $pid_exec_prefixed
          )
          ORDER BY executed_at ASC
          LIMIT $limit
        `;
        const paradigmRows = await surrealDB.query<any>(paradigmQuery, {
          pid: bareId,
          pid_prefixed: `activity_execution_traces:${bareId}`,
          pid_exec_prefixed: `execution:${bareId}`,
          limit,
        });
        if (paradigmRows && paradigmRows.length > 0) {
          // Build set of execution_ids already in primary results
          const existingIds = new Set((executions ?? []).map((e: any) =>
            e.execution_id || e.id?.toString().split(':').pop() || ''
          ).filter(Boolean));

          const newRows = paradigmRows
            .map((row: any) => {
              const rowId = typeof row.id === 'string'
                ? (row.id.includes(':') ? row.id.split(':').pop()! : row.id)
                : String(row.id ?? '');
              return {
                ...row,
                execution_id: row.execution_id || rowId,
                activity_name: row.activity_id || 'Unknown Activity',
                created_at: row.created_at || row.executed_at || new Date().toISOString(),
                error_message: row.error?.message ?? row.error_message,
                tasks: row.trace?.tasks ?? row.tasks ?? [],
              } as ExecutionTrace;
            })
            .filter((row: any) => {
              const eid = row.execution_id || '';
              return eid && !existingIds.has(eid);
            });

          if (newRows.length > 0) {
            logger.info('[paradigm-union] Merged paradigm execution table results', {
              primaryCount: executions?.length ?? 0,
              paradigmCount: paradigmRows.length,
              newCount: newRows.length,
              parentExecutionId,
            });
            executions = [...(executions ?? []), ...newRows] as ExecutionTrace[];
            total = executions.length;
          }
        }
      } catch (paradigmError) {
        logger.warn('[paradigm-union] Paradigm execution union query failed', {
          error: paradigmError instanceof Error ? paradigmError.message : String(paradigmError),
          parentExecutionId,
        });
      }
    }

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

    // Composition chain fallback is skipped on the list endpoint — it triggers
    // one DB walk per result row for old traces with empty composition_chain,
    // adding 1-2s per row (5 rows = 10s total). The chain is only needed in the
    // single-trace detail view which fetches one row and can afford the walk.
    const response: ListExecutionTracesResponse = {
      executions: executionsNormalized,
      total,
      limit,
      offset,
    };

    // Only a SUCCESSFUL page is cached. An error path must never be memoised — a transient
    // DB failure would otherwise be served to every caller for the whole TTL, converting one
    // bad second into ten.
    if (cacheKey) {
      traceListCache.set(cacheKey, { body: response, expiresAt: Date.now() + TRACE_LIST_CACHE_TTL_MS });
      if (traceListCache.size > TRACE_LIST_CACHE_MAX) {
        // Bounded, and pruned by expiry first so a burst of distinct pages cannot grow this
        // without limit. An unbounded cache on a request-shaped key is a slow memory leak,
        // which on this fleet means an OOM kill.
        const now = Date.now();
        for (const [k, v] of traceListCache) if (v.expiresAt <= now) traceListCache.delete(k);
        while (traceListCache.size > TRACE_LIST_CACHE_MAX) {
          const oldest = traceListCache.keys().next().value;
          if (oldest === undefined) break;
          traceListCache.delete(oldest);
        }
      }
    }

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
 * GET /v2/activities/execution-traces/exemplars?activity_id=<id>
 *
 * Returns exemplar traces for an activity selected by the adaptive exemplar selector.
 * Falls back to a live trace_digest query when no exemplars have been selected yet.
 *
 * MUST be registered before /:executionId to prevent dynamic-route shadowing.
 *
 * Response shape: { source: "exemplar" | "digest_fallback", items: ExemplarItem[] }
 */
app.get('/exemplars', async (c) => {
  const activity_id = c.req.query('activity_id');
  if (!activity_id) return c.json({ error: 'activity_id query parameter required' }, 400);

  try {
    const exemplarRows = await surrealDB.query<{
      execution_id: string; success: boolean; digest_id: string; selected_at: string;
    }>(`SELECT execution_id, success, digest_id, selected_at FROM execution_exemplar WHERE activity_id = $activity_id ORDER BY selected_at DESC LIMIT 40`, { activity_id });

    if (exemplarRows && exemplarRows.length > 0) {
      const digestIds = exemplarRows.map(r => r.digest_id).filter(Boolean);
      let digestMap: Record<string, unknown> = {};
      if (digestIds.length > 0) {
        const digestRows = await surrealDB.query<{ id: string } & Record<string, unknown>>(
          `SELECT * FROM trace_digest WHERE id IN array::map($ids, |$id| type::record($id))`, { ids: digestIds }
        );
        for (const d of digestRows ?? []) digestMap[String(d.id)] = d;
      }
      const items = exemplarRows.map(r => ({ ...r, digest: digestMap[r.digest_id] ?? null }));
      return c.json({ source: 'exemplar', items });
    }

    const fallbackRows = await surrealDB.query<Record<string, unknown>>(
      `SELECT * FROM trace_digest WHERE activity_id = $activity_id ORDER BY executed_at DESC LIMIT 20`, { activity_id }
    );
    return c.json({ source: 'digest_fallback', items: fallbackRows ?? [] });

  } catch (error) {
    logger.error('Failed to fetch exemplars', { error: error instanceof Error ? error.message : String(error) });
    return c.json({ error: 'Failed to fetch exemplars', message: error instanceof Error ? error.message : 'Unknown error' }, 500);
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
      whereConditions.push('selected_at >= type::datetime($start_date)');
      params.start_date = startDate;
    }

    if (endDate) {
      whereConditions.push('selected_at <= type::datetime($end_date)');
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

    // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
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
 * Background: previously, every execution trace on canary had
 * `composition_chain: []` despite `parent_execution_id` being set
 * correctly. The denormalization step that should compute the chain by
 * reading the parent's chain at insert time was missing entirely; clients
 * (minibob) compute it for L3 template runs but L1/L2 meta-traces fall
 * through without populating it. Recursive-escalation auditing was
 * effectively blind because chain-depth queries always returned 0 traces.
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
        SELECT execution_id, composition_chain FROM v_paradigm_execution_traces
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
    logger.warn('[composition-chain] Failed to denormalize composition_chain — leaving empty', {
      parent_execution_id: parentExecutionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Backfill `composition_chain` on already-inserted children of a just-inserted
 * trace. Closes the write-order race in the insert-time helper.
 *
 * The insert-time helper computes the chain by reading the parent. That works
 * for L3 template runs but breaks for minibob's L1/L2 synthetic meta-traces
 * (`emitMetaTrace` for `_goal_resolve` / `_activity_execute`) which insert
 * AFTER their children — the meta-trace wraps the entire goal flow and emits
 * at the end. The parent-lookup at child-insert time finds nothing, the child
 * lands with empty chain, and chain-depth audits stay blind.
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
  jwtToken?: string,
): Promise<void> {
  if (!insertedExecutionId || typeof insertedExecutionId !== 'string') return;
  // newChain = parent's chain + parent's own id (root-first ordering, matches
  // migration 081 + minibob composition-chain.ts contract).
  const newChain: string[] = [...insertedCompositionChain, insertedExecutionId];
  try {
    // Perf gate (2026-06-21): the common case is a trace with NO children to
    // backfill (most inserts are leaves or arrive parent-first). Probe that
    // case with a cheap *indexed* existence check before touching the UPDATE.
    //
    // `parent_execution_id` is indexed (idx_activity_executions_parent /
    // idx_aet_parent_execution_id) so this probe is `Iterate Index` (~700µs).
    // The UPDATE's previous `array::len(composition_chain) = 0` predicate is
    // NON-indexable, so the planner fell back to `Iterate Table` — a full
    // ~160K-row scan (~1.1s) on EVERY trace ingest, even when the parent has
    // no children at all. Skipping the UPDATE on the empty probe removes that
    // full scan from the steady-state hot path.
    const probeSql = `
        SELECT VALUE id FROM execution
        WHERE parent_execution_id = $parent_execution_id
        LIMIT 1
      `;
    const probeParams = { parent_execution_id: insertedExecutionId };
    const probe = jwtToken
      ? await queryWithAuth<unknown>(jwtToken, probeSql, probeParams)
      : await surrealDB.query<unknown>(probeSql, probeParams);
    if (!Array.isArray(probe) || probe.length === 0) {
      // No children of this insert exist — nothing to backfill. Common case.
      return;
    }

    // Single statement. SurrealQL handles the row scan; no app-side loop.
    // The `composition_chain IS NONE OR composition_chain = []` clause is the
    // idempotency guard — we never overwrite a populated chain (those children
    // already had a parent at their insert time and the insert-time helper
    // resolved them correctly).
    //
    // `composition_chain = []` replaces the prior `array::len(...) = 0`: the
    // empty-array equality IS index-eligible (idx_..._composition_chain), so
    // combined with the indexed `parent_execution_id` the planner does an
    // index union (`Iterate Index`) instead of a full table scan. Verified via
    // EXPLAIN 2026-06-21.
    //
    // activity_execution_traces FOR update PERMISSIONS require $auth.org_id
    // (migration 099); use the inbound JWT when available so the UPDATE
    // doesn't silently no-op under root signin.
    const updateSql = `
        UPDATE activity_execution_traces
        SET composition_chain = $new_chain
        WHERE parent_execution_id = $parent_execution_id
          AND (composition_chain IS NONE OR composition_chain = [])
      `;
    // WRITE-FLIP: mirror the chain backfill onto the authoritative `execution`
    // table (indexed on parent_execution_id; root path, non-fatal).
    const updateExecSql = `
        UPDATE execution
        SET composition_chain = $new_chain
        WHERE parent_execution_id = $parent_execution_id
          AND (composition_chain IS NONE OR composition_chain = [])
      `;
    const updateParams = {
      parent_execution_id: insertedExecutionId,
      new_chain: newChain,
    };
    if (jwtToken) {
      await queryWithAuth(jwtToken, updateSql, updateParams);
    } else {
      await surrealDB.query(updateSql, updateParams);
    }
    // WRITE-FLIP: mirror onto the authoritative `execution` table (root path).
    await surrealDB.query(updateExecSql, updateParams);
  } catch (err) {
    logger.warn('[composition-chain] Failed to backfill child composition_chains — leaving empty', {
      inserted_execution_id: insertedExecutionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Derive the parent→child composition edge from the LIVE `execution` table.
 *
 * The compose resolver (ias-executor-ts activity.ts) stamps
 * `parent_execution_id` on every nested child trace, but nothing turned those
 * parent→child pairs into `activity_composition_graph` edges — the sole edge
 * writer (POST /composition / activityComposition_write) has no caller, so the
 * graph froze. This derives the edge at ingest by reading the parent's
 * `activity_id` from the AUTHORITATIVE `execution` table (NOT the frozen
 * `activity_execution_traces`) and upserting the producer→consumer edge.
 * Best-effort: never fails the just-succeeded insert.
 *
 * Exported for tests.
 */
export async function deriveCompositionEdgeFromParent(
  childActivityId: string | undefined,
  parentExecutionId: string | undefined,
  success: boolean,
  jwtToken?: string,
  /** The child's own execution id — becomes the edge's `execution_id` witness
   *  ("last execution where this composition occurred"), so a fresh pair is
   *  attributable to the run that earned it rather than to a batch job. */
  childExecutionId?: string,
  /** Tenant. `org_id` is a required, non-NONE column on this SCHEMAFULL table. */
  orgId?: string,
): Promise<void> {
  if (!childActivityId || !parentExecutionId) return;
  if (!orgId) {
    logger.warn('[composition-edge] missing_org_id', {
      outcome: 'missing_org_id',
      child_activity_id: childActivityId,
    });
    return;
  }
  // parent_execution_id may arrive bare or record-prefixed; reduce to the bare
  // id so type::thing('execution', $pid) resolves the live row.
  const bareParent = parentExecutionId.includes(':')
    ? parentExecutionId.split(':').pop()!.replace(/[⟨⟩]/g, '')
    : parentExecutionId;
  try {
    // ★ READ THE LIVE TABLE, BY ITS ACTUAL KEY. Two corrections in series here,
    //   and the second was caught by the counter added alongside the first.
    //
    //   (1) This originally selected from `activity_execution_traces`, a partial
    //       mirror: measured 18,135 rows against `execution`'s 150,003 (12%), so
    //       ~88% of parent lookups missed and no edge was ever minted.
    //   (2) Retargeting to `execution` with `WHERE execution_id = $pid` made it
    //       WORSE — 100% miss, 186 parent_miss in 25 minutes with nothing else.
    //       There is no `execution_id` FIELD on `execution`: the table keys by
    //       RECORD ID, and the compat view synthesizes the column with
    //       `meta::id(id) AS execution_id` (sql/schemas/022-paradigm-compat-views.surql:63)
    //       precisely because it does not exist on the base table. A predicate on
    //       an absent column matches nothing, silently.
    //
    //   `type::thing('execution', $pid)` addresses the row by the key the table
    //   actually uses — which is what the `bareParent` normalization above was
    //   always preparing for.
    const parentRows = await surrealDB.query<{ activity_id?: string }[]>(
      `SELECT activity_id FROM type::thing('execution', $pid) LIMIT 1`,
      { pid: bareParent },
    );
    const parentActivityId = Array.isArray(parentRows)
      ? (parentRows.flat()[0] as { activity_id?: string } | undefined)?.activity_id
      : undefined;
    if (!parentActivityId) {
      // ★ COUNT THE MISS, AND SPLIT IT BY CAUSE. This was a bare `return`, so a
      //   lookup failure and a successful mint were indistinguishable from
      //   outside — the journal showed neither derive activity NOR errors, which
      //   read as "never invoked" when in fact this fired on ~66% of ingests and
      //   gave up here.
      //
      //   The split matters because ONE cause is permanent and correct: a walk
      //   satisfier parent (`walk-satisfier-*`) never persists an execution row,
      //   so it will miss forever and must not be read as ill health. An
      //   undifferentiated parent_miss cannot serve as a health signal while
      //   that population is mixed in.
      //   Two id NAMESPACES reach here and only one can ever resolve. A real
      //   `execution` row's key is `exec_` + 8 chars (`exec_2p6n42ss`, sampled
      //   live). Walk-internal ids — `walk-satisfier-*`, and the longer
      //   hyphenated `exec_<uuid-ish>` form goal-host mints for steps that never
      //   persist a row — are not execution keys at all, and looking them up
      //   MUST miss. Counting those as lookup failures would make the counter
      //   permanently non-zero and useless as a health signal, which is exactly
      //   the trap the split exists to avoid.
      const parentNotPersisted =
        /^walk-/.test(bareParent) || !/^exec_[a-z0-9]{8}$/.test(bareParent);
      logger.warn('[composition-edge] parent_miss', {
        outcome: parentNotPersisted ? 'parent_not_persisted' : 'parent_lookup_miss',
        child_activity_id: childActivityId,
        parent_execution_id: parentExecutionId,
      });
      return;
    }
    if (parentActivityId === childActivityId) {
      logger.info('[composition-edge] self_edge_skipped', {
        outcome: 'self_edge_skipped',
        activity_id: childActivityId,
      });
      return;
    }
    const upsertSql = `
        LET $existing = (SELECT * FROM activity_composition_graph
          WHERE parent_activity_id = $parent AND child_activity_id = $child LIMIT 1);
        IF array::len($existing) > 0 THEN (
          UPDATE activity_composition_graph SET
            execution_count = execution_count + 1,
            success_count = IF($success, success_count + 1, success_count),
            weight = (IF($success, success_count + 1, success_count)) / (execution_count + 1),
            updated_at = time::now()
          WHERE parent_activity_id = $parent AND child_activity_id = $child
        ) ELSE (
          CREATE activity_composition_graph SET
            parent_activity_id = $parent,
            child_activity_id = $child,
            execution_id = $execution_id,
            org_id = $org_id,
            success = $success,
            execution_count = 1,
            success_count = IF($success, 1, 0),
            weight = IF($success, 1.0, 0.0),
            created_at = time::now(),
            updated_at = time::now()
        ) END;
      `;
    // ★ BIND EVERY REQUIRED COLUMN. activity_composition_graph is SCHEMAFULL and
    //   `execution_id`, `success` (sql/002-learning-system-phase1.surql:29,36)
    //   and `org_id` (migrations/031:45) all carry `ASSERT $value != NONE` with
    //   no VALUE/DEFAULT clause. The CREATE bound none of them, so even a
    //   lookup that found its parent could not have written a row. `success` is
    //   the one easily missed: it was referenced inside IF() for the counters
    //   but never SET as a field in its own right.
    // ★ MATCH THE DEDUPE KEY THE TABLE ALREADY USES. All 1,998 existing edges
    //   carry the PREFIXED form on BOTH endpoints (`activity:⟨…⟩`, sampled from
    //   the live graph). `parent_activity_id` comes off the execution row, which
    //   is normalized bare at write; `child_activity_id` arrives prefixed. Left
    //   as-is, a minted edge would land under a different (parent, child) key
    //   than every reconciler edge for the same pair — splitting the family and
    //   double-counting the posterior instead of sharpening it (law 3).
    const asPrefixed = (id: string): string => {
      const bare = id.replace(/^activity:/, '').replace(/[⟨⟩`]/g, '');
      return `activity:⟨${bare}⟩`;
    };
    const params = {
      parent: asPrefixed(parentActivityId),
      child: asPrefixed(childActivityId),
      success,
      execution_id: childExecutionId ?? bareParent,
      org_id: orgId,
    };
    if (jwtToken) {
      await queryWithAuth(jwtToken, upsertSql, params);
    } else {
      await surrealDB.query(upsertSql, params);
    }
    logger.info('[composition-edge] derive_ok', {
      outcome: 'derive_ok',
      parent_activity_id: parentActivityId,
      child_activity_id: childActivityId,
    });
  } catch (err) {
    logger.warn('[composition-edge] derive-from-parent failed (non-blocking)', {
      child_activity_id: childActivityId,
      parent_execution_id: parentExecutionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read-time fallback: walk `parent_execution_id` chain on the fly when the
 * stored `composition_chain` is empty. The insert-time helper and child
 * backfill above are write-time fixes; traces inserted before they landed can
 * still expose `composition_chain: []` despite a valid
 * `parent_execution_id`. This helper closes the audit-time gap.
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
          SELECT execution_id, parent_execution_id, composition_chain FROM v_paradigm_execution_traces
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
          logger.warn('[composition-chain read-time] orphan parent mid-walk — returning partial chain', {
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
    logger.warn('[composition-chain read-time] walkCompositionChain failed — returning []', {
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
 * Apply the read-time composition-chain fallback to a single trace: when the stored
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

    // The posted task array, from EITHER envelope. See the tasks projection below
    // for why both are accepted and why schema enforcement is deliberately not
    // bundled with this fallback.
    const rawPostedTasks: any[] | null =
      Array.isArray((body as any).execution_trace?.tasks) && (body as any).execution_trace.tasks.length > 0
        ? (body as any).execution_trace.tasks
        : Array.isArray((body as any).tasks) && (body as any).tasks.length > 0
          ? (body as any).tasks
          : null;

    // FIX: Use org_id from request body if provided, otherwise fall back to JWT/session
    // This allows MiniBob to explicitly set org_id when sending traces
    const traceOrgId = body.org_id || jwtAuth?.orgId || session?.org_id || 'public';
    const traceProjectId = body.project_id || jwtAuth?.projectId || session?.project_id || null;
    // Phase B2: account_id from JWT auth context (sessions don't carry one).
    // Schema is option<string>; null is acceptable when caller has no claim.
    const traceAccountId = body.account_id ?? jwtAuth?.accountId ?? null;

    logger.debug('[TRACE DEBUG] Determining org_id for trace', {
      body_org_id: body.org_id,
      jwt_org_id: jwtAuth?.orgId,
      session_org_id: session?.org_id,
      final_org_id: traceOrgId,
    });

    // Denormalize composition_chain when client didn't.
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
      // ENVELOPE FALLBACK. Posters disagree about the envelope: ias-executor-ts
      // wraps (adapters/activity-api-trace-sink.ts:94) so ribosome, validator and
      // goal-walk traces persist; light-dispatch-vessel POSTs the task array FLAT
      // (src/index.ts:872, `tasks: taskRecords`) and never constructs an
      // `execution_trace` wrapper at all. Reading only `body.execution_trace.tasks`
      // therefore stored NULL for every light-dispatch trace — 10,166 root
      // executions per 72h, whose metadata.success_count attests to task records
      // that were computed and then destroyed at the write. The identical fallback
      // already exists ~1,000 lines below for the successor-features path: the
      // mismatch was found once, patched for psi, and left unfixed for persistence.
      //
      // NOT measurable via `task_count`: that projection is `(metadata.task_count ?? 0)`
      // sourced from the poster's own tpl.tasks.length, so it reads identically
      // whether this fallback works or is inert. The honest observable is
      // content_source moving 'legacy' -> 'split' with a non-empty tasks array.
      //
      // Deliberately NOT paired with schema enforcement in this change. Wiring
      // StoreExecutionTraceRequestSchema (which makes execution_trace required)
      // into this route would start 400-ing the flat posters that are currently
      // accepted — i.e. light-dispatch traces would stop persisting entirely.
      // Fallback first, rejection second, once no poster still needs the fallback.
      tasks: rawPostedTasks && rawPostedTasks.length > 0
        ? rawPostedTasks.map(normalizePersistedTask)
        : null,

      // Extract state snapshot from whichever envelope carried the tasks.
      state_snapshot: rawPostedTasks
        ? {
            input_state: rawPostedTasks[0]?.inputState || {},
            output_state: rawPostedTasks[rawPostedTasks.length - 1]?.outputState || {},
            stateTransition: rawPostedTasks[rawPostedTasks.length - 1]?.stateTransition || {},
          }
        : null,

      // Multi-tenancy (use org_id from request body if provided)
      org_id: traceOrgId,
      // Phase B2: dual-write account_id alongside org_id. Schema is
      // option<string>, so null is acceptable when caller has no accountId
      // claim. account_id_version=1 marks this row as Phase B dual-written.
      account_id: traceAccountId,
      account_id_version: 1,
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
      // Classification tags (e.g. "intent:topology_discovery", "intent:boredom_source").
      ...(Array.isArray(body.tags) && body.tags.length > 0 ? { tags: body.tags } : {}),
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

    // ========================================================================
    // Learning-track routing (trace-storage-redesign Phase B)
    // Consult the cached learning_track field on the activity template.
    // 'system' → lightweight execution_system_traces row; no AET, no digest.
    // 'learning' | 'unclassified' | any error → existing AET path (fall-through).
    // ========================================================================
    let learningTrack: LearningTrack = 'unclassified';
    try {
      learningTrack = await resolveLearningTrack(trace.activity_id as string);
    } catch (err) {
      logger.warn('learning-track lookup failed; falling through to AET', { activity_id: trace.activity_id, err: err instanceof Error ? err.message : String(err) });
    }

    if (learningTrack === 'system') {
      await insertSystemTrace({
        execution_id: trace.execution_id as string,
        activity_id: trace.activity_id as string,
        success: trace.success as boolean,
        duration_ms: trace.duration_ms as number,
        cost_usd: trace.cost_usd as number,
        parent_execution_id: (trace as any).parent_execution_id ?? null,
        org_id: trace.org_id as string,
        executed_at: trace.executed_at as Date,
      }, jwtAuth?.jwtToken);

      logger.info('System-track trace routed to execution_system_traces', {
        execution_id: trace.execution_id,
        activity_id: trace.activity_id,
      });

      return c.json({
        success: true,
        execution_id: trace.execution_id,
        stored: 'system_traces',
      });
    }

    // Derive the v1 state-space signature BEFORE the INSERT so it lands ATOMICALLY
    // on the trace row (signature is option<string>, migration 145). Doing it here
    // — rather than a post-insert UPDATE — avoids a race where the freshly-inserted
    // row isn't yet visible to a follow-up UPDATE under high-volume subscriber-trace
    // bursts (which silently no-op'd, leaving the row's signature null). The cts
    // conditional-posterior write still derives independently in the score-update
    // path; this one makes the decision-topology coordinate observable on the trace.
    {
      const meta = ((trace as any).metadata ?? {}) as Record<string, unknown>;
      const rawSig = meta.state_space_signature;
      const rawVer = meta.signature_version;
      if (typeof rawSig === 'string' && /^[0-9a-f]{16}$/.test(rawSig) &&
          typeof rawVer === 'number' && Number.isInteger(rawVer) && rawVer >= 1) {
        (trace as any).signature = rawSig;
        (trace as any).signature_version = rawVer;
      } else {
        // C6: widen signature coverage beyond the ~4% of traces that carry
        // input_impulse_shapes. Fall back to per-task / output shape sets already
        // on the trace so a v1 signature lands for the majority of traces.
        const sigShapes = deriveSignatureShapes(trace);
        if (sigShapes.length > 0) {
          try {
            const { computeStateSpaceSignature } = await import('../utils/session-context');
            (trace as any).signature = computeStateSpaceSignature({
              shapes: sigShapes,
              provenance: Array.isArray(meta.provenance) ? (meta.provenance as any) : [],
              missing: Array.isArray(meta.missing_shapes) ? (meta.missing_shapes as any) : [],
            });
            (trace as any).signature_version = 1;
          } catch { /* non-blocking */ }
        }
      }

      // Consumption seam 3b: on FAILED trace ingest, ALSO derive a failure-conditioned
      // ('1f') signature and store it as `repair_signature` (migration 153) alongside the
      // v1 signature. Same shape/provenance/missing assembly as v1, plus the failure_mode
      // discriminator — so a later repair recommendation can read a posterior keyed on
      // (state, failure_mode) instead of collapsing distinct failure modes onto one cell.
      // ADDITIVE + behaviour-preserving: nothing consumes '1f' yet, and successful traces
      // are unchanged (the failure_mode discriminator only exists on failures).
      // REPAIR_SIGNATURE_CONSUME: update version-2 Thompson row for prior_repair_signature if present
    // (inserted before failure-mode sig block; prior_repair_signature comes from caller metadata)
    const _priorRepairSigRaw = (meta as any)?.prior_repair_signature ?? (trace as any)?.metadata?.prior_repair_signature;
    const _priorRepairSig = validRepairSignature(_priorRepairSigRaw);
    if (_priorRepairSig && body.template_id) {
      try {
        const _successForRepair = body.status === 'completed' || body.status === 'success' || body.success === true;
        const _repairDelta = priorRepairDelta(_successForRepair);
        await surrealDB.query(
          `LET $existing = (SELECT * FROM context_thompson_scores WHERE org_id = $org_id AND template_id = $activity_id AND signature_version = 2 AND context_bucket = $sig LIMIT 1); IF array::len($existing) > 0 THEN UPDATE context_thompson_scores SET alpha = alpha + $da, beta = beta + $db, n_observations = n_observations + 1, last_updated_at = time::now() WHERE org_id = $org_id AND template_id = $activity_id AND signature_version = 2 AND context_bucket = $sig ELSE CREATE context_thompson_scores CONTENT { org_id: $org_id, template_id: $activity_id, context_bucket: $sig, signature_version: 2, alpha: 1 + $da, beta: 1 + $db, n_observations: 1, last_updated_at: time::now(), created_at: time::now() } END`,
          { activity_id: body.template_id, org_id: trace.org_id, sig: _priorRepairSig, da: _repairDelta.dAlpha, db: _repairDelta.dBeta }
        );
      } catch (_e) {
        // non-blocking
      }
    }
    const failureModeTypeForSig = body.failure_mode?.type;
    if (!success && typeof failureModeTypeForSig === 'string' && failureModeTypeForSig.length > 0) {
      const anchor_not_found = body.failure_mode?.anchor_not_found;
      if (anchor_not_found) {
        (trace as any).repair_anchor_not_found = anchor_not_found;
      }
        const repairShapes = deriveSignatureShapes(trace);
        if (repairShapes.length > 0) {
          try {
            const { computeStateSpaceSignature } = await import('../utils/session-context');
            (trace as any).repair_signature = computeStateSpaceSignature({
              shapes: repairShapes,
              provenance: Array.isArray(meta.provenance) ? (meta.provenance as any) : [],
              missing: Array.isArray(meta.missing_shapes) ? (meta.missing_shapes as any) : [],
              version: '1f',
              failure_mode: failureModeTypeForSig,
            });
          } catch { /* non-blocking */ }
        }
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
    // tasks, state_snapshot, impulse_resolutions, output_impulses go to execution_trace_content
    // via insertTraceContent dual-write (Phase B); migration 118 removed them from AET.
    // Edge learning fields
    if (trace.improvisation) optionalFields.push('improvisation: $improvisation');
    if (trace.input_impulse_shapes) optionalFields.push('input_impulse_shapes: $input_impulse_shapes');
    if (trace.output_impulse_shapes) optionalFields.push('output_impulse_shapes: $output_impulse_shapes');
    // v1 state-space signature (derived just above) — landed atomically in the INSERT.
    if ((trace as any).signature) {
      optionalFields.push('signature: $signature');
      optionalFields.push('signature_version: $signature_version');
    }
    // Failure-conditioned ('1f') signature on failed traces (consumption seam 3b,
    // migration 153). Only set when the failed-trace branch above derived it.
    if ((trace as any).repair_signature) {
      optionalFields.push('repair_signature: $repair_signature');
    }
    if (body.failure_mode) {
      (trace as any).failure_mode = body.failure_mode;
      optionalFields.push('failure_mode: $failure_mode');
    }
    if (trace.metadata) optionalFields.push('metadata: $metadata');
    // Selection-to-execution correlation
    if ((trace as any).correlation_id) optionalFields.push('correlation_id: $correlation_id');
    // Composition tracking (from three-level activity tracing)
    if ((trace as any).parent_execution_id) optionalFields.push('parent_execution_id: $parent_execution_id');
    if ((trace as any).composition_chain) optionalFields.push('composition_chain: $composition_chain');
    if (Array.isArray((trace as any).tags) && (trace as any).tags.length > 0) optionalFields.push('tags: $tags');
    // Vessel attribution + per-impulse resolver tracking (migration 086)
    if ((trace as any).vessel_id) optionalFields.push('vessel_id: $vessel_id');
    if ((trace as any).resolved_by_vessel_id) optionalFields.push('resolved_by_vessel_id: $resolved_by_vessel_id');
    if ((trace as any).vessel_version) optionalFields.push('vessel_version: $vessel_version');
    // Project ID - only include if set (MiniBob instances may not have projects)
    if (trace.project_id) optionalFields.push('project_id: $project_id');
    // Phase B2: account_id is option<string> per the deployed schema —
    // SurrealDB 3.x rejects JSON `null` against `TYPE none | string` (the
    // value coercion produces NULL, not NONE). Only emit the SET clause when
    // the caller actually provided an accountId; otherwise let the field
    // default to NONE. account_id_version is paired with account_id (only
    // meaningful when the field is written), so guard the same way.
    if ((trace as any).account_id) {
      optionalFields.push('account_id: $account_id');
      optionalFields.push('account_id_version: $account_id_version');
    }

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

    // Always use root path for AET INSERT. The $auth / $token distinction
    // in SurrealDB means JWT-auth sessions only populate $token, while the
    // AET FOR create guard checks $auth.org_id — so queryWithAuth silently
    // blocks the INSERT (PERMISSIONS evaluate false, no error, empty result).
    // HTTP-layer auth (identity-vessel) already enforces access before we
    // reach this point; the root path is safe and matches how the existing
    // 19K rows were inserted (migration 121 repairs the schema PERMISSIONS
    // to also accept $token.org_id so future authenticated SELECTs work).
    // WRITE-FLIP/decommission: activity_execution_traces is the DUAL_WRITE
    // shadow. Execute the INSERT only when the shadow is enabled; when
    // DUAL_WRITE is off, AET stops being written entirely (execution is
    // authoritative below).
    let result: any[] = [];
    if (isDualWriteEnabled()) {
      result = ((await surrealDB.query(query, trace)) as any[]) ?? [];
    }

    // Verify INSERT succeeded.
    //
    // queryWithAuth opens an authenticated SurrealDB session; PERMISSIONS
    // (FOR select on activity_execution_traces) can filter the RETURN
    // AFTER even when FOR create succeeded — the row was inserted but the
    // session can't read it back. queryWithAuth and surrealDB.query both
    // throw on actual SurrealDB errors, so a no-throw + empty-result
    // outcome is "INSERT happened, RETURN was filtered" rather than a
    // real failure. Treat null/undefined as failure (driver-level
    // breakage); empty array is success.
    if (result === null || result === undefined) {
      // WRITE-FLIP: activity_execution_traces is now the non-authoritative
      // DUAL_WRITE shadow — a null/failed AET write is logged, never fatal. The
      // authoritative `execution` write below decides request success.
      logger.warn('[aet-shadow] AET INSERT returned null/undefined (non-fatal)', {
        execution_id: trace.execution_id,
      });
      result = [];
    }
    if (result.length === 0) {
      logger.debug('INSERT succeeded but RETURN was filtered (likely PERMISSIONS)', {
        execution_id: trace.execution_id,
      });
    }

    logger.info('Execution trace stored', {
      execution_id: trace.execution_id,
      variant_id: trace.variant_id,
      success: trace.success,
      task_count: body.execution_trace?.tasks?.length || 0,
      db_result: result[0],
    });

    // ========================================================================
    // Phase B dual-write: trace_digest + execution_trace_content
    // Fire-and-forget so dual-write latency does not add to AET write P95.
    // Failures are logged but never propagate to the caller.
    // ========================================================================
    void insertTraceDigest(trace, body, jwtAuth?.jwtToken).catch((err) => {
      logger.warn('trace_digest dual-write failed', { execution_id: trace.execution_id, err: err instanceof Error ? err.message : String(err) });
    });
    void insertTraceContent(trace, jwtAuth?.jwtToken).catch((err) => {
      logger.warn('execution_trace_content dual-write failed', { execution_id: trace.execution_id, err: err instanceof Error ? err.message : String(err) });
    });
    // Burst counter for adaptive exemplar selection
    void incrementExemplarBurstCounter(trace.activity_id as string).catch(() => {});
    // trace_store_counters bookkeeping (migration 156) — O(1) row-count so the
    // reconciliation observer never has to COUNT() the AET table itself.
    void incrementTraceStoreCounter();

    // Backfill composition_chain on any already-inserted children of this
    // trace. Handles minibob's L1/L2 meta-trace write-order race where
    // children land before parent. Single best-effort UPDATE — we never fail
    // the just-succeeded insert on a backfill error.
    // Off the response hot path: best-effort + idempotent, so detach it rather
    // than awaiting a UPDATE on every insert (it ran even when there were no
    // children to backfill).
    void backfillChildCompositionChains(
      trace.execution_id,
      resolvedCompositionChain,
      jwtAuth?.jwtToken,
    ).catch((e) => logger.warn('backfillChildCompositionChains failed (non-blocking)', {
      execution_id: trace.execution_id,
      error: e instanceof Error ? e.message : String(e),
    }));

    // Derive the parent→child composition edge from the LIVE `execution` table.
    // The compose resolver stamps parent_execution_id on nested child traces,
    // but nothing turned those pairs into activity_composition_graph edges —
    // the graph had frozen. Best-effort + detached, like the chain backfill.
    if (body.parent_execution_id) {
      void deriveCompositionEdgeFromParent(
        trace.activity_id as string | undefined,
        body.parent_execution_id as string | undefined,
        trace.success === true,
        jwtAuth?.jwtToken,
        trace.execution_id as string | undefined,
        (trace.org_id as string | null | undefined) ?? undefined,
        // ★ `.catch(() => {})` swallowed every failure here. Combined with the
        //   bare early-return inside, the journal showed neither derive activity
        //   NOR errors — which reads as "never invoked" when in fact this fires
        //   on ~66% of ingests (measured) and was giving up on a parent lookup
        //   against a 12%-populated shadow table. Log it.
      ).catch((e) => logger.warn('[composition-edge] derive dispatch failed', {
        outcome: 'dispatch_failed',
        execution_id: trace.execution_id,
        error: e instanceof Error ? e.message : String(e),
      }));
    }

    // Emit fine-grained WebSocket events for real-time execution visualization
    if (body.execution_trace?.tasks && Array.isArray(body.execution_trace.tasks)) {
      const { broadcaster } = await import('../websocket/broadcaster');

      // Phase G1 (2026-04-28): denormalize tenancy fields onto each event so
      // downstream consumers (workbench, activity-dashboard, concept-db
      // ExecutionObserver) can filter by tenant without re-fetching the row.
      // Sourced from the just-built `trace` object — `traceAccountId` is the
      // resolved value (body.account_id ?? jwtAuth?.accountId ?? null).
      const broadcastAccountId: string | null = traceAccountId;
      const broadcastOrgId: string = traceOrgId;

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
            org_id: broadcastOrgId,
            account_id: broadcastAccountId,
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
                org_id: broadcastOrgId,
                account_id: broadcastAccountId,
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
            org_id: broadcastOrgId,
            account_id: broadcastAccountId,
          },
        });
      }

      // Emit impulse.resolved events — one per impulse_resolutions[] entry.
      // The broadcaster contract is formalised so workbench's
      // `routeValidationResultImpulse` no longer has to defend
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
          // Phase G1 (2026-04-28): tenancy fields denormalized from `trace`.
          const data: Record<string, unknown> = {
            execution_id: trace.execution_id,
            impulse_id: impulseId,
            resolver_id: resolverId,
            resolver_tier: resolverTier,
            vessel_id: vesselId,
            latency_ms: latencyMs,
            cost_usd: costUsd,
            timestamp: new Date().toISOString(),
            org_id: broadcastOrgId,
            account_id: broadcastAccountId,
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
    // WRITE-FLIP: `execution` is ALWAYS written (authoritative) — no DUAL_WRITE
    // gate. Its failure fails the request (rollback: revert; AET stays warm
    // while DUAL_WRITE is on).
    {
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
        // Prefer the denormalized chain (computed above) so the paradigm
        // dual-write also lands with a populated chain.
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
        // Lossless mirror of AET learning fields so `execution` carries what
        // readers need (migration 157), + cross-instance replication provenance.
        variant_id: trace.variant_id,
        status: trace.status,
        signature: (trace as any).signature,
        signature_version: (trace as any).signature_version,
        repair_signature: (trace as any).repair_signature,
        failure_mode: (trace as any).failure_mode ?? body.failure_mode,
        correlation_id: (trace as any).correlation_id,
        component_changes: trace.component_changes,
        improvisation: trace.improvisation,
        input_impulse_shapes: trace.input_impulse_shapes,
        output_impulse_shapes: trace.output_impulse_shapes,
        metadata: trace.metadata,
        tags: (trace as any).tags,
        account_id: (trace as any).account_id,
        account_id_version: (trace as any).account_id_version,
        origin_substrate_id: process.env.FED_SUBSTRATE_ID || process.env.SUBSTRATE_ID || undefined,
        origin_instance: process.env.ACTIVITY_API_INSTANCE_ID || process.env.VESSEL_ID || undefined,
        // Persist the honest-reach verdict at write time so `execution.reached`
        // is queryable (previously NONE on ~all rows). Only set when the trace
        // carries an explicit verdict — ungraded/legacy traces leave the column
        // NONE rather than fabricating a boolean (mirrors classifyReach's tag
        // authority). A later reach write-back can still set it.
        // CONTRADICTION GUARD (task #55, 2026-08-10). The verdict below is a pure
        // pass-through of whatever the writer claimed, and the SAME record carries
        // failure_mode. Nothing compared them, so `reached: true` was persisted on
        // executions whose own trace said the walk THREW
        // (failure_mode.type = 'execution_error') and produced no shapes.
        //
        // A reach verdict is a claim about the goal; a hard failure mode is the
        // execution's own testimony that it did not complete. When they disagree,
        // the execution's testimony wins: it is mechanical, while the verdict may
        // come from a grader that never saw the throw. Downgrading to `false`
        // rather than `undefined` is deliberate — this is graded evidence, not an
        // ungraded row, and leaving it NONE would hide a real negative from the
        // learner exactly like the `0 introduced` gate did.
        //
        // Narrow ON PURPOSE: only failure modes that mean "did not run to
        // completion". `budget_exhausted` is NOT included — a walk can legitimately
        // reach its goal and then exceed a budget on the way out, and treating that
        // as unreached would erase real successes.
        reached: reachedVerdict(
          typeof (body as any).reached === 'boolean' ? (body as any).reached
          : typeof (trace as any).reached === 'boolean' ? (trace as any).reached
          : Array.isArray((trace as any).tags) && (trace as any).tags.includes('reached:true') ? true
          : Array.isArray((trace as any).tags) && (trace as any).tags.includes('reached:false') ? false
          : undefined,
          body.failure_mode?.type,
        ),
        version: 0,
      };

      // Dual-write STAYS enabled, but detached from the response hot path so the
      // trace-ingest response no longer blocks on a second full-trace insert.
      // WRITE-FLIP: `execution` is the AUTHORITATIVE write — awaited + blocking.
      // insertExecution rethrows real DB errors; they propagate to the outer
      // catch below (-> handler outer catch: duplicate => idempotent 200, else
      // 500). A null result is a successful system-track/empty-RETURN write
      // (null == success).
      const paradigmResult = await insertExecution(paradigmExecution, jwtAuth?.jwtToken);
      if (paradigmResult) {
        logger.info('[paradigm] Execution trace written to AUTHORITATIVE execution table', {
          id: trace.execution_id,
          activity_id: trace.variant_id,
          path: 'authoritative',
        });
      }
      } catch (paradigmError) {
        // WRITE-FLIP: `execution` is authoritative — its failure fails the
        // request (rollback: revert this commit; DUAL_WRITE keeps AET warm).
        // Duplicate redelivery surfaces as "already exists" and is mapped to an
        // idempotent 200 by the handler's outer catch.
        logger.error('[paradigm] Authoritative execution write failed', {
          execution_id: trace.execution_id,
          error: paradigmError instanceof Error ? paradigmError.message : String(paradigmError),
        });
        throw paradigmError;
      }
    } // end execution authoritative write

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
      // Thompson α/β posteriors are written by applyOutcomeToPosteriors (below)
      // to variant_performance_metrics using stratified deltas. Writing α/β here
      // to activity_template was retired (Phase 1, surrealdb-rl-layer) — writes
      // to activity_template invalidate the BM25 FTS scorer (F-V46 regression).
      // Counters (total_executions, last_executed_at) are kept for dashboard display.
      const updateQuery = `
        UPDATE activity_template
        SET
          total_executions = (total_executions ?? 0) + 1,
          successful_executions = (successful_executions ?? 0) + $success_delta,
          failed_executions = (failed_executions ?? 0) + $failure_delta,
          last_executed_at = time::now()
        WHERE (record::id(id) = $activity_id OR name = $activity_id)
          AND (org_id = $org_id OR org_id = $org_id_alt)
        RETURN { id: id, total_executions: total_executions }
      `;

      // NOTE: We do NOT write Thompson posteriors to the `activity` table.
      // Any write to `activity` invalidates the BM25 FTS scorer (SurrealDB 3.0
      // regression, F-V46), keeping fts_score=0 permanently at ~27 writes/min.
      // The canonical posterior store is `variant_performance_metrics` (below).
      // The recommendation read path (activities.ts:4540) already prioritises
      // scores?.alpha from that table over activity.thompson_alpha.

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

        const combinedResult = (updateResult && updateResult.length > 0) ? updateResult : null;

        if (combinedResult && combinedResult.length > 0) {
          if (candidateId === trace.variant_id) {
            primaryUpdateMatched = true;
          }
          logger.info('[learning] activity_template counters updated (posteriors via applyOutcomeToPosteriors)', {
            execution_id: trace.execution_id,
            activity_id: candidateId,
            via_metadata_template_id: candidateId !== trace.variant_id,
            table: 'activity_template',
            success: trace.success,
            total_executions: combinedResult[0].total_executions,
          });

          // FIX 3: Invalidate Redis cache to ensure fresh scores in next recommendation
          try {
            const { RedisClient } = await import('../db/redis');
            const redis = RedisClient.getInstance();

            // Invalidate ONLY the specific template cache. Do NOT del CACHE_LIST_KEY: the list set
            // tracks template EXISTENCE not scores; removing it on every trace store empties the
            // set so every /templates + /recommend full-scans the template store (the CPU floor).
            // Mirrors the documented-correct posterior path in activities.ts (~2036).
            const CACHE_KEY_PREFIX = 'activity:template:';

            await redis.del(`${CACHE_KEY_PREFIX}${candidateId}`);

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
          logger.warn('[learning] Thompson Sampling score update returned no results in either table', {
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

      // v1 state-space signature: read from body.metadata or derive server-side.
      // Passed to applyOutcomeToPosteriors so it can write a stratified v1 row
      // to context_thompson_scores alongside the v0 context_bucket row below.
      let v1Sig: string | undefined;
      let v1SigVersion: number | undefined;
      {
        const rawSig = (body as any).metadata?.state_space_signature;
        const rawVer = (body as any).metadata?.signature_version;
        if (typeof rawSig === 'string' && /^[0-9a-f]{16}$/.test(rawSig) &&
            typeof rawVer === 'number' && Number.isInteger(rawVer) && rawVer >= 1) {
          v1Sig = rawSig;
          v1SigVersion = rawVer;
        } else {
          // C6: widen coverage — fall back to per-task / output shapes already on
          // the trace when input_impulse_shapes is absent, so the cts conditional
          // posterior is keyed (and matches the recommend read-side derivation).
          const sigShapes = deriveSignatureShapes(trace);
          if (sigShapes.length > 0) {
            try {
              const { computeStateSpaceSignature } = await import('../utils/session-context');
              v1Sig = computeStateSpaceSignature({
                shapes: sigShapes,
                provenance: Array.isArray((body as any).metadata?.provenance) ? (body as any).metadata.provenance : [],
                missing: Array.isArray((body as any).metadata?.missing_shapes) ? (body as any).metadata.missing_shapes : [],
              });
              v1SigVersion = 1;
            } catch { /* non-blocking */ }
          }
        }
      }

      // Honest-reach verdict, computed once and reused across ALL posterior sinks in
      // this handler (applyOutcomeToPosteriors, successor-features, context-bucket, the
      // dual-write INSERT seed) so an ungraded/hollow outcome is neither credited nor
      // blamed on ANY of them — the gate boundary must match the side-effect cluster.
      const reachVerdict = classifyReach({
        success: trace.success as boolean,
        execution_id: trace.execution_id as string | undefined,
        activity_id: trace.variant_id as string,
        tags: Array.isArray((trace as any).tags) ? ((trace as any).tags as string[]) : undefined,
      });
      const reachUngraded = reachVerdict === 'ungraded';
      const reachEffectiveSuccess = reachVerdict === 'reached';

      applyOutcomeToPosteriors(
        {
          activity_id: trace.variant_id as string,
          success: trace.success as boolean,
          failure_mode: (body.failure_mode ?? null) as any,
          tasks: trace.tasks as any,
          cost_usd: trace.cost_usd as number,
          ...(typeof trace.execution_id === 'string' ? { execution_id: trace.execution_id as string } : {}),
          ...(Array.isArray((trace as any).tags) && (trace as any).tags.length > 0 ? { tags: (trace as any).tags as string[] } : {}),
          ...(resolvedCompositionChain.length > 0 ? { composition_chain: resolvedCompositionChain } : {}),
          ...(v1Sig ? { signature: v1Sig, signature_version: v1SigVersion } : {}),
          // §7 horizontal-composition fan-out width, surfaced from the engine via
          // body.metadata.siblingGroupSize, so chain-credit averages over siblings
          // instead of k-fold-summing at shared ancestors.
          ...(typeof (body.metadata as { siblingGroupSize?: unknown } | undefined)?.siblingGroupSize === 'number'
            ? { sibling_group_size: (body.metadata as { siblingGroupSize: number }).siblingGroupSize }
            : {}),
          // D2.3: pass the originating shapes so applyOutcomeToPosteriors can
          // fire-and-forget embed the signature's semantic content (shape set).
          ...(v1Sig && Array.isArray(body.input_impulse_shapes) && body.input_impulse_shapes.length > 0
            ? { input_impulse_shapes: body.input_impulse_shapes }
            : {}),
        },
        surrealDB,
        trace.org_id as string,
      ).catch((err) => {
        logger.warn('[18.3.3] applyOutcomeToPosteriors failed (non-blocking)', {
          execution_id: trace.execution_id,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // RETIREMENT, on the route the fleet actually posts to (2026-08-16).
      //
      // The pre-existing trigger sits in `POST /v2/activities/executions` (routes/activities.ts),
      // which nothing in the fleet calls, and reads `FROM execution`, which this handler does not
      // write — so no walk outcome has ever reached it. Measured consequence on the live hub:
      // `retired_reason = "poor_performance"` appears on ZERO rows, while an arm at posterior mean
      // 0.0087 with 395 executions stayed fully selectable. See checkAndRetireByPosterior for the
      // other two reasons that trigger could not have fired even if it were called.
      //
      // Gated on a GRADED FAILURE — the same reach boundary the posterior write above uses. That is
      // deliberate rate-limiting, not caution for its own sake: an arm can only retire on the tick
      // where it freshly earns blame, so retirement trickles instead of sweeping. Fire-and-forget,
      // like every other side effect in this cluster; it must never delay trace ingest.
      if (!reachUngraded && !reachEffectiveSuccess) {
        void import('../services/variant-creator')
          .then(({ checkAndRetireByPosterior }) =>
            checkAndRetireByPosterior(trace.variant_id as string, trace.org_id as string, traceAccountId),
          )
          .then(async (wasRetired) => {
            if (!wasRetired) return;
            logger.info('[retirement] arm retired on posterior evidence', {
              activity_id: trace.variant_id,
              execution_id: trace.execution_id,
            });
            const { broadcaster: retireBroadcaster } = await import('../websocket/broadcaster');
            retireBroadcaster.emit({
              type: 'template_retired',
              timestamp: new Date().toISOString(),
              data: {
                activity_id: trace.variant_id as string,
                reason: 'poor_performance',
                org_id: (trace.org_id as string) ?? null,
                account_id: traceAccountId ?? null,
              },
            });
          })
          .catch((err) => {
            logger.warn('[retirement] posterior retirement check failed (non-blocking)', {
              activity_id: trace.variant_id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      // Successor features ψ(s,a) — learning-rate mechanism #7. Accumulate this
      // trace's discounted shape-occupancy into the (signature, template) cell.
      // ADDITIVE, env-flagged (SUCCESSOR_FEATURES, default ON), fire-and-forget —
      // mirrors the chain-credit path. Keyed on the same v1 signature the
      // conditional Thompson posterior uses, so ψ rides one-to-one alongside R.
      if (v1Sig && !reachUngraded) {   // ungraded: trace's claimed output shapes are untrustworthy; do not accumulate psi
        // Use the RAW execution_trace.tasks (which carry per-task
        // output_impulse_shapes / outputShapes) for the discounted occupancy
        // walk — the normalized `trace.tasks` projection drops shape arrays.
        // Falls back to top-level body.tasks then trace-level output shapes.
        const sfTasks =
          (Array.isArray((body as any).execution_trace?.tasks) && (body as any).execution_trace.tasks.length > 0
            ? (body as any).execution_trace.tasks
            : Array.isArray((body as any).tasks) && (body as any).tasks.length > 0
              ? (body as any).tasks
              : trace.tasks) as any;
        updateSuccessorFeatures(
          {
            activity_id: trace.variant_id as string,
            signature: v1Sig,
            output_impulse_shapes: (trace as any).output_impulse_shapes,
            tasks: sfTasks,
            completion_shapes: (body as any).completion_shapes ?? (trace as any).completion_shapes ?? [],
            missing: (body as any).missing ?? (trace as any).missing ?? [],
          },
          surrealDB,
          trace.org_id as string,
        ).catch((err) => {
          logger.warn('successor-features: update failed (non-blocking)', {
            execution_id: trace.execution_id,
            error: err instanceof Error ? err.message : String(err),
          });
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

    // Honest-reach verdict (local to this scope): ungraded => skip the context bandit
    // write; otherwise credit/penalize the bucket on the REACH verdict, not exit-status.
    const ctxReach = classifyReach({
      success: trace.success as boolean,
      execution_id: trace.execution_id as string | undefined,
      activity_id: trace.variant_id as string,
      tags: Array.isArray((trace as any).tags) ? ((trace as any).tags as string[]) : undefined,
    });
    const ctxUngraded = ctxReach === 'ungraded';
    const ctxEffectiveSuccess = ctxReach === 'reached';

    if (isValidBucket(rawContextBucket) && !ctxUngraded) {
      try {
        const ctxAlphaDelta = ctxEffectiveSuccess ? 1 : 0;
        const ctxBetaDelta  = ctxEffectiveSuccess ? 0 : 1;

        // Phase B2: dual-tenant LET/UPDATE/CREATE. Reads use the dual-tenant
        // WHERE; writes carry account_id + account_id_version=1.
        // context_thompson_scores requires $token.org_id IS NOT NONE for
        // create/update (migration 099) — use inbound JWT when available.
        const ctxSql = `
          LET $existing = (SELECT * FROM context_thompson_scores
            WHERE ${accountIdScopedWhere()} AND template_id = $template_id AND context_bucket = $bucket
            LIMIT 1);
          IF array::len($existing) > 0 THEN
            UPDATE context_thompson_scores
            SET alpha = alpha + $alpha_delta,
                beta  = beta  + $beta_delta,
                n_observations = n_observations + 1,
                last_updated_at = time::now()
            WHERE ${accountIdScopedWhere()} AND template_id = $template_id AND context_bucket = $bucket
          ELSE
            CREATE context_thompson_scores CONTENT {
              org_id: $org_id,
              -- account_id is option<string>: a JS null binds as SurrealDB NULL, which
              -- violates option<string> (NONE | string, never NULL) and aborts the
              -- account_id-keyed re-derive UPDATE path. Coerce NULL -> NONE at write time.
              -- NOT COALESCE: SurrealDB has no such function, so the whole statement failed to
              -- PARSE and every new context bucket silently failed to be created — the error was
              -- caught as "non-blocking" and logged 172 times in two hours while contextual
              -- Thompson scoring quietly had no write path. COALESCE(..., 'NONE') would also
              -- have stored the STRING 'NONE' rather than the NONE value, so it was wrong twice.
              -- This is the idiom already used for the same coercion further down this file.
              account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
              account_id_version: 1,
              template_id: $template_id,
              context_bucket: $bucket,
              alpha: 1.0 + $alpha_delta,
              beta:  1.0 + $beta_delta,
              n_observations: 1,
              last_updated_at: time::now(),
              created_at: time::now()
            }
          END
        `;
        const ctxParams = {
          org_id: traceOrgId,
          account_id: traceAccountId,
          template_id: trace.variant_id,
          bucket: rawContextBucket,
          alpha_delta: ctxAlphaDelta,
          beta_delta: ctxBetaDelta,
        };
        if (jwtAuth?.jwtToken) {
          await queryWithAuth(jwtAuth.jwtToken, ctxSql, ctxParams);
        } else {
          await surrealDB.query(ctxSql, ctxParams);
        }

        logger.debug('[learning] context_thompson_scores updated', {
          execution_id: trace.execution_id,
          context_bucket: rawContextBucket,
          success: trace.success,
        });

        // D4.3 — coarsening write for the legacy inline v0 bucket. Mirrors the
        // leaf delta onto the bucket's cluster posterior when a cluster assignment
        // exists (v0 buckets are not currently clustered, so this typically skips
        // as skipped_no_assignment — the correct degraded path). Non-throwing.
        void applyClusterPosterior(surrealDB, {
          orgId: traceOrgId,
          templateId: trace.variant_id as string,
          signature: rawContextBucket,
          signatureVersion: 0,
          alphaDelta: ctxAlphaDelta,
          betaDelta: ctxBetaDelta,
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

        // Phase B2: dual-tenant LET/UPDATE/CREATE for the rederived path.
        // Same PERMISSIONS constraint as primary bucket path above.
        const rdSql = `
          LET $existing = (SELECT * FROM context_thompson_scores
            WHERE ${accountIdScopedWhere()} AND template_id = $template_id AND context_bucket = $bucket
            LIMIT 1);
          IF array::len($existing) > 0 THEN
            UPDATE context_thompson_scores
            SET alpha = alpha + $alpha_delta,
                beta  = beta  + $beta_delta,
                n_observations = n_observations + 1,
                last_updated_at = time::now()
            WHERE ${accountIdScopedWhere()} AND template_id = $template_id AND context_bucket = $bucket
          ELSE
            CREATE context_thompson_scores CONTENT {
              org_id: $org_id,
              -- account_id is option<string>: coerce JS-null -> NONE so it satisfies
              -- option<string> (never NULL). Same fix as the primary bucket write above.
              -- NOT COALESCE — SurrealDB has no such function; see the note there.
              account_id: IF $account_id IS NULL THEN NONE ELSE $account_id END,
              account_id_version: 1,
              template_id: $template_id,
              context_bucket: $bucket,
              alpha: 1.0 + $alpha_delta,
              beta:  1.0 + $beta_delta,
              n_observations: 1,
              last_updated_at: time::now(),
              created_at: time::now()
            }
          END
        `;
        const rdParams = {
          org_id: traceOrgId,
          account_id: traceAccountId,
          template_id: trace.variant_id,
          bucket: rederived,
          alpha_delta: rdAlphaDelta,
          beta_delta: rdBetaDelta,
        };
        if (jwtAuth?.jwtToken) {
          await queryWithAuth(jwtAuth.jwtToken, rdSql, rdParams);
        } else {
          await surrealDB.query(rdSql, rdParams);
        }

        // D4.3 — coarsening write for the re-derived legacy inline v0 bucket.
        // Same degraded path as the primary bucket above. Non-throwing.
        void applyClusterPosterior(surrealDB, {
          orgId: traceOrgId,
          templateId: trace.variant_id as string,
          signature: rederived,
          signatureVersion: 0,
          alphaDelta: rdAlphaDelta,
          betaDelta: rdBetaDelta,
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
      // Phase E: route the duplicate detection through a deterministic
      // record-id slug keyed on (variant_id, account_id) so different
      // accounts in the same org get separate posteriors. The id is bound
      // per-candidate below — we intentionally do not bake it into the SQL
      // template here so a single template handles all candidate ids.
      // Refactored 2026-04-30: SELECT-by-composite → UPDATE-existing /
      // INSERT-new (JS-side branching). Mirrors activities.ts metrics
      // path. Avoids ON DUPLICATE KEY UPDATE keying on PRIMARY KEY (id)
      // when legacy rows have non-deterministic random-id slugs.
      // Composite UNIQUE INDEX idx_variant_performance_variant_id
      // (migration 100) on (variant_id, account_id) is the matching key.
      const variantMetricsFindExisting = `
        SELECT id FROM variant_performance_metrics
          WHERE variant_id = $variant_id
            AND (account_id IS $account_id OR (account_id IS NONE AND $account_id IS NULL))
          LIMIT 1
      `;
      // α/β posteriors omitted here — applyOutcomeToPosteriors (site 1 above)
      // writes them with stratified deltas. Keeping both would double-increment.
      const variantMetricsUpdate = `
        UPDATE $id SET
          total_executions = (total_executions ?? 0) + 1,
          successful_executions = (successful_executions ?? 0) + $success_delta,
          failed_executions = (failed_executions ?? 0) + $failure_delta,
          -- <float> CAST IS LOAD-BEARING. successful_executions and total_executions are
          -- both TYPE int, and SurrealQL int/int truncates — so this expression could only
          -- ever yield 0 or 1. Measured on the live hub: every sampled success_rate is
          -- exactly 0.0 or 1.0, with ZERO fractional values anywhere in the column.
          --
          -- It is not a cosmetic reporting error. services/task-generator.ts selects
          -- a WHERE success_rate < threshold filter (:209), writes the number into goal text as
          -- 'has N% success rate' (:254), and sets priority = critical when the rate is under 0.3 (:255). So an arm running at 98.6% truncates to 0 and the
          -- substrate mints itself a CRITICAL goal asserting it has a 0% success rate —
          -- false work, at top priority, continuously, about a healthy arm.
          -- The same cast is already used correctly at :3598.
          success_rate = (<float> ((successful_executions ?? 0) + $success_delta)) / (<float> ((total_executions ?? 0) + 1)),
          avg_duration_ms = (((avg_duration_ms ?? 0) * (total_executions ?? 0)) + $duration_ms) / ((total_executions ?? 0) + 1),
          avg_cost_usd = (((avg_cost_usd ?? 0) * (total_executions ?? 0)) + $cost) / ((total_executions ?? 0) + 1),
          last_executed_at = time::now(),
          updated_at = time::now()
        RETURN AFTER;
      `;
      const variantMetricsInsert = `
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
          -- Seed as a float for the same reason: an INSERT of the int 1 or 0 starts the
          -- row off in the binary regime even before the UPDATE above ever runs.
          success_rate: <float> $success_delta,
          avg_duration_ms: $duration_ms,
          avg_cost_usd: $cost,
          thompson_alpha: $seed_alpha,
          thompson_beta: $seed_beta,
          total_selections: 0,
          last_executed_at: time::now(),
          created_at: time::now(),
          updated_at: time::now()
        } RETURN AFTER;
      `;

      const metricsCandidateIds = resolveTemplateIdsForUpdate({
        variantId: trace.variant_id,
        metadata: body.metadata,
      });

      // Honest-reach verdict (local to the INSERT-seed scope) for first-execution seeding.
      const seedReach = classifyReach({
      success: trace.success as boolean,
      execution_id: trace.execution_id as string | undefined,
      activity_id: trace.variant_id as string,
      tags: Array.isArray((trace as any).tags) ? ((trace as any).tags as string[]) : undefined,
    });
      const seedUngraded = seedReach === 'ungraded';
      const seedEffectiveSuccess = seedReach === 'reached';
      for (const candidateId of metricsCandidateIds) {
        const variantMetricsParams = {
          // Phase E: account-keyed record-id slug; legacy `<variant>` slug
          // when account_id is null so pre-Phase-E rows keep their key.
          record_id_slug: variantMetricsRecordId(candidateId, traceAccountId),
          variant_id: candidateId,
          org_id: traceOrgId,
          // Phase B2: account_id propagated from the request's auth context.
          // null when caller has no accountId; option<string> in schema.
          account_id: traceAccountId,
          success_delta: trace.success ? 1 : 0,
          failure_delta: trace.success ? 0 : 1,
          // Honest-reach gate-seed for a template's FIRST execution (the INSERT path):
          // reached/legacy -> (2,1) credit, not-reached -> (1,2) penalize, ungraded -> (1,1) neutral.
          // Race-immune (the INSERT is the write itself), unlike neutralizing to (1,1).
          seed_alpha: seedUngraded ? 1 : (seedEffectiveSuccess ? 2 : 1),
          seed_beta:  seedUngraded ? 1 : (seedEffectiveSuccess ? 1 : 2),
          duration_ms: trace.duration_ms || 0,
          cost: trace.cost_usd || 0,
        };

        // Always use root path for variant_performance_metrics writes — mirrors
        // the AET INSERT fix (line 1836). FOR create uses $auth which is NONE
        // for TYPE JWT access ($token gets the claims, not $auth). HTTP-layer
        // auth (identity-vessel) already enforces access before we reach here.
        const findRows = await surrealDB.query<{ id: string }>(variantMetricsFindExisting, {
          variant_id: variantMetricsParams.variant_id,
          account_id: variantMetricsParams.account_id,
        });
        const existingId = Array.isArray(findRows) && findRows.length > 0
          ? (findRows[0] as { id?: string }).id
          : undefined;

        const opQuery = existingId ? variantMetricsUpdate : variantMetricsInsert;
        const opParams = existingId
          ? { id: existingId, ...variantMetricsParams }
          : variantMetricsParams;
        const variantMetricsResult = (await surrealDB.query<any>(opQuery, opParams)) as any[];

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
      // Fire and forget - don't block the response.
      // Phase B-followup: thread accountId so dual-write fires.
      updateShapeActivityScores(
        trace.variant_id,
        inputShapes,
        trace.success,
        traceOrgId,
        jwtAuth?.jwtToken ?? null,
        traceAccountId
      )
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

    // Emit execution_completed so external WS observers (e.g. development-vessel
    // topology chain) can react without polling. Non-blocking; failure is silent.
    void import('../websocket/broadcaster').then(({ broadcaster }) => {
      broadcaster.emit({
        type: 'execution_completed',
        timestamp: new Date().toISOString(),
        data: {
          execution_id: trace.execution_id,
          activity_id: trace.variant_id || (body as Record<string, unknown>)['template_id'] as string || (body as Record<string, unknown>)['activity_id'] as string || '',
          variant_id: trace.variant_id || '',
          success: trace.success,
          // Task census (2026-08-02). The ribosome gates template extraction on
          // "reached AND at least one task succeeded AND none failed", but it was
          // counting tasks from per-task WS events that mostly never reach it —
          // so it saw `completed=0` on the overwhelming majority of reached
          // executions and NEVER dispatched an extraction (0 in 12h, measured).
          // This emitter already holds the authoritative trace, so it forwards
          // the census rather than making every observer re-derive it.
          task_count: Array.isArray(trace.tasks) ? trace.tasks.length : 0,
          // Counted POSITIVELY, not as (total - failed). A task's status is
          // 'pending' | 'in_progress' | 'completed' | 'failed', so a run
          // abandoned mid-flight persists non-terminal tasks; subtracting only
          // failures would score those as successes and let an observer treat a
          // partial execution as a clean one.
          // TWO VOCABULARIES. The TaskRecord type declares
          // 'pending' | 'in_progress' | 'completed' | 'failed', but the write path
          // at ~:415 persists `t.success === false ? 'failure' : 'success'` — so
          // real rows carry 'success'/'failure' and the declared type is aspirational.
          // Counting only the declared spelling returns 0 on every real trace, which
          // reads identically to "nothing succeeded" and silently disables any
          // consumer gating on it. Accept both spellings; anything else (pending /
          // in_progress) is deliberately counted as NEITHER, so a run abandoned
          // mid-flight cannot pass for a clean one.
          completed_task_count: Array.isArray(trace.tasks)
            ? trace.tasks.filter((t) => t?.status === 'completed' || (t as { status?: string })?.status === 'success').length
            : 0,
          failed_task_count: Array.isArray(trace.tasks)
            ? trace.tasks.filter((t) => t?.status === 'failed' || (t as { status?: string })?.status === 'failure').length
            : 0,
          duration_ms: trace.duration_ms || 0,
          cost: trace.cost_usd || 0,
          completed_at: new Date().toISOString(),
          org_id: traceOrgId || null,
        },
      });
    }).catch(() => { /* non-fatal */ });

    return c.json({
      success: true,
      execution_id: trace.execution_id,
      stored: true,
      trace: result[0],
    });

  } catch (error) {
    // Idempotent duplicate delivery (2026-07-07): trace forwarding is
    // at-least-once (TranslatingTraceSink spools + replays on lost responses),
    // so a re-POST hitting the unique index idx_activity_executions_execution_id
    // means the trace is already durably stored — success, not a 500. Returning
    // 500 here put the sink into a permanent retry loop (43 already-delivered
    // traces replayed 4,200+ times/day against the hub store).
    const dupMsg = error instanceof Error ? error.message : String(error);
    if (
      (dupMsg.includes('already contains') && dupMsg.includes('execution_id')) ||
      // WRITE-FLIP: the authoritative `execution` INSERT throws a record-level
      // "already exists" on redelivery — also idempotent, not a 500.
      (dupMsg.includes('already exists') && dupMsg.includes('execution:'))
    ) {
      logger.info('Duplicate trace delivery, already stored', { message: dupMsg.slice(0, 200) });
      return c.json({ success: true, stored: false, duplicate: true }, 200);
    }

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
      selectionConditions.push('sel.selected_at >= type::datetime($start_date)');
      params.start_date = startDate;
    }

    if (endDate) {
      selectionConditions.push('sel.selected_at <= type::datetime($end_date)');
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
    // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
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
        FROM execution
        WHERE correlation_id IN $correlation_ids
      `;

      let executions: any[];
      // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
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
    // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
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

    // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
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
    // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
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

    // API-key auth produces a JWT with `id: api_key:N` which SurrealDB
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

// ---------------------------------------------------------------------------
// Param route LAST. hono 4.x matches in registration order, so `/:executionId`
// swallows every literal sibling registered after it — that is how
// /selection-events, /selection-outcomes, /selection-calibration and
// /calibration-summary all came to 404 with this handler's own
// {"error":"Execution trace not found"} body. `/exemplars` escaped only
// because it happens to be registered above. Keep this block below every
// literal GET on this router.
// ---------------------------------------------------------------------------
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
      SELECT * FROM v_paradigm_execution_traces
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

    // UNION-GAP FIX (2026-07-02, reason plane): the single-trace GET only
    // consulted activity_execution_traces (wrappers keyed by the execution_id
    // FIELD). ias-executor paradigm-walk executions land in the `execution`
    // table keyed by RECORD ID (execution:<id>) with the execution_id field
    // NULL — so `WHERE execution_id = $id` never matched them and template-walk
    // traces 404'd here, leaving goal_reasoning with no per-task detail. Mirror
    // the LIST path's paradigm union: fall back to the `execution` table by
    // record id before declaring not-found. (Satisfier-only reaches persist no
    // execution row at all — their reasoning lives in the goal-host walkLog.)
    let traceRow: ExecutionTrace | undefined = result?.[0];
    if (!traceRow) {
      try {
        const paradigmRows = await surrealDB.query<any>(
          `SELECT * FROM type::thing('execution', $eid) LIMIT 1`,
          { eid: executionId },
        );
        const p = paradigmRows?.[0];
        if (p) {
          const rowId = typeof p.id === 'string'
            ? (p.id.includes(':') ? p.id.split(':').pop()!.replace(/[⟨⟩]/g, '') : p.id)
            : String(p.id ?? '');
          traceRow = {
            ...p,
            execution_id: p.execution_id || rowId || executionId,
            activity_id: p.activity_id,
            status: p.status,
            created_at: p.created_at || p.executed_at,
            error_message: p.error?.message ?? p.error_message,
            tasks: p.trace?.tasks ?? p.tasks ?? [],
          } as ExecutionTrace;
          logger.info('[paradigm-union] single-GET fell back to paradigm execution table', { executionId });
        }
      } catch (paradigmError) {
        logger.warn('[paradigm-union] single-GET paradigm fallback failed', {
          executionId,
          error: paradigmError instanceof Error ? paradigmError.message : String(paradigmError),
        });
      }
    }

    if (!traceRow) {
      logger.warn('Execution trace not found in database', {
        executionId,
        params: { execution_id: executionId },
      });
      return c.json({
        error: 'Execution trace not found',
        execution_id: executionId,
      }, 404);
    }

    const trace = traceRow;

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

    // Phase C: consult execution_trace_content first (split-write path).
    // If absent, the inline AET fields carry the full payload (legacy path).
    let contentSource: 'split' | 'legacy' = 'legacy';
    let contentOverride: Record<string, unknown> = {};
    try {
      const contentRows = await surrealDB.query<{
        tasks: unknown; state_snapshot: unknown; impulse_resolutions: unknown; output_impulses: unknown;
      }>(`SELECT tasks, state_snapshot, impulse_resolutions, output_impulses FROM execution_trace_content WHERE execution_id = $eid LIMIT 1`, { eid: executionId });
      if (contentRows && contentRows.length > 0) {
        contentSource = 'split';
        const cr = contentRows[0];
        contentOverride = {
          tasks: cr.tasks,
          state_snapshot: cr.state_snapshot,
          impulse_resolutions: cr.impulse_resolutions,
          output_impulses: cr.output_impulses,
        };
      }
    } catch (contentErr) {
      logger.warn('execution_trace_content read failed; falling back to legacy AET fields', { executionId, err: contentErr instanceof Error ? contentErr.message : String(contentErr) });
    }
    if (contentSource === 'legacy') {
      logger.info('trace content source: legacy (Phase D gate)', { executionId, content_source: contentSource });
    } else {
      logger.debug('trace content source', { executionId, content_source: contentSource });
    }

    // The v_paradigm compat view no longer carries `trace AS execution_trace` or
    // `trace.tasks AS tasks` (migration-167). Hydrate the trace blob (and tasks
    // for the legacy, non-split path) from the canonical `execution` row so the
    // response shape is unchanged. Single point-lookup by record id.
    try {
      const blobRows = await surrealDB.query<any>(
        `SELECT trace, trace.tasks AS tasks FROM type::thing('execution', $eid) LIMIT 1`,
        { eid: (trace as any).execution_id || executionId },
      );
      const b = Array.isArray(blobRows) ? blobRows[0] : undefined;
      if (b) {
        (trace as any).execution_trace = b.trace ?? (trace as any).execution_trace ?? null;
        if (contentSource !== 'split' && !(Array.isArray((trace as any).tasks) && (trace as any).tasks.length > 0)) {
          (trace as any).tasks = Array.isArray(b.tasks) ? b.tasks : [];
        }
      }
    } catch (blobErr) {
      logger.warn('trace blob hydrate failed', { executionId, err: blobErr instanceof Error ? blobErr.message : String(blobErr) });
    }

    // Return trace with optional selection data
    // Ensure execution_id is populated (use SurrealDB id as fallback for legacy data)
    const traceNormalized: any = {
      ...trace,
      ...(contentSource === 'split' ? contentOverride : {}),
      execution_id: trace.execution_id || (trace as any).id?.toString().split(':')[1] || (trace as any).id,
      selection_attribution: selectionData,
      content_source: contentSource,
    };

    // Read-time fallback: same contract as list handler.
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

// Append goal-host WALK deliberation steps onto an already-persisted trace, keyed
// by execution_id. The walk's reasoning (backward-chain decisions, bridge/decomp
// authoring, gap-detection, per-step pick + the considered-but-rejected candidate
// set) was previously console.log-only and lost to learning; this lands it durably
// so the substrate can learn from HOW it reaches goals, not just outcomes.
//
// REUSE, NOT a new schema: the steps are appended into the trace's existing
// FLEXIBLE `impulse_resolutions[]` array (migration 094 — TYPE array<object>
// FLEXIBLE), each tagged `{ deliberation: true, shape, ... }`. No new table, no new
// SCHEMAFULL field (which would silently drop). Each step carries its own
// `input_impulse_ids` (the pool shapes/ids the decision saw) so co-occurrence /
// Thompson can later condition on the reasoning. Root write on purpose, same
// rationale as /reach below — an org-scoped UPDATE would silently no-op for ApiKey
// callers whose org differs from the trace's org. Strictly additive + non-fatal:
// a failed append never affects the walk. (2026-06-27)
app.post('/deliberation', async (c) => {
  try {
    const body = await c.req.json();
    const execId = body.execution_id;
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (!execId || steps.length === 0) {
      return c.json({ error: 'execution_id (string) and non-empty steps[] required' }, 400);
    }
    // Bound the payload defensively (the walk already caps, this is belt-and-braces):
    // at most 60 steps, candidate lists already truncated client-side.
    const tagged = steps.slice(0, 60).map((s: Record<string, unknown>) => ({
      ...s,
      deliberation: true,
      resolver_tier: 'deliberation',
      recorded_at: new Date().toISOString(),
    }));
    // Append to the existing FLEXIBLE impulse_resolutions[] (concat, preserve prior).
    const res = await surrealDB.query(
      `UPDATE activity_execution_traces
         SET impulse_resolutions = array::concat(impulse_resolutions ?? [], $steps)
       WHERE execution_id = $execution_id`,
      { steps: tagged, execution_id: String(execId) },
    );
    // WRITE-FLIP: mirror onto the authoritative `execution` row (point update by
    // record id; non-fatal — a shadow-patch miss never fails the request).
    try {
      await surrealDB.query(
        `UPDATE type::thing('execution', $execution_id)
           SET impulse_resolutions = array::concat(impulse_resolutions ?? [], $steps)`,
        { steps: tagged, execution_id: String(execId) },
      );
    } catch (e) {
      logger.warn('[deliberation-patch] execution mirror update failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
    }
    const updated = Array.isArray(res) && Array.isArray(res[0]) ? (res[0] as unknown[]).length : (Array.isArray(res) ? res.length : 0);
    return c.json({ success: true, execution_id: String(execId), appended: tagged.length, updated }, 200);
  } catch (err) {
    logger.warn('[deliberation-patch] failed to append deliberation steps on trace', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Patch the reach-gate verdict onto an already-persisted trace. POST '/' INSERTs
// the trace BEFORE the goal-host reach gate runs (the gate is post-execution), so
// `reached` / `completion_shapes` can only be written back here, keyed by
// execution_id. This lands the decision-outcome on the trace row so per-signature
// reach-rate is queryable (join `reached` against `signature`) — the C6
// selection-quality metric. Root write on purpose: an org-scoped UPDATE would
// silently no-op for ApiKey callers whose org differs from the trace's org — the
// exact silent-drop class this whole pass removes. (2026-06-26)
app.post('/reach', async (c) => {
  try {
    const body = await c.req.json();
    const execId = body.execution_id;
    if (!execId || typeof body.reached !== 'boolean') {
      return c.json({ error: 'execution_id (string) and reached (bool) required' }, 400);
    }
    const completion_shapes: string[] = Array.isArray(body.completion_shapes)
      ? body.completion_shapes.map(String)
      : [];
    const missing: string[] = Array.isArray(body.missing)
      ? body.missing.map(String)
      : [];
    // AUTHORITATIVE PRE-READ — must precede the UPDATE below. It captures the row
    // exactly as it stood BEFORE this patch, which is the only way to know what the
    // INSERT path (app.post('/'), applyOutcomeToPosteriors) already did with this
    // execution. Re-crediting a row the insert path already graded would double-count
    // against the same alpha/beta counters. Reusing the ONE honest-reach primitive
    // (classifyReach) on the PRE-patch tags answers it exactly: only an 'ungraded'
    // pre-verdict means the insert contributed {0,0}, so this late verdict is the
    // first and only credit for the row.
    //
    // Reads `execution`, NOT activity_execution_traces: AET is the DUAL_WRITE shadow
    // and isDualWriteEnabled() defaults to FALSE (db/paradigm.ts, "Migration COMPLETE
    // (2026-07): `execution` is the sole authoritative trace store"). DUAL_WRITE_ENABLED
    // is set in no script, unit or compose file, so on this deployment AET receives no
    // new rows at all and a pre-read there would find nothing, forever.
    let preRow: any = null;
    let preReadOk = false;
    try {
      const preRes = await surrealDB.query<any>(
        `SELECT variant_id, activity_id, success, tags, cost_usd, org_id, signature, signature_version, composition_chain, failure_mode, trace.tasks AS tasks FROM type::thing('execution', $execution_id) LIMIT 1`,
        { execution_id: String(execId) },
      );
      preRow = Array.isArray(preRes) && preRes.length > 0
        ? (Array.isArray((preRes as any)[0]) ? (preRes as any)[0][0] : (preRes as any)[0])
        : null;
      preReadOk = true;
    } catch (e) {
      // Fail CLOSED on grading only: a missed pre-read must never produce an unguarded
      // (possibly double-counting) posterior write. The verdict patch itself still
      // proceeds — persisting it is the caller's contract.
      logger.warn('[reach-patch] pre-read for posterior grading failed (verdict still patched)', { error: e instanceof Error ? e.message : String(e) });
    }
    const preTags: string[] = Array.isArray(preRow?.tags) ? (preRow.tags as string[]) : [];
    // AET WRITE IS GATED ON THE DUAL-WRITE SWITCH THAT ALREADY GOVERNS IT — this is
    // the same guard the insert path applies, applied here too.
    //
    // This UPDATE has no index to use: every index defined on activity_execution_traces
    // (migrations 102, 113, 081, 031) covers other columns, and none covers
    // execution_id. So it is a full unindexed scan of the trace store. Measured against
    // the hub: an unindexed scan costs 12-16s (a `limit=1` list is 11.9s, proving the
    // cost is the scan and not the row count), while every indexed or point access on
    // the same store is 0.2-0.4s. It consumed the ENTIRE client deadline by itself.
    //
    // And it can never match. DUAL_WRITE_ENABLED is set in no unit file, so
    // isDualWriteEnabled() is false and AET has received no rows since decommission;
    // a reach patch is always for a current execution. Confirmed in the journal:
    // across 143/143 successful patches `rows=1`, and since rows = aetUpdated +
    // mirrored with the mirror being a point update returning exactly 1, aetUpdated
    // was structurally 0 every single time.
    //
    // So the one query that spent the whole budget contributed zero persistence, and
    // 165 of 377 "timeouts" were verdicts the server had already persisted after the
    // client gave up — false failures on a path whose real work costs ~0.2s.
    //
    // Gated rather than deleted because `res` still feeds updatedTrace ->
    // updateSuccessorFeatures below. That call is already unreachable while AET is
    // frozen (an empty result yields updatedTrace = null), so gating changes no
    // behaviour today and keeps the psi path correct if dual-write is ever re-enabled.
    const res = isDualWriteEnabled()
      ? await surrealDB.query(
        `UPDATE activity_execution_traces SET reached = $reached, completion_shapes = $completion_shapes, missing = $missing, tags = array::union(tags ?? [], [IF $reached { 'reached:true' } ELSE { 'reached:false' }]) WHERE execution_id = $execution_id`,
        { reached: body.reached, completion_shapes, missing, execution_id: String(execId) },
      )
      : [];
    // LATE-VERDICT GRADING. The reach gate runs AFTER the trace is inserted, so before
    // this the walk's honest verdict was persisted and NEVER credited: every posterior
    // consumer of classifyReach lived in app.post('/'). Measured consequence — two
    // full-population snapshots 3.5 minutes apart showed ZERO movement in
    // thompson_alpha/thompson_beta across 2,392 comparable templates while ~400 traces
    // landed. Reuses the existing producer applyOutcomeToPosteriors with the same
    // argument shape as the insert-path call site, so 'reached' credits alpha and
    // 'not-reached' penalizes beta (computeDeltas(false, ...) => beta >= 0.5) exactly
    // as it would have at insert time. The system learns from failures AND successes.
    //
    // SATELLITE EXCLUSION: classifyReach returns 'ungraded' for BOTH a goal-host walk
    // awaiting a verdict AND a structural satisfier satellite, but only the first is
    // creditable — a satellite is a walk artifact the honest-reach gate deliberately
    // never grades, and passing it a 'reached:true' tag would make classifyReach credit
    // it, because the tag branch is tested BEFORE the satellite branch. Without this
    // guard the fix would hand full alpha to satisfier: arms, which carry ~37% of all
    // executions — the precise opposite of the intent.
    const preActivityId = typeof preRow?.variant_id === 'string'
      ? (preRow.variant_id as string)
      : (typeof preRow?.activity_id === 'string' ? (preRow.activity_id as string) : '');
    const preIsSatellite = String(execId).startsWith('walk-satisfier-') || preActivityId.startsWith('satisfier:');
    if (preReadOk && preRow && preActivityId && !preIsSatellite && !preTags.includes('reach_graded:true')) {
      const preVerdict = classifyReach({
        success: preRow.success === true,
        execution_id: String(execId),
        activity_id: preActivityId,
        tags: preTags,
      });
      if (preVerdict === 'ungraded') {
        // Idempotence marker on the AUTHORITATIVE row, written before the credit so a
        // retry of this endpoint cannot grade the same execution twice even if the
        // reach-tag mirror below fails.
        try {
          await surrealDB.query(
            `UPDATE type::thing('execution', $execution_id) SET tags = array::union(tags ?? [], ['reach_graded:true'])`,
            { execution_id: String(execId) },
          );
        } catch (e) {
          logger.warn('[reach-patch] reach_graded marker write failed (grading proceeds)', { error: e instanceof Error ? e.message : String(e) });
        }
        const gradedTags = [...preTags, body.reached ? 'reached:true' : 'reached:false'];
        applyOutcomeToPosteriors(
          {
            activity_id: preActivityId,
            success: preRow.success === true,
            failure_mode: (preRow.failure_mode ?? null) as any,
            tasks: preRow.tasks as any,
            cost_usd: typeof preRow.cost_usd === 'number' ? (preRow.cost_usd as number) : 0,
            execution_id: String(execId),
            tags: gradedTags,
            ...(Array.isArray(preRow.composition_chain) && preRow.composition_chain.length > 0
              ? { composition_chain: preRow.composition_chain as string[] }
              : {}),
            ...(typeof preRow.signature === 'string' && typeof preRow.signature_version === 'number'
              ? { signature: preRow.signature as string, signature_version: preRow.signature_version as number }
              : {}),
          },
          surrealDB,
          typeof preRow.org_id === 'string' ? (preRow.org_id as string) : 'public',
        ).catch((err) => {
          logger.warn('[reach-patch] applyOutcomeToPosteriors failed (non-blocking)', {
            execution_id: String(execId),
            error: err instanceof Error ? err.message : String(err),
          });
        });
        logger.info('[reach-patch] late reach verdict graded into posteriors', {
          execution_id: String(execId),
          activity_id: preActivityId,
          reached: body.reached,
        });
      } else {
        logger.info('[reach-patch] posterior grading skipped; insert path already graded this trace', {
          execution_id: String(execId),
          pre_verdict: preVerdict,
        });
      }
    } else if (preReadOk && preRow && preIsSatellite) {
      logger.info('[reach-patch] posterior grading skipped; structural satisfier satellite (never graded by design)', {
        execution_id: String(execId),
        activity_id: preActivityId,
      });
    }
    const updatedTrace: any = Array.isArray(res) && Array.isArray(res[0]) && res[0].length > 0 ? res[0][0] : null;
    if (updatedTrace && updatedTrace.signature) {
      import('../lib/successor-features').then(({ updateSuccessorFeatures }) => {
        updateSuccessorFeatures(
          {
            activity_id: updatedTrace.variant_id as string,
            signature: updatedTrace.signature as string,
            output_impulse_shapes: updatedTrace.output_impulse_shapes,
            tasks: updatedTrace.tasks,
            completion_shapes,
            missing,
          },
          surrealDB,
          updatedTrace.org_id as string
        ).catch((err) => {
          logger.warn('successor-features (reach): update failed', { error: err.message });
        });
      }).catch(() => {});
    }
    // WRITE-FLIP: mirror the reach verdict onto the authoritative `execution`
    // row (the load-bearing learning signal; point update, non-fatal).
    //
    // The tag union MUST be written HERE, not only on activity_execution_traces.
    // Readers fetch traces through v_paradigm_execution_traces, a view over
    // `execution`, and that view projects `tags` but NOT `reached` — so a verdict
    // written anywhere else is invisible to classifyReach, which reads tags only.
    // `missing` is deliberately not set here: it is defined on
    // activity_execution_traces but on no migration for the SCHEMAFULL `execution`
    // table, which defines reached and completion_shapes only.
    let mirrored = 0;
    try {
      const mres = await surrealDB.query(
        `UPDATE type::thing('execution', $execution_id) SET reached = $reached, completion_shapes = $completion_shapes, tags = array::union(tags ?? [], [IF $reached { 'reached:true' } ELSE { 'reached:false' }])`,
        { reached: body.reached, completion_shapes, execution_id: String(execId) },
      );
      mirrored = Array.isArray(mres) && Array.isArray(mres[0]) ? (mres[0] as unknown[]).length : (Array.isArray(mres) ? mres.length : 0);
    } catch (e) {
      logger.warn('[reach-patch] execution mirror update failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
    }
    // `updated` is the caller's persistence signal: goal-host logs MATCHED NO ROW
    // and abandons the verdict whenever it is 0, so the mirror must be counted.
    const aetUpdated = Array.isArray(res) && Array.isArray(res[0]) ? (res[0] as unknown[]).length : (Array.isArray(res) ? res.length : 0);
    const updated = aetUpdated + mirrored;
    return c.json({ success: true, execution_id: String(execId), reached: body.reached, updated }, 200);
  } catch (err) {
    logger.warn('[reach-patch] failed to persist reach verdict on trace', { error: err instanceof Error ? err.message : String(err) });
    return c.json({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default app;
