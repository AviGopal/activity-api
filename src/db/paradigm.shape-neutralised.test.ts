/**
 * getShapeConditionedScores is NEUTRALISED: it must not read v_shape_conditioned_score (exit-status
 * evidence, mis-maintained by SurrealDB 2.3.3) and must return the global posteriors.
 *
 * Static on purpose: '../db/paradigm' is mock.module'd by other files in this suite, so a
 * behavioural call here would be order-dependent. The behavioural proof against a real view is
 * paradigm.shape-neutralised.scratch.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const src = readFileSync(new URL('./paradigm.ts', import.meta.url), 'utf8');
const start = src.indexOf('export async function getShapeConditionedScores(');
const body = src.slice(start, src.indexOf('\n}\n', start));

describe('getShapeConditionedScores — neutralised', () => {
  test('reads no exit-status shape view', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).not.toContain('v_shape_conditioned_score');
    expect(body).not.toMatch(/SELECT/i);
  });
  test('returns the global posteriors with an empty shape signature', () => {
    expect(body).toContain('await getActivityScores(orgId, activityIds, jwtToken, accountId)');
    expect(body).toMatch(/shape_signature:\s*\[\]/);
  });
});
