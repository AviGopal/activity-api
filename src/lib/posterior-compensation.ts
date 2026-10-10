/**
 * posterior-compensation.ts — the β-leak REPLAY: undo, once, the β that withheld executions leaked into
 * variant_performance_metrics, for exactly the pairs of a frozen, sha-pinned list. Nothing else.
 *
 * NOT A GENERAL β-EDIT PRIMITIVE. Two resolver shapes on the existing POST /v2/impulses/resolve (no new
 * REST endpoint), both operator-only:
 *
 *   posteriorCompensation        the single-key write ({ ledger_key } only). REFUSES every call in this build
 *                                (apply_requires_authorization): admin scope is not an acceptable bound on a
 *                                posterior write, and the operator-attested posteriorReplayAuthorization record
 *                                that will be is not implemented yet.
 *   posteriorCompensationReplay  dry_run (default; writes nothing — the per-arm plan, with every arm's keys)
 *                                and verify (post-boot re-read: live (α, β) against the recorded AFTER). apply
 *                                refuses exactly like posteriorCompensation.
 *
 * The write path (unauthorizedApply.key / .arms) is complete and tested but unreachable from any route: variant,
 * org and leak time are DERIVED from the shipped list (REPLAY_LIST_*) and the frozen eligibility file
 * (ELIGIBILITY_*), each pinned by a sha256 constant over the whole bytes and checked at load — a mismatch
 * refuses EVERYTHING; a key outside CLEAN ∩ ELIGIBLE is refused (not_in_frozen_list / arm_not_eligible).
 *
 * THE WRITE is never done here. Each pair is queued with enqueueCompensation (posterior-aggregator.ts), whose
 * flush applies it in one transaction with the row's genuine Σδ and the ledger row (see that section's header
 * for why the coalescer's Σδ cannot carry it). Refused when coalescing is disabled.
 *
 * AMOUNT: not a flat −1. The flush decays the stored posterior toward (1, 1), so the leaked unit β has
 * already decayed; the compensation is the RESIDUE — a unit β decayed by the same kernel from leak_at
 * (the list's applied_ts: when the β landed) to the flush. β never goes below 1 (floored, no write). A row
 * at its exit counts (α = s+1, β = f+1) was reset since the leak: reset_since_leak, no write.
 *
 * INERT AFTER COMPLETION: once every eligible key has a TERMINAL ledger row, the completion row
 * `posterior_compensation_ledger:complete` is written, and from then on every write refuses with
 * replay_complete. A completion row present at boot is honoured the same way.
 *
 * NOT A TEMPLATE: this is a one-shot repair, inert after completion, not a taught behaviour. Its durable record
 * is the UNIQUE ledger, the per-arm log lines and the frozen pinned inputs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { JwtAuthContext } from '../middleware/jwtAuth';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
// posterior-update first: it and posterior-aggregator import each other.
import { decayedThompsonCounts } from './posterior-update';
import {
  COMPENSATION_ROW_SQL,
  compensationResidue,
  enqueueCompensation,
  flushPosteriors,
  posteriorCoalesceEnabled,
  readLedgerByIds,
  TERMINAL_LEDGER_STATUSES,
  type CompensationOutcome,
  type CompensationRequest,
  type CompensationStatus,
} from './posterior-aggregator';

// ─── The frozen inputs (commit 1 ships FIXTURES; the real frozen list + Step-0 eligibility replace them) ───

export const REPLAY_LIST_PATH = fileURLToPath(new URL('./posterior-compensation-data/replay-list.fixture.tsv', import.meta.url));
export const REPLAY_LIST_SHA256 = 'b6806d5112b79e9635a147add84e025f320b8e13c37d7a92482b6876596dfc01';
export const ELIGIBILITY_PATH = fileURLToPath(new URL('./posterior-compensation-data/eligibility.fixture.tsv', import.meta.url));
export const ELIGIBILITY_SHA256 = 'dac5431d6bd0e61a66b51ab503caffe7956fda0c6291c4386ec92802cd514398';

export interface FrozenSources {
  listPath: string;
  listSha: string;
  eligibilityPath: string;
  eligibilitySha: string;
}
export const DEFAULT_SOURCES: FrozenSources = {
  listPath: REPLAY_LIST_PATH,
  listSha: REPLAY_LIST_SHA256,
  eligibilityPath: ELIGIBILITY_PATH,
  eligibilitySha: ELIGIBILITY_SHA256,
};

export interface FrozenPair {
  ledger_key: string;
  node: string;
  path: string;
  withheld_ts: string;
  arm_id: string;
  exec_id: string;
  applied_ts: string;
  leak_at_ms: number;
  status: string;
}
export interface FrozenArm {
  arm_id: string;
  org_id: string;
  candidate_rows: number;
  eligible: boolean;
  note: string;
}
export type FrozenInputs =
  | {
      ok: true;
      list_sha: string;
      eligibility_sha: string;
      pairs: Map<string, FrozenPair>;
      arms: Map<string, FrozenArm>;
      /** CLEAN ∩ ELIGIBLE keys per arm, arms sorted, keys in list order. */
      keysByArm: Map<string, string[]>;
      eligibleKeys: string[];
    }
  | { ok: false; refused: 'list_sha_mismatch' | 'eligibility_sha_mismatch' | 'frozen_input_invalid'; detail: string };

/** ledger_key = sha256(node|path|withheld_ts|arm_id|exec_id), hex. */
export function ledgerKeyOf(p: Pick<FrozenPair, 'node' | 'path' | 'withheld_ts' | 'arm_id' | 'exec_id'>): string {
  return createHash('sha256').update(`${p.node}|${p.path}|${p.withheld_ts}|${p.arm_id}|${p.exec_id}`).digest('hex');
}

/** The list's timestamps carry no zone; the journal they were extracted from is UTC. */
function parseUtc(ts: string): number {
  const t = ts.trim();
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
}

/**
 * Parse a pinned TSV. Leading lines starting with `#` (comment/provenance headers some frozen lists carry)
 * are skipped before the column header; the sha pin is always over the WHOLE file bytes, those lines included.
 */
function readTsv(text: string, required: string[]): { rows: Record<string, string>[]; error?: string } {
  const all = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  let skip = 0;
  while (skip < all.length && all[skip].startsWith('#')) skip++;
  const lines = all.slice(skip);
  if (lines.length === 0) return { rows: [], error: 'empty file' };
  const header = lines[0].replace(/\r$/, '').split('\t');
  for (const c of required) if (!header.includes(c)) return { rows: [], error: `missing column ${c}` };
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].replace(/\r$/, '').split('\t');
    if (f.length !== header.length) return { rows: [], error: `line ${i + 1}: ${f.length} fields, header has ${header.length}` };
    rows.push(Object.fromEntries(header.map((h, j) => [h, f[j]])));
  }
  return { rows };
}

/** Read and verify both frozen files. Any mismatch or malformation refuses everything (never a partial list). */
export function loadFrozenInputs(src: FrozenSources = DEFAULT_SOURCES): FrozenInputs {
  let listBytes: Buffer;
  let eligBytes: Buffer;
  try {
    listBytes = readFileSync(src.listPath);
    eligBytes = readFileSync(src.eligibilityPath);
  } catch (err) {
    return { ok: false, refused: 'frozen_input_invalid', detail: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const listSha = createHash('sha256').update(listBytes).digest('hex');
  if (listSha !== src.listSha) return { ok: false, refused: 'list_sha_mismatch', detail: `list sha256 ${listSha} != pinned ${src.listSha}` };
  const eligSha = createHash('sha256').update(eligBytes).digest('hex');
  if (eligSha !== src.eligibilitySha) return { ok: false, refused: 'eligibility_sha_mismatch', detail: `eligibility sha256 ${eligSha} != pinned ${src.eligibilitySha}` };

  const list = readTsv(listBytes.toString('utf8'), ['node', 'path', 'withheld_ts', 'arm_id', 'exec_id', 'applied_ts', 'beta_delta', 'status']);
  if (list.error) return { ok: false, refused: 'frozen_input_invalid', detail: `list: ${list.error}` };
  const elig = readTsv(eligBytes.toString('utf8'), ['arm_id', 'org_id', 'candidate_rows', 'eligible']);
  if (elig.error) return { ok: false, refused: 'frozen_input_invalid', detail: `eligibility: ${elig.error}` };

  const arms = new Map<string, FrozenArm>();
  for (const r of elig.rows) {
    if (arms.has(r.arm_id)) return { ok: false, refused: 'frozen_input_invalid', detail: `eligibility: arm ${r.arm_id} listed twice` };
    const candidate_rows = Number(r.candidate_rows);
    const eligible = r.eligible === '1';
    // ELIGIBLE only if exactly one row matched the leak's org; anything else is excluded and never guessed.
    if (eligible && (candidate_rows !== 1 || !r.org_id)) {
      return { ok: false, refused: 'frozen_input_invalid', detail: `eligibility: arm ${r.arm_id} eligible with ${r.candidate_rows} candidate rows / org '${r.org_id}'` };
    }
    arms.set(r.arm_id, { arm_id: r.arm_id, org_id: r.org_id, candidate_rows, eligible, note: r.note ?? '' });
  }

  const pairs = new Map<string, FrozenPair>();
  for (const r of list.rows) {
    const p: FrozenPair = {
      ledger_key: '', node: r.node, path: r.path, withheld_ts: r.withheld_ts, arm_id: r.arm_id, exec_id: r.exec_id,
      applied_ts: r.applied_ts, leak_at_ms: parseUtc(r.applied_ts), status: r.status,
    };
    p.ledger_key = ledgerKeyOf(p);
    if (pairs.has(p.ledger_key)) return { ok: false, refused: 'frozen_input_invalid', detail: `list: duplicate pair ${p.ledger_key}` };
    if (p.status === 'CLEAN') {
      if (r.beta_delta !== '1') return { ok: false, refused: 'frozen_input_invalid', detail: `list: CLEAN pair ${p.ledger_key} has beta_delta ${r.beta_delta}` };
      if (!Number.isFinite(p.leak_at_ms)) return { ok: false, refused: 'frozen_input_invalid', detail: `list: CLEAN pair ${p.ledger_key} has applied_ts '${r.applied_ts}'` };
    }
    pairs.set(p.ledger_key, p);
  }

  const keysByArm = new Map<string, string[]>();
  for (const armId of [...new Set([...pairs.values()].map((p) => p.arm_id))].sort()) {
    if (!arms.get(armId)?.eligible) continue;
    const keys = [...pairs.values()].filter((p) => p.arm_id === armId && p.status === 'CLEAN').map((p) => p.ledger_key);
    if (keys.length > 0) keysByArm.set(armId, keys);
  }
  return { ok: true, list_sha: listSha, eligibility_sha: eligSha, pairs, arms, keysByArm, eligibleKeys: [...keysByArm.values()].flat() };
}

let defaultInputs: FrozenInputs | null = null;
/** Loaded once per process and pinned at that load. */
function loadDefaultInputs(): FrozenInputs {
  if (!defaultInputs) {
    defaultInputs = loadFrozenInputs(DEFAULT_SOURCES);
    if (!defaultInputs.ok) logger.error('posterior compensation: frozen inputs REFUSED — every call will be refused', { event: 'posterior_compensation_inputs_refused', refused: defaultInputs.refused, detail: defaultInputs.detail });
  }
  return defaultInputs;
}

// ─── Dependencies (injected in tests) ───

type QueryAllable = {
  query: <T = unknown>(sql: string, vars?: Record<string, unknown>) => Promise<T[]>;
  queryAll?: (sql: string, vars?: Record<string, unknown>) => Promise<unknown[]>;
};

export interface CompensationDeps {
  db: QueryAllable;
  inputs: () => FrozenInputs;
  coalesceEnabled: () => boolean;
  enqueue: (req: CompensationRequest) => Promise<CompensationOutcome> | null;
  /** Kick a flush now (the aggregator's timer would otherwise pick the items up within one FLUSH_MS). */
  flush: () => Promise<void>;
  /** The clock for plans and verify (the write's own instant is the flush's). */
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long one call waits for its items to be decided before answering `pending` (they stay queued). */
  outcomeTimeoutMs: number;
}

export function defaultCompensationDeps(): CompensationDeps {
  return {
    db: surrealDB as unknown as QueryAllable,
    inputs: loadDefaultInputs,
    coalesceEnabled: posteriorCoalesceEnabled,
    enqueue: enqueueCompensation,
    flush: () => flushPosteriors(),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    outcomeTimeoutMs: 30_000,
  };
}

// ─── Ledger reads (BY RECORD ID — see readLedgerByIds; never `ledger_key IN $keys`) ───

/** Fields of a ledger read. */
export const LEDGER_READ_FIELDS = 'ledger_key, variant_id, org_id, status, attempts, applied, after, observed_row_ids, <string> at AS at_s';
export const COMPLETION_READ_SQL =
  `SELECT ledger_key, status, eligible_total, <string> at AS at_s FROM type::thing('posterior_compensation_ledger', 'complete')`;
export const COMPLETION_CREATE_SQL =
  `CREATE type::thing('posterior_compensation_ledger', 'complete') CONTENT { ledger_key: 'complete', status: 'complete', list_sha: $list_sha, eligible_total: $eligible_total, at: time::now() }`;

type LedgerRow = {
  ledger_key?: string; variant_id?: string; org_id?: string; status?: string; attempts?: number; applied?: number;
  after?: { alpha?: number; beta?: number } | null; observed_row_ids?: string[]; at_s?: string;
};

async function readLedger(deps: CompensationDeps, keys: string[]): Promise<Map<string, LedgerRow>> {
  if (keys.length === 0) return new Map();
  const rows = await readLedgerByIds<LedgerRow>(deps.db, keys, LEDGER_READ_FIELDS);
  return new Map(rows.filter((r) => r?.ledger_key).map((r) => [String(r.ledger_key), r]));
}

async function replayComplete(deps: CompensationDeps): Promise<boolean> {
  const rows = (await deps.db.query<LedgerRow>(COMPLETION_READ_SQL, {})) ?? [];
  return rows.some((r) => r?.status === 'complete');
}

/** When every eligible key has a TERMINAL ledger row, write the completion row (idempotent). */
async function maybeComplete(deps: CompensationDeps, inputs: Extract<FrozenInputs, { ok: true }>): Promise<boolean> {
  if (await replayComplete(deps)) return true;
  const ledger = await readLedger(deps, inputs.eligibleKeys);
  const done = inputs.eligibleKeys.every((k) => TERMINAL_LEDGER_STATUSES.has(String(ledger.get(k)?.status ?? '')));
  if (!done) return false;
  try {
    await deps.db.query(COMPLETION_CREATE_SQL, { list_sha: inputs.list_sha, eligible_total: inputs.eligibleKeys.length });
  } catch {
    /* a concurrent completion already wrote it — re-read below decides */
  }
  const complete = await replayComplete(deps);
  if (complete) logger.info('posterior compensation replay COMPLETE — the resolver is now inert', { event: 'posterior_compensation_complete', eligible_total: inputs.eligibleKeys.length, list_sha: inputs.list_sha });
  return complete;
}

// ─── Auth ───

/**
 * activity-api's existing admin predicate (activityTemplate_update/_deprecate), minus federation OBO callers.
 * It gates the READ modes only (dry_run, verify). It is NOT a bound on writes: the bootstrap key and hub keys
 * carry admin scope. Writes require an operator-attested, signed posteriorReplayAuthorization trust-root record
 * naming the list sha, the eligibility sha and the node — not implemented in this build, so every write refuses.
 */
export function isOperatorCaller(auth: JwtAuthContext | null | undefined): boolean {
  if (!auth || auth.obo) return false;
  return auth.role === 'admin' || (Array.isArray(auth.scopes) && auth.scopes.includes('admin'));
}

export type RefusalCode =
  | 'not_operator'
  | 'apply_requires_authorization'
  | 'list_sha_mismatch'
  | 'eligibility_sha_mismatch'
  | 'frozen_input_invalid'
  | 'coalescing_disabled'
  | 'replay_complete'
  | 'not_in_frozen_list'
  | 'arm_not_eligible'
  | 'unexpected_field'
  | 'bad_request';

export interface ResolverResult {
  status: number;
  body: Record<string, unknown>;
}

const refuse = (status: number, code: RefusalCode, detail?: string, extra: Record<string, unknown> = {}): ResolverResult => ({
  status,
  body: { success: false, refused: code, error: code, ...(detail ? { detail } : {}), ...extra },
});

function operatorGate(auth: JwtAuthContext | null | undefined, shape: string): ResolverResult | null {
  if (isOperatorCaller(auth)) return null;
  logger.warn('posterior compensation REFUSED: caller is not an operator', { event: 'posterior_compensation_refused', refused: 'not_operator', shape, key_id: auth?.keyId ?? null, user_id: auth?.userId ?? null, org_id: auth?.orgId ?? null, obo: !!auth?.obo });
  return refuse(403, 'not_operator', 'operator (admin) credentials required');
}

const APPLY_REFUSAL_DETAIL =
  'writes require an operator-attested, signed posteriorReplayAuthorization trust-root record naming the list sha, the eligibility sha and the node; this build serves dry_run and verify only';
function refuseWrite(shape: string, auth: JwtAuthContext | null | undefined): ResolverResult {
  logger.warn('posterior compensation REFUSED: write without authorization', { event: 'posterior_compensation_refused', refused: 'apply_requires_authorization', shape, key_id: auth?.keyId ?? null, user_id: auth?.userId ?? null });
  return refuse(403, 'apply_requires_authorization', APPLY_REFUSAL_DETAIL);
}

type InputsGate = { ok: true; inputs: Extract<FrozenInputs, { ok: true }> } | { ok: false; result: ResolverResult };
async function inputsGate(deps: CompensationDeps, opts: { write: boolean }): Promise<InputsGate> {
  const inputs = deps.inputs();
  if (!inputs.ok) return { ok: false, result: refuse(422, inputs.refused, inputs.detail) };
  if (opts.write) {
    if (!deps.coalesceEnabled()) return { ok: false, result: refuse(422, 'coalescing_disabled', 'compensation is applied only through the coalescing flush') };
    if (await replayComplete(deps)) return { ok: false, result: refuse(409, 'replay_complete', 'the replay has completed; this resolver is inert') };
  }
  return { ok: true, inputs };
}

// ─── Applying keys (UNREACHABLE from any route in this build — see unauthorizedApply) ───

export type KeyResult =
  | { ledger_key: string; refused: RefusalCode; detail?: string }
  | ({ ledger_key: string } & (CompensationOutcome | { status: 'pending' }));

function membership(inputs: Extract<FrozenInputs, { ok: true }>, key: string): { pair: FrozenPair; org_id: string } | { refused: RefusalCode; detail: string } {
  const pair = inputs.pairs.get(key);
  if (!pair) return { refused: 'not_in_frozen_list', detail: 'no pair of the frozen list has this key' };
  if (pair.status !== 'CLEAN') return { refused: 'not_in_frozen_list', detail: `pair is ${pair.status}, only CLEAN pairs are compensated` };
  const arm = inputs.arms.get(pair.arm_id);
  if (!arm?.eligible) return { refused: 'arm_not_eligible', detail: `arm ${pair.arm_id} is not eligible (${arm ? `${arm.candidate_rows} candidate rows` : 'not in the eligibility file'})` };
  return { pair, org_id: arm.org_id };
}

/** Queue the valid keys together (one row → one transaction), kick a flush, wait for the outcomes. */
async function compensateKeys(keys: string[], inputs: Extract<FrozenInputs, { ok: true }>, deps: CompensationDeps): Promise<KeyResult[]> {
  const out: KeyResult[] = [];
  const waits: Array<{ key: string; p: Promise<CompensationOutcome> }> = [];
  for (const key of keys) {
    const m = membership(inputs, key);
    if ('refused' in m) { out.push({ ledger_key: key, refused: m.refused, detail: m.detail }); continue; }
    const p = deps.enqueue({ ledgerKey: key, variantId: m.pair.arm_id, orgId: m.org_id, leakAtMs: m.pair.leak_at_ms, listSha: inputs.list_sha, execId: m.pair.exec_id });
    if (!p) { out.push({ ledger_key: key, refused: 'coalescing_disabled' }); continue; }
    waits.push({ key, p });
  }
  if (waits.length > 0) {
    await deps.flush();
    const PENDING = Symbol('pending');
    const timeout = new Promise<typeof PENDING>((r) => { const t = setTimeout(() => r(PENDING), deps.outcomeTimeoutMs); (t as { unref?: () => void }).unref?.(); });
    for (const w of waits) {
      const o = await Promise.race([w.p, timeout]);
      out.push(o === PENDING ? { ledger_key: w.key, status: 'pending' } : o);
    }
  }
  return out;
}

async function applyKey(pointer: Record<string, unknown>, deps: CompensationDeps): Promise<ResolverResult> {
  const g = await inputsGate(deps, { write: true });
  if (!g.ok) return g.result;
  const extra = Object.keys(pointer).filter((k) => k !== 'type' && k !== 'ledger_key');
  if (extra.length > 0) return refuse(400, 'unexpected_field', `posteriorCompensation accepts only { ledger_key }; got ${extra.join(', ')}`);
  const key = pointer.ledger_key;
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return refuse(400, 'bad_request', 'ledger_key must be a sha256 hex string');
  const [r] = await compensateKeys([key], g.inputs, deps);
  if ('refused' in r) {
    if (r.refused !== 'coalescing_disabled') logger.warn('posterior compensation REFUSED', { event: 'posterior_compensation_refused', refused: r.refused, ledger_key: key, detail: r.detail });
    return refuse(422, r.refused, r.detail, { ledger_key: key });
  }
  const complete = await maybeComplete(deps, g.inputs);
  return { status: 200, body: { success: true, shape: 'posteriorCompensationResult', body: { ...r, replay_complete: complete } } };
}

export interface ArmApplyRecord {
  arm_id: string;
  org_id: string;
  k: number;
  ledger_keys: string[];
  /** (α, β) before the first write and after the last, from the transaction's own reads. */
  before: { alpha: number; beta: number } | null;
  after: { alpha: number; beta: number } | null;
  nominal_sum: number;
  applied_sum: number;
  counts: Record<CompensationStatus | 'pending' | 'refused', number>;
}

function armRecord(armId: string, orgId: string, keys: string[], results: KeyResult[]): ArmApplyRecord {
  const counts: ArmApplyRecord['counts'] = {
    written: 0, floored: 0, reset_since_leak: 0, already_compensated: 0, dropped_no_row: 0, skipped_ambiguous: 0, cas_exhausted: 0, pending: 0, refused: 0,
  };
  let applied = 0;
  let before: ArmApplyRecord['before'] = null;
  let after: ArmApplyRecord['after'] = null;
  for (const r of results) {
    if ('refused' in r) { counts.refused += 1; continue; }
    counts[r.status] += 1;
    if (r.status === 'pending') continue;
    applied += r.applied;
    if (r.before && !before) before = r.before;
    if (r.after) after = r.after;
  }
  return { arm_id: armId, org_id: orgId, k: keys.length, ledger_keys: keys, before, after, nominal_sum: keys.length, applied_sum: applied, counts };
}

/** Minimum spacing between two arms' writes, across calls. */
const MIN_ARM_SPACING_MS = 1_000;
let lastArmWriteAt = 0;

async function applyArms(pointer: Record<string, unknown>, deps: CompensationDeps): Promise<ResolverResult> {
  const g = await inputsGate(deps, { write: true });
  if (!g.ok) return g.result;
  const inputs = g.inputs;
  const { armIds, common } = selectArms(pointer, inputs);
  const rateLimitMs = Math.max(MIN_ARM_SPACING_MS, Number.isFinite(Number(pointer.rate_limit_ms)) ? Number(pointer.rate_limit_ms) : 5_000);
  const records: ArmApplyRecord[] = [];
  let stoppedAt: string | null = null;
  for (const a of armIds) {
    // ONE ARM PER WRITE, sequential, spaced: the coalescer never batches across arms and a fault stops at an
    // arm boundary.
    const wait = lastArmWriteAt + rateLimitMs - Date.now();
    if (lastArmWriteAt > 0 && wait > 0) await deps.sleep(wait);
    const keys = inputs.keysByArm.get(a) ?? [];
    const results = await compensateKeys(keys, inputs, deps);
    lastArmWriteAt = Date.now();
    const rec = armRecord(a, inputs.arms.get(a)!.org_id, keys, results);
    records.push(rec);
    logger.info('posterior compensation replay: arm', { event: 'posterior_compensation_replay_arm', ...rec });
    if (rec.counts.pending > 0 || rec.counts.refused > 0) { stoppedAt = a; break; }
  }
  const complete = await maybeComplete(deps, inputs);
  const sum = (f: (r: ArmApplyRecord) => number) => records.reduce((acc, r) => acc + f(r), 0);
  return {
    status: 200,
    body: {
      success: stoppedAt === null,
      shape: 'posteriorCompensationReplayResult',
      body: {
        ...common, mode: 'apply', rate_limit_ms: rateLimitMs, stopped_at: stoppedAt, replay_complete: complete, arms: records,
        totals: {
          arms: records.length,
          nominal_sum: sum((r) => r.nominal_sum),
          applied_sum: sum((r) => r.applied_sum),
          written: sum((r) => r.counts.written),
          floored: sum((r) => r.counts.floored),
          reset_since_leak: sum((r) => r.counts.reset_since_leak),
          skipped_ambiguous: sum((r) => r.counts.skipped_ambiguous),
          cas_exhausted: sum((r) => r.counts.cas_exhausted),
          already_compensated: sum((r) => r.counts.already_compensated),
        },
      },
    },
  };
}

/**
 * THE WRITE PATHS, NOT REACHABLE FROM ANY ROUTE IN THIS BUILD. Both route shapes refuse every write with
 * apply_requires_authorization; these are exported only so the mechanism (queue, transaction, ledger, floor,
 * reset, CAS, ambiguity, completion) is exercised by tests now. The follow-up wires them behind a verified
 * posteriorReplayAuthorization record. They perform no caller check of their own.
 */
export const unauthorizedApply = { key: applyKey, arms: applyArms };

// ─── Routes ───

/** posteriorCompensation: the single-key write shape. Every call refuses in this build (no authorization path). */
export async function resolvePosteriorCompensation(
  _pointer: Record<string, unknown>,
  auth: JwtAuthContext | null | undefined,
  _deps: CompensationDeps = defaultCompensationDeps(),
): Promise<ResolverResult> {
  return operatorGate(auth, 'posteriorCompensation') ?? refuseWrite('posteriorCompensation', auth);
}

export interface ArmPlan {
  arm_id: string;
  org_id: string;
  eligible: true;
  /** Every CLEAN key of the arm (the set the frozen eligibility diff is made against). */
  keys: string[];
  /** Keys not yet terminally ledgered. */
  k: number;
  /** Ledger statuses already present for this arm's keys. */
  ledger_statuses: Record<string, number>;
  row: 'present' | 'absent' | 'ambiguous';
  observed_row_ids: string[];
  before: { alpha: number; beta: number } | null;
  beta_decayed_now: number | null;
  reset_since_leak: boolean;
  pairs: Array<{ ledger_key: string; factor: number }>;
  expected_residue: number;
  expected_floored: number;
  expected_skipped_ambiguous: number;
  expected_dropped_no_row: number;
  beta_after_floor: number | null;
}

export interface VerifyFlag {
  arm_id: string;
  org_id: string;
  kind: 'below_recorded_after' | 'mismatch_with_logged_deltas' | 're_reset' | 'row_missing' | 'row_ambiguous';
  expected: { alpha?: number; beta?: number; beta_min?: number } | null;
  observed: { alpha: number; beta: number } | null;
  boot_at: string;
}

type RowRead = { row_id?: string | null; thompson_alpha?: number | null; thompson_beta?: number | null; updated_at_s?: string | null; successful_executions?: number | null; failed_executions?: number | null };
async function readRow(deps: CompensationDeps, armId: string, orgId: string): Promise<RowRead[]> {
  return (await deps.db.query<RowRead>(COMPENSATION_ROW_SQL, { variant_id: armId, org_id: orgId })) ?? [];
}
const tsMs = (s: string | null | undefined): number => { const p = s ? Date.parse(String(s)) : NaN; return Number.isNaN(p) ? 0 : p; };

function selectArms(pointer: Record<string, unknown>, inputs: Extract<FrozenInputs, { ok: true }>) {
  let armIds = [...inputs.keysByArm.keys()];
  const unknownArms: string[] = [];
  if (Array.isArray(pointer.arm_ids)) {
    const wanted = pointer.arm_ids.map(String);
    for (const a of wanted) if (!inputs.keysByArm.has(a)) unknownArms.push(a);
    armIds = armIds.filter((a) => wanted.includes(a));
  }
  // Every arm of the list that is NOT planned, with its CLEAN keys, so a diff against the frozen eligibility
  // is mechanical: eligible arms are in `arms`, the rest here.
  const listArms = [...new Set([...inputs.pairs.values()].map((p) => p.arm_id))].sort();
  const excluded = listArms.filter((a) => !inputs.keysByArm.has(a)).map((a) => {
    const arm = inputs.arms.get(a);
    const keys = [...inputs.pairs.values()].filter((p) => p.arm_id === a && p.status === 'CLEAN').map((p) => p.ledger_key);
    return { arm_id: a, eligible: false, org_id: arm?.org_id ?? null, candidate_rows: arm?.candidate_rows ?? null, note: arm?.note ?? 'not in the eligibility file', keys, k: keys.length };
  });
  const common = { list_sha: inputs.list_sha, eligibility_sha: inputs.eligibility_sha, excluded_arms: excluded, unknown_arms: unknownArms };
  return { armIds, common };
}

async function planArm(deps: CompensationDeps, inputs: Extract<FrozenInputs, { ok: true }>, armId: string, nowMs: number): Promise<ArmPlan> {
  const org = inputs.arms.get(armId)!.org_id;
  const keys = inputs.keysByArm.get(armId) ?? [];
  const ledger = await readLedger(deps, keys);
  const ledgerStatuses: Record<string, number> = {};
  for (const l of ledger.values()) ledgerStatuses[String(l.status)] = (ledgerStatuses[String(l.status)] ?? 0) + 1;
  const open = keys.filter((k) => !TERMINAL_LEDGER_STATUSES.has(String(ledger.get(k)?.status ?? '')));
  const rows = await readRow(deps, armId, org);
  const row = rows.length === 1 ? rows[0] : null;
  const before = row ? { alpha: Number(row.thompson_alpha ?? 1), beta: Number(row.thompson_beta ?? 1) } : null;
  const reset = !!row && ((before!.alpha === Number(row.successful_executions ?? NaN) + 1 && before!.beta === Number(row.failed_executions ?? NaN) + 1)
    || [...ledger.values()].some((l) => l.status === 'reset_since_leak'));
  const decayedBeta = row ? decayedThompsonCounts(before!.alpha, before!.beta, tsMs(row.updated_at_s), nowMs).beta : null;
  const pairs = open.map((k) => ({ ledger_key: k, factor: compensationResidue(inputs.pairs.get(k)!.leak_at_ms, nowMs) }));
  let beta = decayedBeta;
  let floored = 0;
  let residue = 0;
  if (beta !== null && !reset) {
    for (const p of pairs) {
      if (beta - p.factor < 1) floored += 1;
      else { beta -= p.factor; residue += p.factor; }
    }
  }
  return {
    arm_id: armId, org_id: org, eligible: true, keys, k: open.length, ledger_statuses: ledgerStatuses,
    row: rows.length === 0 ? 'absent' : rows.length === 1 ? 'present' : 'ambiguous',
    observed_row_ids: rows.length >= 2 ? rows.map((r) => String(r.row_id ?? '')) : [],
    before, beta_decayed_now: decayedBeta, reset_since_leak: reset, pairs,
    expected_residue: residue, expected_floored: floored,
    expected_skipped_ambiguous: rows.length >= 2 ? open.length : 0,
    expected_dropped_no_row: rows.length === 0 ? open.length : 0,
    beta_after_floor: reset ? decayedBeta : beta,
  };
}

/** posteriorCompensationReplay: dry_run (default) and verify. Any write mode refuses in this build. */
export async function resolvePosteriorCompensationReplay(
  pointer: Record<string, unknown>,
  auth: JwtAuthContext | null | undefined,
  deps: CompensationDeps = defaultCompensationDeps(),
): Promise<ResolverResult> {
  const denied = operatorGate(auth, 'posteriorCompensationReplay');
  if (denied) return denied;
  const mode = pointer.mode === undefined ? 'dry_run' : String(pointer.mode);
  if (mode === 'apply') return refuseWrite('posteriorCompensationReplay', auth);
  if (mode !== 'dry_run' && mode !== 'verify') return refuse(400, 'bad_request', `mode must be dry_run | verify, got ${mode}`);
  const g = await inputsGate(deps, { write: false });
  if (!g.ok) return g.result;
  const inputs = g.inputs;
  const { armIds, common } = selectArms(pointer, inputs);

  if (mode === 'dry_run') {
    const nowMs = deps.nowMs();
    const plans: ArmPlan[] = [];
    for (const a of armIds) plans.push(await planArm(deps, inputs, a, nowMs));
    const sum = (f: (p: ArmPlan) => number) => plans.reduce((acc, p) => acc + f(p), 0);
    const statusTotals: Record<string, number> = {};
    for (const p of plans) for (const [st, n] of Object.entries(p.ledger_statuses)) statusTotals[st] = (statusTotals[st] ?? 0) + n;
    return {
      status: 200,
      body: {
        success: true,
        shape: 'posteriorCompensationPlan',
        body: {
          ...common, mode, at: new Date(nowMs).toISOString(), replay_complete: await replayComplete(deps),
          arms: plans,
          totals: {
            arms: plans.length, keys: sum((p) => p.keys.length), k: sum((p) => p.k),
            ledger_statuses: statusTotals,
            expected_residue: sum((p) => p.expected_residue), expected_floored: sum((p) => p.expected_floored),
            expected_skipped_ambiguous: sum((p) => p.expected_skipped_ambiguous), expected_dropped_no_row: sum((p) => p.expected_dropped_no_row),
            reset_arms: plans.filter((p) => p.reset_since_leak).map((p) => p.arm_id),
            excluded_arms: common.excluded_arms.length, excluded_keys: common.excluded_arms.reduce((acc, a) => acc + a.k, 0),
          },
        },
      },
    };
  }

  // verify: re-read every compensated row and compare it with the recorded AFTER.
  //   Without logged genuine deltas: β may only have risen since (decay toward 1 plus non-negative genuine
  //   penalties), so β_now ≥ 1 + (β_after − 1)·f(at → updated_at) is required — a drop below it means
  //   something overwrote the row (e.g. a re-register reset).
  //   With `genuine_deltas` ([{arm_id, at, alpha, beta}] from the APPLIED log since the run): the exact
  //   kernel composition must match within `tolerance` (default 1e-3) on both α and β.
  const bootAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const tolerance = Number.isFinite(Number(pointer.tolerance)) ? Number(pointer.tolerance) : 1e-3;
  const logged = Array.isArray(pointer.genuine_deltas) ? (pointer.genuine_deltas as Array<Record<string, unknown>>) : null;
  const flags: VerifyFlag[] = [];
  const checked: Array<Record<string, unknown>> = [];
  let ledgerRowsRead = 0;
  for (const a of armIds) {
    const org = inputs.arms.get(a)!.org_id;
    const ledger = await readLedger(deps, inputs.keysByArm.get(a) ?? []);
    ledgerRowsRead += ledger.size;
    const written = [...ledger.values()].filter((l) => l.status === 'written' && l.after && l.at_s).sort((x, y) => tsMs(x.at_s) - tsMs(y.at_s));
    if (written.length === 0) continue;
    const last = written[written.length - 1];
    const recAfter = { alpha: Number(last.after!.alpha), beta: Number(last.after!.beta) };
    const atMs = tsMs(last.at_s);
    const rows = await readRow(deps, a, org);
    if (rows.length !== 1) {
      flags.push({ arm_id: a, org_id: org, kind: rows.length === 0 ? 'row_missing' : 'row_ambiguous', expected: recAfter, observed: null, boot_at: bootAt });
      continue;
    }
    const row = rows[0];
    const observed = { alpha: Number(row.thompson_alpha ?? 1), beta: Number(row.thompson_beta ?? 1) };
    const u = Math.max(atMs, tsMs(row.updated_at_s));
    const decayedAfter = decayedThompsonCounts(recAfter.alpha, recAfter.beta, atMs, u);
    if (observed.alpha === Number(row.successful_executions ?? NaN) + 1 && observed.beta === Number(row.failed_executions ?? NaN) + 1) {
      flags.push({ arm_id: a, org_id: org, kind: 're_reset', expected: recAfter, observed, boot_at: bootAt });
    } else if (logged) {
      let ea = decayedAfter.alpha;
      let eb = decayedAfter.beta;
      for (const d of logged.filter((x) => String(x.arm_id) === a)) {
        const t = tsMs(String(d.at ?? ''));
        if (t <= atMs || t > u) continue;
        const f = decayedThompsonCounts(2, 2, t, u).alpha - 1; // the kernel's factor from t to u
        ea += Number(d.alpha ?? 0) * f;
        eb += Number(d.beta ?? 0) * f;
      }
      if (Math.abs(observed.alpha - ea) > tolerance || Math.abs(observed.beta - eb) > tolerance) {
        flags.push({ arm_id: a, org_id: org, kind: 'mismatch_with_logged_deltas', expected: { alpha: ea, beta: eb }, observed, boot_at: bootAt });
      }
    } else if (observed.beta < decayedAfter.beta - tolerance) {
      flags.push({ arm_id: a, org_id: org, kind: 'below_recorded_after', expected: { beta_min: decayedAfter.beta }, observed, boot_at: bootAt });
    }
    checked.push({ arm_id: a, org_id: org, recorded_after: recAfter, recorded_at: last.at_s, observed, updated_at: row.updated_at_s ?? null });
  }
  if (flags.length > 0) logger.warn('posterior compensation verify FLAGGED', { event: 'posterior_compensation_verify_flag', flags });
  return {
    status: 200,
    body: {
      success: flags.length === 0,
      shape: 'posteriorCompensationVerify',
      // ledger_rows_read lets a reader tell "nothing compensated yet" from "the ledger read returned nothing".
      body: { ...common, mode, boot_at: bootAt, with_logged_deltas: !!logged, ledger_rows_read: ledgerRowsRead, checked, flags },
    },
  };
}
