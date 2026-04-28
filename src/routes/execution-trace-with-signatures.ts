/**
 * executionTraceWithSignatures read resolver
 *
 * Returns recent execution traces hydrated with an `impulse_id -> {pointer_type,
 * shape}` signature map so a consumer (e.g. the minibob co-occurrence extractor
 * added in commit 1f8d703) does not have to do a second round trip to resolve
 * each impulse reference.
 *
 * The persisted trace schema flattens impulse data: `execution.input_impulses`
 * is `string[]` and `execution.input_impulse_shapes` is a parallel `string[]`
 * with no per-impulse pointer-type information and no per-task grouping. This
 * resolver stitches things back together by joining each execution's
 * `input_impulses` id list against the `impulse` table (whose `pointer` is a
 * FLEXIBLE object with a `type` field, and whose `shape` is a required string).
 *
 * Per-task `input_impulse_ids` / `output_impulse_ids` are NOT currently
 * persisted (see SCHEMA NOTE in the response assembly below). Tasks are still
 * returned so the extractor can enumerate them by index, but the per-task
 * impulse arrays will be empty on all existing traces. The extractor falls back
 * to execution-level (same-execution) co-occurrence, which is still useful.
 *
 * Authoritative schema references:
 *   - sql/schemas/020-paradigm-core-tables.surql: `execution`, `impulse`
 *   - sql/schemas/011-executions.surql: legacy `activity_execution_traces`
 *
 * This module is pure: it takes a Surreal client plus parsed input, runs two
 * queries (executions then impulses), and assembles the response. Authn/authz
 * is handled by the caller — the same pattern as `template-audit.ts`.
 */

import type { Surreal } from 'surrealdb';

import { logger } from '../utils/logger';
import {
  applyChainFallback,
  type CompositionChainCache,
} from './execution-traces';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionTraceWithSignaturesInput {
  /** ISO-8601 timestamp; only executions with `executed_at >= since` are returned.
   *  Defaults to 24 hours ago when undefined. */
  since?: string;
  /** Hard cap on the returned trace count. Clamped to [1, 500]. Default 100. */
  limit?: number;
  /** Filter by `execution.activity_id`. The persisted schema tracks templates
   *  via `activity_id` (template/variant id). No separate template_id column
   *  exists on `execution`. */
  activity_template_id?: string;
  /** When true, only return traces where `success = true`. Default false. */
  success_only?: boolean;
  /** Filter by `duration_ms >= min_duration_ms`. */
  min_duration_ms?: number;
}

export interface ImpulseSignature {
  /** `pointer.type` extracted from the impulse row, or null when the row is
   *  missing / has no pointer.type. */
  pointer_type: string | null;
  /** `shape` from the impulse row, or null when the row is missing. */
  shape: string | null;
  /** Optional human-readable summary; only present when the impulse row has one. */
  summary?: string;
}

export interface ExecutionTraceTaskEntry {
  task_id: string;
  task_index: number;
  status?: string;
  started_at?: string;
  completed_at?: string;
  /** SCHEMA NOTE: persisted trace rows flatten per-task impulse grouping into
   *  execution-level `input_impulses` / `output_impulses`. Until a schema
   *  change lands, this is empty for historical traces; newer traces that
   *  include per-task impulse refs (via `task.inputState.impulses` on the
   *  paradigm `execution.trace.tasks` array) will populate it. */
  input_impulse_ids: string[];
  output_impulse_ids: string[];
}

export interface ExecutionTraceHydrated {
  id: string;
  activity_id: string;
  execution_id: string;
  status: 'success' | 'failure';
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  task_count?: number;
  success_count?: number;
  failure_count?: number;
  parent_execution_id?: string | null;
  composition_chain?: string[];
  impulse_resolutions?: unknown[];
  input_impulses: string[];
  output_impulses?: string[];
  /** The hydrated `impulse_id -> signature` map. Every id from `input_impulses`
   *  and `output_impulses` is present as a key; missing impulse rows yield
   *  `{pointer_type: null, shape: null}` rather than throwing. */
  impulses_by_id: Record<string, ImpulseSignature>;
  tasks: ExecutionTraceTaskEntry[];
}

export interface ExecutionTraceWithSignaturesReport {
  generated_at: string;
  count: number;
  filtered_by: {
    since: string;
    limit: number;
    activity_template_id?: string;
    success_only?: boolean;
    min_duration_ms?: number;
  };
  traces: ExecutionTraceHydrated[];
}

export interface ExecutionTraceAuthContext {
  orgId: string;
  /** Phase B3: account_id-first scoping. When present, the resolver matches
   *  rows on `account_id = $account_id`; legacy rows (account_id IS NONE)
   *  fall back to org_id. Pass through from the caller's JWT auth. */
  accountId?: string | null;
  /** 'apikey' bypasses SurrealDB PERMISSIONS (self-signed JWT); for those
   *  callers the resolver applies an app-side dual-tenant filter. */
  authType?: 'jwt' | 'apikey' | 'minibob_token';
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000; // 24h

/** Parse + normalize input. Throws {status: 400, message} for bad input. */
export function parseInput(raw: unknown): ExecutionTraceWithSignaturesInput & {
  since: string;
  limit: number;
} {
  const input = (raw ?? {}) as Record<string, unknown>;

  // since: ISO-8601. Default to 24h ago. Any non-string or unparseable value
  // is a 400; silent defaults would hide typos in activity configs.
  let since: string;
  if (input.since === undefined || input.since === null) {
    since = new Date(Date.now() - DEFAULT_SINCE_MS).toISOString();
  } else if (typeof input.since !== 'string') {
    throw { status: 400, message: 'since must be an ISO-8601 string' };
  } else {
    const parsed = Date.parse(input.since);
    if (Number.isNaN(parsed)) {
      throw { status: 400, message: `since is not a valid ISO-8601 timestamp: ${input.since}` };
    }
    since = new Date(parsed).toISOString();
  }

  // limit: int in [1, 500]. Default 100.
  let limit: number;
  if (input.limit === undefined || input.limit === null) {
    limit = DEFAULT_LIMIT;
  } else {
    const n = typeof input.limit === 'string' ? parseInt(input.limit, 10) : input.limit;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw { status: 400, message: 'limit must be a positive integer' };
    }
    if (n > MAX_LIMIT) {
      throw { status: 400, message: `limit must be <= ${MAX_LIMIT}` };
    }
    limit = n;
  }

  const activity_template_id =
    typeof input.activity_template_id === 'string' && input.activity_template_id.length > 0
      ? input.activity_template_id
      : undefined;

  const success_only =
    input.success_only === true || input.success_only === 'true' ? true : false;

  let min_duration_ms: number | undefined;
  if (input.min_duration_ms !== undefined && input.min_duration_ms !== null) {
    const n =
      typeof input.min_duration_ms === 'string'
        ? parseInt(input.min_duration_ms, 10)
        : input.min_duration_ms;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      throw { status: 400, message: 'min_duration_ms must be a non-negative number' };
    }
    min_duration_ms = n;
  }

  return { since, limit, activity_template_id, success_only, min_duration_ms };
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function toIsoOrUndefined(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  try {
    const s = String(v);
    return s.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

function primaryIdString(rawId: unknown): string {
  if (typeof rawId === 'string') return rawId;
  if (rawId && typeof rawId === 'object') {
    const obj = rawId as { tb?: unknown; id?: unknown };
    if (obj.tb != null && obj.id != null) return `${obj.tb}:${obj.id}`;
    if (obj.id != null) return primaryIdString(obj.id);
  }
  return rawId == null ? '' : String(rawId);
}

// ---------------------------------------------------------------------------
// Task extraction
// ---------------------------------------------------------------------------

interface RawTask {
  id?: unknown;
  task_id?: unknown;
  taskId?: unknown;
  status?: unknown;
  started_at?: unknown;
  startedAt?: unknown;
  completed_at?: unknown;
  completedAt?: unknown;
  /** Present on rich traces when the persistence layer preserves inputState.
   *  See SCHEMA NOTE on ExecutionTraceTaskEntry. */
  input_impulse_ids?: unknown;
  inputImpulseIds?: unknown;
  inputState?: { impulses?: unknown } | unknown;
  output_impulse_ids?: unknown;
  outputImpulseIds?: unknown;
  outputState?: { impulses?: unknown } | unknown;
}

function extractTasks(row: RawExecutionRow): ExecutionTraceTaskEntry[] {
  // The paradigm `execution.trace` is FLEXIBLE, legacy is top-level `tasks`.
  const traceField =
    row.trace && typeof row.trace === 'object' ? (row.trace as Record<string, unknown>) : null;

  const rawTasks: unknown[] = Array.isArray(row.tasks)
    ? row.tasks
    : traceField && Array.isArray(traceField.tasks)
      ? (traceField.tasks as unknown[])
      : [];

  const out: ExecutionTraceTaskEntry[] = [];
  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i];
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as RawTask;

    const task_id =
      (typeof t.id === 'string' && t.id) ||
      (typeof t.task_id === 'string' && t.task_id) ||
      (typeof t.taskId === 'string' && t.taskId) ||
      `task-${i}`;

    const status = typeof t.status === 'string' ? t.status : undefined;

    // Per-task impulse ids. Try both snake_case and camelCase field shapes and
    // fall back to inputState.impulses / outputState.impulses which are the
    // richer shapes produced by minibob's ExecutedTask type (see
    // repos/minibob/src/types.ts:1145). On historical traces where the
    // persistence layer strips these, the arrays come back empty.
    const inputState = (t as { inputState?: unknown }).inputState;
    const outputState = (t as { outputState?: unknown }).outputState;
    const inputImpulseIds = [
      ...toStringArray(t.input_impulse_ids),
      ...toStringArray(t.inputImpulseIds),
      ...(inputState && typeof inputState === 'object'
        ? toStringArray((inputState as { impulses?: unknown }).impulses)
        : []),
    ];
    const outputImpulseIds = [
      ...toStringArray(t.output_impulse_ids),
      ...toStringArray(t.outputImpulseIds),
      ...(outputState && typeof outputState === 'object'
        ? toStringArray((outputState as { impulses?: unknown }).impulses)
        : []),
    ];

    out.push({
      task_id,
      task_index: i,
      status,
      started_at: toIsoOrUndefined(t.started_at) ?? toIsoOrUndefined(t.startedAt),
      completed_at: toIsoOrUndefined(t.completed_at) ?? toIsoOrUndefined(t.completedAt),
      input_impulse_ids: Array.from(new Set(inputImpulseIds)),
      output_impulse_ids: Array.from(new Set(outputImpulseIds)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

interface RawExecutionRow {
  id?: unknown;
  activity_id?: unknown;
  success?: unknown;
  duration_ms?: unknown;
  executed_at?: unknown;
  created_at?: unknown;
  input_impulses?: unknown;
  output_impulses?: unknown;
  parent_execution_id?: unknown;
  composition_chain?: unknown;
  impulse_resolutions?: unknown;
  trace?: unknown;
  tasks?: unknown;
  org_id?: unknown;
  [key: string]: unknown;
}

interface RawImpulseRow {
  id?: unknown;
  pointer?: unknown;
  shape?: unknown;
  summary?: unknown;
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Fetch execution rows from the paradigm `execution` table, filtered by the
 * parsed input. Applies an app-side `org_id` filter for API-key auth (where
 * SurrealDB PERMISSIONS can't validate the self-signed JWT); relies on
 * PERMISSIONS for real JWT auth.
 */
async function queryExecutions(
  db: Surreal,
  input: ExecutionTraceWithSignaturesInput & { since: string; limit: number },
  auth: ExecutionTraceAuthContext,
): Promise<RawExecutionRow[]> {
  const params: Record<string, unknown> = {
    since: input.since,
    lim: input.limit,
  };
  const where: string[] = ['executed_at >= type::datetime($since)'];

  if (auth.authType === 'apikey') {
    // Phase B3: dual-tenant scoping. Match on account_id when present;
    // legacy rows fall back to org_id via the disjunction.
    where.push(
      '(account_id = $account_id OR (account_id IS NONE AND org_id = $orgId))',
    );
    params.orgId = auth.orgId;
    params.account_id = auth.accountId ?? null;
  }
  if (input.activity_template_id) {
    where.push('activity_id = $activityId');
    params.activityId = input.activity_template_id;
  }
  if (input.success_only) {
    where.push('success = true');
  }
  if (typeof input.min_duration_ms === 'number') {
    where.push('duration_ms >= $minDuration');
    params.minDuration = input.min_duration_ms;
  }

  const sql = `
    SELECT
      id,
      activity_id,
      success,
      duration_ms,
      executed_at,
      created_at,
      input_impulses,
      output_impulses,
      parent_execution_id,
      composition_chain,
      impulse_resolutions,
      trace,
      org_id
    FROM execution
    WHERE ${where.join(' AND ')}
    ORDER BY executed_at DESC
    LIMIT $lim
  `;

  try {
    const result = await db.query(sql, params);
    const firstSet = Array.isArray(result) && result.length > 0 ? result[0] : [];
    return Array.isArray(firstSet) ? (firstSet as RawExecutionRow[]) : [];
  } catch (err) {
    logger.warn('[execution-trace-with-signatures] execution query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Fetch impulse signatures for the given ids. Missing ids produce no row. */
async function queryImpulseSignatures(
  db: Surreal,
  impulseIds: string[],
  auth: ExecutionTraceAuthContext,
): Promise<Map<string, ImpulseSignature>> {
  const map = new Map<string, ImpulseSignature>();
  if (impulseIds.length === 0) return map;

  const params: Record<string, unknown> = { ids: impulseIds };
  let whereOrg = '';
  if (auth.authType === 'apikey') {
    // Phase B3: dual-tenant scoping (account_id with org_id fallback).
    whereOrg =
      ' AND (account_id = $account_id OR (account_id IS NONE AND org_id = $orgId))';
    params.orgId = auth.orgId;
    params.account_id = auth.accountId ?? null;
  }

  const sql = `
    SELECT id, pointer, shape, summary
    FROM impulse
    WHERE id IN $ids${whereOrg}
  `;

  try {
    const result = await db.query(sql, params);
    const firstSet = Array.isArray(result) && result.length > 0 ? result[0] : [];
    const rows = Array.isArray(firstSet) ? (firstSet as RawImpulseRow[]) : [];
    for (const row of rows) {
      const id = primaryIdString(row.id);
      if (!id) continue;
      const pointer = row.pointer && typeof row.pointer === 'object'
        ? (row.pointer as { type?: unknown })
        : null;
      const pointer_type =
        pointer && typeof pointer.type === 'string' ? pointer.type : null;
      const shape = typeof row.shape === 'string' ? row.shape : null;
      const signature: ImpulseSignature = { pointer_type, shape };
      if (typeof row.summary === 'string' && row.summary.length > 0) {
        signature.summary = row.summary;
      }
      map.set(id, signature);
    }
  } catch (err) {
    logger.warn('[execution-trace-with-signatures] impulse query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}

/**
 * Run the full resolver end-to-end. Pure function over the supplied `db`
 * client; the caller owns authn/authz.
 */
export async function runExecutionTraceWithSignatures(
  db: Surreal,
  rawInput: unknown,
  auth: ExecutionTraceAuthContext,
): Promise<ExecutionTraceWithSignaturesReport> {
  const input = parseInput(rawInput);

  const execRows = await queryExecutions(db, input, auth);

  // Collect every impulse id across all rows (input + output) for a single
  // batched impulse lookup. Keeps us at exactly 2 DB round trips regardless of
  // trace count.
  const allImpulseIds = new Set<string>();
  for (const row of execRows) {
    for (const id of toStringArray(row.input_impulses)) allImpulseIds.add(id);
    for (const id of toStringArray(row.output_impulses)) allImpulseIds.add(id);
  }

  const signatureMap = await queryImpulseSignatures(
    db,
    Array.from(allImpulseIds),
    auth,
  );

  const tracesRaw: ExecutionTraceHydrated[] = execRows.map((row) => {
    const input_impulses = toStringArray(row.input_impulses);
    const output_impulses = toStringArray(row.output_impulses);

    const impulses_by_id: Record<string, ImpulseSignature> = {};
    for (const id of input_impulses) {
      impulses_by_id[id] = signatureMap.get(id) ?? { pointer_type: null, shape: null };
    }
    for (const id of output_impulses) {
      if (!(id in impulses_by_id)) {
        impulses_by_id[id] = signatureMap.get(id) ?? { pointer_type: null, shape: null };
      }
    }

    const tasks = extractTasks(row);
    const execId = primaryIdString(row.id);

    return {
      id: execId,
      execution_id: execId,
      activity_id: typeof row.activity_id === 'string' ? row.activity_id : primaryIdString(row.activity_id),
      status: row.success === true ? 'success' : 'failure',
      started_at: toIsoOrUndefined(row.executed_at) ?? toIsoOrUndefined(row.created_at),
      completed_at: toIsoOrUndefined(row.executed_at),
      duration_ms: typeof row.duration_ms === 'number' ? row.duration_ms : undefined,
      task_count: tasks.length,
      success_count: tasks.filter((t) => t.status === 'success').length,
      failure_count: tasks.filter((t) => t.status === 'failure' || t.status === 'failed').length,
      parent_execution_id:
        typeof row.parent_execution_id === 'string' ? row.parent_execution_id : null,
      composition_chain: toStringArray(row.composition_chain),
      impulse_resolutions: Array.isArray(row.impulse_resolutions)
        ? (row.impulse_resolutions as unknown[])
        : [],
      input_impulses,
      output_impulses,
      impulses_by_id,
      tasks,
    };
  });

  // F-37/F-40 read-time fallback (2026-04-26): when stored chain is empty
  // but parent_execution_id is set, walk on the fly. Read-only — never
  // writes back. Per-request memoization cache: sibling traces sharing a
  // parent collapse to one DB walk per distinct parent. The walk reads
  // from `activity_execution_traces` (canonical chain store, dual-write
  // target shared with the paradigm `execution` table this resolver reads).
  const chainCache: CompositionChainCache = new Map();
  const traces: ExecutionTraceHydrated[] = await Promise.all(
    tracesRaw.map((t) => applyChainFallback(t, chainCache)),
  );

  const filtered_by: ExecutionTraceWithSignaturesReport['filtered_by'] = {
    since: input.since,
    limit: input.limit,
  };
  if (input.activity_template_id) filtered_by.activity_template_id = input.activity_template_id;
  if (input.success_only) filtered_by.success_only = input.success_only;
  if (typeof input.min_duration_ms === 'number') filtered_by.min_duration_ms = input.min_duration_ms;

  return {
    generated_at: new Date().toISOString(),
    count: traces.length,
    filtered_by,
    traces,
  };
}

// ---------------------------------------------------------------------------
// Internal exports for tests
// ---------------------------------------------------------------------------

export const _internals = {
  extractTasks,
  parseInput,
  primaryIdString,
  toStringArray,
};
