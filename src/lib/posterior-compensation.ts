/**
 * posterior-compensation.ts — the β-leak REPLAY: undo, once, the β that withheld executions leaked into
 * variant_performance_metrics, for exactly the pairs of a frozen, sha-pinned list. Nothing else.
 *
 * NOT A GENERAL β-EDIT PRIMITIVE. Two resolver shapes on the existing POST /v2/impulses/resolve (no new
 * REST endpoint), both operator-only:
 *
 *   posteriorCompensation        accepts ONLY { ledger_key }. Variant, org and leak time are DERIVED here
 *                                from the shipped list (REPLAY_LIST_*) and the frozen eligibility file
 *                                (ELIGIBILITY_*), each pinned by a sha256 constant checked at load — a file
 *                                whose bytes do not match its pin refuses EVERYTHING. A key outside
 *                                CLEAN ∩ ELIGIBLE is refused (not_in_frozen_list / arm_not_eligible).
 *   posteriorCompensationReplay  the activity's resolver: dry_run (default; writes nothing — the per-arm
 *                                plan), arms (the eligible arm ids), apply (ONE ARM PER WRITE, sequential,
 *                                rate-limited; per-arm before/after from the transaction's own RETURN), and
 *                                verify (post-boot re-read: live (α, β) against the recorded AFTER).
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
 * INERT AFTER COMPLETION: once every eligible key has a ledger row, the completion row
 * `posterior_compensation_ledger:complete` is written, and from then on every posteriorCompensation call
 * (and replay apply) refuses with replay_complete. A completion row present at boot is honoured the same way.
 *
 * OPERATOR-ONLY uses activity-api's existing admin check (role 'admin' or scope 'admin', the predicate the
 * activityTemplate_update/_deprecate cases use), and refuses federation on-behalf-of callers. Admin scope is
 * not operator-exclusive (identity-vessel's bootstrap key carries it); the pinned list, not the caller, is
 * what bounds what this can write.
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

function readTsv(text: string, required: string[]): { rows: Record<string, string>[]; error?: string } {
  const lines = text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
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

// ─── Ledger reads ───

export const LEDGER_READ_SQL =
  `SELECT ledger_key, variant_id, org_id, status, applied, after, <string> at AS at_s FROM posterior_compensation_ledger WHERE ledger_key IN $keys`;
export const COMPLETION_READ_SQL =
  `SELECT ledger_key, status, eligible_total, <string> at AS at_s FROM type::thing('posterior_compensation_ledger', 'complete')`;
export const COMPLETION_CREATE_SQL =
  `CREATE type::thing('posterior_compensation_ledger', 'complete') CONTENT { ledger_key: 'complete', status: 'complete', list_sha: $list_sha, eligible_total: $eligible_total, at: time::now() }`;

/** Statuses that settle a pair for good (each leaves a ledger row). */
const TERMINAL = new Set(['written', 'floored', 'reset_since_leak', 'dropped_no_row']);

type LedgerRow = { ledger_key?: string; variant_id?: string; org_id?: string; status?: string; applied?: number; after?: { alpha?: number; beta?: number } | null; at_s?: string };

async function readLedger(deps: CompensationDeps, keys: string[]): Promise<Map<string, LedgerRow>> {
  if (keys.length === 0) return new Map();
  const rows = (await deps.db.query<LedgerRow>(LEDGER_READ_SQL, { keys })) ?? [];
  return new Map(rows.filter((r) => r?.ledger_key).map((r) => [String(r.ledger_key), r]));
}

async function replayComplete(deps: CompensationDeps): Promise<boolean> {
  const rows = (await deps.db.query<LedgerRow>(COMPLETION_READ_SQL, {})) ?? [];
  return rows.some((r) => r?.status === 'complete');
}

/** When every eligible key has a terminal ledger row, write the completion row (idempotent). */
async function maybeComplete(deps: CompensationDeps, inputs: Extract<FrozenInputs, { ok: true }>): Promise<boolean> {
  if (await replayComplete(deps)) return true;
  const ledger = await readLedger(deps, inputs.eligibleKeys);
  const done = inputs.eligibleKeys.every((k) => TERMINAL.has(String(ledger.get(k)?.status ?? '')));
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

// ─── Auth and the shared gate ───

/** activity-api's existing admin predicate (activityTemplate_update/_deprecate), minus federation OBO callers. */
export function isOperatorCaller(auth: JwtAuthContext | null | undefined): boolean {
  if (!auth || auth.obo) return false;
  return auth.role === 'admin' || (Array.isArray(auth.scopes) && auth.scopes.includes('admin'));
}

export type RefusalCode =
  | 'not_operator'
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

type Gate = { ok: true; inputs: Extract<FrozenInputs, { ok: true }> } | { ok: false; result: ResolverResult };

async function gate(auth: JwtAuthContext | null | undefined, deps: CompensationDeps, shape: string, opts: { write: boolean }): Promise<Gate> {
  if (!isOperatorCaller(auth)) {
    logger.warn('posterior compensation REFUSED: caller is not an operator', { event: 'posterior_compensation_refused', refused: 'not_operator', shape, key_id: auth?.keyId ?? null, user_id: auth?.userId ?? null, org_id: auth?.orgId ?? null, obo: !!auth?.obo });
    return { ok: false, result: refuse(403, 'not_operator', 'operator (admin) credentials required') };
  }
  const inputs = deps.inputs();
  if (!inputs.ok) return { ok: false, result: refuse(422, inputs.refused, inputs.detail) };
  if (opts.write) {
    if (!deps.coalesceEnabled()) return { ok: false, result: refuse(422, 'coalescing_disabled', 'compensation is applied only through the coalescing flush') };
    if (await replayComplete(deps)) return { ok: false, result: refuse(409, 'replay_complete', 'the replay has completed; this resolver is inert') };
  }
  return { ok: true, inputs };
}

// ─── Applying keys ───

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

// ─── posteriorCompensation: one key ───

export async function resolvePosteriorCompensation(
  pointer: Record<string, unknown>,
  auth: JwtAuthContext | null | undefined,
  deps: CompensationDeps = defaultCompensationDeps(),
): Promise<ResolverResult> {
  const g = await gate(auth, deps, 'posteriorCompensation', { write: true });
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

// ─── posteriorCompensationReplay: the activity's resolver ───

export interface ArmPlan {
  arm_id: string;
  org_id: string;
  k: number;
  already: number;
  row: 'present' | 'absent' | 'ambiguous';
  before: { alpha: number; beta: number } | null;
  beta_decayed_now: number | null;
  reset_since_leak: boolean;
  pairs: Array<{ ledger_key: string; factor: number }>;
  expected_residue: number;
  expected_floored: number;
  beta_after_floor: number | null;
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

export interface VerifyFlag {
  arm_id: string;
  org_id: string;
  kind: 'below_recorded_after' | 'mismatch_with_logged_deltas' | 're_reset' | 'row_missing' | 'row_ambiguous';
  expected: { alpha?: number; beta?: number; beta_min?: number } | null;
  observed: { alpha: number; beta: number } | null;
  boot_at: string;
}

type RowRead = { thompson_alpha?: number | null; thompson_beta?: number | null; updated_at_s?: string | null; successful_executions?: number | null; failed_executions?: number | null };
async function readRow(deps: CompensationDeps, armId: string, orgId: string): Promise<RowRead[]> {
  return (await deps.db.query<RowRead>(COMPENSATION_ROW_SQL, { variant_id: armId, org_id: orgId })) ?? [];
}
const tsMs = (s: string | null | undefined): number => { const p = s ? Date.parse(String(s)) : NaN; return Number.isNaN(p) ? 0 : p; };

/** Minimum spacing between two arms' writes, across calls (law 5 rhythm is the template's; this is the floor). */
const MIN_ARM_SPACING_MS = 1_000;
let lastArmWriteAt = 0;

async function planArm(deps: CompensationDeps, inputs: Extract<FrozenInputs, { ok: true }>, armId: string, nowMs: number): Promise<ArmPlan> {
  const org = inputs.arms.get(armId)!.org_id;
  const keys = inputs.keysByArm.get(armId) ?? [];
  const ledger = await readLedger(deps, keys);
  const open = keys.filter((k) => !ledger.has(k));
  const rows = await readRow(deps, armId, org);
  const row = rows.length === 1 ? rows[0] : null;
  const before = row ? { alpha: Number(row.thompson_alpha ?? 1), beta: Number(row.thompson_beta ?? 1) } : null;
  const reset = !!row && (before!.alpha === Number(row.successful_executions ?? NaN) + 1 && before!.beta === Number(row.failed_executions ?? NaN) + 1
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
    arm_id: armId, org_id: org, k: open.length, already: keys.length - open.length,
    row: rows.length === 0 ? 'absent' : rows.length === 1 ? 'present' : 'ambiguous',
    before, beta_decayed_now: decayedBeta, reset_since_leak: reset, pairs,
    expected_residue: residue, expected_floored: floored, beta_after_floor: reset ? decayedBeta : beta,
  };
}

function armRecord(armId: string, orgId: string, keys: string[], results: KeyResult[]): ArmApplyRecord {
  const counts: ArmApplyRecord['counts'] = { written: 0, floored: 0, reset_since_leak: 0, already_compensated: 0, dropped_no_row: 0, row_ambiguous: 0, pending: 0, refused: 0 };
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

export async function resolvePosteriorCompensationReplay(
  pointer: Record<string, unknown>,
  auth: JwtAuthContext | null | undefined,
  deps: CompensationDeps = defaultCompensationDeps(),
): Promise<ResolverResult> {
  const mode = pointer.mode === undefined ? 'dry_run' : String(pointer.mode);
  if (!['dry_run', 'arms', 'apply', 'verify'].includes(mode)) {
    // Auth first so an unknown mode never tells a non-operator anything.
    const g0 = await gate(auth, deps, 'posteriorCompensationReplay', { write: false });
    return g0.ok ? refuse(400, 'bad_request', `mode must be dry_run | arms | apply | verify, got ${mode}`) : g0.result;
  }
  const g = await gate(auth, deps, 'posteriorCompensationReplay', { write: mode === 'apply' });
  if (!g.ok) return g.result;
  const inputs = g.inputs;

  let armIds = [...inputs.keysByArm.keys()];
  const unknownArms: string[] = [];
  if (Array.isArray(pointer.arm_ids)) {
    const wanted = pointer.arm_ids.map(String);
    for (const a of wanted) if (!inputs.keysByArm.has(a)) unknownArms.push(a);
    armIds = armIds.filter((a) => wanted.includes(a));
  }
  const excluded = [...inputs.arms.values()].filter((a) => !a.eligible).map((a) => ({ arm_id: a.arm_id, candidate_rows: a.candidate_rows, note: a.note }));
  const common = { mode, list_sha: inputs.list_sha, eligibility_sha: inputs.eligibility_sha, excluded_arms: excluded, unknown_arms: unknownArms };

  if (mode === 'arms') {
    return { status: 200, body: { success: true, shape: 'posteriorCompensationArms', body: armIds } };
  }

  if (mode === 'dry_run') {
    const nowMs = deps.nowMs();
    const plans: ArmPlan[] = [];
    for (const a of armIds) plans.push(await planArm(deps, inputs, a, nowMs));
    return {
      status: 200,
      body: {
        success: true,
        shape: 'posteriorCompensationPlan',
        body: {
          ...common, at: new Date(nowMs).toISOString(), replay_complete: await replayComplete(deps),
          arms: plans,
          totals: {
            arms: plans.length, k: plans.reduce((s, p) => s + p.k, 0), already: plans.reduce((s, p) => s + p.already, 0),
            expected_residue: plans.reduce((s, p) => s + p.expected_residue, 0), expected_floored: plans.reduce((s, p) => s + p.expected_floored, 0),
            reset_arms: plans.filter((p) => p.reset_since_leak).map((p) => p.arm_id),
          },
        },
      },
    };
  }

  if (mode === 'apply') {
    const rateLimitMs = Math.max(MIN_ARM_SPACING_MS, Number.isFinite(Number(pointer.rate_limit_ms)) ? Number(pointer.rate_limit_ms) : 5_000);
    const records: ArmApplyRecord[] = [];
    let stoppedAt: string | null = null;
    for (const a of armIds) {
      // ONE ARM PER WRITE, sequential, spaced: the coalescer never batches across arms and a fault stops at
      // an arm boundary.
      const wait = lastArmWriteAt + rateLimitMs - Date.now();
      if (lastArmWriteAt > 0 && wait > 0) await deps.sleep(wait);
      const keys = inputs.keysByArm.get(a) ?? [];
      const results = await compensateKeys(keys, inputs, deps);
      lastArmWriteAt = Date.now();
      const rec = armRecord(a, inputs.arms.get(a)!.org_id, keys, results);
      records.push(rec);
      logger.info('posterior compensation replay: arm', { event: 'posterior_compensation_replay_arm', ...rec });
      if (rec.counts.pending > 0 || rec.counts.refused > 0 || rec.counts.row_ambiguous > 0) { stoppedAt = a; break; }
    }
    const complete = await maybeComplete(deps, inputs);
    return {
      status: 200,
      body: {
        success: stoppedAt === null,
        shape: 'posteriorCompensationReplayResult',
        body: {
          ...common, rate_limit_ms: rateLimitMs, stopped_at: stoppedAt, replay_complete: complete, arms: records,
          totals: {
            arms: records.length,
            nominal_sum: records.reduce((s, r) => s + r.nominal_sum, 0),
            applied_sum: records.reduce((s, r) => s + r.applied_sum, 0),
            written: records.reduce((s, r) => s + r.counts.written, 0),
            floored: records.reduce((s, r) => s + r.counts.floored, 0),
            reset_since_leak: records.reduce((s, r) => s + r.counts.reset_since_leak, 0),
            already_compensated: records.reduce((s, r) => s + r.counts.already_compensated, 0),
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
  for (const a of armIds) {
    const org = inputs.arms.get(a)!.org_id;
    const ledger = await readLedger(deps, inputs.keysByArm.get(a) ?? []);
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
      body: { ...common, boot_at: bootAt, with_logged_deltas: !!logged, checked, flags },
    },
  };
}
