// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Surreal } from 'surrealdb';
import * as jose from 'jose';
import { startRealSurreal, NS, DB, type RealSurreal } from '../support/real-surreal';

/**
 * A PERSON'S LABEL WRITTEN THROUGH A TOKEN SESSION LANDS, on a REAL SurrealDB built from every migration
 * (test/support/real-surreal.ts), with the CREATE run on a session AUTHENTICATED BY A DATABASE TOKEN, so the table's
 * PERMISSIONS are evaluated. The other real-engine label tests write on root credentials, where PERMISSIONS never run.
 *
 * The token carries the org as identity signs it, "organizations:<slug>". The writer binds the row's org_id from the
 * validated context, which strips the prefix (jwtAuth contextFromSessionClaims), so the row says "<slug>". Migration
 * 101's `FOR create WHERE org_id = $token.org_id` compared the two forms with plain equality and refused the write;
 * migration 229 accepts either form.
 *   [MUST-FAIL] a session OBO human label with a prefixed $token.org_id and an unprefixed row org_id is stored with
 *               the person's stamp.
 *   [CONTROL]   a token session for one org cannot write a row for another org (different slug): refused, nothing stored.
 *   [CONTROL]   a token whose org_id is already unprefixed still writes (the form 101 accepted).
 * Writes only. Reads are NOT checked here because FOR select does not scope them: a database token with no `id` claim
 * authenticates as a system user with the default Viewer role, and on SurrealDB 2.3.10 a Viewer reads every row of the
 * table whatever its PERMISSIONS say (measured while writing this file), while a CREATE, which a Viewer has no role
 * for, falls through to the table's FOR create clause.
 * Needs `surreal` on PATH; if it is missing the test FAILS rather than skipping.
 */

const word = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const SLUG = `label-token-${word()}`;
const OTHER_SLUG = `label-token-other-${word()}`;
const USE = 'USE NS `activity-system` DB learning_loop;';
// A test-only signing key: the access is redefined below with the same definition migration 112 gives it.
const KEY = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

let rs: RealSurreal | null = null;
let startError = '';
let W: typeof import('../../src/routes/goal-verification-label-write') | null = null;
let NODE = '';

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    await rs.sql(`${USE} DEFINE ACCESS OVERWRITE apikey_token ON DATABASE TYPE JWT ALGORITHM HS512 KEY '${KEY}' DURATION FOR TOKEN 15m, FOR SESSION 1h;`);
    W = await import('../../src/routes/goal-verification-label-write');
    NODE = (await import('../../src/middleware/jwtAuth')).thisNode();
  } catch (e) {
    startError = e instanceof Error ? e.message : String(e);
  }
}, 180_000);
afterAll(async () => { await rs?.stop(); });

/** A database token with the claims src/services/auth.ts and identity's on-behalf-of DB token carry (no `id`). */
async function dbToken(orgClaim: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new jose.SignJWT({
    NS, DB, AC: 'apikey_token', org_id: orgClaim, user_id: 'users:person-1', caller_type: 'session', scopes: ['read', 'write'], project_ids: [],
  })
    .setProtectedHeader({ alg: 'HS512' })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(KEY));
}

/** What queryWithAuth does on its legacy path (createAuthenticatedClient): connect, use, authenticate with the token, query. */
async function asToken(token: string, sql: string, params: Record<string, unknown>): Promise<any[]> {
  const db = new Surreal();
  try {
    await db.connect(rs!.url.replace(/^http/, 'ws') + '/rpc');
    await db.use({ namespace: NS, database: DB });
    await db.authenticate(token);
    const r = await db.query(sql, params);
    return (Array.isArray(r) && r.length > 0 ? r[0] : []) as any[];
  } finally {
    try { await db.close(); } catch { /* ignore */ }
  }
}

/** executeAsAuth's routing: a jwt context runs on its token, never on root. */
const exec = (auth: { authType: string; jwtToken: string }, sql: string, params: Record<string, unknown>) => {
  if (auth.authType !== 'jwt') throw new Error('this file writes only through token sessions');
  return asToken(auth.jwtToken, sql, params);
};

async function rootRows(executionId: string): Promise<Array<Record<string, unknown>>> {
  const res = await rs!.sql(`${USE} SELECT * FROM goal_verification_labels WHERE execution_id = '${executionId}';`);
  return res[res.length - 1].result as Array<Record<string, unknown>>;
}

/** The context the OBO middleware sets for a person signed in on a surface: orgId stripped of its prefix. */
function personCtx(orgId: string, jwtToken: string) {
  return {
    orgId, userId: 'person-1', authType: 'jwt' as const, jwtToken, scopes: ['read', 'write'],
    obo: { node: NODE, shape: 'goal_verification_label_write', actorKeyId: 'key_SURFACEABCDEFGH', callerType: 'session' },
  };
}

const label = (execution_id: string) => ({
  goal: 'g', execution_id, activity_id: 'activity:x', verdict: 'not_achieved', confidence: 0.9, labeler: 'human',
});

describe('goal_verification_label_write: a person label through a token session on the real engine', () => {
  it('[MUST-FAIL] a prefixed $token.org_id writes a row whose org_id is unprefixed', async () => {
    expect(startError).toBe('');
    const id = `lt-${word()}`;
    const token = await dbToken(`organizations:${SLUG}`);
    const r = await W!.resolveGoalVerificationLabelWrite(personCtx(SLUG, token), label(id), exec as never);
    expect((r.body as { error?: string }).error).toBeUndefined();
    expect(r.status).toBe(200);
    const rows = await rootRows(id);
    expect(rows.length).toBe(1);
    expect(rows[0].org_id).toBe(SLUG);
    const p = rows[0].labeled_by_principal as Record<string, unknown>;
    expect(p.user_id).toBe('person-1');
    expect(p.caller_type).toBe('session');
  });

  it('[CONTROL] a token session for another org cannot write a row for this org, and nothing is stored', async () => {
    expect(startError).toBe('');
    const id = `lt-${word()}`;
    const token = await dbToken(`organizations:${OTHER_SLUG}`);
    const r = await W!.resolveGoalVerificationLabelWrite(personCtx(SLUG, token), label(id), exec as never);
    expect(r.status).toBe(500);
    expect(await rootRows(id)).toEqual([]);
  });

  it('[CONTROL] a token whose org_id is unprefixed still writes', async () => {
    expect(startError).toBe('');
    const id = `lt-${word()}`;
    const token = await dbToken(SLUG);
    const r = await W!.resolveGoalVerificationLabelWrite(personCtx(SLUG, token), label(id), exec as never);
    expect(r.status).toBe(200);
    expect((await rootRows(id)).length).toBe(1);
  });
});
