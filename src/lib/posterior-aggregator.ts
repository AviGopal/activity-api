/**
 * posterior-aggregator.ts — coalesce additive Thompson α/β deltas per hot row.
 *
 * WHY (2026-06-21): every execution of a template UPDATEs the SAME
 * `variant_performance_metrics` row (`thompson_alpha += δ`), and composition
 * chain-credit (`writeAncestorDelta`) UPDATEs the SAME ancestor rows. Under
 * autonomous load, concurrent read-modify-write UPDATEs on a handful of hot rows
 * abort with SurrealDB optimistic-concurrency "read or write conflict" — and the
 * learning write is then DROPPED (callers swallow it non-blocking). The result:
 * `variant_performance_metrics` and `context_thompson_scores` silently fail to
 * accumulate, so the learning store / decision topology cannot self-assemble.
 *
 * FIX: α/β deltas are ADDITIVE and COMMUTATIVE, so N concurrent `+δ` on one row
 * collapse losslessly into a single `+Σδ`. This buffer coalesces deltas keyed by
 * row identity and flushes one UPDATE per hot row every FLUSH_MS, turning N
 * conflicting transactions into 1. Conflicts at the source disappear; the
 * surreal.ts conflict-retry stops firing under load; in_flight drops.
 *
 * Gated by POSTERIOR_COALESCE (default ON). Set POSTERIOR_COALESCE=0 to fall back
 * to synchronous in-place UPDATEs. Flushes on SIGTERM/SIGINT so no deltas are lost
 * on shutdown.
 */
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { decayedThompsonCounts } from "./posterior-update";
import { getTuningParam } from './tuning-params';

/**
 * POSTERIOR_COALESCE, read as data rather than frozen at process start (law 1, audit 3.8).
 *
 * This gates whether alpha/beta deltas are coalesced at all — with it off, every delta goes
 * out as a direct read-modify-write UPDATE and the optimistic-concurrency conflict storm this
 * module exists to remove comes back, dropping learning writes under load. That is behaviour,
 * and law 1 says behaviour may not live somewhere the system cannot observe or change.
 *
 * WHY A CACHED BOOLEAN AND NOT AN ASYNC READ. `enqueueVariantDelta` is synchronous and one of
 * its two callers reads it inside a compound `&&` condition on the hot learning-write path.
 * Making it async means restructuring that condition, and a mistake there silently drops
 * posterior writes — precisely the failure class this file's own history is about. So the
 * value is refreshed on the flush timer this module ALREADY runs, and read synchronously.
 *
 * That still satisfies the law as this fleet defines it: activity-api's getTuningParam is
 * itself a 30s TTL cache, so "read at use time" here has always meant "within one refresh
 * window, no restart". This just uses a window the module already had.
 *
 * Env remains the middle tier (row -> env -> default), so no deployment setting
 * POSTERIOR_COALESCE=0 silently re-enables coalescing.
 */
let coalesceEnabled = process.env.POSTERIOR_COALESCE !== '0';

/** The live setting. Synchronous by necessity; freshness comes from refreshCoalesceSetting. */
export function posteriorCoalesceEnabled(): boolean {
  return coalesceEnabled;
}

/** Back-compat for existing importers; now a snapshot rather than a frozen constant. */
export const POSTERIOR_COALESCE_ENABLED = coalesceEnabled;

/**
 * Re-resolve the setting from the tuning table. Called from the flush timer, so the value
 * tracks an authored row within one FLUSH_MS window without a restart.
 *
 * Never throws and never flips the value on a lookup failure: getTuningParam already falls
 * back to env-then-default internally, and a DB blip must not silently disable coalescing on
 * a loaded box — which is the exact condition under which coalescing matters most.
 */
let coalesceRefreshInFlight = false;

async function refreshCoalesceSetting(): Promise<void> {
  // ★ A TUNING LOOKUP MUST NOT BE ABLE TO OUTLIVE ITS TICK. `getTuningParam` carries no
  //   deadline of its own, and against an unreachable store it does not fail fast — it HANGS.
  //   The first version of this refresh was fire-and-forget from the flush timer, which sounds
  //   safe and is not: each tick started another lookup that never settled, so pending work
  //   accumulated once per FLUSH_MS forever. Measured effect —
  //   `applyOutcomeToPosteriors` timed out after 5000ms, i.e. a POLICY REFRESH stalled a
  //   CREDIT WRITE. The same store saturation that already loses reach verdicts would now also
  //   stall the path that records them, which is strictly worse than the condition this flag
  //   exists to help with.
  //
  //   So: at most one refresh in flight, and a hard deadline well inside the flush cadence.
  //   A refresh that cannot finish quickly is a refresh not worth having — the cached value is
  //   always a valid answer.
  if (coalesceRefreshInFlight) return;
  coalesceRefreshInFlight = true;
  try {
    const envRaw = process.env.POSTERIOR_COALESCE;
    // Default 1 = enabled, matching `!== '0'`. An authored 0 disables; anything else enables.
    const v = await Promise.race([
      getTuningParam('POSTERIOR_COALESCE', envRaw, envRaw === '0' ? 0 : 1),
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error('tuning lookup deadline')), 2_000)),
    ]);
    coalesceEnabled = v >= 1;
  } catch {
    /* keep the last known value — a DB blip must not disable coalescing under load */
  } finally {
    coalesceRefreshInFlight = false;
  }
}
const FLUSH_MS = Math.max(50, parseInt(process.env.POSTERIOR_FLUSH_MS ?? '250', 10));

/** Which update a delta came from: the executed activity's own outcome, or chain credit to a producer. */
export type DeltaKind = 'leaf' | 'ancestor';

/** One issued ancestor (chain-credit) delta and what became of it. */
export type AncestorDeltaRecord = {
  at: string;
  variant_id: string;
  org_id: string;
  alpha: number;
  beta: number;
  ancestor_execution_id?: string;
  leaf_activity_id?: string;
  status: 'queued' | 'written' | 'dropped_no_row';
};

/** One delta discarded because no row matched: which org was tried and which orgs the variant has rows under. */
export type NoRowDropRecord = {
  at: string;
  variant_id: string;
  org_tried: string;
  /** null when the lookup itself failed (unknown, not "none"). */
  orgs_present: string[] | null;
  kinds: DeltaKind[];
  /** The executions whose deltas were folded into the dropped write: the first EXECUTION_IDS_MAX distinct ids. */
  execution_ids: string[];
  /** How many more distinct executions were folded in beyond execution_ids. */
  execution_ids_overflow: number;
};

interface PendingVariant {
  variantId: string;
  orgId: string;
  alpha: number;
  beta: number;
  kinds: Set<DeltaKind>;
  ancestorRecords: AncestorDeltaRecord[];
  /** Distinct executions folded into this Σδ, bounded (EXECUTION_IDS_MAX); the rest are only counted. */
  executionIds: string[];
  executionIdsOverflow: number;
}

/** A dropped write names at most this many of the executions folded into it; the rest are counted, not listed. */
const EXECUTION_IDS_MAX = 5;
function noteExecution(e: Pick<PendingVariant, 'executionIds' | 'executionIdsOverflow'>, id: string | undefined): void {
  if (!id || e.executionIds.includes(id)) return;
  if (e.executionIds.length < EXECUTION_IDS_MAX) e.executionIds.push(id);
  else e.executionIdsOverflow += 1;
}

const pendingVariant = new Map<string, PendingVariant>();
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

/** Deltas discarded because no `variant_performance_metrics` row matched the UPDATE.
 *  Module-scope so the count survives across flushes and appears in every warning — a
 *  single dropped delta reads as noise, a rising total reads as a severed channel. */
let droppedNoRow = 0;
/** The same drops split by where the delta came from, so a severed chain-credit channel is told apart from a
 *  leaf whose own row is missing (a delta carrying both kinds counts once in each). */
const droppedNoRowByKind: Record<DeltaKind, number> = { leaf: 0, ancestor: 0 };
const RING_MAX = 50;
const ancestorRing: AncestorDeltaRecord[] = [];
const dropRing: NoRowDropRecord[] = [];
const pushBounded = <T>(ring: T[], v: T): void => { ring.push(v); if (ring.length > RING_MAX) ring.shift(); };

export function posteriorDeltasDroppedNoRowByKind(): Record<DeltaKind, number> {
  return { ...droppedNoRowByKind };
}
/** The last issued ancestor deltas (newest last) with their outcome: the evidence that chain credit lands. */
export function recentAncestorDeltas(): AncestorDeltaRecord[] {
  return ancestorRing.map((r) => ({ ...r }));
}
/** The last no-row drops (newest last), each with the orgs its variant does have rows under. */
export function recentNoRowDrops(): NoRowDropRecord[] {
  return dropRing.map((r) => ({ ...r, orgs_present: r.orgs_present ? [...r.orgs_present] : null, kinds: [...r.kinds], execution_ids: [...r.execution_ids] }));
}
/** Record an issued ancestor delta in the ring; the returned record's status is updated when it is written or dropped. */
export function recordAncestorDelta(rec: Omit<AncestorDeltaRecord, 'at' | 'status'>): AncestorDeltaRecord {
  const r: AncestorDeltaRecord = { at: new Date().toISOString(), status: 'queued', ...rec };
  pushBounded(ancestorRing, r);
  return r;
}

type Queryable = { query: <T = unknown>(sql: string, vars?: Record<string, unknown>) => Promise<T[]> };
/**
 * Count one no-row drop and record WHY: the orgs this variant has rows under, read with an equality-only lookup
 * (no range, so the 2.3.10 indexed-count defect does not apply). Shared by the flush and by the synchronous
 * fallback write in posterior-update. Never throws.
 */
export async function recordNoRowDrop(db: Queryable, variantId: string, orgId: string, kinds: DeltaKind[], alpha: number, beta: number, executionIds: string[] = [], executionIdsOverflow = 0): Promise<void> {
  droppedNoRow += 1;
  for (const k of kinds) droppedNoRowByKind[k] += 1;
  let orgsPresent: string[] | null = null;
  try {
    const rows = await db.query<unknown>(
      `SELECT VALUE org_id FROM variant_performance_metrics WHERE variant_id = $variant_id LIMIT 20`,
      { variant_id: variantId },
    );
    orgsPresent = [...new Set((Array.isArray(rows) ? rows : []).map((o) => String(o ?? 'NONE')))];
  } catch { /* unknown, recorded as null */ }
  pushBounded(dropRing, { at: new Date().toISOString(), variant_id: variantId, org_tried: orgId, orgs_present: orgsPresent, kinds: [...kinds], execution_ids: [...executionIds], execution_ids_overflow: executionIdsOverflow });
  logger.warn(
    'posterior delta DROPPED — no variant_performance_metrics row to update; this arm learns nothing from these executions',
    {
      event: 'posterior_delta_dropped_no_row',
      variant_id: variantId,
      org_id: orgId,
      orgs_present: orgsPresent,
      kinds,
      // Which executions this delta came from (bounded; a coalesced flush folds several), so a drop is attributed
      // by id rather than by the journal line that happens to precede it.
      execution_ids: executionIds,
      execution_ids_overflow: executionIdsOverflow,
      alpha_delta: alpha,
      beta_delta: beta,
      dropped_total: droppedNoRow,
    },
  );
}
/** Deltas dropped so far because their target row did not exist. Exposed for the health
 *  route and for tests; a learning channel whose loss rate cannot be read is one nobody
 *  can prioritise fixing. */
export function posteriorDeltasDroppedNoRow(): number {
  return droppedNoRow;
}

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    // Refresh the coalesce setting on the cadence the module already has — this is what makes
    // the flag data rather than a process-start constant.
    void refreshCoalesceSetting();
    void flushPosteriors();
  }, FLUSH_MS);
  // Don't keep the event loop alive solely for the flush timer.
  (flushTimer as { unref?: () => void }).unref?.();
}

/**
 * Coalesce an additive α/β delta for a variant_performance_metrics hot row.
 * Returns true if enqueued (coalescing active), false if the caller should fall
 * back to a synchronous UPDATE.
 */
export function enqueueVariantDelta(
  variantId: string,
  orgId: string,
  alphaDelta: number,
  betaDelta: number,
  kind: DeltaKind = 'leaf',
  ancestorRecord?: AncestorDeltaRecord,
  executionId?: string,
): boolean {
  if (!posteriorCoalesceEnabled()) return false;
  if (alphaDelta === 0 && betaDelta === 0) return true;
  const key = `${variantId} ${orgId}`;
  const existing = pendingVariant.get(key);
  if (existing) {
    existing.alpha += alphaDelta;
    existing.beta += betaDelta;
    existing.kinds.add(kind);
    if (ancestorRecord) existing.ancestorRecords.push(ancestorRecord);
    noteExecution(existing, executionId);
  } else {
    const e: PendingVariant = { variantId, orgId, alpha: alphaDelta, beta: betaDelta, kinds: new Set([kind]), ancestorRecords: ancestorRecord ? [ancestorRecord] : [], executionIds: [], executionIdsOverflow: 0 };
    noteExecution(e, executionId);
    pendingVariant.set(key, e);
  }
  ensureTimer();
  return true;
}

/**
 * Flush all buffered deltas — one UPDATE per hot row with Σδ already folded in.
 * Re-queues a row's residual delta on transient failure so nothing is lost.
 */
export async function flushPosteriors(): Promise<void> {
  if (flushing || pendingVariant.size === 0) return;
  flushing = true;
  try {
    const batch = [...pendingVariant.values()];
    pendingVariant.clear();
    for (const e of batch) {
      try {
        // Decay-aware flush (openspec 2026-07-29-thompson-posterior-time-decay): decay the
        // STORED posterior toward the neutral prior once per flush — using the row's own
        // updated_at — then add the coalesced Σδ. Decay applies to the pre-coalesce stored
        // value exactly once, never per-delta, so N coalesced deltas and 1 flush see the
        // same decay. Missing row / unparseable updated_at ⇒ fully decayed (1,1) — the
        // uninformative prior, which the deltas then rebuild.
        const rows = await surrealDB.query<{ thompson_alpha?: number | null; thompson_beta?: number | null; updated_at?: string | null }>(
          `SELECT thompson_alpha, thompson_beta, updated_at FROM variant_performance_metrics WHERE variant_id = $activity_id AND org_id = $org_id LIMIT 1`,
          { activity_id: e.variantId, org_id: e.orgId },
        );
        const row = rows?.[0];
        const lastUpdatedMs = (() => {
          const p = row?.updated_at ? Date.parse(String(row.updated_at)) : NaN;
          return Number.isNaN(p) ? 0 : p;
        })();
        const decayed = decayedThompsonCounts(row?.thompson_alpha ?? 1, row?.thompson_beta ?? 1, lastUpdatedMs, Date.now());
        const updated = await surrealDB.query(
          `
          UPDATE variant_performance_metrics
          SET
            thompson_alpha = $new_alpha,
            thompson_beta  = $new_beta,
            updated_at     = time::now()
          WHERE variant_id = $activity_id
            AND org_id     = $org_id
          `,
          {
            activity_id: e.variantId,
            org_id: e.orgId,
            new_alpha: decayed.alpha + e.alpha,
            new_beta: decayed.beta + e.beta,
          },
        );

        // A ZERO-ROW UPDATE DOES NOT THROW, SO THE catch BELOW NEVER SEES IT.
        //
        // The buffer is cleared before this loop and the only re-queue is in `catch`, so a
        // delta aimed at a row that does not exist is discarded in complete silence — the
        // learning signal for a brand-new arm, which is exactly the arm that most needs it.
        //
        // The decay block directly above already reasons about this case ("Missing row ⇒
        // fully decayed (1,1) — the uninformative prior, which the deltas then rebuild"),
        // but the deltas cannot rebuild anything through an UPDATE that matches nothing.
        // The read half planned for absence and the write half could not act on it.
        //
        // CREATION IS DELIBERATELY NOT ATTEMPTED HERE. Rows are created in the routes via
        // `type::thing('variant_performance_metrics', $record_id_slug)` with an
        // account-slug-derived record id this module does not have. Inventing a second
        // identity scheme would fragment the table across two id conventions — a worse
        // failure than the drop, and one that would look like working code.
        //
        // So: make it loud and countable. A silent loss cannot be prioritised; a logged one
        // can, and the count is the evidence for whichever fix is chosen.
        const rowsAffected = Array.isArray(updated) ? updated.length : (updated == null ? 0 : 1);
        if (rowsAffected === 0) {
          for (const r of e.ancestorRecords) r.status = 'dropped_no_row';
          await recordNoRowDrop(surrealDB, e.variantId, e.orgId, [...e.kinds], e.alpha, e.beta, e.executionIds, e.executionIdsOverflow);
        } else {
          for (const r of e.ancestorRecords) r.status = 'written';
        }
      } catch (err) {
        // Re-fold the residual delta back into the buffer so it is retried on the
        // next flush rather than dropped. surreal.ts already retries conflicts 4×;
        // reaching here means it still failed — keep the (now-coalesced) delta.
        const key = `${e.variantId} ${e.orgId}`;
        const cur = pendingVariant.get(key);
        if (cur) {
          cur.alpha += e.alpha;
          cur.beta += e.beta;
          for (const k of e.kinds) cur.kinds.add(k);
          cur.ancestorRecords.push(...e.ancestorRecords);
          for (const id of e.executionIds) noteExecution(cur, id);
          cur.executionIdsOverflow += e.executionIdsOverflow;
        } else {
          pendingVariant.set(key, e);
        }
        logger.warn('posterior-aggregator: flush UPDATE failed, re-queued', {
          variant_id: e.variantId,
          org_id: e.orgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    flushing = false;
  }
}

let shutdownHooked = false;
export function installPosteriorFlushOnShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const handler = () => {
    void flushPosteriors();
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  process.on('beforeExit', handler);
}
