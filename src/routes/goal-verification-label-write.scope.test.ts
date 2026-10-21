/**
 * A LABEL NEEDS THE WRITE SCOPE, AND EVERY LABEL NAMES WHO WROTE IT.
 *
 * goal_verification_label_write is the oracle corpus's one writer. A key identity issued with
 * exactly [read] wrote a label (HTTP 200): authentication alone admitted it. These tests run the
 * REAL auth middleware (jwtAuthMiddleware) in front of the REAL impulses route, with identity's
 * answer stubbed at services/auth and SurrealDB replaced by an in-memory store that keeps only the
 * fields some migration defines on goal_verification_labels (the table is SCHEMAFULL, so an
 * undeclared field is never stored). No live database is touched.
 *   [MUST-FAIL] a [read] ApiKey, a [read] JWT session and a credential with no scopes are refused
 *               403 with nothing stored;
 *   [MUST-FAIL] a written label carries the validated principal_kind and the masked key id, and a
 *               body-supplied principal is ignored;
 *   [CONTROL]   a read,write key writes (200, one row); a [read] key still READS labels;
 *               identity unreachable or erroring is refused 503 and nothing is stored.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '../../sql/migrations');

function definedLabelFields(): Set<string> {
  const fields = new Set<string>(['id']);
  for (const f of readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith('.surql')) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    for (const m of sql.matchAll(/DEFINE FIELD (?:OVERWRITE |IF NOT EXISTS )?(\w+)\s+ON (?:TABLE )?goal_verification_labels\b/g)) {
      fields.add(m[1]!);
    }
  }
  return fields;
}

type Row = Record<string, unknown>;
const store: Row[] = [];
const sqlSeen: string[] = [];
let seq = 0;

function runSql(sql: string, params: Record<string, unknown> = {}): Row[] {
  sqlSeen.push(sql);
  const guarded = /^\s*\{\s*LET \$c = \(CREATE goal_verification_labels CONTENT/.test(sql);
  if (guarded || /^\s*CREATE goal_verification_labels CONTENT/.test(sql)) {
    const schema = definedLabelFields();
    const row: Row = { id: `goal_verification_labels:s${++seq}` };
    const start = sql.indexOf('CONTENT {') + 'CONTENT {'.length;
    const end = guarded ? sql.indexOf('})') : sql.lastIndexOf('}');
    for (const line of sql.slice(start, end).split('\n')) {
      const m = line.match(/^\s*(\w+):\s*(.+?),?\s*$/);
      if (!m) continue;
      const [, key, expr] = m as unknown as [string, string, string];
      if (!schema.has(key)) continue; // SCHEMAFULL: an undefined field is not stored
      if (/time::now\(\)/.test(expr)) { row[key] = seq; continue; }
      const ref = expr.match(/\$(\w+)/);
      if (!ref) continue;
      const v = params[ref[1]!];
      if (v === null || v === undefined) continue; // NONE
      row[key] = v;
    }
    store.push(row);
    return [row];
  }
  if (/^\s*SELECT \* FROM goal_verification_labels/.test(sql)) {
    const conds = [...sql.matchAll(/(\w+) = \$(\w+)/g)].map((m) => [m[1]!, m[2]!] as const);
    return store.filter((r) => conds.every(([f, p]) => r[f] === params[p])).slice(0, Number(params.limit ?? 20));
  }
  throw new Error('unexpected SQL in label scope test: ' + sql.slice(0, 80));
}

// identity's answer, per presented key. A key not listed is refused (not a transient failure).
type IdentityAnswer = { scopes: string[]; keyId: string } | 'unreachable' | 'throws';
const identity = new Map<string, IdentityAnswer>();
const validateApiKeyWithFallbackImpl = mock(async (apiKey: string) => {
  const a = identity.get(apiKey);
  if (a === 'unreachable') return { authenticated: false, reason: 'Network error', transient: true } as any;
  if (a === 'throws') throw new Error('connect ECONNREFUSED');
  if (!a) return { authenticated: false, reason: 'Invalid API key' } as any;
  return { authenticated: true, orgId: 'org-1', userId: 'user-1', keyId: a.keyId, scopes: a.scopes, authMethod: 'identity-vessel' } as any;
});
// The claims a Bearer JWT session carries ($auth / $token), answered by the DB session the middleware opens.
let sessionClaims: Record<string, unknown> = {};

// mock.module replaces the module for every LATER test file too, so the exports this file does
// not exercise are the real ones, not stand-ins another file would then test.
const realAuth = await import('../services/auth');
mock.module('../services/auth', () => ({
  isTransientIdentityFailure: realAuth.isTransientIdentityFailure,
  validateJwtToken: realAuth.validateJwtToken,
  generateJwtToken: async () => 'eyJ.minted.session',
  validateApiKeyViaIdentityVessel: realAuth.validateApiKeyViaIdentityVessel,
  validateApiKeyWithFallback: validateApiKeyWithFallbackImpl,
  validateBearerViaIdentity: async () => ({ authenticated: false, reason: 'not used by this test' }),
}));

mock.module('../db/surreal', () => ({
  surrealDB: { query: async (sql: string, params?: Record<string, unknown>) => runSql(sql, params) },
  queryWithAuth: async (_t: string, sql: string, params?: Record<string, unknown>) => runSql(sql, params),
  createAuthenticatedClient: async () => ({ query: async () => [sessionClaims], close: async () => {} }),
  // every real export, so the process-wide mock cannot break a later file's import
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
}));

const { jwtAuthMiddleware } = await import('../middleware/jwtAuth');
const { _resetAuthKeyCache } = await import('../middleware/auth-cache');
const impulsesRoutes = (await import('./impulses')).default;

function app(): Hono {
  const a = new Hono();
  a.use('/v2/*', async (c, next) => jwtAuthMiddleware(c, next));
  a.route('/v2/impulses', impulsesRoutes);
  return a;
}

async function resolve(authorization: string, pointer: Record<string, unknown>) {
  const res = await app().request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body: JSON.stringify({ pointer }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const LABEL = {
  type: 'goal_verification_label_write',
  goal: 'summarise the open gaps',
  activity_id: 'activity:summarise',
  verdict: 'not_achieved',
  confidence: 0.98,
  labeler: 'deterministic',
};
const creates = () => sqlSeen.filter((s) => /CREATE goal_verification_labels/.test(s));

// A JWT that is not an on-behalf-of token: the middleware validates it by opening a DB session.
const SESSION_JWT = `eyJhbGciOiJIUzUxMiJ9.${Buffer.from(JSON.stringify({ sub: 's' })).toString('base64url')}.sig`;

beforeEach(() => {
  store.length = 0;
  sqlSeen.length = 0;
  _resetAuthKeyCache();
  identity.clear();
  identity.set('read-only-key', { scopes: ['read'], keyId: 'key_READONLY1234567' });
  identity.set('read-write-key', { scopes: ['read', 'write'], keyId: 'key_RWABCDEFGHIJKLM' });
  identity.set('admin-key', { scopes: ['read', 'write', 'admin'], keyId: 'key_ADMINXYZ98765' });
  sessionClaims = {};
});

describe('goal_verification_label_write needs the write scope, validated by identity', () => {
  test('[MUST-FAIL] a [read] ApiKey is refused 403 with a named reason, and nothing is stored', async () => {
    const r = await resolve('ApiKey read-only-key', { ...LABEL, execution_id: 'exec-read-1' });
    expect(r.status).toBe(403);
    expect(r.body.success).toBe(false);
    expect(String(r.body.error)).toContain('"write" scope');
    expect(creates()).toHaveLength(0);
    expect(store).toHaveLength(0);
  });

  test('[MUST-FAIL] every labeler is refused for a [read] key, not only "human"', async () => {
    for (const labeler of ['automated', 'deterministic', 'human']) {
      const r = await resolve('ApiKey read-only-key', { ...LABEL, labeler, execution_id: `exec-read-${labeler}` });
      expect(r.status).toBe(403);
    }
    expect(creates()).toHaveLength(0);
  });

  test('[MUST-FAIL] a [read] JWT session is refused 403, and nothing is stored', async () => {
    sessionClaims = { id: 'key_SESSIONREAD0001', org_id: 'org-1', user_id: 'user-1', scopes: ['read'] };
    const r = await resolve(`Bearer ${SESSION_JWT}`, { ...LABEL, execution_id: 'exec-jwt-read' });
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('[MUST-FAIL] a credential that carries no scopes at all is refused (fail closed)', async () => {
    const minibob = Buffer.from(JSON.stringify({ instanceId: 'i-1', orgId: 'org-1', expiresAt: Date.now() + 60_000 })).toString('base64');
    const r = await resolve(`Bearer ${minibob}`, { ...LABEL, execution_id: 'exec-noscope' });
    expect(r.status).toBe(403);
    expect(creates()).toHaveLength(0);
  });

  test('[CONTROL] a read,write key writes the label: 200 and one row', async () => {
    const r = await resolve('ApiKey read-write-key', { ...LABEL, execution_id: 'exec-rw-1' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(creates()).toHaveLength(1);
    expect(store).toHaveLength(1);
    expect(store[0]!.execution_id).toBe('exec-rw-1');
  });

  test('[CONTROL] a [read] key can still READ labels', async () => {
    await resolve('ApiKey read-write-key', { ...LABEL, execution_id: 'exec-readback' });
    const r = await resolve('ApiKey read-only-key', { type: 'goal_verification_label', execution_id: 'exec-readback' });
    expect(r.status).toBe(200);
    const rows = JSON.parse(r.body.content) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('not_achieved');
  });

  test('[CONTROL] identity unreachable is refused 503 and nothing is stored or queried', async () => {
    identity.set('read-write-key', 'unreachable');
    const r = await resolve('ApiKey read-write-key', { ...LABEL, execution_id: 'exec-down' });
    expect(r.status).toBe(503);
    expect(String(r.body.error?.code)).toBe('IDENTITY_UNAVAILABLE');
    expect(sqlSeen).toHaveLength(0);
  });

  test('[CONTROL] identity erroring (the validator throws) is refused 503 and nothing is stored', async () => {
    identity.set('read-write-key', 'throws');
    const r = await resolve('ApiKey read-write-key', { ...LABEL, execution_id: 'exec-throws' });
    expect(r.status).toBe(503);
    expect(sqlSeen).toHaveLength(0);
  });

  test('[CONTROL] a key identity refuses is 401 and nothing is stored', async () => {
    const r = await resolve('ApiKey unknown-key', { ...LABEL, execution_id: 'exec-unknown' });
    expect(r.status).toBe(401);
    expect(sqlSeen).toHaveLength(0);
  });
});

describe('every label names who wrote it, from the validated caller only', () => {
  // What a forger would add to the body.
  const FORGED = { principal_kind: 'node-self', principal_key_id: 'key_FORGED00', principal_key_id_masked: 'key_FORGED00' };

  test('[MUST-FAIL] a written label carries principal_kind "key" and the key id masked to key_ + 8, and the body\'s principal is ignored', async () => {
    const r = await resolve('ApiKey read-write-key', { ...LABEL, execution_id: 'exec-who-1', ...FORGED });
    expect(r.status).toBe(200);
    const rows = JSON.parse((await resolve('ApiKey read-only-key', { type: 'goal_verification_label', execution_id: 'exec-who-1' })).body.content) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.principal_kind).toBe('key');
    expect(rows[0]!.principal_key_id).toBe('key_RWABCDEF');
    // the full key id is not stored on a non-human label
    expect(JSON.stringify(rows[0])).not.toContain('key_RWABCDEFGHIJKLM');
  });

  test('[MUST-FAIL] an admin-scoped key is stamped principal_kind "admin"', async () => {
    const r = await resolve('ApiKey admin-key', { ...LABEL, execution_id: 'exec-who-admin', ...FORGED });
    expect(r.status).toBe(200);
    expect(store).toHaveLength(1);
    expect(store[0]!.principal_kind).toBe('admin');
    expect(store[0]!.principal_key_id).toBe('key_ADMINXYZ');
  });

  test('[MUST-FAIL] a read,write JWT session is stamped principal_kind "session"', async () => {
    sessionClaims = { id: 'key_SESSIONRW000001', org_id: 'org-1', user_id: 'user-1', scopes: ['read', 'write'] };
    const r = await resolve(`Bearer ${SESSION_JWT}`, { ...LABEL, execution_id: 'exec-who-jwt' });
    expect(r.status).toBe(200);
    expect(store).toHaveLength(1);
    expect(store[0]!.principal_kind).toBe('session');
    expect(store[0]!.principal_key_id).toBe('key_SESSIONR');
  });
});
