/**
 * A SIGNED-IN PERSON'S VERDICT IS A HUMAN VERDICT, STAMPED WITH THE PERSON.
 *
 * A surface that holds only its own key signs the person in and writes the verdict with an
 * on-behalf-of token: identity validated the person's login token as the caller (callerType
 * 'session') and the surface's key as the actor, for this node and this shape. The writer read
 * every on-behalf-of caller as a federation ingress and refused it, so a person's verdict could
 * reach the corpus only as a key's. What these tests hold:
 *   - a session OBO for THIS node's goal_verification_label_write lands as human, stamped with the
 *     person (user_id, caller_type, actor key, audience) from the validated context only;
 *   - an OBO for another node, a key caller's OBO, and a session OBO without a user id are refused;
 *   - a pointer that claims to be a person does not make a key one;
 *   - controls: the verdict-scoped key path and the automated path are unchanged.
 *
 * Fixture contexts only: the auth middleware is replaced by one that sets a fixed JwtAuthContext,
 * and SurrealDB by a stub that records the statement and its bindings.
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';

type Call = { sql: string; params: Record<string, unknown> };
const calls: Call[] = [];
let seq = 0;
const record = async (sql: string, params: Record<string, unknown> = {}) => {
  calls.push({ sql, params });
  return [{ id: `goal_verification_labels:s${++seq}`, ...((params.labeled_by_principal ? { labeled_by_principal: params.labeled_by_principal } : {})) }];
};

mock.module('../db/surreal', () => ({
  surrealDB: { query: async (sql: string, params?: Record<string, unknown>) => record(sql, params) },
  queryWithAuth: async (_t: string, sql: string, params?: Record<string, unknown>) => record(sql, params),
  createAuthenticatedClient: async () => ({}),
  // every real export, so the process-wide mock cannot break a later file's import
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
}));

const impulsesRoutes = (await import('./impulses')).default;
const { thisNode } = await import('../middleware/jwtAuth');
const NODE = thisNode();

// What the OBO middleware sets for a person signed in on a surface (jwtAuth authenticateOboBearer).
const PERSON_CTX = {
  orgId: 'org-1', userId: 'person-1', role: 'member', authType: 'jwt' as const, jwtToken: 'obo-db-token',
  scopes: ['read', 'write'],
  obo: { node: NODE, shape: 'goal_verification_label_write', actorKeyId: 'key-surface', callerType: 'session' },
};
const FLEET_KEY_CTX = { orgId: 'org-1', userId: 'user-1', role: 'user', authType: 'apikey' as const, jwtToken: '', keyId: 'key-fleet', scopes: ['read', 'write'] };
const VERDICT_KEY_CTX = { ...FLEET_KEY_CTX, keyId: 'key-verdict', scopes: ['read', 'write', 'verdict:human'] };

function app(ctx: unknown): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('jwtAuth', ctx as never); await next(); });
  a.route('/v2/impulses', impulsesRoutes);
  return a;
}

async function write(ctx: unknown, pointer: Record<string, unknown>) {
  const res = await app(ctx).request('/v2/impulses/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pointer }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const HUMAN = {
  type: 'goal_verification_label_write',
  goal: 'summarise the open gaps',
  execution_id: 'walk-person-1',
  activity_id: 'activity:summarise',
  verdict: 'not_achieved',
  confidence: 0.9,
  labeler: 'human',
};
// What a forger would add: a person of its choosing.
const FORGED_PERSON = { labeled_by_principal: { user_id: 'someone', caller_type: 'session', actor_key_id: 'key-x', aud: `${NODE}/goal_verification_label_write` }, caller_type: 'session' };

const creates = () => calls.filter((c) => /CREATE goal_verification_labels/.test(c.sql));

describe('goal_verification_label_write: a signed-in person on behalf of this node is a human verdict', () => {
  test('MUST-FAIL: a session OBO for this node lands as human, stamped with the person from the validated context', async () => {
    calls.length = 0;
    const r = await write(PERSON_CTX, { ...HUMAN, ...FORGED_PERSON });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const c = creates();
    expect(c).toHaveLength(1);
    expect(c[0]!.params.labeled_by_principal).toEqual({
      user_id: 'person-1', caller_type: 'session', actor_key_id: 'key-surface',
      aud: `${NODE}/goal_verification_label_write`, auth_type: 'jwt', scopes: ['read', 'write'],
    });
    expect(c[0]!.params.principal_kind).toBe('session');
    // refuse, don't degrade: the statement THROWs (rolls back) if the person fields did not land
    expect(c[0]!.sql).toContain('$c[0].labeled_by_principal.user_id != $principal_user_id');
    expect(c[0]!.params.principal_user_id).toBe('person-1');
  });

  test('CONTROL (refusal kept): a session OBO minted for another node is refused, nothing written', async () => {
    calls.length = 0;
    const r = await write({ ...PERSON_CTX, obo: { ...PERSON_CTX.obo, node: `${NODE}-peer` } }, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('a session OBO for another shape is refused', async () => {
    calls.length = 0;
    const r = await write({ ...PERSON_CTX, obo: { ...PERSON_CTX.obo, shape: 'concept' } }, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('a key caller\'s OBO for this node is refused even with the verdict scope', async () => {
    calls.length = 0;
    const r = await write({ ...VERDICT_KEY_CTX, authType: 'jwt', obo: { ...PERSON_CTX.obo, callerType: 'api_key' } }, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('an OBO with no caller kind (identity did not say) is refused', async () => {
    calls.length = 0;
    const { callerType: _t, ...noKind } = PERSON_CTX.obo;
    const r = await write({ ...PERSON_CTX, obo: noKind }, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('a session OBO naming no user id is refused', async () => {
    calls.length = 0;
    const { userId: _u, ...noUser } = PERSON_CTX;
    const r = await write(noUser, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('a pointer claiming a person does not make a read/write key one', async () => {
    calls.length = 0;
    const r = await write(FLEET_KEY_CTX, { ...HUMAN, ...FORGED_PERSON });
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('CONTROL: a verdict-scoped key still lands with its key stamp, never a person stamp', async () => {
    calls.length = 0;
    const r = await write(VERDICT_KEY_CTX, { ...HUMAN, ...FORGED_PERSON });
    expect(r.status).toBe(200);
    const c = creates();
    expect(c).toHaveLength(1);
    expect(c[0]!.params.labeled_by_principal).toEqual({ key_id: 'key-verdict', auth_type: 'apikey', scopes: ['read', 'write', 'verdict:human'] });
    expect(c[0]!.params.principal_kind).toBe('key');
    expect(c[0]!.params.principal_user_id).toBeUndefined();
  });

  test('CONTROL: an automated label from a person OBO names no principal stamp, only who wrote it', async () => {
    calls.length = 0;
    const r = await write(PERSON_CTX, { ...HUMAN, labeler: 'automated' });
    expect(r.status).toBe(200);
    const c = creates();
    expect(c).toHaveLength(1);
    expect(c[0]!.params.labeled_by_principal).toBeUndefined();
    expect(c[0]!.sql.trimStart().startsWith('CREATE goal_verification_labels')).toBe(true);
  });
});
