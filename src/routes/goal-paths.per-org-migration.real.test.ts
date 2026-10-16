// MIGRATION 224 APPLIES ON THE REAL ENGINE, ALSO ON A POPULATED TABLE (A2b-proper aa-1; qa review 2026-10-16 ~18:2xZ).
//
// Against a scratch SurrealDB 2.3.10 built from the REAL schema and every migration in order (test/support/real-surreal.ts,
// which throws on any statement that is not OK), so 224 is applied at boot. Then, the unit-start case on a live store:
// legacy rows exist, and 224's statements are applied AGAIN (the index is DEFINE ... OVERWRITE), which must rebuild clean.
//   [MUST-FAIL] after 224, two orgs can hold a row for the same (goal_hash, path_signature); on the parent the old
//               UNIQUE (goal_hash, path_signature) index refuses the second org's row.
//   [CONTROL]   one org still cannot hold two rows for one (goal_hash, path_signature) (the widened key is still unique);
//               re-applying 224 over a populated table succeeds.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

let db: RealSurreal;
beforeAll(async () => { db = await startRealSurreal(); }, 180_000);
afterAll(async () => { await db?.stop(); });
const USE = 'USE NS `activity-system` DB learning_loop;';
const row = (org: string, n: number) => `CREATE goal_execution_paths CONTENT { goal_hash: 'gh-per-org', org_id: '${org}', goal_text: 'g', goal_category: 'meta', path_activities: ['a'], path_signature: 'ps-per-org', total_executions: ${n}, execution_count: ${n}, success_count: ${n}, successful_executions: ${n}, failed_executions: 0, thompson_alpha: 1.0, thompson_beta: 1.0, success_rate: 1.0, avg_duration_ms: 1.0, avg_cost_usd: 0.0, avg_token_usage: 0, created_at: time::now(), updated_at: time::now(), last_executed_at: time::now() };`;
const tryCreate = async (org: string, n: number): Promise<boolean> => { try { await db.sql(`${USE} ${row(org, n)}`); return true; } catch (e) { console.log(`CREATE-ERR ${org} ${n}: ${(e as Error).message}`); return false; } };

describe('migration 224 on the real engine', () => {
  it('[MUST-FAIL] two orgs can hold the same goal path; one org cannot hold it twice', async () => {
    expect(await tryCreate('org-a', 1)).toBe(true);
    expect(await tryCreate('org-b', 1)).toBe(true);
    expect(await tryCreate('org-a', 2)).toBe(false);
  });

  it('[CONTROL] re-applying 224 over a populated table rebuilds clean, and the rows survive', async () => {
    const m = readFileSync(join(import.meta.dir, '..', '..', 'sql', 'migrations', '224-goal-paths-per-org.surql'), 'utf8');
    await db.sql(`${USE} ${m}`);
    const res = await db.sql(`${USE} SELECT org_id FROM goal_execution_paths WHERE goal_hash = 'gh-per-org' ORDER BY org_id;`);
    expect((res[res.length - 1].result as Array<{ org_id: string }>).map((r) => r.org_id)).toEqual(['org-a', 'org-b']);
  });
});
