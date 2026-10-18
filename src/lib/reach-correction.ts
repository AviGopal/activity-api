/**
 * reach-correction.ts — a RECORDED CORRECTION that retracts a latched `reached:false` verdict to ungraded.
 *
 * WHY. POST /execution-traces/reach credits a row once: it stamps `reach_graded:true` before crediting and a
 * row carrying the stamp is never graded again; tags are only ever unioned; classifyReach reads the tags. So a
 * verdict produced by a WRONG grading rule (light-dispatch's all-of rule graded clean completions reached:false
 * whenever a declared shape was missing, or none were declared) is latched for good: no later /reach can correct
 * it, and metadata.superseded_verdicts records history only for a stamped verdict_class, which light-dispatch
 * never sends. This is the correction path. It can only RETRACT, never promote: the per-task shapes a fresh
 * verdict would need were never stored.
 *
 * WHAT A RETRACTION WRITES, on the authoritative `execution` row, in one statement:
 *   - tag `reach_retracted:<list_sha>`  classifyReach reads it ahead of reached:false → 'ungraded';
 *   - `reached = NONE`                  every reader of the column (grouped-execution-stats, the trace list and
 *                                       detail hydrates, the reach-history rollup) reads it as ungraded;
 *   - metadata.reach_retraction         {list_sha, rule, commit, prior_reached, at}: the SQL-readable marker
 *                                       (retention compaction, the dry run's exclusion);
 *   - a metadata.superseded_verdicts entry, superseded_by `correction:<list_sha>`, written even though no
 *     verdict_class was stamped, bounded like the route's own (SUPERSEDED_VERDICTS_KEPT).
 * It moves NO posterior: no variant_performance_metrics, context_thompson_scores or shape counter write. The
 * β the verdict charged stays until a separate, attested posterior correction.
 *
 * ONLY A LATCHED, CLEAN, NOT-REACHED ROW: reach_graded:true, reached:false, no reached:true, success:true. A
 * failed execution is not-reached by its own exit status whatever the rule said (classifyReach's failure arm),
 * and a reached row is never retracted by a correction of reach:false. An unlatched row is refused: its verdict
 * has not been credited and a later /reach still decides it.
 *
 * IDEMPOTENT AND REVERSIBLE. Re-applying is a no-op (`already_retracted`); the INVERSE, through the same path
 * with `inverse: true` and the same provenance, removes the tag, restores the prior `reached` and appends its own
 * superseded_verdicts entry (superseded_by `inverse-correction:<list_sha>`). A row retracted under another list
 * is refused, never re-stamped. A row RE-GRADED after its retraction (a later /reach reached:true set its column
 * and tag) is not restored: `skipped_regraded`, since restoring would write false under a reached:true tag.
 *
 * THE LIST. Retractions are applied only for a FROZEN, sha-pinned list of executions, with the same operator
 * attestation as the β-leak replay (posterior-compensation.ts): resolver shape `reachCorrection` on
 * POST /v2/impulses/resolve, operator-only.
 *   dry_run (default)  read-only: selects the candidates in a window and returns them with the list sha.
 *                      Canonical form: sha256 over the sorted, de-duplicated execution ids, each followed by "\n".
 *   apply              { execution_ids, provenance: { list_sha, rule, commit }, inverse? }: the ids must hash to
 *                      provenance.list_sha, and THIS node's development-vessel must hold an open, operator-attested,
 *                      verified posteriorReplayAuthorization naming this node and that list sha (no eligibility
 *                      sha), unexpired (checkAuthorization). Then each id is corrected.
 * There is no completion row: inert-on-completion would block the inverse.
 */
import { createHash } from 'node:crypto';
import type { JwtAuthContext } from '../middleware/jwtAuth';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';
import { REACH_RETRACTED_PREFIX } from './reach-classify';
import {
  checkAuthorization,
  defaultCompensationDeps,
  nodeIdentity,
  operatorGate,
  type CompensationDeps,
  type ResolverResult,
} from './posterior-compensation';

export const REACH_CORRECTION_SHAPE = 'reachCorrection';
/** The only verdict a correction may retract. */
export const CORRECTION_OF_REACH_FALSE = 'reach:false';
/** metadata.superseded_verdicts is append-only history, bounded to the last N entries (POST /reach uses the same bound). */
export const SUPERSEDED_VERDICTS_KEPT = 10;

export interface ReachCorrectionProvenance {
  /** sha256 of the frozen list this execution belongs to (see the canonical form above). */
  list_sha: string;
  /** The grading rule found wrong, named by the operator (e.g. which dispatcher, which predicate). */
  rule: string;
  /** The commit that fixed the rule. */
  commit: string;
}
export interface ReachCorrection {
  execution_id: string;
  correction_of: typeof CORRECTION_OF_REACH_FALSE;
  provenance: ReachCorrectionProvenance;
  /** true: undo this list's retraction on the row. */
  inverse?: boolean;
}

export type CorrectionRefusal =
  | 'bad_request'
  | 'no_such_execution'
  | 'reached_true'
  | 'not_reach_false'
  | 'not_latched'
  | 'failed_execution'
  | 'retracted_by_other_list'
  | 'write_failed';
export type CorrectionOutcome =
  | { execution_id: string; status: 'retracted' | 'already_retracted' | 'restored' | 'not_retracted' | 'skipped_regraded' }
  | { execution_id: string; refused: CorrectionRefusal; detail: string };

type QueryDb = { query: <T = unknown>(sql: string, vars?: Record<string, unknown>) => Promise<T[]> };

const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** Why a correction is malformed, or null. */
export function correctionError(c: Partial<ReachCorrection> | null | undefined): string | null {
  if (!c || typeof c !== 'object') return 'a correction object is required';
  if (typeof c.execution_id !== 'string' || !c.execution_id.trim()) return 'execution_id (string) required';
  if (c.correction_of !== CORRECTION_OF_REACH_FALSE) return `correction_of must be '${CORRECTION_OF_REACH_FALSE}'`;
  const p = c.provenance;
  if (!p || typeof p !== 'object') return 'provenance { list_sha, rule, commit } required';
  if (typeof p.list_sha !== 'string' || !SHA_RE.test(p.list_sha)) return 'provenance.list_sha must be a sha256 hex string';
  if (typeof p.rule !== 'string' || !p.rule.trim() || p.rule.length > 200) return 'provenance.rule must be a non-empty string (at most 200 chars)';
  if (typeof p.commit !== 'string' || !COMMIT_RE.test(p.commit)) return 'provenance.commit must be a hex commit id';
  if (c.inverse !== undefined && typeof c.inverse !== 'boolean') return 'inverse must be a boolean';
  return null;
}

/** The list sha: sha256 over the sorted, de-duplicated ids, each followed by "\n". */
export function listShaOf(executionIds: string[]): string {
  const ids = [...new Set(executionIds.map(String))].sort();
  return createHash('sha256').update(ids.map((id) => `${id}\n`).join('')).digest('hex');
}

const PRE_READ_SQL =
  `SELECT success, tags, reached, metadata.reach_retraction AS retraction FROM type::thing('execution', $eid)`;

// SET clauses are evaluated left to right, so the history entry and prior_reached read the row BEFORE
// `reached = NONE`. The WHERE repeats the pre-read's conditions, so a concurrent change cannot be retracted.
const RETRACT_SQL = `UPDATE type::thing('execution', $eid) SET
  metadata.superseded_verdicts = array::slice(array::append(metadata.superseded_verdicts ?? [], { class: metadata.verdict_class, reason: metadata.reach_reason, prior_reached: reached, superseded_at: time::now(), superseded_by: $by, correction_of: $correction_of, provenance: $prov }), -${SUPERSEDED_VERDICTS_KEPT}),
  metadata.reach_retraction = { list_sha: $prov.list_sha, rule: $prov.rule, commit: $prov.commit, prior_reached: reached, at: time::now() },
  reached = NONE,
  tags = array::union(tags ?? [], [$tag])
WHERE success = true AND tags CONTAINS 'reach_graded:true' AND tags CONTAINS 'reached:false' AND !(tags CONTAINS 'reached:true') AND metadata.reach_retraction = NONE
RETURN id`;

const RESTORE_SQL = `UPDATE type::thing('execution', $eid) SET
  metadata.superseded_verdicts = array::slice(array::append(metadata.superseded_verdicts ?? [], { retraction: metadata.reach_retraction, superseded_at: time::now(), superseded_by: $by, correction_of: $correction_of, provenance: $prov }), -${SUPERSEDED_VERDICTS_KEPT}),
  reached = metadata.reach_retraction.prior_reached,
  tags = array::complement(tags ?? [], [$tag]),
  metadata.reach_retraction = NONE
WHERE metadata.reach_retraction.list_sha = $prov.list_sha AND reached = NONE AND !(tags CONTAINS 'reached:true')
RETURN id`;

type PreRow = { success?: boolean; tags?: string[]; reached?: boolean | null; retraction?: { list_sha?: string } | null };

/**
 * Apply ONE correction (or its inverse) to one execution. Performs no caller or authorization check: it is
 * reached from the resolver only through the apply gate, and exported so the real-engine tests drive it.
 */
export async function applyReachCorrection(db: QueryDb, c: ReachCorrection): Promise<CorrectionOutcome> {
  const err = correctionError(c);
  const eid = String(c?.execution_id ?? '');
  if (err) return { execution_id: eid, refused: 'bad_request', detail: err };
  const prov = { list_sha: c.provenance.list_sha, rule: c.provenance.rule.trim(), commit: c.provenance.commit };
  const tag = `${REACH_RETRACTED_PREFIX}${prov.list_sha}`;
  let row: PreRow | undefined;
  try {
    row = ((await db.query<PreRow>(PRE_READ_SQL, { eid })) ?? [])[0];
  } catch (e) {
    return { execution_id: eid, refused: 'write_failed', detail: `pre-read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!row) return { execution_id: eid, refused: 'no_such_execution', detail: 'no execution row has this id' };
  const tags = Array.isArray(row.tags) ? row.tags : [];
  const heldSha = row.retraction?.list_sha ?? null;

  if (c.inverse === true) {
    if (heldSha === null) return { execution_id: eid, status: 'not_retracted' };
    if (heldSha !== prov.list_sha) return { execution_id: eid, refused: 'retracted_by_other_list', detail: `retracted under list ${heldSha}` };
    // RE-GRADED SINCE THE RETRACTION: a later /reach reached:true set the column and the tag (only reach:false is
    // held on a retracted row). Restoring prior_reached would write false under a reached:true tag, so the row is
    // left as it is and reported; the RESTORE WHERE repeats the condition against a concurrent re-grade.
    if (tags.includes('reached:true') || typeof row.reached === 'boolean') {
      logger.info('[reach-correction] inverse SKIPPED: the row was re-graded after its retraction', { event: 'reach_correction_skipped_regraded', execution_id: eid, list_sha: prov.list_sha, reached: row.reached ?? null });
      return { execution_id: eid, status: 'skipped_regraded' };
    }
    const res = await db.query(RESTORE_SQL, { eid, prov, tag, by: `inverse-correction:${prov.list_sha}`, correction_of: tag });
    if (!Array.isArray(res) || res.length === 0) return { execution_id: eid, refused: 'write_failed', detail: 'the restore matched no row' };
    logger.info('[reach-correction] retraction REVERSED', { event: 'reach_correction_restored', execution_id: eid, list_sha: prov.list_sha });
    return { execution_id: eid, status: 'restored' };
  }

  if (heldSha !== null) {
    return heldSha === prov.list_sha
      ? { execution_id: eid, status: 'already_retracted' }
      : { execution_id: eid, refused: 'retracted_by_other_list', detail: `already retracted under list ${heldSha}` };
  }
  if (tags.includes('reached:true')) return { execution_id: eid, refused: 'reached_true', detail: 'the row holds reached:true; a correction of reach:false never retracts it' };
  if (!tags.includes('reached:false')) return { execution_id: eid, refused: 'not_reach_false', detail: 'the row holds no reached:false verdict' };
  if (!tags.includes('reach_graded:true')) return { execution_id: eid, refused: 'not_latched', detail: 'the verdict was never credited (no reach_graded:true); POST /reach still decides it' };
  if (row.success !== true) return { execution_id: eid, refused: 'failed_execution', detail: 'a failed execution is not-reached by its exit status; only a clean completion is retracted' };
  const res = await db.query(RETRACT_SQL, { eid, prov, tag, by: `correction:${prov.list_sha}`, correction_of: CORRECTION_OF_REACH_FALSE });
  if (!Array.isArray(res) || res.length === 0) return { execution_id: eid, refused: 'write_failed', detail: 'the row changed between the read and the write; nothing retracted' };
  logger.info('[reach-correction] latched reach:false RETRACTED to ungraded', { event: 'reach_correction_retracted', execution_id: eid, list_sha: prov.list_sha, rule: prov.rule, commit: prov.commit });
  return { execution_id: eid, status: 'retracted' };
}

// ─── The candidate selection (dry_run) ───

/**
 * The light-dispatch all-of candidates: clean completions dispatched by light-dispatch whose late reach:false was
 * credited (reach_graded:true), never reached, not yet retracted, executed in [since, until). Read-only.
 * Identifying fields: the tag `dispatcher_used:light-dispatch` (light-dispatch also writes
 * metadata.dispatcher_used), `success`, the reach tags, `executed_at` (indexed).
 */
const CANDIDATE_WHERE = `executed_at >= type::datetime($since) AND executed_at < type::datetime($until)
  AND tags CONTAINS 'dispatcher_used:light-dispatch' AND tags CONTAINS 'reach_graded:true' AND tags CONTAINS 'reached:false' AND !(tags CONTAINS 'reached:true')`;
export const CANDIDATES_SQL = `SELECT meta::id(id) AS execution_id, activity_id, success, metadata.reach_retraction.list_sha AS retracted_by, <string> executed_at AS executed_at FROM execution
WHERE ${CANDIDATE_WHERE}
ORDER BY executed_at ASC LIMIT $cap TIMEOUT 60s`;
export const CANDIDATE_CAP = 5000;

export interface ReachCorrectionDeps {
  db: QueryDb;
  /** The authorization read (THIS node's development-vessel) and its clock. */
  auth: Pick<CompensationDeps, 'fetch' | 'poolResolveUrl' | 'nowMs'>;
  node: () => string | null;
}
export function defaultReachCorrectionDeps(): ReachCorrectionDeps {
  return { db: surrealDB as unknown as QueryDb, auth: defaultCompensationDeps(), node: () => nodeIdentity() };
}

const refuse = (status: number, code: string, detail?: string, extra: Record<string, unknown> = {}): ResolverResult => ({
  status,
  body: { success: false, refused: code, error: code, ...(detail ? { detail } : {}), ...extra },
});

async function dryRun(pointer: Record<string, unknown>, deps: ReachCorrectionDeps): Promise<ResolverResult> {
  const since = typeof pointer.since === 'string' ? pointer.since : '';
  const until = typeof pointer.until === 'string' ? pointer.until : new Date(deps.auth.nowMs()).toISOString();
  if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until))) return refuse(400, 'bad_request', 'since (ISO time) required; until optional (ISO time)');
  const rows = (await deps.db.query<{ execution_id: string; activity_id?: string; success?: boolean; retracted_by?: string | null; executed_at?: string }>(
    CANDIDATES_SQL, { since, until, cap: CANDIDATE_CAP + 1 },
  )) ?? [];
  const truncated = rows.length > CANDIDATE_CAP;
  const seen = rows.slice(0, CANDIDATE_CAP);
  const list = seen.filter((r) => r.success === true && !r.retracted_by);
  const ids = [...new Set(list.map((r) => String(r.execution_id)))].sort();
  const byActivity: Record<string, number> = {};
  for (const r of list) byActivity[String(r.activity_id ?? '')] = (byActivity[String(r.activity_id ?? '')] ?? 0) + 1;
  return {
    status: 200,
    body: {
      success: true,
      shape: 'reachCorrectionPlan',
      body: {
        mode: 'dry_run', node: deps.node(), since, until, correction_of: CORRECTION_OF_REACH_FALSE,
        selector: `execution WHERE ${CANDIDATE_WHERE.replace(/\s+/g, ' ')} AND success = true AND metadata.reach_retraction = NONE`,
        canonical: 'sha256 over the sorted, de-duplicated execution ids, each followed by "\\n"',
        list_sha: listShaOf(ids), count: ids.length, execution_ids: ids, by_activity: byActivity,
        // Shown so the operator can reconcile the count: a failed execution is not-reached by exit status and is
        // never retracted; a retracted row is already corrected.
        excluded: {
          failed_execution: seen.filter((r) => r.success !== true).length,
          already_retracted: seen.filter((r) => r.success === true && !!r.retracted_by).length,
        },
        truncated, cap: CANDIDATE_CAP,
      },
    },
  };
}

async function apply(pointer: Record<string, unknown>, deps: ReachCorrectionDeps): Promise<ResolverResult> {
  const ids = Array.isArray(pointer.execution_ids) ? pointer.execution_ids.map(String) : null;
  const prov = pointer.provenance as ReachCorrectionProvenance | undefined;
  if (!ids || ids.length === 0) return refuse(400, 'bad_request', 'execution_ids (the frozen list) required');
  const probe = correctionError({ execution_id: ids[0], correction_of: pointer.correction_of as typeof CORRECTION_OF_REACH_FALSE, provenance: prov, inverse: pointer.inverse as boolean | undefined });
  if (probe) return refuse(400, 'bad_request', probe);
  const sha = listShaOf(ids);
  if (sha !== prov!.list_sha) return refuse(422, 'list_sha_mismatch', `the execution_ids hash to ${sha}, provenance names ${prov!.list_sha}`);
  const node = deps.node();
  if (!node) return refuse(422, 'no_list_for_node', 'this node has no identity (FED_SUBSTRATE_ID / SUBSTRATE_ID)');
  const denial = await checkAuthorization(deps.auth, { node, list_sha: sha });
  if (denial) {
    logger.warn('reach correction REFUSED: write without authorization', { event: 'reach_correction_refused', refused: denial.code, why: denial.why, list_sha: sha });
    return refuse(403, denial.code, denial.why);
  }
  const outcomes: CorrectionOutcome[] = [];
  for (const id of [...new Set(ids)].sort()) {
    outcomes.push(await applyReachCorrection(deps.db, { execution_id: id, correction_of: CORRECTION_OF_REACH_FALSE, provenance: prov!, ...(pointer.inverse === true ? { inverse: true } : {}) }));
  }
  const counts: Record<string, number> = {};
  for (const o of outcomes) { const k = 'refused' in o ? `refused:${o.refused}` : o.status; counts[k] = (counts[k] ?? 0) + 1; }
  logger.info('reach correction applied', { event: 'reach_correction_apply', list_sha: sha, inverse: pointer.inverse === true, counts });
  return {
    status: 200,
    body: { success: true, shape: 'reachCorrectionResult', body: { mode: 'apply', inverse: pointer.inverse === true, node, list_sha: sha, provenance: prov, counts, outcomes } },
  };
}

/** reachCorrection: dry_run (default, read-only) | apply (operator + this node's attestation for the list sha). */
export async function resolveReachCorrection(
  pointer: Record<string, unknown>,
  auth: JwtAuthContext | null | undefined,
  deps: ReachCorrectionDeps = defaultReachCorrectionDeps(),
): Promise<ResolverResult> {
  const denied = operatorGate(auth, REACH_CORRECTION_SHAPE);
  if (denied) return denied;
  const mode = pointer.mode === undefined ? 'dry_run' : String(pointer.mode);
  if (mode === 'dry_run') return dryRun(pointer, deps);
  if (mode === 'apply') return apply(pointer, deps);
  return refuse(400, 'bad_request', `mode must be dry_run | apply, got ${mode}`);
}
