/**
 * A HUMAN VERDICT NEEDS A HUMAN-VERDICT PRINCIPAL.
 *
 * goal-host turns a labeler:"human" row into a reach override and a human_reported gap. Before this
 * check any authenticated key could write one, including goal-host's own fleet key, which a goal
 * walk uses when it resolves this shape. The operator's cockpit key and the node keys share one
 * principal (same user, org and role) and differ only in the scopes identity issued them with, so
 * the check reads the SERVER-VALIDATED scopes on the JwtAuthContext and nothing on the pointer.
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
  return [{ id: `goal_verification_labels:p${++seq}`, ...((params.labeled_by_principal ? { labeled_by_principal: params.labeled_by_principal } : {})) }];
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

// The node/vessel key and the cockpit key today: read/write, same user/org/role as the operator.
const FLEET_KEY_CTX = { orgId: 'org-1', userId: 'user-1', role: 'user', authType: 'apikey' as const, jwtToken: '', keyId: 'key-fleet', scopes: ['read', 'write'] };
const VERDICT_KEY_CTX = { ...FLEET_KEY_CTX, keyId: 'key-verdict', scopes: ['read', 'write', 'verdict:human'] };
const ADMIN_KEY_CTX = { ...FLEET_KEY_CTX, keyId: 'key-admin', scopes: ['read', 'write', 'admin'] };

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
  execution_id: 'walk-satisfier-1-1791608365322',
  activity_id: 'activity:summarise',
  verdict: 'not_achieved',
  confidence: 0.9,
  labeler: 'human',
};
// What a forger would add: a principal of its choosing.
const FORGED = { labeled_by_principal: { key_id: 'key-admin', auth_type: 'apikey', scopes: ['admin', 'verdict:human'] } };

const creates = () => calls.filter((c) => /CREATE goal_verification_labels/.test(c.sql));

describe('goal_verification_label_write: labeler "human" needs a human-verdict principal', () => {
  test('MUST-FAIL (a): a read/write-scoped node/fleet key writing labeler "human" is refused 403, and nothing is written', async () => {
    calls.length = 0;
    const r = await write(FLEET_KEY_CTX, HUMAN);
    expect(r.status).toBe(403);
    expect(r.body.success).toBe(false);
    expect(String(r.body.error)).toContain('verdict:human');
    expect(creates()).toHaveLength(0);
  });

  test('MUST-FAIL (a): a pointer-supplied principal does not elevate a read/write key', async () => {
    calls.length = 0;
    const r = await write(FLEET_KEY_CTX, { ...HUMAN, ...FORGED });
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('MUST-FAIL (a): an on-behalf-of (federated) caller is refused even with the verdict scope', async () => {
    calls.length = 0;
    const r = await write({ ...VERDICT_KEY_CTX, obo: { node: 'peer', shape: 'goal_verification_label_write' } }, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('MUST-FAIL (a): a credential with the verdict scope but no server-derived key id is refused', async () => {
    calls.length = 0;
    const { keyId: _k, ...noKey } = VERDICT_KEY_CTX;
    const r = await write(noKey, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('MUST-FAIL (b): a verdict:human-scoped key lands, stamped with the SERVER-derived principal, not the forged one', async () => {
    calls.length = 0;
    const r = await write(VERDICT_KEY_CTX, { ...HUMAN, ...FORGED });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const c = creates();
    expect(c).toHaveLength(1);
    expect(c[0]!.sql).toContain('labeled_by_principal: $labeled_by_principal');
    expect(c[0]!.params.labeled_by_principal).toEqual({ key_id: 'key-verdict', auth_type: 'apikey', scopes: ['read', 'write', 'verdict:human'] });
    // refuse, don't degrade: the statement THROWs (rolls back) if the principal did not land
    expect(c[0]!.sql).toContain('$c[0].labeled_by_principal.key_id != $principal_key_id');
    expect(c[0]!.params.principal_key_id).toBe('key-verdict');
  });

  test('MUST-FAIL (b): an admin-scoped key (interim fallback) lands, stamped with its own key id', async () => {
    calls.length = 0;
    const r = await write(ADMIN_KEY_CTX, { ...HUMAN, labeled_by_principal: { key_id: 'someone-else', scopes: ['verdict:human'] } });
    expect(r.status).toBe(200);
    const c = creates();
    expect(c).toHaveLength(1);
    expect(c[0]!.params.labeled_by_principal).toEqual({ key_id: 'key-admin', auth_type: 'apikey', scopes: ['read', 'write', 'admin'] });
  });

  test('CONTROL: automated and deterministic labels from the fleet key are written as before, with no principal named', async () => {
    for (const labeler of ['automated', 'deterministic']) {
      calls.length = 0;
      const r = await write(FLEET_KEY_CTX, { ...HUMAN, labeler, ...FORGED });
      expect(r.status).toBe(200);
      const c = creates();
      expect(c).toHaveLength(1);
      expect(c[0]!.sql).not.toContain('labeled_by_principal');
      expect(c[0]!.params.labeled_by_principal).toBeUndefined();
      // a bare CREATE, not the guarded block
      expect(c[0]!.sql.trimStart().startsWith('CREATE goal_verification_labels')).toBe(true);
    }
  });

  test('role and user id do not make an operator: an admin-ROLE JWT with read/write scopes is refused', async () => {
    calls.length = 0;
    const r = await write({ ...FLEET_KEY_CTX, authType: 'jwt', role: 'admin', jwtToken: 't' }, HUMAN);
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });
});
