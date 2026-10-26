// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, test, expect } from 'bun:test';

/**
 * A TOKEN SESSION'S EMPTY CREATE IS REPORTED AS A PERMISSIONS REFUSAL, NOT A MISSING MIGRATION.
 *
 * Under a token session the CREATE runs under goal_verification_labels' PERMISSIONS, and a refused CREATE returns an
 * empty result with no error. The writer's field checks then read $c[0] as NONE and THROWs blaming migration 228 (a
 * person label) or 219 (a key label), which sends the reader to the wrong cause. What these tests hold:
 *   - a wrapped CREATE under a token session checks emptiness FIRST, with a message naming the table permissions and
 *     the org, bound as a parameter;
 *   - an empty result that reaches JS under a token session is a 500 with that message, never one naming 228, and a
 *     bare CREATE (no checks) gets the same refusal instead of a 200 with no id;
 *   - CONTROL: an API-key caller (root credentials, no PERMISSIONS) gets no such check and answers as before.
 * The SQL runner is a stub that records the statement and returns an empty result.
 */

const W = await import('../../src/routes/goal-verification-label-write');
const NODE = (await import('../../src/middleware/jwtAuth')).thisNode();

type Call = { sql: string; params: Record<string, unknown> };
const empty = (calls: Call[]) => async (_a: unknown, sql: string, params: Record<string, unknown>) => {
  calls.push({ sql, params });
  return [];
};

const PERSON_CTX = {
  orgId: 'org-1', userId: 'person-1', authType: 'jwt' as const, jwtToken: 'obo-db-token', scopes: ['read', 'write'],
  obo: { node: NODE, shape: 'goal_verification_label_write', actorKeyId: 'key_SURFACEABCDEFGH', callerType: 'session' },
};
const VERDICT_KEY_CTX = { orgId: 'org-1', userId: 'user-1', authType: 'apikey' as const, jwtToken: '', keyId: 'key_VERDICTABCDEFGH', scopes: ['read', 'write', 'verdict:human'] };
const label = (labeler: string) => ({ goal: 'g', execution_id: 'e-1', activity_id: 'activity:x', verdict: 'not_achieved', confidence: 0.9, labeler });

describe('goal_verification_label_write: an empty CREATE under a token session', () => {
  test('the message names the table permissions and the org, not a migration', () => {
    const m = W.gvlRefusedMessage('org-1');
    expect(m).toContain('refused by table permissions for org org-1');
    expect(m).not.toMatch(/migration/);
  });

  test('MUST-FAIL: a person label refused by PERMISSIONS is a 500 naming the permissions and org, never migration 228', async () => {
    const calls: Call[] = [];
    const r = await W.resolveGoalVerificationLabelWrite(PERSON_CTX as never, label('human'), empty(calls) as never);
    expect(r.status).toBe(500);
    const error = String((r.body as { error?: string }).error);
    expect(error).toContain('refused by table permissions for org org-1');
    expect(error).not.toMatch(/228/);
    // In the statement, the emptiness check is the first one, ahead of the 228 field check, with its message bound.
    expect(calls).toHaveLength(1);
    const sql = calls[0]!.sql;
    const guard = sql.indexOf('IF array::len($c) = 0 { THROW $gvl_refused }');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(sql.indexOf('migration 228 not applied'));
    expect(calls[0]!.params.gvl_refused).toBe(W.gvlRefusedMessage('org-1'));
  });

  test('MUST-FAIL: a bare CREATE (automated label) refused under a token session is a 500, not a 200 with no id', async () => {
    const calls: Call[] = [];
    const r = await W.resolveGoalVerificationLabelWrite(PERSON_CTX as never, label('automated'), empty(calls) as never);
    expect(calls[0]!.sql.trimStart().startsWith('CREATE goal_verification_labels')).toBe(true);
    expect(calls[0]!.params.gvl_refused).toBeUndefined();
    expect(r.status).toBe(500);
    expect(String((r.body as { error?: string }).error)).toContain('refused by table permissions for org org-1');
  });

  test('CONTROL: an API-key caller writes on root credentials, so no permissions check is added and it answers as before', async () => {
    const calls: Call[] = [];
    const r = await W.resolveGoalVerificationLabelWrite(VERDICT_KEY_CTX as never, label('human'), empty(calls) as never);
    expect(r.status).toBe(200);
    expect(calls[0]!.sql).not.toContain('array::len($c) = 0');
    expect(calls[0]!.params.gvl_refused).toBeUndefined();
  });
});
