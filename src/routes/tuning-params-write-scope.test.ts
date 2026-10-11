/**
 * A GATE-INPUT TUNING ROW NEEDS A POLICY-WRITE PRINCIPAL; A LEARNING ROW STAYS LIVE.
 *
 * Some substrate_tuning_param rows are gate inputs (the auto-revert guard thresholds, retirement
 * thresholds, ...: GATE_INPUT_ROWS in src/policy/gate-input-rows.ts). POST /v2/tuning-params sat
 * behind only the global /v2/* auth, so any authenticated key, a vessel's or a goal walk's service
 * key included, could rewrite them and loosen the gates that judge its own work. Writing a
 * gate-input row now needs a credential whose SERVER-VALIDATED scopes (the JwtAuthContext the auth
 * middleware set) carry "policy:write", or "admin" as the interim fallback, with a key id and no
 * on-behalf-of grant. Learning rows (TD_LAMBDA, YIELD_FLOOR: what learningPolicyWriteback authors)
 * stay writable by any authenticated key so the system keeps tuning its own learner, inside the
 * closed LEARNING_ROW_BOUNDS envelope (422 outside it, for every caller). No on-behalf-of caller
 * writes any row. Every write is attributed to the server-derived key id; nothing in the body is
 * read for any of these decisions.
 *
 * Fixture contexts only: the auth middleware is replaced by one that sets a fixed JwtAuthContext,
 * and SurrealDB by an in-memory stub that records each statement and answers the writer's read-back.
 * Only the route's default export is imported, so at the parent commit this file loads and fails
 * behaviourally (the parent writes a gate-input row for a read/write key) rather than on a missing
 * named export. The per-name check over the whole set lives in src/policy/gate-input-rows.test.ts.
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';

type Call = { sql: string; params: Record<string, unknown> };
const calls: Call[] = [];
const rows = new Map<string, Record<string, unknown>>();

async function query(sql: string, params: Record<string, unknown> = {}) {
  calls.push({ sql, params });
  const name = String(params.name ?? '');
  if (/^UPSERT substrate_tuning_param/.test(sql)) {
    const row = { name, value: params.value, updated_by: params.updated_by, evidence: params.evidence };
    rows.set(name, row);
    return [row];
  }
  if (/FROM substrate_tuning_param/.test(sql)) {
    const row = rows.get(name);
    return row ? [{ param_value: row.value }] : [];
  }
  return [];
}

mock.module('../db/surreal', () => ({
  surrealDB: { query: async (sql: string, params?: Record<string, unknown>) => query(sql, params) },
  queryWithAuth: async (_t: string, sql: string, params?: Record<string, unknown>) => query(sql, params),
  createAuthenticatedClient: async () => ({}),
  // every real export, so the process-wide mock cannot break a later file's import
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
}));

const tuningParamsRoutes = (await import('./tuning-params')).default;

// The node/vessel key and the cockpit key today: read/write, same user/org/role as the operator.
const FLEET_KEY_CTX = { orgId: 'org-1', userId: 'user-1', role: 'user', authType: 'apikey' as const, jwtToken: '', keyId: 'key-fleet', scopes: ['read', 'write'] };
const POLICY_KEY_CTX = { ...FLEET_KEY_CTX, keyId: 'key-policy', scopes: ['read', 'write', 'policy:write'] };
const ADMIN_KEY_CTX = { ...FLEET_KEY_CTX, keyId: 'key-admin', scopes: ['read', 'write', 'admin'] };

function app(ctx: unknown): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('jwtAuth', ctx as never); await next(); });
  a.route('/v2/tuning-params', tuningParamsRoutes);
  return a;
}

async function post(ctx: unknown, body: Record<string, unknown>) {
  const res = await app(ctx).request('/v2/tuning-params', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function reset() {
  calls.length = 0;
  rows.clear();
}

const upserts = () => calls.filter((c) => /^UPSERT substrate_tuning_param/.test(c.sql));

const GATE = { name: 'AUTO_REVERT_STRIKE_LIMIT', value: 99, evidence: 'loosen the guard' };
const LEARNING = { name: 'TD_LAMBDA', value: 0.72, evidence: 'reflect recommends' };
// What a self-elevating caller would add: scopes and an attribution of its choosing.
const CLAIMS = { scopes: ['policy:write', 'admin'], updated_by: 'operator', keyId: 'key-admin', key_id: 'key-admin' };

describe('POST /v2/tuning-params: gate-input rows need a policy-write principal', () => {
  test('MUST-FAIL: a read/write-scoped key writing a gate-input row is refused 403, and nothing is written', async () => {
    reset();
    const r = await post(FLEET_KEY_CTX, GATE);
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain('policy:write');
    expect(upserts()).toHaveLength(0);
    expect(rows.size).toBe(0);
  });

  test('MUST-FAIL: an on-behalf-of (federated) caller writing a gate-input row is refused even with the policy-write scope', async () => {
    reset();
    const r = await post({ ...POLICY_KEY_CTX, obo: { node: 'peer', shape: 'tuning_param' } }, GATE);
    expect(r.status).toBe(403);
    expect(upserts()).toHaveLength(0);
  });

  test('MUST-FAIL: a policy-write credential without a server-derived key id is refused on a gate-input row', async () => {
    reset();
    const { keyId: _k, ...noKey } = POLICY_KEY_CTX;
    const r = await post(noKey, GATE);
    expect(r.status).toBe(403);
    expect(upserts()).toHaveLength(0);
  });

  test('MUST-FAIL: body-claimed scopes and updated_by do not elevate a read/write key on a gate-input row', async () => {
    reset();
    const r = await post(FLEET_KEY_CTX, { ...GATE, ...CLAIMS });
    expect(r.status).toBe(403);
    expect(upserts()).toHaveLength(0);
  });

  test('MUST-FAIL: a policy:write-scoped key writing a gate-input row lands, attributed to the SERVER-derived key id, not the body claim', async () => {
    reset();
    const r = await post(POLICY_KEY_CTX, { ...GATE, ...CLAIMS });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.updated_by).toBe('key-policy');
    const u = upserts();
    expect(u).toHaveLength(1);
    expect(u[0]!.sql).toContain('updated_by = $updated_by');
    expect(u[0]!.params.updated_by).toBe('key-policy');
    expect(u[0]!.params.value).toBe(99);
    expect(rows.get('AUTO_REVERT_STRIKE_LIMIT')?.updated_by).toBe('key-policy');
  });

  test('MUST-FAIL: an admin-scoped key (interim fallback) writing a gate-input row lands, attributed to its own key id', async () => {
    reset();
    const r = await post(ADMIN_KEY_CTX, { ...GATE, updated_by: 'someone-else' });
    expect(r.status).toBe(200);
    const u = upserts();
    expect(u).toHaveLength(1);
    expect(u[0]!.params.updated_by).toBe('key-admin');
  });
});

describe('POST /v2/tuning-params: learning rows stay writable by any authenticated key, attributed server-side', () => {
  test('MUST-FAIL: a read/write key writing a learning row lands, stamped with ITS key id, not the body claim', async () => {
    reset();
    const r = await post(FLEET_KEY_CTX, { ...LEARNING, ...CLAIMS });
    expect(r.status).toBe(200);
    expect(r.body.updated_by).toBe('key-fleet');
    const u = upserts();
    expect(u).toHaveLength(1);
    expect(u[0]!.params.updated_by).toBe('key-fleet');
    expect(rows.get('TD_LAMBDA')?.updated_by).toBe('key-fleet');
  });

  test('MUST-FAIL: a credential with no server-derived key id cannot write even a learning row (nothing to attribute it to)', async () => {
    reset();
    const { keyId: _k, ...noKey } = FLEET_KEY_CTX;
    const r = await post(noKey, LEARNING);
    expect(r.status).toBe(403);
    expect(upserts()).toHaveLength(0);
  });

  test('MUST-FAIL: an on-behalf-of (federated) caller cannot write even a learning row', async () => {
    reset();
    const r = await post({ ...FLEET_KEY_CTX, obo: { node: 'peer', shape: 'tuning_param' } }, LEARNING);
    expect(r.status).toBe(403);
    expect(upserts()).toHaveLength(0);
  });

  test('MUST-FAIL: an out-of-envelope learning-row write from a read/write key is refused 422, naming the bound', async () => {
    reset();
    const r = await post(FLEET_KEY_CTX, { ...LEARNING, value: 0.99 });
    expect(r.status).toBe(422);
    expect(String(r.body.error)).toContain('TD_LAMBDA');
    expect(String(r.body.error)).toContain('[0.3, 0.95]');
    const r2 = await post(FLEET_KEY_CTX, { name: 'YIELD_FLOOR', value: -0.1 });
    expect(r2.status).toBe(422);
    expect(String(r2.body.error)).toContain('[0, 1]');
    expect(upserts()).toHaveLength(0);
  });

  test('MUST-FAIL: the envelope binds admin and policy:write too (moving it is a code change, not a write)', async () => {
    reset();
    expect((await post(ADMIN_KEY_CTX, { ...LEARNING, value: 0.2 })).status).toBe(422);
    expect((await post(POLICY_KEY_CTX, { name: 'YIELD_FLOOR', value: 1.5 })).status).toBe(422);
    expect(upserts()).toHaveLength(0);
  });

  test('MUST-FAIL: in-envelope learning-row writes from a read/write key land at both edges, stamped with its key id', async () => {
    reset();
    for (const [name, value] of [['TD_LAMBDA', 0.3], ['TD_LAMBDA', 0.95], ['YIELD_FLOOR', 0], ['YIELD_FLOOR', 1]] as const) {
      const r = await post(FLEET_KEY_CTX, { name, value });
      expect(r.status).toBe(200);
      expect(rows.get(name)?.value).toBe(value);
      expect(rows.get(name)?.updated_by).toBe('key-fleet');
    }
    expect(upserts()).toHaveLength(4);
  });

  test('POSITIVE CONTROL: learningPolicyWriteback\'s actual call shape (GET current, then POST each of its rows) succeeds with a read/write key', async () => {
    reset();
    // development-vessel src/resolvers/learning-policy-writeback.ts: CLAMPS keys, the body it sends.
    const evidence = JSON.stringify({ evidence: null, source: 'learning_policy_writeback', at: '2026-10-10T00:00:00.000Z' });
    for (const [name, value] of [['TD_LAMBDA', 0.72], ['YIELD_FLOOR', 0.05]] as const) {
      const g = await app(FLEET_KEY_CTX).request(`/v2/tuning-params/${encodeURIComponent(name)}`);
      expect(g.status).toBe(200);
      const r = await post(FLEET_KEY_CTX, { name, value, updated_by: 'learning-policy-writeback', evidence });
      expect(r.status).toBe(200);
      expect(rows.get(name)?.value).toBe(value);
      expect(rows.get(name)?.updated_by).toBe('key-fleet');
    }
    expect(upserts()).toHaveLength(2);
  });

  test('CONTROL: GET stays open to any authenticated caller, gate-input rows included', async () => {
    reset();
    rows.set('TD_LAMBDA', { name: 'TD_LAMBDA', value: 0.72 });
    rows.set('AUTO_REVERT_STRIKE_LIMIT', { name: 'AUTO_REVERT_STRIKE_LIMIT', value: 3 });
    const res = await app(FLEET_KEY_CTX).request('/v2/tuning-params/TD_LAMBDA');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'TD_LAMBDA', value: 0.72 });
    const res2 = await app(FLEET_KEY_CTX).request('/v2/tuning-params/AUTO_REVERT_STRIKE_LIMIT');
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ name: 'AUTO_REVERT_STRIKE_LIMIT', value: 3 });
  });
});
