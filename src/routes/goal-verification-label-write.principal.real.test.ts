// config.ts evaluates loadConfig() at import and THROWS without these.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

/**
 * EVERY LABEL'S WRITER PERSISTS, on a REAL SurrealDB built from the schema init-database.ts applies
 * (every migration in order, test/support/real-surreal.ts). goal_verification_labels is SCHEMAFULL:
 * a field no migration defines is dropped silently on the fleet's engine, so a writer stamp that the
 * code binds but the schema lacks would read as present in a fake store and be absent in production.
 *   [MUST-FAIL] a label written by a read,write key carries principal_kind "key" and the key id
 *               masked to key_ + 8 characters, both read back from the engine; the body's own
 *               principal_kind / principal_key_id are not what is stored.
 *   [CONTROL]   a human label from a verdict-scoped key keeps its labeled_by_principal (migration
 *               219) alongside the new fields.
 * Needs `surreal` on PATH; if it is missing the test FAILS rather than skipping.
 */

const ORG = 'organizations:label-writer-probe';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const USE = 'USE NS `activity-system` DB learning_loop;';

let rs: RealSurreal | null = null;
let client: any = null;
let startError = '';
let W: typeof import('./goal-verification-label-write') | null = null;

beforeAll(async () => {
  try {
    rs = await startRealSurreal();
    client = await rs.connectModuleClient();
    W = await import('./goal-verification-label-write');
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

describe('goal_verification_label_write on the real engine', () => {
  it('[MUST-FAIL] the writer stamp is stored on a non-human label, from the validated caller only', async () => {
    expect(startError).toBe('');
    const id = `lw-${word()}`;
    const ctx = { orgId: ORG, authType: 'apikey' as const, jwtToken: '', keyId: 'key_RWABCDEFGHIJKLM', scopes: ['read', 'write'] };
    const r = await W!.resolveGoalVerificationLabelWrite(ctx, {
      goal: 'g', execution_id: id, activity_id: 'activity:x', verdict: 'achieved', confidence: 0.98, labeler: 'deterministic',
      principal_kind: 'node-self', principal_key_id: 'key_FORGED00',
    }, exec as never);
    expect(r.status).toBe(200);
    const row = await rowFor(id);
    expect(row).toBeDefined();
    expect(row!.principal_kind).toBe('key');
    expect(row!.principal_key_id).toBe('key_RWABCDEF');
  });

  it('[CONTROL] a human label keeps labeled_by_principal next to the writer stamp', async () => {
    expect(startError).toBe('');
    const id = `lw-${word()}`;
    const ctx = { orgId: ORG, authType: 'apikey' as const, jwtToken: '', keyId: 'key_VERDICTABCDEFGH', scopes: ['read', 'write', 'verdict:human'] };
    const r = await W!.resolveGoalVerificationLabelWrite(ctx, {
      goal: 'g', execution_id: id, activity_id: 'activity:x', verdict: 'not_achieved', confidence: 0.9, labeler: 'human',
    }, exec as never);
    expect(r.status).toBe(200);
    const row = await rowFor(id);
    expect((row!.labeled_by_principal as Record<string, unknown>).key_id).toBe('key_VERDICTABCDEFGH');
  });

  it('[MUST-FAIL] the human label carries the writer stamp too', async () => {
    expect(startError).toBe('');
    const id = `lw-${word()}`;
    const ctx = { orgId: ORG, authType: 'apikey' as const, jwtToken: '', keyId: 'key_VERDICTABCDEFGH', scopes: ['read', 'write', 'verdict:human'] };
    const r = await W!.resolveGoalVerificationLabelWrite(ctx, {
      goal: 'g', execution_id: id, activity_id: 'activity:x', verdict: 'not_achieved', confidence: 0.9, labeler: 'human',
    }, exec as never);
    expect(r.status).toBe(200);
    const row = await rowFor(id);
    expect(row!.principal_kind).toBe('key');
    expect(row!.principal_key_id).toBe('key_VERDICTA');
  });
});
