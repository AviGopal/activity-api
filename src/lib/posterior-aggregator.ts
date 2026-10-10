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

// ─────────────────────────────────────────────────────────────────────────────
// β-leak COMPENSATION — a NON-FOLDING per-row queue (posterior-compensation.ts is the only caller).
//
// WHY NOT enqueueVariantDelta(−residue). pendingVariant folds every delta for a (variant, org) into one Σδ
// regardless of kind, and the flush below writes ABSOLUTE values (SELECT, decay in app memory, then
// `SET thompson_beta = decayed + Σδ`) with no transaction. A compensation folded into Σδ could neither be
// floored, nor idempotency-keyed, nor reported with exact before/after values; a compensation written by a
// separate transaction could be silently overwritten by the next absolute flush (lost update).
//
// SO: compensation items queue per row WITHOUT folding. A row that has items is flushed by
// flushCompensatedRow — the row's genuine Σδ (if any) travels with them — in ONE BEGIN…COMMIT that
// re-reads the row, refuses if it moved since the pre-read (CAS on α, β, updated_at) or if any ledger key
// already exists, then UPDATEs α/β = decayed + genuine Σδ − Σresidue and CREATEs one ledger row per item
// (UNIQUE ledger_key), returning the row AFTER the write. Rows without items take the unchanged path below.
//
// The decay is computed in app memory with the SAME decayedThompsonCounts (default half-life) the plain
// flush uses; the transaction's guard is what makes that read-then-write safe. Refused when coalescing is
// off: the synchronous fallback writers would race the ledgered write with no shared queue.
// ─────────────────────────────────────────────────────────────────────────────

/** What became of one compensation item. Every status except row_ambiguous/pending leaves a ledger row. */
export type CompensationStatus =
  | 'written'
  | 'floored'
  | 'reset_since_leak'
  | 'already_compensated'
  | 'dropped_no_row'
  | 'row_ambiguous';

export interface CompensationRequest {
  ledgerKey: string;
  variantId: string;
  orgId: string;
  /** When the leaked β landed on the row (ms). The residue is a unit β decayed from here to the flush. */
  leakAtMs: number;
  listSha: string;
  execId?: string;
}

export interface CompensationOutcome {
  ledger_key: string;
  variant_id: string;
  org_id: string;
  status: CompensationStatus;
  /** The leaked β as logged (always 1). */
  nominal: number;
  /** The kernel's factor from leak_at to the flush: what is left of that unit β now. */
  factor: number;
  /** What was actually subtracted (factor when written, else 0). */
  applied: number;
  /** The row's stored (α, β) as the transaction read it; null when there was no row. */
  before: { alpha: number; beta: number } | null;
  /** The row's (α, β) after the transaction (its own RETURN AFTER); null when there was no row. */
  after: { alpha: number; beta: number } | null;
  /** The flush instant written to updated_at and to the ledger row. */
  at: string | null;
  /** For already_compensated: the status of the ledger row that already existed. */
  existing_status?: string;
}

interface PendingCompensation extends CompensationRequest {
  settle: (o: CompensationOutcome) => void;
  attempts: number;
}

const pendingCompensation = new Map<string, PendingCompensation[]>();
const compRowKey = (variantId: string, orgId: string): string => `${variantId}\u0000${orgId}`;

/** Queued compensation items not yet flushed (tests and the replay's progress line read this). */
export function pendingCompensationCount(): number {
  let n = 0;
  for (const v of pendingCompensation.values()) n += v.length;
  return n;
}

/**
 * Queue one compensation item. Returns null (REFUSED) when coalescing is disabled; otherwise a promise that
 * settles when a flush has decided the item. Never folds into pendingVariant.
 */
export function enqueueCompensation(req: CompensationRequest): Promise<CompensationOutcome> | null {
  if (!posteriorCoalesceEnabled()) return null;
  const key = compRowKey(req.variantId, req.orgId);
  return new Promise<CompensationOutcome>((settle) => {
    const list = pendingCompensation.get(key) ?? [];
    list.push({ ...req, settle, attempts: 0 });
    pendingCompensation.set(key, list);
    ensureTimer();
  });
}

/** The unit-β residue: a β of 1 that landed at leakAtMs, decayed by the flush's own kernel to nowMs. */
export function compensationResidue(leakAtMs: number, nowMs: number): number {
  return decayedThompsonCounts(1, 2, leakAtMs, nowMs).beta - 1;
}

/** The pre-read of a compensated row (also the replay's plan/verify read). LIMIT 2 so a duplicate row is seen. */
export const COMPENSATION_ROW_SQL =
  `SELECT thompson_alpha, thompson_beta, <string> (updated_at ?? '') AS updated_at_s, successful_executions, failed_executions FROM variant_performance_metrics WHERE variant_id = $variant_id AND org_id = $org_id LIMIT 2`;

/** Ledger rows already present for these keys, plus any arm-level reset verdict for this row. */
export const COMPENSATION_LEDGER_SQL =
  `SELECT ledger_key, status FROM posterior_compensation_ledger WHERE ledger_key IN $keys OR (variant_id = $variant_id AND org_id = $org_id AND status = 'reset_since_leak')`;

/**
 * ONE transaction per compensated row. Decisions (decay, residue, floor, reset) were made in app memory from
 * the pre-read; $__ok is the guard that the row is still exactly what was read and no key is ledgered yet.
 * When $__ok is false nothing is written and the caller re-queues. The UNIQUE ledger_key index remains the
 * backstop for a race between two transactions (one conflicts and is retried, then sees the key).
 */
export const COMPENSATION_TXN_SQL = `
BEGIN TRANSACTION;
LET $__rows = (SELECT thompson_alpha, thompson_beta, <string> (updated_at ?? '') AS updated_at_s FROM variant_performance_metrics WHERE variant_id = $variant_id AND org_id = $org_id LIMIT 2);
LET $__dup = $keys.filter(|$k| record::exists(type::thing('posterior_compensation_ledger', $k)));
LET $__ok = array::len($__dup) = 0 AND array::len($__rows) = $seen_rows
  AND ($seen_rows = 0 OR ($__rows[0].thompson_alpha = $seen_alpha AND $__rows[0].thompson_beta = $seen_beta AND $__rows[0].updated_at_s = $seen_updated_at));
LET $__upd = (UPDATE variant_performance_metrics SET thompson_alpha = $new_alpha, thompson_beta = $new_beta, updated_at = <datetime> $now
  WHERE variant_id = $variant_id AND org_id = $org_id AND $__ok = true AND $do_update = true RETURN AFTER);
LET $__a = IF array::len($__upd) > 0 { $__upd[0] } ELSE { $__rows[0] };
FOR $__it IN $items {
  IF $__ok {
    CREATE type::thing('posterior_compensation_ledger', $__it.ledger_key) CONTENT {
      ledger_key: $__it.ledger_key,
      variant_id: $__it.variant_id,
      org_id: $__it.org_id,
      exec_id: $__it.exec_id,
      list_sha: $__it.list_sha,
      leak_at: <datetime> $__it.leak_at,
      nominal: $__it.nominal,
      factor: $__it.factor,
      applied: $__it.applied,
      status: $__it.status,
      before: $__it.before,
      after: { alpha: $__a.thompson_alpha, beta: $__a.thompson_beta },
      at: <datetime> $now
    };
  };
};
RETURN { ok: $__ok, dup: $__dup, rows: array::len($__rows), updated: array::len($__upd), after_alpha: $__a.thompson_alpha, after_beta: $__a.thompson_beta };
COMMIT TRANSACTION;`;

type CompRowRead = {
  thompson_alpha?: number | null;
  thompson_beta?: number | null;
  updated_at_s?: string | null;
  successful_executions?: number | null;
  failed_executions?: number | null;
};
type QueryAllable = Queryable & { queryAll?: (sql: string, vars?: Record<string, unknown>) => Promise<unknown[]> };

function refoldVariant(e: PendingVariant): void {
  const key = compRowKey(e.variantId, e.orgId);
  const cur = pendingVariant.get(key);
  if (!cur) { pendingVariant.set(key, e); return; }
  cur.alpha += e.alpha;
  cur.beta += e.beta;
  for (const k of e.kinds) cur.kinds.add(k);
  cur.ancestorRecords.push(...e.ancestorRecords);
  for (const id of e.executionIds) noteExecution(cur, id);
  cur.executionIdsOverflow += e.executionIdsOverflow;
}

function requeueCompensation(key: string, items: PendingCompensation[]): void {
  if (items.length === 0) return;
  for (const it of items) it.attempts += 1;
  pendingCompensation.set(key, [...items, ...(pendingCompensation.get(key) ?? [])]);
}

/**
 * Flush one row that carries compensation items (and maybe a genuine Σδ, `e`). See the section header.
 * Never throws: a failure re-queues the items and the genuine Σδ for the next flush.
 * Returns false when `e` was NOT consumed (no item reached the transaction): the caller then flushes it on
 * the plain path in this same flush, exactly as if no compensation had been queued.
 */
async function flushCompensatedRow(
  db: QueryAllable,
  key: string,
  queued: PendingCompensation[],
  e: PendingVariant | undefined,
  nowMs: number,
): Promise<boolean> {
  const variantId = queued[0].variantId;
  const orgId = queued[0].orgId;
  const nowIso = new Date(nowMs).toISOString();
  const outcome = (it: PendingCompensation, status: CompensationStatus, extra: Partial<CompensationOutcome> = {}): CompensationOutcome => ({
    ledger_key: it.ledgerKey, variant_id: it.variantId, org_id: it.orgId, status, nominal: 1,
    factor: compensationResidue(it.leakAtMs, nowMs), applied: 0, before: null, after: null, at: null, ...extra,
  });

  // A key queued twice in one flush: the first is decided below, every later copy is already_compensated.
  // (Two CREATEs of one record id inside one transaction would abort the whole transaction.)
  const items: PendingCompensation[] = [];
  const seen = new Set<string>();
  for (const it of queued) {
    if (seen.has(it.ledgerKey)) { it.settle(outcome(it, 'already_compensated', { existing_status: 'in_flight' })); continue; }
    seen.add(it.ledgerKey);
    items.push(it);
  }

  let rows: CompRowRead[];
  let ledger: Array<{ ledger_key?: string; status?: string }>;
  try {
    rows = (await db.query<CompRowRead>(COMPENSATION_ROW_SQL, { variant_id: variantId, org_id: orgId })) ?? [];
    ledger = (await db.query<{ ledger_key?: string; status?: string }>(COMPENSATION_LEDGER_SQL, {
      keys: items.map((i) => i.ledgerKey), variant_id: variantId, org_id: orgId,
    })) ?? [];
  } catch (err) {
    requeueCompensation(key, items);
    if (e) refoldVariant(e);
    logger.warn('posterior compensation: pre-read failed, re-queued', { variant_id: variantId, org_id: orgId, error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  // Already ledgered (an earlier flush or an earlier run): settle, apply nothing.
  const existing = new Map<string, string>();
  let armReset = false;
  for (const r of ledger) {
    if (r?.ledger_key && seen.has(r.ledger_key)) existing.set(r.ledger_key, String(r.status ?? ''));
    if (r?.status === 'reset_since_leak') armReset = true;
  }
  const todo: PendingCompensation[] = [];
  for (const it of items) {
    if (existing.has(it.ledgerKey)) it.settle(outcome(it, 'already_compensated', { existing_status: existing.get(it.ledgerKey) }));
    else todo.push(it);
  }

  if (rows.length >= 2) {
    // Two rows answer this (variant, org): which one the leak hit is unknown, so nothing is guessed. The
    // genuine Σδ goes back to the plain path (this key has no items left), which behaves as it always has.
    for (const it of todo) it.settle(outcome(it, 'row_ambiguous'));
    logger.warn('posterior compensation: two rows match, not compensated', { event: 'posterior_compensation_row_ambiguous', variant_id: variantId, org_id: orgId });
    return false;
  }
  if (todo.length === 0) return false;

  const row = rows[0];
  const before = row ? { alpha: Number(row.thompson_alpha ?? 1), beta: Number(row.thompson_beta ?? 1) } : null;
  // Reset since the leak: the row sits exactly at its exit counts (the re-register reset), so the leaked β
  // is already gone. Arm-level and sticky (an earlier reset verdict on this row also applies).
  const atExitCounts = !!row && before!.alpha === Number(row.successful_executions ?? NaN) + 1 && before!.beta === Number(row.failed_executions ?? NaN) + 1;
  const reset = !!row && (armReset || atExitCounts);

  const lastUpdatedMs = (() => { const p = row?.updated_at_s ? Date.parse(String(row.updated_at_s)) : NaN; return Number.isNaN(p) ? 0 : p; })();
  const decayed = row ? decayedThompsonCounts(before!.alpha, before!.beta, lastUpdatedMs, nowMs) : null;
  const newAlpha = decayed ? decayed.alpha + (e?.alpha ?? 0) : 0;
  let newBeta = decayed ? decayed.beta + (e?.beta ?? 0) : 0;

  const decided = todo.map((it) => {
    const factor = compensationResidue(it.leakAtMs, nowMs);
    let status: CompensationStatus;
    let applied = 0;
    if (!row) status = 'dropped_no_row';
    else if (reset) status = 'reset_since_leak';
    else if (newBeta - factor < 1) status = 'floored'; // never below the Beta prior
    else { status = 'written'; applied = factor; newBeta -= factor; }
    return { it, status, factor, applied };
  });
  const anyWritten = decided.some((d) => d.status === 'written');
  const doUpdate = !!row && (anyWritten || (!!e && (e.alpha !== 0 || e.beta !== 0)));

  const vars = {
    variant_id: variantId,
    org_id: orgId,
    keys: decided.map((d) => d.it.ledgerKey),
    seen_rows: row ? 1 : 0,
    seen_alpha: row ? row.thompson_alpha ?? null : null,
    seen_beta: row ? row.thompson_beta ?? null : null,
    seen_updated_at: row ? String(row.updated_at_s ?? '') : null,
    new_alpha: newAlpha,
    new_beta: newBeta,
    do_update: doUpdate,
    now: nowIso,
    // Absent values are OMITTED (NONE in SurrealQL), never null: NULL fails an option<…> field and would
    // cancel the transaction.
    items: decided.map((d) => ({
      ledger_key: d.it.ledgerKey, variant_id: variantId, org_id: orgId,
      ...(d.it.execId ? { exec_id: d.it.execId } : {}),
      list_sha: d.it.listSha, leak_at: new Date(d.it.leakAtMs).toISOString(), nominal: 1,
      factor: d.factor, applied: d.applied, status: d.status,
      ...(before ? { before } : {}),
    })),
  };

  let summary: { ok?: boolean; dup?: string[]; rows?: number; updated?: number; after_alpha?: number | null; after_beta?: number | null } | undefined;
  try {
    const out = typeof db.queryAll === 'function' ? await db.queryAll(COMPENSATION_TXN_SQL, vars) : await db.query(COMPENSATION_TXN_SQL, vars);
    summary = (Array.isArray(out) ? out : []).filter((r): r is NonNullable<typeof summary> => !!r && typeof r === 'object' && 'ok' in (r as object)).pop();
  } catch (err) {
    // A conflict surreal.ts could not retry away, or the UNIQUE index catching a racing writer: nothing was
    // committed. Re-queue; the next pre-read sees whatever the other writer left.
    requeueCompensation(key, todo);
    if (e) refoldVariant(e);
    logger.warn('posterior compensation: transaction failed, re-queued', { variant_id: variantId, org_id: orgId, error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  if (!summary?.ok) {
    // The row moved since the pre-read, or a key was ledgered meanwhile: nothing was written. The genuine Σδ
    // and the items go back; the next flush re-reads and re-decides (a now-ledgered key settles as already).
    requeueCompensation(key, todo);
    if (e) refoldVariant(e);
    logger.info('posterior compensation: row moved or key ledgered since pre-read, re-queued', {
      event: 'posterior_compensation_requeued', variant_id: variantId, org_id: orgId, dup: summary?.dup ?? null, attempts: Math.max(...todo.map((t) => t.attempts)),
    });
    return true;
  }

  const after = row && summary.after_alpha != null && summary.after_beta != null ? { alpha: Number(summary.after_alpha), beta: Number(summary.after_beta) } : null;
  for (const d of decided) d.it.settle(outcome(d.it, d.status, { factor: d.factor, applied: d.applied, before, after, at: nowIso }));

  if (e) {
    if (!row) {
      for (const r of e.ancestorRecords) r.status = 'dropped_no_row';
      await recordNoRowDrop(db, e.variantId, e.orgId, [...e.kinds], e.alpha, e.beta, e.executionIds, e.executionIdsOverflow);
    } else {
      for (const r of e.ancestorRecords) r.status = 'written';
    }
  }
  const count = (s: CompensationStatus) => decided.filter((d) => d.status === s).length;
  logger.info('posterior compensation APPLIED', {
    event: 'posterior_compensation_applied',
    variant_id: variantId,
    org_id: orgId,
    ledger_keys: decided.map((d) => d.it.ledgerKey),
    before,
    after,
    genuine_alpha_delta: e?.alpha ?? 0,
    genuine_beta_delta: e?.beta ?? 0,
    nominal_sum: decided.length,
    applied_sum: decided.reduce((s, d) => s + d.applied, 0),
    written: count('written'),
    floored: count('floored'),
    reset_since_leak: count('reset_since_leak'),
    dropped_no_row: count('dropped_no_row'),
    at: nowIso,
  });
  return true;
}

export interface FlushOptions {
  /** The store for the COMPENSATION path only (tests inject a fake). The plain path below always uses surrealDB. */
  db?: QueryAllable;
  /** The flush instant for the compensation path (tests pin it). Defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Flush all buffered deltas — one UPDATE per hot row with Σδ already folded in.
 * Re-queues a row's residual delta on transient failure so nothing is lost.
 * Rows carrying compensation items are flushed first, transactionally (flushCompensatedRow).
 */
export async function flushPosteriors(opts: FlushOptions = {}): Promise<void> {
  if (flushing || (pendingVariant.size === 0 && pendingCompensation.size === 0)) return;
  flushing = true;
  try {
    const batch = [...pendingVariant.values()];
    pendingVariant.clear();
    if (pendingCompensation.size > 0) {
      const comps = [...pendingCompensation.entries()];
      pendingCompensation.clear();
      for (const [ckey, items] of comps) {
        const i = batch.findIndex((b) => compRowKey(b.variantId, b.orgId) === ckey);
        const e = i >= 0 ? batch.splice(i, 1)[0] : undefined;
        const consumed = await flushCompensatedRow(opts.db ?? surrealDB, ckey, items, e, opts.nowMs ?? Date.now());
        if (e && !consumed) batch.push(e);
      }
    }
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
