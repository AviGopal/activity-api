/**
 * THE TRACE'S ORG, AND WHETHER IT WAS GUESSED (check-first).
 *
 * The trace POST handler resolved its org as `body.org_id || jwt || session || 'public'`. The trace must still be
 * stored when no org is known (execution.org_id is a required string), but every learning write keyed on that org
 * was then aimed at a guessed row. resolveTraceOrg says when the org was defaulted, so the handler can store the
 * trace and skip the learning writes.
 *
 * Taking the body org FIRST let any authenticated caller write into another org by naming it. The org is now the
 * authenticated one (jwt, then session); a body org is only a claim that must equal it.
 *
 * THE RULE PINNED HERE: jwt, then session; only a non-empty string counts; a body org that differs from that org
 * (compared without the `organizations:` prefix), or that no authenticated org vouches for, is `refused`; a matching
 * body org keeps its own spelling; otherwise { org: 'public', defaulted: true }.
 */
import { describe, expect, test } from 'bun:test';
import { resolveTraceOrg } from './trace-org';

describe('resolveTraceOrg', () => {
  test('MUST-FAIL: a body org that differs from the jwt org is refused, and the jwt org is the org', () => {
    const r = resolveTraceOrg({ bodyOrg: 'org-body', jwtOrg: 'org-jwt', sessionOrg: 'org-sess' });
    expect(r.org).toBe('org-jwt');
    expect(r.refused).toContain('org-body');
  });

  test('MUST-FAIL: a body org with no authenticated org to vouch for it is refused', () => {
    const r = resolveTraceOrg({ bodyOrg: 'org-body' });
    expect(typeof r.refused).toBe('string');
    expect(r.org).not.toBe('org-body');
    expect(resolveTraceOrg({ bodyOrg: 'public' }).refused).toBeDefined();
  });

  test('MUST-FAIL: a body org that differs from the session org is refused', () => {
    expect(resolveTraceOrg({ bodyOrg: 'org-body', sessionOrg: 'org-sess' }).refused).toBeDefined();
  });

  test('a body org equal to the authenticated org is accepted under its own spelling', () => {
    expect(resolveTraceOrg({ bodyOrg: 'org-jwt', jwtOrg: 'org-jwt' })).toEqual({ org: 'org-jwt', defaulted: false });
    expect(resolveTraceOrg({ bodyOrg: 'organizations:org-jwt', jwtOrg: 'org-jwt' })).toEqual({ org: 'organizations:org-jwt', defaulted: false });
    expect(resolveTraceOrg({ bodyOrg: 'org-sess', sessionOrg: 'organizations:org-sess' })).toEqual({ org: 'org-sess', defaulted: false });
  });

  test('jwt org is used when the body carries none', () => {
    expect(resolveTraceOrg({ bodyOrg: undefined, jwtOrg: 'org-jwt', sessionOrg: 'org-sess' })).toEqual({ org: 'org-jwt', defaulted: false });
  });

  test('session org is used when neither body nor jwt carries one', () => {
    expect(resolveTraceOrg({ sessionOrg: 'org-sess' })).toEqual({ org: 'org-sess', defaulted: false });
  });

  test("no org anywhere stores under 'public' and says it was defaulted", () => {
    expect(resolveTraceOrg({})).toEqual({ org: 'public', defaulted: true });
    expect(resolveTraceOrg({ bodyOrg: null, jwtOrg: null, sessionOrg: null })).toEqual({ org: 'public', defaulted: true });
  });

  test('empty and non-string values are not an org, and a non-string body org is no claim', () => {
    expect(resolveTraceOrg({ bodyOrg: '', jwtOrg: '', sessionOrg: '' })).toEqual({ org: 'public', defaulted: true });
    expect(resolveTraceOrg({ bodyOrg: 42, jwtOrg: { id: 'x' }, sessionOrg: true })).toEqual({ org: 'public', defaulted: true });
    expect(resolveTraceOrg({ bodyOrg: 42, sessionOrg: 'org-sess' })).toEqual({ org: 'org-sess', defaulted: false });
  });

  test("an authenticated 'public' org is a known org, not a default", () => {
    expect(resolveTraceOrg({ jwtOrg: 'public' })).toEqual({ org: 'public', defaulted: false });
  });
});
