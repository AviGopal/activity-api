/**
 * LIFECYCLE SUBSCRIBER RUNS, COUNTED (CHANGE DB1).
 *
 * goal-host traced every lifecycle-subscriber run (validator-dispatch, slot-binding, ribosome-extract,
 * audit-test-report, debug-failing-audit) as a full execution: measured on node1 (2 h to 2026-10-16T07:54Z) 32.1
 * lifecycle trace writes per run-goal start, and each ingest pays the full posterior/edge/credit path. With the
 * shaped switch lifecycle.subscriber_trace_mode = 1, ias-executor-ts counts a NORMAL subscriber run instead and
 * flushes the counts here about once a minute; an ANOMALOUS run (status failed, or a task with success:false)
 * still writes its full trace, so nothing the learner needs to see fails silently.
 *
 * What this applies, per (subscriber template, parent execution) count, for exactly the readers a normal subscriber
 * trace fed (history: CHANGE DB1 record):
 *   - the subscriber's own variant_performance_metrics: execution counters (total / successful / failed, average
 *     duration and cost) and its Thompson alpha/beta (alpha += ok, beta += fail) through the one leaf writer
 *     (applyVariantThompsonDelta), so its posterior is fed, not starved to failures only;
 *   - the parent -> subscriber hub edge in activity_composition_graph (execution_count / success_count), with the
 *     parents' templates resolved in ONE read per batch instead of one read per trace.
 * What it deliberately does NOT apply (both were wrong for a subscriber, and are named fixes):
 *   - NO ancestor (TD-lambda) credit: a subscriber's composition_chain holds its PARENT, so its outcome credited the
 *     parent's arms with the subscriber's result;
 *   - NO decision_outcome: the subscriber inherits the parent's correlation:<id> tag, so its outcome could overwrite
 *     the parent's decision outcome.
 * Nor the trace-store row counter: that counts rows stored in `execution`, and a counted run stores none.
 *
 * Delivery is at-least-once (the sender retries): a batch id seen in the last hour is answered as a duplicate and
 * applied once.
 */
import { logger } from '../utils/logger';

export interface SubscriberParentCount { parent_execution_id: string; runs: number; ok: number }
export interface SubscriberCountEntry {
  template_id: string;
  variant_id?: string;
  runs: number;
  ok: number;
  fail: number;
  duration_ms_sum?: number;
  cost_usd_sum?: number;
  parents?: SubscriberParentCount[];
}
export interface SubscriberCountsBatch { batch_id: string; window_start?: string; window_end?: string; entries: SubscriberCountEntry[] }

const nonNegInt = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Why a batch is malformed, or null. Counts must add up: ok + fail = runs, and a parent's ok <= its runs. */
export function subscriberCountsProblem(b: unknown): string | null {
  if (!b || typeof b !== 'object') return 'body must be an object';
  const batch = b as Partial<SubscriberCountsBatch>;
  if (typeof batch.batch_id !== 'string' || batch.batch_id.length === 0 || batch.batch_id.length > 200) return 'batch_id is required';
  if (!Array.isArray(batch.entries) || batch.entries.length === 0 || batch.entries.length > 500) return 'entries must be a non-empty array (at most 500)';
  for (const e of batch.entries) {
    if (!e || typeof e.template_id !== 'string' || !e.template_id) return 'every entry needs a template_id';
    if (!nonNegInt(e.runs) || !nonNegInt(e.ok) || !nonNegInt(e.fail) || e.ok + e.fail !== e.runs) return `entry ${e.template_id}: runs/ok/fail must be non-negative integers with ok + fail = runs`;
    for (const p of e.parents ?? []) {
      if (!p || typeof p.parent_execution_id !== 'string' || !nonNegInt(p.runs) || !nonNegInt(p.ok) || p.ok > p.runs) return `entry ${e.template_id}: a parent count is malformed`;
    }
  }
  return null;
}

export interface SubscriberCountsDeps {
  /** Execution counters on the subscriber's variant_performance_metrics row; false when the row does not exist. */
  vpmCounters: (variantId: string, orgId: string, e: SubscriberCountEntry) => Promise<boolean>;
  /** The one leaf Thompson writer (posterior-update.ts applyVariantThompsonDelta). */
  thompson: (variantId: string, orgId: string, alphaDelta: number, betaDelta: number) => Promise<string>;
  /** Parent execution id -> its activity (template) id, for every id in ONE read. */
  resolveParents: (executionIds: string[]) => Promise<Map<string, string>>;
  /** The parent -> child hub edge, incremented by runs / ok. */
  edge: (parentActivityId: string, childActivityId: string, runs: number, ok: number, orgId: string) => Promise<void>;
}

const seenBatches = new Map<string, number>();
const SEEN_TTL_MS = 3_600_000;
const stats = { batches: 0, duplicates: 0, entries: 0, runs: 0, missing_vpm_rows: 0, unresolved_parents: 0, errors: 0 };
/** Process counters for the counts path (exposed for health and tests). */
export function subscriberCountsStats(): Readonly<typeof stats> { return { ...stats }; }
export function __resetSubscriberCountsForTests(): void { seenBatches.clear(); for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0; }

export interface SubscriberCountsResult { duplicate: boolean; entries: number; runs: number; edges: number; missing_vpm_rows: number; unresolved_parents: number }

export async function applySubscriberCounts(batch: SubscriberCountsBatch, orgId: string, deps: SubscriberCountsDeps, now = Date.now()): Promise<SubscriberCountsResult> {
  for (const [id, at] of seenBatches) if (now - at > SEEN_TTL_MS) seenBatches.delete(id);
  if (seenBatches.has(batch.batch_id)) {
    stats.duplicates += 1;
    return { duplicate: true, entries: 0, runs: 0, edges: 0, missing_vpm_rows: 0, unresolved_parents: 0 };
  }
  stats.batches += 1;
  const out: SubscriberCountsResult = { duplicate: false, entries: 0, runs: 0, edges: 0, missing_vpm_rows: 0, unresolved_parents: 0 };
  const parentIds = [...new Set(batch.entries.flatMap((e) => (e.parents ?? []).map((p) => p.parent_execution_id)))];
  let parents = new Map<string, string>();
  if (parentIds.length > 0) {
    try { parents = await deps.resolveParents(parentIds); }
    catch (err) { stats.errors += 1; logger.warn('[subscriber-counts] parent lookup failed (edges skipped this batch)', { batch_id: batch.batch_id, error: err instanceof Error ? err.message : String(err) }); }
  }
  for (const e of batch.entries) {
    const variantId = e.variant_id || e.template_id;
    out.entries += 1; out.runs += e.runs; stats.entries += 1; stats.runs += e.runs;
    try {
      if (!(await deps.vpmCounters(variantId, orgId, e))) { out.missing_vpm_rows += 1; stats.missing_vpm_rows += 1; }
      if (e.ok + e.fail > 0) await deps.thompson(variantId, orgId, e.ok, e.fail);
    } catch (err) {
      stats.errors += 1;
      logger.warn('[subscriber-counts] posterior write failed', { batch_id: batch.batch_id, template_id: e.template_id, error: err instanceof Error ? err.message : String(err) });
    }
    // Hub edges, summed per parent TEMPLATE (several parent executions of one template are one edge).
    const perParentTemplate = new Map<string, { runs: number; ok: number }>();
    for (const p of e.parents ?? []) {
      const pt = parents.get(p.parent_execution_id);
      if (!pt) { out.unresolved_parents += 1; stats.unresolved_parents += 1; continue; }
      if (pt === e.template_id) continue; // a self edge is never written (as deriveCompositionEdgeFromParent)
      const acc = perParentTemplate.get(pt) ?? { runs: 0, ok: 0 };
      acc.runs += p.runs; acc.ok += p.ok;
      perParentTemplate.set(pt, acc);
    }
    for (const [pt, c] of perParentTemplate) {
      try { await deps.edge(pt, e.template_id, c.runs, c.ok, orgId); out.edges += 1; }
      catch (err) { stats.errors += 1; logger.warn('[subscriber-counts] edge write failed', { parent: pt, child: e.template_id, error: err instanceof Error ? err.message : String(err) }); }
    }
  }
  // Recorded only once applied: a redelivery after a crash mid-batch is applied, not answered as a duplicate.
  seenBatches.set(batch.batch_id, now);
  logger.info('[subscriber-counts] applied', { batch_id: batch.batch_id, org_id: orgId, ...out });
  return out;
}
