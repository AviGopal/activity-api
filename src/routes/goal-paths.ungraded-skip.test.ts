/**
 * A GOAL-PATH RECORD WITH NO REACH VERDICT IS UNGRADED: IT WRITES NOTHING (REALIGNMENT §2.2: credit only on a graded
 * verdict).
 *
 * POST /v2/goal-paths credits a path's counters and thompson_alpha/beta from the `reached` verdict the body carries
 * (goal-host recordGoalPath sends it beside `success`). A body with no `reached` was charged beta, so a path was blamed
 * for the absence of a verdict, and isProvenFailing (execs >= 3, zero successes) and path ranking read that as failure.
 * Now a record with no verdict is not written at all: no counter, no posterior, no row created.
 *
 * In-process (child bun), surrealDB.query replaced by a recorder; each case drives either the CREATE branch (no row)
 * or the UPDATE branch (an existing row).
 *   [MUST-FAIL] success:true, no reached ⇒ no CREATE (no row) and no UPDATE (existing row); the response says
 *               skipped:'reach_ungraded'; one 'goal-path posterior SKIPPED' line per record, reason reach_ungraded.
 *   [MUST-FAIL] success:false, no reached ⇒ nothing written either: an exit status charges no beta.
 *   [MUST-FAIL] reached:null ⇒ nothing written (null is no verdict).
 *   [CONTROL]   reached:false ⇒ one write charging beta; reached:true ⇒ one write crediting alpha; neither is skipped.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { relative as pathRelative, join as pathJoin } from 'node:path';

const ISOLATED_ENV = 'ACTIVITY_API_ISOLATED_TEST';
const ISOLATED = process.env[ISOLATED_ENV] === import.meta.path;
if (!ISOLATED) {
  test('runs isolated in its own bun process (5 cases)', () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-4000))
      .toEqual({ exit: 0, pass: 5, fail: 0 });
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

  type Write = { kind: 'CREATE' | 'UPDATE'; vars: Record<string, any> };
  const writes: Write[] = [];
  const skipped: Array<Record<string, unknown>> = [];
  let existing: Record<string, any> | null = null;
  async function fakeQuery(sql: string, vars: Record<string, any> = {}): Promise<any> {
    if (/CREATE goal_execution_paths CONTENT/.test(sql)) { writes.push({ kind: 'CREATE', vars }); return [{ id: 'goal_execution_paths:new' }]; }
    if (/^\s*UPDATE goal_execution_paths/.test(sql)) { writes.push({ kind: 'UPDATE', vars }); return [{ id: 'goal_execution_paths:old' }]; }
    if (/SELECT \* FROM goal_execution_paths/.test(sql)) return existing ? [existing] : [];
    return [];
  }
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } | null = null;
  async function setup() {
    if (app) return app;
    const { surrealDB } = await import('../db/surreal');
    (surrealDB as unknown as { query: unknown }).query = fakeQuery;
    const { logger } = await import('../utils/logger');
    const orig = logger.info.bind(logger);
    spyOn(logger, 'info').mockImplementation(((msg: string, meta?: Record<string, unknown>) => {
      if (msg === 'goal-path posterior SKIPPED') skipped.push(meta ?? {});
      return orig(msg, meta as never);
    }) as never);
    const { Hono } = await import('hono');
    const gp = (await import('./goal-paths')).default;
    const h = new Hono();
    h.use('*', async (c, next) => { (c as any).set('session', { session_id: 't', org_id: 'org-ungraded', project_id: null, api_key: null, latest_job_id: null }); await next(); });
    h.route('/', gp);
    app = h;
    return h;
  }

  async function record(verdict: { success: boolean; reached?: boolean | null }, existingRow: Record<string, any> | null) {
    const h = await setup();
    writes.length = 0;
    skipped.length = 0;
    existing = existingRow;
    const res = await h.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      goal_text: 'list the open gaps for the ungraded-skip test', goal_category: 'meta',
      path_activities: ['satisfier:gapSummary'], duration_ms: 10, cost_usd: 0, ...verdict,
    }) });
    expect(res.status).toBe(200);
    return { body: (await res.json()) as Record<string, any>, writes: writes.slice(), skipped: skipped.slice() };
  }
  const ROW = { goal_hash: 'h', path_signature: 's', org_id: 'org-ungraded', total_executions: 4, successful_executions: 2, failed_executions: 2, thompson_alpha: 3, thompson_beta: 3 };

  describe('a record with no reach verdict writes nothing', () => {
    test('[MUST-FAIL] success:true, no reached: no row created, no row updated, skipped reach_ungraded', async () => {
      const c = await record({ success: true }, null);
      expect(c.writes).toEqual([]);
      expect(c.body).toMatchObject({ success: true, skipped: 'reach_ungraded' });
      expect(c.body.path).toBeNull();
      expect(c.skipped.map((m) => [m.reason, m.row])).toEqual([['reach_ungraded', 'none']]);
      const u = await record({ success: true }, ROW);
      expect(u.writes).toEqual([]);
      expect(u.body).toMatchObject({ success: true, skipped: 'reach_ungraded', path: ROW });
      expect(u.skipped.map((m) => [m.reason, m.row])).toEqual([['reach_ungraded', 'existing']]);
    }, 30_000);

    test('[MUST-FAIL] success:false, no reached: no beta, nothing written', async () => {
      expect((await record({ success: false }, null)).writes).toEqual([]);
      expect((await record({ success: false }, ROW)).writes).toEqual([]);
    }, 30_000);

    test('[MUST-FAIL] reached:null is no verdict: nothing written', async () => {
      expect((await record({ success: true, reached: null }, null)).writes).toEqual([]);
      expect((await record({ success: false, reached: null }, ROW)).writes).toEqual([]);
    }, 30_000);
  });

  describe('a graded record is credited as before', () => {
    test('[CONTROL] reached:false charges beta (CREATE and UPDATE), not skipped', async () => {
      const c = await record({ success: true, reached: false }, null);
      expect(c.writes.map((w) => [w.kind, w.vars.thompson_alpha, w.vars.thompson_beta])).toEqual([['CREATE', 1, 2]]);
      expect('skipped' in c.body).toBe(false);
      const u = await record({ success: true, reached: false }, ROW);
      expect(u.writes.map((w) => [w.kind, w.vars.success_delta, w.vars.failure_delta])).toEqual([['UPDATE', 0, 1]]);
      expect(u.skipped).toEqual([]);
    }, 30_000);

    test('[CONTROL] reached:true credits alpha (CREATE and UPDATE), not skipped', async () => {
      const c = await record({ success: false, reached: true }, null);
      expect(c.writes.map((w) => [w.kind, w.vars.thompson_alpha, w.vars.thompson_beta])).toEqual([['CREATE', 2, 1]]);
      const u = await record({ success: true, reached: true }, ROW);
      expect(u.writes.map((w) => [w.kind, w.vars.success_delta, w.vars.failure_delta])).toEqual([['UPDATE', 1, 0]]);
      expect('skipped' in u.body).toBe(false);
    }, 30_000);
  });
}
