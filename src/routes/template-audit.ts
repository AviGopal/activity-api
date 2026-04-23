/**
 * Template Audit Report Resolver
 *
 * Read-only resolver for the `templateAuditReport` impulse shape. Scans stored
 * activity templates and produces a per-template deficiency report covering:
 *
 *   - Missing or default input/output shapes (migration-044 fallbacks)
 *   - Missing tags
 *   - Weak descriptions (< 50 chars)
 *   - All-LLM task graphs (no deterministic resolvers)
 *   - No declared task outputs
 *   - Hardcoded URLs in prompts/configs
 *
 * When `includeProposals` is true, each template gets a suggested backfill
 * computed from `analyzeTaskSemantics` on the description + task descriptions.
 * When `includeAliasWarnings` is true the report also includes the output of
 * `findAliasClusters` over the observed-shapes inventory, so consumers see
 * likely shape drift that an audit pass should rationalize.
 *
 * This resolver is descriptive, not prescriptive: it flags deficiencies and
 * proposes fills, but never writes. The companion write resolvers
 * (`activityTemplate_update`, `activityTemplate_deprecate`) handle mutation.
 *
 * Shape inventory is reused from `src/utils/observed-shapes.ts` so this module
 * does not re-implement shape accounting. Note that `observeShapes` may
 * double-count in deployments where `activity_template` is a view over
 * `activity`; the audit itself de-duplicates templates by primary id.
 */

import type { Surreal } from 'surrealdb';

import { logger } from '../utils/logger';
import { analyzeTaskSemantics } from '../utils/semantic-tags';
import {
  observeShapes,
  findAliasClusters,
  type AliasCandidate,
  type ObservedShapeUsage,
} from '../utils/observed-shapes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MissingMarker =
  | 'input_shapes'
  | 'output_shapes'
  | 'tags'
  | 'description'
  | 'task_outputs'
  | 'hardcoded_urls';

export type TaskFormat = 'all_llm' | 'all_resolver' | 'mixed' | 'any';

export interface TemplateAuditInput {
  filter?: {
    missingMarkers?: MissingMarker[];
    taskFormat?: TaskFormat;
    scope?: 'global' | 'org' | 'project';
    limit?: number;
    offset?: number;
  };
  includeProposals?: boolean;
  includeAliasWarnings?: boolean;
}

export interface TemplateDeficiencies {
  missing_input_shapes: boolean;
  missing_output_shapes: boolean;
  /** Matches migration-044 category defaults (e.g. ['goal'], ['patch']) exactly. */
  default_shapes: boolean;
  missing_tags: boolean;
  /** Description missing, empty, or fewer than 50 chars. */
  weak_description: boolean;
  /** Every task has a `prompt` and none declares a `resolver`. */
  all_llm_tasks: boolean;
  /** No task declares outputImpulses or outputShapes. */
  no_task_outputs: boolean;
  /** Unique URLs found in task prompts/configs. Empty = no deficiency. */
  hardcoded_urls: string[];
}

export interface TemplateCurrent {
  input_shapes: string[];
  output_shapes: string[];
  tags: string[];
  task_count: number;
  resolver_task_count: number;
  llm_task_count: number;
}

export interface TemplateProposals {
  suggested_tags?: string[];
  suggested_input_shapes?: string[];
  suggested_output_shapes?: string[];
}

export interface TemplateAuditRow {
  id: string;
  name: string;
  scope: string;
  deficiencies: TemplateDeficiencies;
  current: TemplateCurrent;
  proposals?: TemplateProposals;
  /** 0..1. Fraction of deficiency flags that are FALSE. 7 flags total. */
  completeness_score: number;
}

export interface TemplateAuditReport {
  generated_at: string;
  total_scanned: number;
  total_with_deficiencies: number;
  templates: TemplateAuditRow[];
  alias_warnings?: AliasCandidate[];
  observed_shape_summary?: {
    total_unique_shapes: number;
    top_20_shapes: Array<{ shape: string; total: number }>;
  };
}

export interface AuditAuthContext {
  orgId: string;
  /** 'apikey' uses root SurrealDB + app-side org filter; 'jwt'/undefined relies
   *  on the passed `db` client honouring PERMISSIONS. */
  authType?: 'jwt' | 'apikey' | 'minibob_token';
}

// ---------------------------------------------------------------------------
// Raw template row (paradigm + legacy)
// ---------------------------------------------------------------------------

interface RawTask {
  id?: unknown;
  description?: unknown;
  prompt?: { template?: unknown; variables?: unknown } | unknown;
  resolver?: { id?: unknown; config?: { command?: unknown } | unknown } | unknown;
  config?: { command?: unknown } | unknown;
  inputShapes?: unknown;
  outputShapes?: unknown;
  outputImpulses?: unknown;
}

interface RawTemplateRow {
  id?: unknown;
  name?: unknown;
  variant_name?: unknown;
  description?: unknown;
  scope?: unknown;
  org_id?: unknown;
  tags?: unknown;
  input_shapes?: unknown;
  output_shapes?: unknown;
  tasks?: unknown;
  task_steps?: unknown;
}

// ---------------------------------------------------------------------------
// Migration-044 default shape combinations
// ---------------------------------------------------------------------------
//
// Migration 044 backfilled category-based defaults when input_shapes /
// output_shapes were missing. A template whose current list matches one of
// these combinations exactly is considered "default" (unthinking backfill),
// not intentional authorship. This is a signal, not a verdict.

const DEFAULT_INPUT_COMBINATIONS: string[][] = [
  ['goal'],
  ['error', 'goal', 'source_code'],
  ['goal', 'source_code'],
];

const DEFAULT_OUTPUT_COMBINATIONS: string[][] = [
  ['patch'],
  ['patch', 'source_code'],
  ['test_suite'],
  ['config_file', 'source_code'],
];

function arraysEqualSorted(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function matchesAnyDefault(list: string[], combos: string[][]): boolean {
  if (list.length === 0) return false;
  const sorted = [...list].sort();
  for (const combo of combos) {
    const comboSorted = [...combo].sort();
    if (arraysEqualSorted(sorted, comboSorted)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Coercion helpers — be liberal in what we accept, since live data is messy.
// ---------------------------------------------------------------------------

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function toStringOrEmpty(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

function toTasks(row: RawTemplateRow): RawTask[] {
  const src = Array.isArray(row.tasks)
    ? row.tasks
    : Array.isArray(row.task_steps)
      ? row.task_steps
      : [];
  const out: RawTask[] = [];
  for (const t of src) {
    if (t && typeof t === 'object') out.push(t as RawTask);
  }
  return out;
}

/** Extract the string id from a SurrealDB record id (which may be `activity:foo`,
 *  an object `{ tb, id }`, or already a bare string). */
function primaryId(rawId: unknown): string {
  if (typeof rawId === 'string') {
    const colonIdx = rawId.indexOf(':');
    if (colonIdx >= 0) return rawId.slice(colonIdx + 1).replace(/^⟨|⟩$/g, '').replace(/^`|`$/g, '');
    return rawId;
  }
  if (rawId && typeof rawId === 'object') {
    const obj = rawId as { id?: unknown; tb?: unknown };
    if (obj.id != null) return primaryId(obj.id);
  }
  return toStringOrEmpty(rawId);
}

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------
//
// Scan a template's task prompts and resolver configs for hardcoded URLs so
// operators can see which templates bake in environment-specific endpoints.
// The regex intentionally excludes closing brackets / quotes / whitespace;
// the `g` flag is new each call to avoid stateful lastIndex issues.

function extractUrls(text: string): string[] {
  if (!text) return [];
  const re = /https?:\/\/[^\s"')\]]+/g;
  const matches = text.match(re) ?? [];
  return matches;
}

function extractHardcodedUrls(tasks: RawTask[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    // task.prompt.template
    const prompt = (t.prompt as { template?: unknown } | undefined) ?? undefined;
    const tmpl = prompt ? toStringOrEmpty(prompt.template) : '';
    for (const url of extractUrls(tmpl)) set.add(url);

    // task.resolver.config.command
    const resolver = (t.resolver as { config?: { command?: unknown } } | undefined) ?? undefined;
    const resolverCmd = resolver?.config ? toStringOrEmpty(resolver.config.command) : '';
    for (const url of extractUrls(resolverCmd)) set.add(url);

    // task.config.command (alternative shape — some templates put config inline)
    const taskConfig = (t.config as { command?: unknown } | undefined) ?? undefined;
    const taskCmd = taskConfig ? toStringOrEmpty(taskConfig.command) : '';
    for (const url of extractUrls(taskCmd)) set.add(url);
  }
  return Array.from(set);
}

// ---------------------------------------------------------------------------
// Task classification
// ---------------------------------------------------------------------------

interface TaskClassification {
  resolverCount: number;
  llmCount: number;
  hasAnyOutputDecl: boolean;
}

function classifyTasks(tasks: RawTask[]): TaskClassification {
  let resolverCount = 0;
  let llmCount = 0;
  let hasAnyOutputDecl = false;

  for (const t of tasks) {
    const hasResolver = !!t.resolver && typeof t.resolver === 'object';
    const promptObj = t.prompt as { template?: unknown } | undefined;
    const hasPrompt =
      !!promptObj &&
      typeof promptObj === 'object' &&
      typeof promptObj.template === 'string' &&
      promptObj.template.length > 0;

    if (hasResolver) resolverCount += 1;
    else if (hasPrompt) llmCount += 1;

    const taskOutputs = toStringArray(t.outputShapes);
    const taskImpulses = toStringArray(t.outputImpulses);
    if (taskOutputs.length > 0 || taskImpulses.length > 0) {
      hasAnyOutputDecl = true;
    }
  }

  return { resolverCount, llmCount, hasAnyOutputDecl };
}

// ---------------------------------------------------------------------------
// Scope coercion
// ---------------------------------------------------------------------------

function coerceScope(v: unknown): string {
  if (typeof v === 'string' && v.length > 0) return v;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Per-template audit
// ---------------------------------------------------------------------------

function auditRow(
  row: RawTemplateRow,
  includeProposals: boolean,
): TemplateAuditRow {
  const id = primaryId(row.id);
  const name = toStringOrEmpty(row.name) || toStringOrEmpty(row.variant_name) || id;
  const scope = coerceScope(row.scope);
  const description = toStringOrEmpty(row.description);

  const inputShapes = toStringArray(row.input_shapes);
  const outputShapes = toStringArray(row.output_shapes);
  const tags = toStringArray(row.tags);
  const tasks = toTasks(row);
  const classification = classifyTasks(tasks);
  const hardcodedUrls = extractHardcodedUrls(tasks);

  const missing_input_shapes = inputShapes.length === 0;
  const missing_output_shapes = outputShapes.length === 0;
  const default_shapes =
    matchesAnyDefault(inputShapes, DEFAULT_INPUT_COMBINATIONS) ||
    matchesAnyDefault(outputShapes, DEFAULT_OUTPUT_COMBINATIONS);
  const missing_tags = tags.length === 0;
  const weak_description = description.trim().length < 50;
  // all_llm_tasks: every task that has any content at all is LLM. Guard against
  // zero-task templates (treat as not-all-llm to avoid penalising them twice —
  // they'll already be flagged by no_task_outputs).
  const all_llm_tasks =
    tasks.length > 0 &&
    classification.resolverCount === 0 &&
    classification.llmCount === tasks.length;
  const no_task_outputs = !classification.hasAnyOutputDecl;

  const deficiencies: TemplateDeficiencies = {
    missing_input_shapes,
    missing_output_shapes,
    default_shapes,
    missing_tags,
    weak_description,
    all_llm_tasks,
    no_task_outputs,
    hardcoded_urls: hardcodedUrls,
  };

  // Completeness: 7 boolean flags. `hardcoded_urls` counts as 1 flag when the
  // array is non-empty, 0 otherwise. We count TRUE (bad) flags and return
  // 1 - (bad / 7).
  const booleanFlags = [
    missing_input_shapes,
    missing_output_shapes,
    default_shapes,
    missing_tags,
    weak_description,
    all_llm_tasks,
    no_task_outputs,
  ];
  let badCount = booleanFlags.reduce((acc, f) => (f ? acc + 1 : acc), 0);
  if (hardcodedUrls.length > 0) badCount += 1;
  const completeness_score = Math.max(0, Math.min(1, 1 - badCount / 7));

  const current: TemplateCurrent = {
    input_shapes: inputShapes,
    output_shapes: outputShapes,
    tags,
    task_count: tasks.length,
    resolver_task_count: classification.resolverCount,
    llm_task_count: classification.llmCount,
  };

  const result: TemplateAuditRow = {
    id,
    name,
    scope,
    deficiencies,
    current,
    completeness_score,
  };

  if (includeProposals) {
    // Only propose if we have a description to reason about. Empty description
    // -> empty proposals (we don't want to guess from the bare id).
    if (description.trim().length > 0) {
      const taskDescriptions = tasks
        .map((t) => toStringOrEmpty(t.description))
        .filter((s) => s.length > 0);
      const combined = [description, ...taskDescriptions].join(' \n ');
      const semantics = analyzeTaskSemantics(combined);

      const proposals: TemplateProposals = {};
      if (semantics.tagPrefixes.length > 0) proposals.suggested_tags = semantics.tagPrefixes;
      if (semantics.impliedShapes.length > 0) {
        // No single semantic model for input-vs-output; surface the same set
        // twice and let the consumer narrow. Activities using these proposals
        // should cross-check against observed shape usage.
        proposals.suggested_input_shapes = semantics.impliedShapes;
        proposals.suggested_output_shapes = semantics.impliedShapes;
      }
      result.proposals = proposals;
    } else {
      result.proposals = {};
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Query + dedupe
// ---------------------------------------------------------------------------

async function queryTemplates(
  db: Surreal,
  auth: AuditAuthContext,
  scope?: 'global' | 'org' | 'project',
): Promise<RawTemplateRow[]> {
  // Read from the paradigm `activity` table (preferred) and fall back to the
  // legacy `activity_template` view. We then de-duplicate by primary id so
  // that deployments where `activity_template` is a view over `activity`
  // don't report the same template twice.
  //
  // For API-key auth we add `org_id = $orgId OR scope = 'global'` manually;
  // for JWT auth the caller's db client already honours PERMISSIONS but the
  // extra predicate is a safe no-op.

  const orgPredicate =
    auth.authType === 'apikey'
      ? `(org_id = $orgId OR scope = 'global')`
      : `(org_id = $orgId OR scope = 'global' OR org_id IS NONE)`;

  const scopePredicate = scope ? ` AND scope = $scope` : '';
  const whereClause = `WHERE ${orgPredicate}${scopePredicate}`;
  const params: Record<string, unknown> = { orgId: auth.orgId };
  if (scope) params.scope = scope;

  const fields =
    'id, name, variant_name, description, scope, org_id, tags, input_shapes, output_shapes, tasks, task_steps';

  const rows: RawTemplateRow[] = [];

  for (const table of ['activity', 'activity_template']) {
    try {
      const result = await db.query(`SELECT ${fields} FROM ${table} ${whereClause}`, params);
      const firstSet = Array.isArray(result) && result.length > 0 ? result[0] : [];
      if (Array.isArray(firstSet)) {
        for (const r of firstSet) {
          if (r && typeof r === 'object') rows.push(r as RawTemplateRow);
        }
      }
    } catch (err) {
      logger.warn('[template-audit] Failed to query table, skipping', {
        table,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return rows;
}

/** De-duplicate by primary id. When the same id appears in both `activity`
 *  and `activity_template` (view case) prefer the row that carries `tasks`
 *  rather than `task_steps`, since that's the paradigm shape. */
function dedupeTemplates(rows: RawTemplateRow[]): RawTemplateRow[] {
  const byId = new Map<string, RawTemplateRow>();
  for (const row of rows) {
    const id = primaryId(row.id);
    if (!id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, row);
      continue;
    }
    const existingHasTasks = Array.isArray(existing.tasks) && existing.tasks.length > 0;
    const newHasTasks = Array.isArray(row.tasks) && row.tasks.length > 0;
    if (!existingHasTasks && newHasTasks) byId.set(id, row);
  }
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function hasAnyMissingMarker(
  deficiencies: TemplateDeficiencies,
  markers: MissingMarker[],
): boolean {
  for (const m of markers) {
    switch (m) {
      case 'input_shapes':
        if (deficiencies.missing_input_shapes) return true;
        break;
      case 'output_shapes':
        if (deficiencies.missing_output_shapes) return true;
        break;
      case 'tags':
        if (deficiencies.missing_tags) return true;
        break;
      case 'description':
        if (deficiencies.weak_description) return true;
        break;
      case 'task_outputs':
        if (deficiencies.no_task_outputs) return true;
        break;
      case 'hardcoded_urls':
        if (deficiencies.hardcoded_urls.length > 0) return true;
        break;
    }
  }
  return false;
}

function matchesTaskFormat(row: TemplateAuditRow, format: TaskFormat): boolean {
  const { resolver_task_count: r, llm_task_count: l, task_count: n } = row.current;
  switch (format) {
    case 'all_llm':
      return n > 0 && r === 0 && l === n;
    case 'all_resolver':
      return n > 0 && l === 0 && r === n;
    case 'mixed':
      return n > 0 && r > 0 && l > 0;
    case 'any':
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute a templateAuditReport for the caller's org.
 *
 * The `db` argument must already be authenticated (JWT) or a root client (for
 * API-key auth). The function does NOT perform auth itself — that's the
 * responsibility of the caller in `impulses.ts`.
 */
export async function runTemplateAuditReport(
  db: Surreal,
  input: TemplateAuditInput,
  auth: AuditAuthContext,
): Promise<TemplateAuditReport> {
  const includeProposals = input.includeProposals !== false;
  const includeAliasWarnings = input.includeAliasWarnings !== false;
  const limit = Math.min(Math.max(1, input.filter?.limit ?? 100), 500);
  const offset = Math.max(0, input.filter?.offset ?? 0);

  // 1. Fetch templates from both tables, de-duplicate.
  const rawRows = await queryTemplates(db, auth, input.filter?.scope);
  const deduped = dedupeTemplates(rawRows);

  // 2. Compute audit rows.
  const allRows = deduped.map((r) => auditRow(r, includeProposals));

  // 3. Apply filters.
  let filtered = allRows;
  const missingMarkers = input.filter?.missingMarkers;
  if (missingMarkers && missingMarkers.length > 0) {
    filtered = filtered.filter((r) => hasAnyMissingMarker(r.deficiencies, missingMarkers));
  }
  const taskFormat = input.filter?.taskFormat ?? 'any';
  if (taskFormat !== 'any') {
    filtered = filtered.filter((r) => matchesTaskFormat(r, taskFormat));
  }

  // 4. Stable ordering: lowest completeness first (worst deficiencies surface
  //    first), then id for determinism.
  filtered.sort((a, b) => {
    if (a.completeness_score !== b.completeness_score) {
      return a.completeness_score - b.completeness_score;
    }
    return a.id.localeCompare(b.id);
  });

  const totalWithDeficiencies = filtered.filter((r) => r.completeness_score < 1).length;
  const paged = filtered.slice(offset, offset + limit);

  // 5. Shape observations (reused from observed-shapes utility). Non-fatal
  //    if it fails — we'd rather return a partial report than 500.
  let aliasWarnings: AliasCandidate[] | undefined;
  let observedSummary: TemplateAuditReport['observed_shape_summary'];
  if (includeAliasWarnings) {
    try {
      const observed = await observeShapes(db);
      aliasWarnings = findAliasClusters(observed);
      observedSummary = summariseObserved(observed);
    } catch (err) {
      logger.warn('[template-audit] observeShapes failed; continuing without alias warnings', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const report: TemplateAuditReport = {
    generated_at: new Date().toISOString(),
    total_scanned: allRows.length,
    total_with_deficiencies: totalWithDeficiencies,
    templates: paged,
  };
  if (aliasWarnings) report.alias_warnings = aliasWarnings;
  if (observedSummary) report.observed_shape_summary = observedSummary;
  return report;
}

function summariseObserved(observed: ObservedShapeUsage[]): TemplateAuditReport['observed_shape_summary'] {
  const top20 = observed.slice(0, 20).map((o) => ({ shape: o.shape, total: o.total }));
  return {
    total_unique_shapes: observed.length,
    top_20_shapes: top20,
  };
}

// ---------------------------------------------------------------------------
// Internal exports for tests
// ---------------------------------------------------------------------------

export const _internals = {
  auditRow,
  dedupeTemplates,
  extractHardcodedUrls,
  matchesAnyDefault,
  DEFAULT_INPUT_COMBINATIONS,
  DEFAULT_OUTPUT_COMBINATIONS,
};
