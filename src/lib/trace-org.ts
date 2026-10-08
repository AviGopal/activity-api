/**
 * The org a posted trace is stored under, and whether it was guessed.
 *
 * Precedence is unchanged from the handler's original expression: the body's org, then the JWT's, then the
 * session's. Only a non-empty string counts as an org. With none, the trace is still stored under 'public'
 * (execution.org_id is a required string, and dropping the trace would be its own harm) but `defaulted` is true:
 * the org is a guess, so nothing keyed on it may be LEARNED. Callers skip every org-keyed learning write for a
 * defaulted trace rather than redirect it to another org.
 */
export function resolveTraceOrg(i: { bodyOrg?: unknown; jwtOrg?: unknown; sessionOrg?: unknown }): { org: string; defaulted: boolean } {
  for (const candidate of [i.bodyOrg, i.jwtOrg, i.sessionOrg]) {
    if (typeof candidate === 'string' && candidate.length > 0) return { org: candidate, defaulted: false };
  }
  return { org: 'public', defaulted: true };
}
