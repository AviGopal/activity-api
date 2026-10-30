/**
 * trace_evidence_ref_write: open or close an in-store reference that keeps a cited execution's trace row.
 *
 * Trace retention treats an execution as evidence while a `trace_evidence_ref` row names it with `open` not false
 * (migration 220; services/trace-retention.ts PROTECTED_REFS_LET): the valve's drains and id fallback never delete
 * it. The table had no writer. A person-verdict deferral on a template run (exec_*) waits on an engine-owned durable
 * row that is ungraded until the person or the fallback decides, so retention could prune it first; /reach then
 * matched no row and the verdict was lost. Goal-host must not re-insert engine rows, so it opens a reference here
 * when it defers and closes it when the verdict lands or the deferral expires.
 *
 * Pointer: { type: 'trace_evidence_ref_write', execution_id, source: 'person_verdict', ref, open }
 *   execution_id  the execution's bare id as the trace store keys it (meta::id, e.g. 'exec_ab12cd34'); a
 *                 table-prefixed id is refused, because retention compares bare ids and a prefixed one would
 *                 protect nothing
 *   source        'person_verdict' (the only source this path writes; 'gap' and 'attempt_ledger' keep their own
 *                 writers and are refused here)
 *   ref           the citing record's key: the deferral's dispatch id
 *   open          true while the deferral is open, false once decided or expired
 * One record per (source, ref, execution_id), so re-opening or re-closing is idempotent and a close lands on the row
 * its open wrote.
 *
 * TENANCY. A reference keeps an execution from pruning, so a caller may cite only an execution of its OWN org: the
 * execution's org is read AS THE CALLER (executeAsAuth: a token session through its own PERMISSIONS, an API key on
 * root with the org compared here, the pattern every other write in impulses.ts uses) and must equal the caller's
 * org, else 403. A missing execution is refused the same way (nothing of the caller's to protect). The row is
 * written as the caller with org_id from the validated context, and migration 230 scopes the table's select,
 * create and update to that org for token sessions. Retention reads it on root, across orgs, as before.
 * The caller also needs a validated credential carrying the write scope (or admin), the grant a label write needs.
 */

import type { ImpulseResolveResponse } from '../models/schemas';
import type { JwtAuthContext } from '../middleware/jwtAuth';
import { logger } from '../utils/logger';
import { WRITE_SCOPE, ADMIN_SCOPE, type ExecuteAsAuth } from './goal-verification-label-write';

export const TRACE_EVIDENCE_REF_WRITE_SHAPE = 'trace_evidence_ref_write';
/** The sources this path writes. */
export const TRACE_EVIDENCE_REF_WRITE_SOURCES: ReadonlySet<string> = new Set(['person_verdict']);

export interface TraceEvidenceRefWriteResult {
  status: 200 | 400 | 401 | 403 | 500;
  body: ImpulseResolveResponse;
}

const fail = (status: TraceEvidenceRefWriteResult['status'], error: string): TraceEvidenceRefWriteResult =>
  ({ status, body: { success: false, error } as ImpulseResolveResponse });

/** An org id in the context's form: the record prefix stripped (middleware/jwtAuth.ts strips it the same way). */
const bareOrg = (v: unknown): string => String(v ?? '').replace(/^organizations:/, '');

export async function resolveTraceEvidenceRefWrite(
  ctx: JwtAuthContext | null | undefined,
  pointer: Record<string, unknown>,
  executeAsAuth: ExecuteAsAuth,
): Promise<TraceEvidenceRefWriteResult> {
  if (!ctx) return fail(401, 'Authentication required for trace_evidence_ref_write');
  const scopes = Array.isArray(ctx.scopes) ? ctx.scopes : [];
  if (!scopes.includes(WRITE_SCOPE) && !scopes.includes(ADMIN_SCOPE)) {
    return fail(403, 'trace_evidence_ref_write needs a credential with the write scope');
  }
  const executionId = typeof pointer['execution_id'] === 'string' ? pointer['execution_id'].trim() : '';
  const source = typeof pointer['source'] === 'string' ? pointer['source'] : '';
  const ref = typeof pointer['ref'] === 'string' ? pointer['ref'].trim() : '';
  const open = pointer['open'];
  if (!executionId || executionId.includes(':')) {
    return fail(400, 'execution_id must be the bare execution id (no table prefix), e.g. exec_ab12cd34');
  }
  if (!TRACE_EVIDENCE_REF_WRITE_SOURCES.has(source)) {
    return fail(400, `source must be one of: ${[...TRACE_EVIDENCE_REF_WRITE_SOURCES].join(', ')}`);
  }
  if (!ref) return fail(400, 'ref (the citing record key, e.g. the dispatch id) is required');
  if (typeof open !== 'boolean') return fail(400, 'open must be a boolean');
  const callerOrg = bareOrg(ctx.orgId);
  if (!callerOrg) return fail(403, 'trace_evidence_ref_write needs a caller org');

  try {
    // Ownership, read as the caller.
    const owners = await executeAsAuth<unknown>(ctx, 'SELECT VALUE org_id FROM type::thing("execution", $e)', { e: executionId });
    if (!Array.isArray(owners) || owners.length !== 1 || bareOrg(owners[0]) !== callerOrg) {
      logger.warn('trace_evidence_ref_write refused', { reason: 'not_callers_execution', execution_id: executionId, ref });
      return fail(403, 'execution_id names no execution of the caller\'s org');
    }
    await executeAsAuth(
      ctx,
      `UPSERT type::thing('trace_evidence_ref', [$source, $ref, $execution_id]) MERGE {
         execution_id: $execution_id, source: $source, ref: $ref, open: $open, org_id: $org_id, updated_at: time::now()
       } RETURN NONE`,
      { execution_id: executionId, source, ref, open, org_id: callerOrg },
    );
  } catch (err) {
    logger.error('trace_evidence_ref_write failed', { error: err instanceof Error ? err.message : String(err) });
    return fail(500, 'trace_evidence_ref_write failed');
  }
  logger.info('trace_evidence_ref_write', { execution_id: executionId, source, ref, open });
  return {
    status: 200,
    body: {
      success: true,
      content: JSON.stringify({ execution_id: executionId, source, ref, open }),
      metadata: {
        shape: `${TRACE_EVIDENCE_REF_WRITE_SHAPE}_result`,
        summary: `trace evidence ref ${open ? 'opened' : 'closed'} for ${executionId} (${source} ${ref})`,
      },
    } as ImpulseResolveResponse,
  };
}
