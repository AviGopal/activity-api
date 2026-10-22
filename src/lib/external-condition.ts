/**
 * external-condition.ts — the LOOPBACK READ of this node's open externalCondition pool rows. Nothing else.
 *
 * An externalCondition row is an operator-written record of an observed environment outage window on this node (a
 * trust-root pool shape on development-vessel). The learner's blame step (posterior-update.ts, closed) reads it so a
 * failure recorded inside a CONFIRMED window is "unattributed (environment)": beta 0, never alpha.
 *
 * THIS MODULE IS UNTRUSTED BY DESIGN. It is lane-open, so posterior-update.ts uses what it returns only to choose which
 * record ids to look at: it re-reads each candidate BY ID from this node's development-vessel itself and judges that
 * copy (attestation, confirmation, window, holder). An edit here can therefore hide a window (the arm keeps its blame)
 * or name a record the node does not hold (refused), never make a failure unattributed. No verdict logic belongs here.
 *
 * Fails soft: an unreadable pool is no candidates (blame unchanged). Cached briefly so a burst of failures during an
 * outage asks development-vessel once, not once per trace.
 */
import { logger } from '../utils/logger';

/** This node's development-vessel (the posterior-compensation precedent): never discovery, never a peer. */
const POOL_RESOLVE_URL = 'http://127.0.0.1:8090/v2/impulses/resolve';
const CANDIDATE_TTL_MS = 30_000;
const READ_TIMEOUT_MS = 3_000;

let cache: { at: number; rows: unknown[] } | null = null;
/** Whether the last read answered: an unreadable pool is logged once when it becomes unreadable, not every TTL. */
let lastReadOk = true;

/** The open externalCondition rows as this node's pool serves them, or [] when unreadable. Untrusted: candidates only. */
export async function readExternalConditionCandidates(nowMs: number = Date.now()): Promise<unknown[]> {
  if (cache && nowMs - cache.at < CANDIDATE_TTL_MS) return cache.rows;
  let rows: unknown[] = [];
  let why: string | null = null;
  try {
    const res = await fetch(POOL_RESOLVE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impulse: { type: 'poolImpulse', shape: 'externalCondition', status: 'open' } }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    const j = (await res.json().catch(() => null)) as { body?: { impulses?: unknown } } | null;
    if (res.ok && Array.isArray(j?.body?.impulses)) rows = j!.body!.impulses as unknown[];
    else why = `HTTP ${res.status}`;
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (why !== null && lastReadOk) logger.warn('external condition candidates unreadable (blame unchanged)', { error: why });
  else if (why === null && !lastReadOk) logger.info('external condition candidates readable again');
  lastReadOk = why === null;
  cache = { at: nowMs, rows };
  return rows;
}

/** Tests only: forget the cached candidate list. */
export function _resetExternalConditionCandidatesForTests(): void { cache = null; }
