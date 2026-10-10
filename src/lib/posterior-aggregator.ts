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
// already exists, then UPDATEs α/β = decayed + genuine Σδ − Σresidue and UPSERTs one ledger row per item
// (UNIQUE ledger_key), returning the row AFTER the write. Rows without items take the unchanged path below.
//
// The decay is computed in app memory with the SAME decayedThompsonCounts (default half-life) the plain
// flush uses; the transaction's guard is what makes that read-then-write safe. Refused when coalescing is
// off: the synchronous fallback writers would race the ledgered write with no shared queue.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What became of one compensation item. Every status but `already_compensated` (the row that already exists
 * is the record) leaves this item's own ledger row. All are TERMINAL except `cas_retry`, which is a ledger
 * row only (the item is re-queued, never settled with it): the row moved between the pre-read and the
 * transaction. After CAS_MAX_ATTEMPTS misses the item settles `cas_exhausted` (terminal, not compensated).
 */
export type CompensationStatus =
  | 'written'
  | 'floored'
  | 'reset_since_leak'
  | 'already_compensated'
  | 'dropped_no_row'
  | 'skipped_ambiguous'
  | 'cas_exhausted';

/** Ledger statuses that settle a pair for good (cas_retry is the only non-terminal one). */
export const TERMINAL_LEDGER_STATUSES: ReadonlySet<string> = new Set(['written', 'floored', 'reset_since_leak', 'dropped_no_row', 'skipped_ambiguous', 'cas_exhausted']);
/** A row that keeps moving under a pair stops being retried here; the pair is then counted, not compensated. */
export const CAS_MAX_ATTEMPTS = 5;

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
  /** The row's stored (α, β) as the transaction read it; null when there was no single row. */
  before: { alpha: number; beta: number } | null;
  /** The row's (α, β) after the transaction (its own RETURN AFTER); null when there was no single row. */
  after: { alpha: number; beta: number } | null;
  /** The flush instant written to updated_at and to the ledger row. */
  at: string | null;
  /** For already_compensated: the status of the ledger row that already existed. */
  existing_status?: string;
  /** For skipped_ambiguous: the record ids of the rows that matched (variant, org). */
  observed_row_ids?: string[];
  /** Transactions this item reached (CAS misses + the deciding one). */
  attempts?: number;
}

interface PendingCompensation extends CompensationRequest {
  settle: (o: CompensationOutcome) => void;
  /** CAS misses so far (also carried by its cas_retry ledger row, so a restart resumes the count). */
  attempts: number;
}

const pendingCompensation = new Map<string, PendingCompensation[]>();
const compRowKey = (variantId: string, orgId: string): string => `${variantId}\u0000${orgId}`;

/** Queued compensation items not yet flushed. */
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
  // The key becomes a record id in the ledger reads; refuse a malformed one here, not inside a flush.
  if (!LEDGER_KEY_RE.test(req.ledgerKey)) throw new Error(`enqueueCompensation: invalid ledger_key ${JSON.stringify(req.ledgerKey)}`);
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

/** The pre-read of a compensated row (also the replay's plan/verify read). Equality only; LIMIT 2 so a duplicate row is seen. */
export const COMPENSATION_ROW_SQL =
  `SELECT <string> id AS row_id, thompson_alpha, thompson_beta, <string> (updated_at ?? '') AS updated_at_s, successful_executions, failed_executions FROM variant_performance_metrics WHERE variant_id = $variant_id AND org_id = $org_id LIMIT 2`;

/**
 * LEDGER READS ARE BY RECORD ID, NEVER `WHERE ledger_key IN $keys` (nor INSIDE / CONTAINSANY / CONTAINSALL).
 * On SurrealDB 2.3.10 a WHERE on an indexed field with IN over an array param returns ZERO rows with status OK
 * (measured on node1: equality on 3 keys gave 1+1+1 rows, IN on the same 3 gave 0). A ledger read that silently
 * returns nothing would make the pre-read miss already-compensated keys and make verify report clean — so
 * ledger rows are fetched by their record ids (record id = ledger_key), which touches no index. Keys are
 * validated 64-hex before they are spliced into the statement.
 */
const LEDGER_KEY_RE = /^[0-9a-f]{64}$/;
const LEDGER_ID_CHUNK = 200;
export function ledgerByIdsSql(keys: string[], fields: string): string {
  if (keys.length === 0) throw new Error('ledgerByIdsSql: no keys');
  for (const k of keys) if (!LEDGER_KEY_RE.test(k)) throw new Error(`ledgerByIdsSql: invalid ledger_key ${JSON.stringify(k)}`);
  return `SELECT ${fields} FROM ${keys.map((k) => `posterior_compensation_ledger:⟨${k}⟩`).join(', ')}`;
}
/** Fetch ledger rows by record id, chunked. A missing record simply yields no row. */
export async function readLedgerByIds<T = { ledger_key?: string; status?: string; attempts?: number }>(db: Queryable, keys: string[], fields = 'ledger_key, status, attempts'): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < keys.length; i += LEDGER_ID_CHUNK) {
    const rows = await db.query<T>(ledgerByIdsSql(keys.slice(i, i + LEDGER_ID_CHUNK), fields), {});
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}
/**
 * An arm-level reset verdict already ledgered for this row: equality only (no IN), status filtered in app.
 * variant_id/org_id are selected so every returned row is RE-CHECKED in app (a composite-index read on 2.3.10
 * is not trusted to honour both conjuncts): a row for another variant or org is dropped and logged, never
 * allowed to settle this row's pairs as reset.
 */
export const COMPENSATION_LEDGER_ROW_SQL =
  `SELECT ledger_key, variant_id, org_id, status FROM posterior_compensation_ledger WHERE variant_id = $variant_id AND org_id = $org_id`;

/**
 * ONE transaction per compensated row. Decisions (decay, residue, floor, reset, ambiguity) were made in app
 * memory from the pre-read; $__cas is the guard that the row is still exactly what was read (α, β and the
 * <string> updated_at for a single row; the row count otherwise) and $__dup that no key is TERMINALLY ledgered.
 *   ok          → UPDATE α/β (when $do_update), UPSERT each item's ledger row with its decided status.
 *   CAS miss    → no posterior write; each item's ledger row is UPSERTed as its miss_status (cas_retry with
 *                 the attempt count, or cas_exhausted at the bound) — a miss is recorded, never silent.
 *   dup         → nothing written; the caller re-queues and the next pre-read settles already_compensated.
 * UPSERT (not CREATE) so a cas_retry row can become terminal; the UNIQUE ledger_key index and the optimistic
 * conflict between two such transactions remain the backstop for a race.
 */
export const COMPENSATION_TXN_SQL = `
BEGIN TRANSACTION;
LET $__rows = (SELECT thompson_alpha, thompson_beta, <string> (updated_at ?? '') AS updated_at_s FROM variant_performance_metrics WHERE variant_id = $variant_id AND org_id = $org_id LIMIT 2);
LET $__dup = $keys.filter(|$k| record::exists(type::thing('posterior_compensation_ledger', $k)) AND type::thing('posterior_compensation_ledger', $k).status != 'cas_retry');
LET $__cas = array::len($__rows) = $seen_rows
  AND ($seen_rows != 1 OR ($__rows[0].thompson_alpha = $seen_alpha AND $__rows[0].thompson_beta = $seen_beta AND $__rows[0].updated_at_s = $seen_updated_at));
LET $__ok = array::len($__dup) = 0 AND $__cas;
LET $__upd = (UPDATE variant_performance_metrics SET thompson_alpha = $new_alpha, thompson_beta = $new_beta, updated_at = <datetime> $now
  WHERE variant_id = $variant_id AND org_id = $org_id AND $__ok = true AND $do_update = true RETURN AFTER);
LET $__a = IF array::len($__upd) > 0 { $__upd[0] } ELSE { $__rows[0] };
LET $__after = { alpha: $__a.thompson_alpha, beta: $__a.thompson_beta };
FOR $__it IN $items {
  IF $__ok {
    UPSERT type::thing('posterior_compensation_ledger', $__it.ledger_key) CONTENT {
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
      attempts: $__it.attempts,
      observed_row_ids: $__it.observed_row_ids,
      before: $__it.before,
      after: IF $__it.record_after { $__after } ELSE { NONE },
      at: <datetime> $now
    };
  } ELSE IF array::len($__dup) = 0 {
    UPSERT type::thing('posterior_compensation_ledger', $__it.ledger_key) CONTENT {
      ledger_key: $__it.ledger_key,
      variant_id: $__it.variant_id,
      org_id: $__it.org_id,
      exec_id: $__it.exec_id,
      list_sha: $__it.list_sha,
      leak_at: <datetime> $__it.leak_at,
      nominal: $__it.nominal,
      factor: $__it.factor,
      applied: 0,
      status: $__it.miss_status,
      attempts: $__it.attempts,
      at: <datetime> $now
    };
  };
};
RETURN { ok: $__ok, cas: $__cas, dup: $__dup, rows: array::len($__rows), updated: array::len($__upd), after_alpha: $__a.thompson_alpha, after_beta: $__a.thompson_beta };
COMMIT TRANSACTION;`;

type CompRowRead = {
  row_id?: string | null;
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
  pendingCompensation.set(key, [...items, ...(pendingCompensation.get(key) ?? [])]);
}

/**
 * Flush one row that carries compensation items (and maybe a genuine Σδ, `e`). See the section header.
 * Never throws: a failure re-queues the items (and the genuine Σδ) for the next flush.
 * Returns false when `e` was NOT consumed (no single row took the transaction): the caller then flushes it
 * on the plain path in this same flush, exactly as if no compensation had been queued.
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
  // (Two writes of one record id inside one transaction would make the item's outcome ambiguous.)
  const items: PendingCompensation[] = [];
  const seen = new Set<string>();
  for (const it of queued) {
    if (seen.has(it.ledgerKey)) { it.settle(outcome(it, 'already_compensated', { existing_status: 'in_flight' })); continue; }
    seen.add(it.ledgerKey);
    items.push(it);
  }

  let rows: CompRowRead[];
  let byKey: Array<{ ledger_key?: string; status?: string; attempts?: number }>;
  let byRow: Array<{ ledger_key?: string; variant_id?: string; org_id?: string; status?: string }>;
  try {
    rows = (await db.query<CompRowRead>(COMPENSATION_ROW_SQL, { variant_id: variantId, org_id: orgId })) ?? [];
    byKey = await readLedgerByIds(db, items.map((i) => i.ledgerKey));
    const rawByRow = (await db.query<{ ledger_key?: string; variant_id?: string; org_id?: string; status?: string }>(COMPENSATION_LEDGER_ROW_SQL, { variant_id: variantId, org_id: orgId })) ?? [];
    byRow = rawByRow.filter((r) => r?.variant_id === variantId && r?.org_id === orgId);
    if (byRow.length !== rawByRow.length) {
      logger.warn('posterior compensation: ledger row read returned rows for another variant/org — dropped', {
        event: 'posterior_compensation_foreign_ledger_rows', variant_id: variantId, org_id: orgId,
        dropped: rawByRow.filter((r) => !(r?.variant_id === variantId && r?.org_id === orgId)).map((r) => ({ ledger_key: r?.ledger_key, variant_id: r?.variant_id, org_id: r?.org_id, status: r?.status })),
      });
    }
  } catch (err) {
    requeueCompensation(key, items);
    if (e) refoldVariant(e);
    logger.warn('posterior compensation: pre-read failed, re-queued', { variant_id: variantId, org_id: orgId, error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  // TERMINALLY ledgered already (an earlier flush or run): settle, apply nothing. A cas_retry row is not
  // terminal: the item is decided again, resuming its attempt count.
  // (By-id reads return only the requested records; the `seen` check below keeps it that way.)
  const existing = new Map<string, { status: string; attempts: number }>();
  for (const r of byKey) if (r?.ledger_key && seen.has(r.ledger_key)) existing.set(r.ledger_key, { status: String(r.status ?? ''), attempts: Number(r.attempts ?? 0) || 0 });
  const armReset = byRow.some((r) => r?.status === 'reset_since_leak');
  const todo: PendingCompensation[] = [];
  for (const it of items) {
    const ex = existing.get(it.ledgerKey);
    if (ex && ex.status !== 'cas_retry') it.settle(outcome(it, 'already_compensated', { existing_status: ex.status }));
    else { if (ex) it.attempts = Math.max(it.attempts, ex.attempts); todo.push(it); }
  }
  // Only a single row takes the genuine Σδ in the transaction; otherwise it goes to the plain path unchanged.
  const consumesE = rows.length <= 1;
  if (todo.length === 0) return false;

  const ambiguous = rows.length >= 2;
  const row = rows.length === 1 ? rows[0] : undefined;
  const observedRowIds = ambiguous ? rows.map((r) => String(r.row_id ?? '')) : undefined;
  const before = row ? { alpha: Number(row.thompson_alpha ?? 1), beta: Number(row.thompson_beta ?? 1) } : null;
  // Reset since the leak: the row sits exactly at its exit counts (the re-register reset), so the leaked β
  // is already gone. Arm-level and sticky (an earlier reset verdict on this row also applies).
  const atExitCounts = !!row && before!.alpha === Number(row.successful_executions ?? NaN) + 1 && before!.beta === Number(row.failed_executions ?? NaN) + 1;
  const reset = !!row && (armReset || atExitCounts);

  const lastUpdatedMs = (() => { const p = row?.updated_at_s ? Date.parse(String(row.updated_at_s)) : NaN; return Number.isNaN(p) ? 0 : p; })();
  const decayed = row ? decayedThompsonCounts(before!.alpha, before!.beta, lastUpdatedMs, nowMs) : null;
  const ge = consumesE ? e : undefined;
  const newAlpha = decayed ? decayed.alpha + (ge?.alpha ?? 0) : 0;
  let newBeta = decayed ? decayed.beta + (ge?.beta ?? 0) : 0;

  const decided = todo.map((it) => {
    const factor = compensationResidue(it.leakAtMs, nowMs);
    let status: CompensationStatus;
    let applied = 0;
    // Two rows answer this (variant, org): which one the leak hit is unknown, so nothing is guessed — but the
    // pair is settled (skipped_ambiguous, with the observed row ids) so the replay can go inert and the
    // uncompensated residue stays countable.
    if (ambiguous) status = 'skipped_ambiguous';
    else if (!row) status = 'dropped_no_row';
    else if (reset) status = 'reset_since_leak';
    else if (newBeta - factor < 1) status = 'floored'; // never below the Beta prior
    else { status = 'written'; applied = factor; newBeta -= factor; }
    return { it, status, factor, applied, attempts: it.attempts + 1 };
  });
  const anyWritten = decided.some((d) => d.status === 'written');
  const doUpdate = !!row && (anyWritten || (!!ge && (ge.alpha !== 0 || ge.beta !== 0)));

  const vars = {
    variant_id: variantId,
    org_id: orgId,
    keys: decided.map((d) => d.it.ledgerKey),
    seen_rows: Math.min(rows.length, 2),
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
      factor: d.factor, applied: d.applied, status: d.status, attempts: d.attempts,
      miss_status: d.attempts >= CAS_MAX_ATTEMPTS ? 'cas_exhausted' : 'cas_retry',
      record_after: !!row,
      ...(observedRowIds ? { observed_row_ids: observedRowIds } : {}),
      ...(before ? { before } : {}),
    })),
  };

  const fail = (): boolean => {
    if (e && consumesE) refoldVariant(e);
    return consumesE;
  };
  let summary: { ok?: boolean; cas?: boolean; dup?: string[]; rows?: number; updated?: number; after_alpha?: number | null; after_beta?: number | null } | undefined;
  try {
    const out = typeof db.queryAll === 'function' ? await db.queryAll(COMPENSATION_TXN_SQL, vars) : await db.query(COMPENSATION_TXN_SQL, vars);
    summary = (Array.isArray(out) ? out : []).filter((r): r is NonNullable<typeof summary> => !!r && typeof r === 'object' && 'ok' in (r as object)).pop();
  } catch (err) {
    // A conflict surreal.ts could not retry away, or the UNIQUE index catching a racing writer: nothing was
    // committed. Re-queue; the next pre-read sees whatever the other writer left.
    requeueCompensation(key, todo);
    logger.warn('posterior compensation: transaction failed, re-queued', { variant_id: variantId, org_id: orgId, error: err instanceof Error ? err.message : String(err) });
    return fail();
  }
  if (!summary) {
    requeueCompensation(key, todo);
    logger.warn('posterior compensation: transaction returned no summary, re-queued', { variant_id: variantId, org_id: orgId });
    return fail();
  }

  if (!summary.ok) {
    const dup = Array.isArray(summary.dup) ? summary.dup : [];
    if (dup.length > 0) {
      // A key became terminally ledgered meanwhile: nothing was written. The next pre-read settles it.
      requeueCompensation(key, todo);
      logger.info('posterior compensation: key ledgered since pre-read, re-queued', { event: 'posterior_compensation_requeued', variant_id: variantId, org_id: orgId, dup });
      return fail();
    }
    // CAS MISS: the row moved since the pre-read. The transaction recorded each item's miss in the ledger
    // (cas_retry with its attempt count, or cas_exhausted at the bound); nothing touched the posterior.
    const retry: PendingCompensation[] = [];
    for (const d of decided) {
      d.it.attempts = d.attempts;
      if (d.attempts >= CAS_MAX_ATTEMPTS) d.it.settle(outcome(d.it, 'cas_exhausted', { factor: d.factor, attempts: d.attempts, at: nowIso }));
      else retry.push(d.it);
    }
    requeueCompensation(key, retry);
    logger.warn('posterior compensation: row moved since pre-read (CAS miss), recorded', {
      event: 'posterior_compensation_cas_miss', variant_id: variantId, org_id: orgId,
      retry: retry.length, exhausted: decided.length - retry.length, attempts: Math.max(...decided.map((d) => d.attempts)),
    });
    return fail();
  }

  const after = row && summary.after_alpha != null && summary.after_beta != null ? { alpha: Number(summary.after_alpha), beta: Number(summary.after_beta) } : null;
  for (const d of decided) {
    d.it.settle(outcome(d.it, d.status, { factor: d.factor, applied: d.applied, before, after, at: nowIso, attempts: d.attempts, ...(observedRowIds ? { observed_row_ids: observedRowIds } : {}) }));
  }

  if (e && consumesE) {
    if (!row) {
      for (const r of e.ancestorRecords) r.status = 'dropped_no_row';
      await recordNoRowDrop(db, e.variantId, e.orgId, [...e.kinds], e.alpha, e.beta, e.executionIds, e.executionIdsOverflow);
    } else {
      for (const r of e.ancestorRecords) r.status = 'written';
    }
  }
  const count = (st: CompensationStatus) => decided.filter((d) => d.status === st).length;
  logger.info('posterior compensation APPLIED', {
    event: 'posterior_compensation_applied',
    variant_id: variantId,
    org_id: orgId,
    ledger_keys: decided.map((d) => d.it.ledgerKey),
    before,
    after,
    genuine_alpha_delta: ge?.alpha ?? 0,
    genuine_beta_delta: ge?.beta ?? 0,
    nominal_sum: decided.length,
    applied_sum: decided.reduce((acc, d) => acc + d.applied, 0),
    written: count('written'),
    floored: count('floored'),
    reset_since_leak: count('reset_since_leak'),
    dropped_no_row: count('dropped_no_row'),
    skipped_ambiguous: count('skipped_ambiguous'),
    observed_row_ids: observedRowIds ?? null,
    at: nowIso,
  });
  return consumesE;
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
