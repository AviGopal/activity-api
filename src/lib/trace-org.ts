/**
 * The org a posted trace (or goal-path record, or subscriber-count batch) is stored under, and whether it was guessed.
 *
 * The org is the AUTHENTICATED one: the JWT's (the API key's validated org arrives here too), then the session's.
 * Only a non-empty string counts as an org. A body org is never a source: the caller can write any string there, and
 * taking it first let any authenticated caller write traces, goal-path counters and posteriors into another org,
 * which then steer that org's selection. A body org is accepted only as a claim that must equal the authenticated
 * org (compared without the `organizations:` record prefix, since both spellings are live); then the write lands
 * exactly as it did, under the body's spelling. A body org that differs, or that no authenticated org can vouch for,
 * sets `refused`, and the caller answers 403 rather than storing the write under either org.
 *
 * With no org at all, the write is still stored under 'public' (execution.org_id is a required string, and dropping
 * the trace would be its own harm) but `defaulted` is true: the org is a guess, so nothing keyed on it may be
 * LEARNED. Callers skip every org-keyed learning write for a defaulted trace rather than redirect it to another org.
 */
export function resolveTraceOrg(i: { bodyOrg?: unknown; jwtOrg?: unknown; sessionOrg?: unknown }): { org: string; defaulted: boolean; refused?: string } {
  const isOrg = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const authOrg = [i.jwtOrg, i.sessionOrg].find(isOrg);
  if (isOrg(i.bodyOrg)) {
    const bare = (o: string) => o.replace(/^organizations:/, '');
    if (authOrg === undefined) {
      return { org: 'public', defaulted: true, refused: `body org_id "${i.bodyOrg}" is not the caller's: the request carries no authenticated org to vouch for it` };
    }
    if (bare(i.bodyOrg) !== bare(authOrg)) {
      return { org: authOrg, defaulted: false, refused: `body org_id "${i.bodyOrg}" is not the caller's authenticated org "${authOrg}"` };
    }
    return { org: i.bodyOrg, defaulted: false };
  }
  if (authOrg !== undefined) return { org: authOrg, defaulted: false };
  return { org: 'public', defaulted: true };
}

/** The named refusal every org-keyed write route answers with when resolveTraceOrg sets `refused`. */
export const ORG_MISMATCH = 'ORG_MISMATCH';
