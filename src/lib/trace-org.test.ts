/**
 * THE TRACE'S ORG, AND WHETHER IT WAS GUESSED (check-first).
 *
 * The trace POST handler resolved its org as `body.org_id || jwt || session || 'public'`. The trace must still be
 * stored when no org is known (execution.org_id is a required string), but every learning write keyed on that org
 * was then aimed at a guessed row. resolveTraceOrg keeps the precedence and says when the org was defaulted, so
 * the handler can store the trace and skip the learning writes.
 *
 * THE RULE PINNED HERE: body, then jwt, then session; only a non-empty string counts; otherwise
 * { org: 'public', defaulted: true }.
 */
import { describe, expect, test } from 'bun:test';
import { resolveTraceOrg } from './trace-org';

describe('resolveTraceOrg', () => {
  test('MUST-FAIL: body org wins over jwt and session, and is not defaulted', () => {
    expect(resolveTraceOrg({ bodyOrg: 'org-body', jwtOrg: 'org-jwt', sessionOrg: 'org-sess' })).toEqual({ org: 'org-body', defaulted: false });
  });

  test('MUST-FAIL: jwt org is used when the body carries none', () => {
    expect(resolveTraceOrg({ bodyOrg: undefined, jwtOrg: 'org-jwt', sessionOrg: 'org-sess' })).toEqual({ org: 'org-jwt', defaulted: false });
  });

  test('MUST-FAIL: session org is used when neither body nor jwt carries one', () => {
    expect(resolveTraceOrg({ sessionOrg: 'org-sess' })).toEqual({ org: 'org-sess', defaulted: false });
  });

  test("MUST-FAIL: no org anywhere stores under 'public' and says it was defaulted", () => {
    expect(resolveTraceOrg({})).toEqual({ org: 'public', defaulted: true });
    expect(resolveTraceOrg({ bodyOrg: null, jwtOrg: null, sessionOrg: null })).toEqual({ org: 'public', defaulted: true });
  });

  test('MUST-FAIL: empty and non-string values are not an org', () => {
    expect(resolveTraceOrg({ bodyOrg: '', jwtOrg: '', sessionOrg: '' })).toEqual({ org: 'public', defaulted: true });
    expect(resolveTraceOrg({ bodyOrg: 42, jwtOrg: { id: 'x' }, sessionOrg: true })).toEqual({ org: 'public', defaulted: true });
    expect(resolveTraceOrg({ bodyOrg: 42, sessionOrg: 'org-sess' })).toEqual({ org: 'org-sess', defaulted: false });
  });

  test("an explicitly supplied 'public' is a known org, not a default", () => {
    expect(resolveTraceOrg({ bodyOrg: 'public' })).toEqual({ org: 'public', defaulted: false });
  });
});
