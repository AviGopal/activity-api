/**
 * A GOAL PATH IS CREDITED FROM THE REACH VERDICT, NOT THE EXIT STATUS.
 *
 * POST /v2/goal-paths credited a path's successful/failed counters and thompson_alpha/beta from `success`, which is
 * the walk's exit status. Those counters feed path ranking and isProvenFailing, so a path was ranked and proven by
 * completion: a hollow completion (exited cleanly, goal not reached) earned alpha. goal-host recordGoalPath now sends
 * the dispatch's graded verdict as `reached` beside `success`; the request schema stripped it and nothing read it.
 *
 * In-process (child bun), surrealDB.query replaced by a recorder that returns an existing row only when the case
 * says so, so each case drives exactly one branch: CREATE (first run of a path) or UPDATE (a repeat run).
 *   [MUST-FAIL] success:true, reached:false credits beta, not alpha — on CREATE and on UPDATE.
 *   [MUST-FAIL] success:true with NO reached (a sender that predates the field) credits beta: absent is not a reach.
 *   [MUST-FAIL] success:false, reached:true credits alpha: the verdict decides, not the exit status.
 *   [CONTROL]   success:true, reached:true credits alpha — on CREATE and on UPDATE (as before this change).
 *   [MUST-FAIL] the verdict is persisted: both writes carry `reached` (an absent one as NONE, never NULL), migration
 *               227 declares it on the SCHEMAFULL table, and the response schema does not strip it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { relative as pathRelative, join as pathJoin } from 'node:path';

const ISOLATED_ENV = 'ACTIVITY_API_ISOLATED_TEST';
const ISOLATED = process.env[ISOLATED_ENV] === import.meta.path;
if (!ISOLATED) {
  test('runs isolated in its own bun process (7 cases)', () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-4000))
      .toEqual({ exit: 0, pass: 7, fail: 0 });
  }, 250_000);
}

if (ISOLATED) {
  process.env.SURREALDB_NAMESPACE ??= 'activity-system';
  process.env.SURREALDB_DATABASE ??= 'learning_loop';
  process.env.SURREALDB_URL = 'http://127.0.0.1:9';
  process.env.SURREALDB_USERNAME ??= 'test';
  process.env.SURREALDB_PASSWORD ??= 'test';
  process.env.POSTERIOR_COALESCE = '0';
  process.env.PRIOR_SEED_ENABLED = 'false';
  process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';

  type Write = { kind: 'CREATE' | 'UPDATE'; sql: string; vars: Record<string, any> };
  const writes: Write[] = [];
  let existing: Record<string, any> | null = null;
  async function fakeQuery(sql: string, vars: Record<string, any> = {}): Promise<any> {
    if (/CREATE goal_execution_paths CONTENT/.test(sql)) { writes.push({ kind: 'CREATE', sql, vars }); return [{ id: 'goal_execution_paths:new' }]; }
    if (/^\s*UPDATE goal_execution_paths/.test(sql)) { writes.push({ kind: 'UPDATE', sql, vars }); return [{ id: 'goal_execution_paths:old' }]; }
    if (/SELECT \* FROM goal_execution_paths/.test(sql)) return existing ? [existing] : [];
    return [];
  }

  async function record(body: Record<string, unknown>, existingRow: Record<string, any> | null): Promise<Write> {
    const { surrealDB } = await import('../db/surreal');
    (surrealDB as unknown as { query: unknown }).query = fakeQuery;
    const { Hono } = await import('hono');
    const gp = (await import('./goal-paths')).default;
    const app = new Hono();
    app.use('*', async (c, next) => { (c as any).set('session', { session_id: 't', org_id: 'org-reach', project_id: null, api_key: null, latest_job_id: null }); await next(); });
    app.route('/', gp);
    writes.length = 0;
    existing = existingRow;
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(writes.length).toBe(1);
    return writes[0]!;
  }

  const body = (verdict: { success: boolean; reached?: boolean }) => ({
    goal_text: 'summarise the open gaps for the reach-credit test', goal_category: 'meta',
    path_activities: ['satisfier:gapSummary'], duration_ms: 10, cost_usd: 0, ...verdict,
  });
  const ROW = { goal_hash: 'h', path_signature: 's', org_id: 'org-reach', total_executions: 4, successful_executions: 2, failed_executions: 2, thompson_alpha: 3, thompson_beta: 3 };
  // The credit a CREATE carries, and the deltas an UPDATE applies.
  const created = (w: Write) => ({ kind: w.kind, alpha: w.vars.thompson_alpha, beta: w.vars.thompson_beta, ok: w.vars.successful_executions, failed: w.vars.failed_executions, rate: w.vars.success_rate });
  const updated = (w: Write) => ({ kind: w.kind, success_delta: w.vars.success_delta, failure_delta: w.vars.failure_delta });

  describe('path alpha/beta follow the reach verdict', () => {
    test('[MUST-FAIL] CREATE: success:true, reached:false credits beta, not alpha', async () => {
      expect(created(await record(body({ success: true, reached: false }), null))).toEqual({ kind: 'CREATE', alpha: 1, beta: 2, ok: 0, failed: 1, rate: 0 });
    }, 30_000);

    test('[MUST-FAIL] UPDATE: success:true, reached:false credits beta, not alpha', async () => {
      expect(updated(await record(body({ success: true, reached: false }), ROW))).toEqual({ kind: 'UPDATE', success_delta: 0, failure_delta: 1 });
    }, 30_000);

    test('[MUST-FAIL] success:true with no reached is not a reach: beta on CREATE and on UPDATE', async () => {
      expect(created(await record(body({ success: true }), null))).toEqual({ kind: 'CREATE', alpha: 1, beta: 2, ok: 0, failed: 1, rate: 0 });
      expect(updated(await record(body({ success: true }), ROW))).toEqual({ kind: 'UPDATE', success_delta: 0, failure_delta: 1 });
    }, 30_000);

    test('[MUST-FAIL] success:false, reached:true credits alpha: the verdict decides, not the exit status', async () => {
      expect(created(await record(body({ success: false, reached: true }), null))).toEqual({ kind: 'CREATE', alpha: 2, beta: 1, ok: 1, failed: 0, rate: 1 });
      expect(updated(await record(body({ success: false, reached: true }), ROW))).toEqual({ kind: 'UPDATE', success_delta: 1, failure_delta: 0 });
    }, 30_000);

    test('[CONTROL] success:true, reached:true credits alpha on CREATE and on UPDATE', async () => {
      expect(created(await record(body({ success: true, reached: true }), null))).toEqual({ kind: 'CREATE', alpha: 2, beta: 1, ok: 1, failed: 0, rate: 1 });
      expect(updated(await record(body({ success: true, reached: true }), ROW))).toEqual({ kind: 'UPDATE', success_delta: 1, failure_delta: 0 });
    }, 30_000);
  });

  describe('the verdict is persisted', () => {
    test('[MUST-FAIL] both writes carry reached; an absent verdict is NONE (undefined), never NULL', async () => {
      const c = await record(body({ success: true, reached: false }), null);
      expect([/\breached: \$reached\b/.test(c.sql), c.vars.reached]).toEqual([true, false]);
      const u = await record(body({ success: false, reached: true }), ROW);
      expect([/\breached = \$reached\b/.test(u.sql), u.vars.reached]).toEqual([true, true]);
      const a = await record(body({ success: true }), ROW);
      expect(['reached' in a.vars, a.vars.reached === undefined]).toEqual([true, true]);
    }, 30_000);

    test('[MUST-FAIL] migration 227 declares reached on the SCHEMAFULL table, and the response schema keeps it', async () => {
      const migPath = pathJoin(import.meta.dir, '..', '..', 'sql', 'migrations', '227-goal-paths-reached.surql');
      const mig = existsSync(migPath) ? readFileSync(migPath, 'utf8') : '';
      expect(mig).toContain('DEFINE FIELD IF NOT EXISTS reached ON goal_execution_paths TYPE option<bool>;');
      const { GoalExecutionPathSchema } = await import('../models/schemas');
      const row = GoalExecutionPathSchema.parse({
        goal_hash: 'h', goal_text: 'g', goal_category: 'meta', path_activities: ['a'], path_signature: 's',
        total_executions: 1, success_rate: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), reached: false,
      } as never) as Record<string, unknown>;
      expect(row.reached).toBe(false);
    }, 30_000);
  });
}
