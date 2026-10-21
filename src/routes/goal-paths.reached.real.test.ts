// MIGRATION 227: A GOAL PATH'S REACH VERDICT IS STORED ON THE REAL ENGINE.
//
// goal_execution_paths is SCHEMAFULL, which drops an undeclared field silently while the write still answers OK, so the
// route's `reached` write proves nothing at the SQL-text layer. Against a scratch SurrealDB built from the REAL schema
// and every migration in order (test/support/real-surreal.ts), so 227 is applied at boot:
//   [MUST-FAIL] a row created with reached:false reads back reached = false (on the parent the field is dropped: NONE).
//   [MUST-FAIL] the route's UPDATE form `reached = $reached` with $reached unbound (an absent verdict) clears the field
//               rather than failing the write, and binding true sets it again (on the parent it stays NONE).
// NONE reads back as null over the engine's HTTP SQL endpoint.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

let db: RealSurreal;
beforeAll(async () => { db = await startRealSurreal(); }, 180_000);
afterAll(async () => { await db?.stop(); });
const USE = 'USE NS `activity-system` DB learning_loop;';
const WHERE = "WHERE goal_hash = 'gh-reached' AND path_signature = 'ps-reached'";
const readReached = async (): Promise<unknown[]> => {
  const res = await db.sql(`${USE} SELECT reached FROM goal_execution_paths ${WHERE};`);
  return (res[res.length - 1].result as Array<{ reached?: unknown }>).map((r) => r.reached);
};

describe('migration 227 on the real engine', () => {
  it('[MUST-FAIL] a path row keeps the reach verdict it was written with', async () => {
    await db.sql(`${USE} CREATE goal_execution_paths CONTENT { goal_hash: 'gh-reached', org_id: 'org-reached', goal_text: 'g', goal_category: 'meta', path_activities: ['a'], path_signature: 'ps-reached', total_executions: 1, execution_count: 1, success_count: 0, successful_executions: 0, failed_executions: 1, thompson_alpha: 1.0, thompson_beta: 2.0, success_rate: 0.0, reached: false, avg_duration_ms: 1.0, avg_cost_usd: 0.0, avg_token_usage: 0, created_at: time::now(), updated_at: time::now(), last_executed_at: time::now() };`);
    expect(await readReached()).toEqual([false]);
  });

  it('[MUST-FAIL] an unbound $reached clears the field without failing the write; a bound one sets it', async () => {
    await db.sql(`${USE} UPDATE goal_execution_paths SET reached = $reached, updated_at = time::now() ${WHERE};`);
    expect(await readReached()).toEqual([null]);
    await db.sql(`${USE} LET $reached = true; UPDATE goal_execution_paths SET reached = $reached, updated_at = time::now() ${WHERE};`);
    expect(await readReached()).toEqual([true]);
  });
});
