// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

/**
 * A SIGNED-IN PERSON'S STAMP PERSISTS, on a REAL SurrealDB built from the schema init-database.ts
 * applies (every migration in order, test/support/real-surreal.ts). goal_verification_labels is
 * SCHEMAFULL: a labeled_by_principal subfield no migration defines is dropped silently, and the
 * writer then THROWs (rolled back) rather than store a person label without its person.
 *   [MUST-FAIL] a human label from a session OBO for this node is stored with
 *               labeled_by_principal.user_id, caller_type "session", actor_key_id and aud
 *               (migration 228), and principal_kind "session", all read back from the engine.
 *   [CONTROL]   a verdict-scoped key's human label keeps its key stamp (migration 219).
 * Needs `surreal` on PATH; if it is missing the test FAILS rather than skipping.
 */

const ORG = 'organizations:label-person-probe';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const USE = 'USE NS `activity-system` DB learning_loop;';

let rs: RealSurreal | null = null;
let client: any = null;
let startError = '';
let W: typeof import('./goal-verification-label-write') | null = null;
let NODE = '';

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    client = await rs.connectModuleClient();
    W = await import('./goal-verification-label-write');
    NODE = (await import('../middleware/jwtAuth')).thisNode();
  } catch (e) {
    startError = e instanceof Error ? e.message : String(e);
  }
}, 180_000);
afterAll(async () => { await rs?.stop(); });

const exec = (_a: unknown, sql: string, params: Record<string, unknown>) => client.query(sql, params);

async function rowFor(executionId: string): Promise<Record<string, unknown> | undefined> {
  const res = await rs!.sql(`${USE} SELECT * FROM goal_verification_labels WHERE execution_id = '${executionId}';`);
  return (res[res.length - 1].result as Array<Record<string, unknown>>)[0];
}

describe('goal_verification_label_write: a person label on the real engine', () => {
  it('[MUST-FAIL] a session OBO human label is stored with the person, not dropped or refused', async () => {
    expect(startError).toBe('');
    const id = `lp-${word()}`;
    const ctx = {
      orgId: ORG, userId: 'person-1', authType: 'jwt' as const, jwtToken: '', scopes: ['read', 'write'],
      obo: { node: NODE, shape: 'goal_verification_label_write', actorKeyId: 'key_SURFACEABCDEFGH', callerType: 'session' },
    };
    const r = await W!.resolveGoalVerificationLabelWrite(ctx, {
      goal: 'g', execution_id: id, activity_id: 'activity:x', verdict: 'not_achieved', confidence: 0.9, labeler: 'human',
    }, exec as never);
    expect(r.status).toBe(200);
    const row = await rowFor(id);
    expect(row).toBeDefined();
    const p = row!.labeled_by_principal as Record<string, unknown>;
    expect(p.user_id).toBe('person-1');
    expect(p.caller_type).toBe('session');
    expect(p.actor_key_id).toBe('key_SURFACEABCDEFGH');
    expect(p.aud).toBe(`${NODE}/goal_verification_label_write`);
    expect(row!.principal_kind).toBe('session');
  });

  it('[CONTROL] a verdict-scoped key\'s human label keeps its key stamp', async () => {
    expect(startError).toBe('');
    const id = `lp-${word()}`;
    const ctx = { orgId: ORG, authType: 'apikey' as const, jwtToken: '', keyId: 'key_VERDICTABCDEFGH', scopes: ['read', 'write', 'verdict:human'] };
    const r = await W!.resolveGoalVerificationLabelWrite(ctx, {
      goal: 'g', execution_id: id, activity_id: 'activity:x', verdict: 'not_achieved', confidence: 0.9, labeler: 'human',
    }, exec as never);
    expect(r.status).toBe(200);
    const row = await rowFor(id);
    const p = row!.labeled_by_principal as Record<string, unknown>;
    expect(p.key_id).toBe('key_VERDICTABCDEFGH');
    expect(p.caller_type).toBeUndefined();
    expect(row!.principal_kind).toBe('key');
  });
});
