/**
 * Observed Shapes Utility (descriptive, not prescriptive)
 *
 * Shapes in this system are LEARNED semantic types that emerge from template
 * authorship and execution data. They are NOT a fixed canonical vocabulary.
 *
 * This utility describes what shapes are currently in use across the activity
 * corpus - at the template level (`input_shapes`, `output_shapes`) and at the
 * per-task level (`inputShapes`, `outputShapes`, `outputImpulses`) - and surfaces
 * likely alias clusters (e.g. `execution_trace` vs `executionTrace`) so that
 * downstream consumers can reason about shape drift and duplication.
 *
 * Intentionally NOT a gatekeeper: there is no allow-list, no validation, and
 * no rejection. Consumers decide what to do with the observations.
 */
import type { Surreal } from 'surrealdb';

import { logger } from './logger';

export interface ObservedShapeUsage {
  shape: string;
  sources: {
    templateInputShapes: number;
    templateOutputShapes: number;
    taskInputShapes: number;
    taskOutputShapes: number;
    taskOutputImpulses: number;
  };
  total: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface AliasCandidate {
  shape: string;
  candidates: Array<{
    other: string;
    similarity: number;
    reason: 'levenshtein' | 'normalized-equal' | 'substring';
  }>;
}

/**
 * Normalize a shape string for comparison purposes.
 *
 * Collapses common casing/punctuation variants so we can detect that
 * `execution_trace`, `executionTrace`, and `execution-trace` describe the
 * same concept. Lowercases and strips underscores, hyphens, and colons.
 */
export function normalizeShape(shape: string): string {
  return shape.toLowerCase().replace(/[_\-:]/g, '');
}

/**
 * Levenshtein edit distance between two strings.
 *
 * Pure function. Uses the standard dynamic programming table.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // dp[i][j] = edit distance between a.slice(0,i) and b.slice(0,j)
  const rows = a.length + 1;
  const cols = b.length + 1;

  let prev = new Array<number>(cols);
  let curr = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;

  for (let i = 1; i < rows; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insertion
        prev[j] + 1,           // deletion
        prev[j - 1] + cost,    // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[cols - 1];
}

// ---------------------------------------------------------------------------
// DB observation
// ---------------------------------------------------------------------------

interface RawActivityRow {
  input_shapes?: unknown;
  output_shapes?: unknown;
  tasks?: unknown;
  task_steps?: unknown;
  created_at?: unknown;
}

interface RawTaskShape {
  inputShapes?: unknown;
  outputShapes?: unknown;
  outputImpulses?: unknown;
}

interface Accumulator {
  counts: {
    templateInputShapes: number;
    templateOutputShapes: number;
    taskInputShapes: number;
    taskOutputShapes: number;
    taskOutputImpulses: number;
  };
  firstSeenAt?: string;
  lastSeenAt?: string;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

function toTasks(row: RawActivityRow): unknown[] {
  if (Array.isArray(row.tasks)) return row.tasks;
  if (Array.isArray(row.task_steps)) return row.task_steps;
  return [];
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  // SurrealDB may return datetime wrapped as an object depending on the
  // client version. Try toString() as a last resort.
  try {
    const s = String(value);
    return s.length > 0 ? s : undefined;
  } catch {
    return undefined;
  }
}

function bump(
  acc: Map<string, Accumulator>,
  shape: string,
  key: keyof Accumulator['counts'],
  createdAt: string | undefined,
): void {
  let entry = acc.get(shape);
  if (!entry) {
    entry = {
      counts: {
        templateInputShapes: 0,
        templateOutputShapes: 0,
        taskInputShapes: 0,
        taskOutputShapes: 0,
        taskOutputImpulses: 0,
      },
    };
    acc.set(shape, entry);
  }
  entry.counts[key] += 1;

  if (createdAt) {
    if (!entry.firstSeenAt || createdAt < entry.firstSeenAt) {
      entry.firstSeenAt = createdAt;
    }
    if (!entry.lastSeenAt || createdAt > entry.lastSeenAt) {
      entry.lastSeenAt = createdAt;
    }
  }
}

function accumulateRow(acc: Map<string, Accumulator>, row: RawActivityRow): void {
  const createdAt = toIsoTimestamp(row.created_at);

  // Template-level input/output shapes: dedup within a single template so
  // a template with duplicate entries contributes one template-level count.
  const templateInputs = new Set(toStringArray(row.input_shapes));
  for (const shape of templateInputs) {
    bump(acc, shape, 'templateInputShapes', createdAt);
  }

  const templateOutputs = new Set(toStringArray(row.output_shapes));
  for (const shape of templateOutputs) {
    bump(acc, shape, 'templateOutputShapes', createdAt);
  }

  // Per-task shapes. Each task contributes independently; within a single
  // task we dedup so a repeated entry in inputShapes counts once for that task.
  for (const rawTask of toTasks(row)) {
    if (!rawTask || typeof rawTask !== 'object') continue;
    const task = rawTask as RawTaskShape;

    const taskInputs = new Set(toStringArray(task.inputShapes));
    for (const shape of taskInputs) {
      bump(acc, shape, 'taskInputShapes', createdAt);
    }

    const taskOutputs = new Set(toStringArray(task.outputShapes));
    for (const shape of taskOutputs) {
      bump(acc, shape, 'taskOutputShapes', createdAt);
    }

    const taskImpulses = new Set(toStringArray(task.outputImpulses));
    for (const shape of taskImpulses) {
      bump(acc, shape, 'taskOutputImpulses', createdAt);
    }
  }
}

async function queryRows(db: Surreal, table: string): Promise<RawActivityRow[]> {
  try {
    const result = await db.query(
      `SELECT input_shapes, output_shapes, tasks, task_steps, created_at FROM ${table}`,
    );
    // SurrealDB query returns array of result sets; take the first set.
    const firstSet = Array.isArray(result) && result.length > 0 ? result[0] : [];
    if (!Array.isArray(firstSet)) return [];
    return firstSet as RawActivityRow[];
  } catch (error) {
    // Graceful degradation: if a table doesn't exist in this deployment
    // (e.g. pre-paradigm or view not defined) we log and contribute 0.
    logger.warn('[observed-shapes] Failed to query table, skipping', {
      table,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Observe shape usage across the activity corpus.
 *
 * Reads `activity` (paradigm) and `activity_template` (legacy view/table),
 * accumulates per-shape counts at the template and task levels, and returns
 * the result sorted by total usage (descending).
 *
 * The client is dependency-injected so tests/tools can pass any Surreal
 * instance (root or authenticated).
 */
export async function observeShapes(db: Surreal): Promise<ObservedShapeUsage[]> {
  const accumulator = new Map<string, Accumulator>();

  // Query both tables. In modern deployments `activity_template` is a view
  // over `activity`, so rows will overlap - this is fine for a descriptive
  // count; we're reporting observed surface area, not unique templates.
  // In legacy deployments only `activity_template` may have data.
  const [activityRows, templateRows] = await Promise.all([
    queryRows(db, 'activity'),
    queryRows(db, 'activity_template'),
  ]);

  for (const row of activityRows) accumulateRow(accumulator, row);
  for (const row of templateRows) accumulateRow(accumulator, row);

  const results: ObservedShapeUsage[] = [];
  for (const [shape, entry] of accumulator.entries()) {
    const total =
      entry.counts.templateInputShapes +
      entry.counts.templateOutputShapes +
      entry.counts.taskInputShapes +
      entry.counts.taskOutputShapes +
      entry.counts.taskOutputImpulses;

    results.push({
      shape,
      sources: { ...entry.counts },
      total,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
    });
  }

  results.sort((a, b) => b.total - a.total);
  return results;
}

// ---------------------------------------------------------------------------
// Alias detection
// ---------------------------------------------------------------------------

/**
 * Surface probable alias clusters among observed shapes.
 *
 * Heuristic (intentionally conservative - we'd rather miss a real alias than
 * mis-merge two distinct shapes):
 *
 *   1. `normalized-equal`: after `normalizeShape`, the two strings are
 *      identical. Similarity 1.0. This catches casing/punctuation drift
 *      like `execution_trace` vs `executionTrace`.
 *   2. `levenshtein`: edit distance on the NORMALIZED forms is <= 2 and
 *      the shorter normalized form is at least 4 chars long (avoids
 *      conflating short near-identical strings like `log` vs `bug`).
 *      Similarity is scaled by normalized-length.
 *   3. `substring`: one normalized form is a proper substring of the other
 *      and the shorter is at least 5 chars long. Similarity is the ratio
 *      of lengths. Helps surface `trace` vs `executionTrace`.
 *
 * The output only contains entries for shapes that have at least one
 * candidate; shapes without lookalikes are omitted.
 */
export function findAliasClusters(observed: ObservedShapeUsage[]): AliasCandidate[] {
  const shapes = observed.map((o) => o.shape);
  const normalized = shapes.map(normalizeShape);
  const out: AliasCandidate[] = [];

  for (let i = 0; i < shapes.length; i++) {
    const candidates: AliasCandidate['candidates'] = [];
    const aNorm = normalized[i];
    if (!aNorm) continue;

    for (let j = 0; j < shapes.length; j++) {
      if (i === j) continue;
      const bNorm = normalized[j];
      if (!bNorm) continue;

      // 1. Normalized equality: strongest signal.
      if (aNorm === bNorm) {
        candidates.push({
          other: shapes[j],
          similarity: 1,
          reason: 'normalized-equal',
        });
        continue;
      }

      // 2. Levenshtein on normalized forms, with a minimum-length guard.
      const minLen = Math.min(aNorm.length, bNorm.length);
      if (minLen >= 4) {
        const dist = levenshtein(aNorm, bNorm);
        if (dist <= 2) {
          const maxLen = Math.max(aNorm.length, bNorm.length);
          const similarity = maxLen === 0 ? 0 : 1 - dist / maxLen;
          candidates.push({
            other: shapes[j],
            similarity,
            reason: 'levenshtein',
          });
          continue;
        }
      }

      // 3. Substring containment (proper, with minimum-length guard).
      if (aNorm !== bNorm && minLen >= 5) {
        const [shorter, longer] = aNorm.length <= bNorm.length ? [aNorm, bNorm] : [bNorm, aNorm];
        if (longer.includes(shorter)) {
          candidates.push({
            other: shapes[j],
            similarity: shorter.length / longer.length,
            reason: 'substring',
          });
        }
      }
    }

    if (candidates.length > 0) {
      // Highest-confidence candidates first.
      candidates.sort((a, b) => b.similarity - a.similarity);
      out.push({ shape: shapes[i], candidates });
    }
  }

  return out;
}
