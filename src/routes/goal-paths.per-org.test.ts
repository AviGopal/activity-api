/**
 * GOAL PATHS ARE PER ORG (A2b-proper aa-1; user ruling 2026-10-16T17:53:17Z "Build it as part of A2b").
 *
 * A goal_execution_paths row was keyed by (goal_hash, path_signature): the POST's lookup and UPDATE carried no org, so
 * org B's run of a path incremented org A's row, and the GET returned every org's rows through the shared client. goal-
 * host's target selection reads these counters, so one org's outcomes would steer another org's target choice.
 * The system did not detect this class; it was found reading the store for A2b-proper (the filed gap is the class need).
 *
 * In-process, surrealDB.query replaced by a FAKE path store that applies an org filter ONLY when the query carries one,
 * so the parent's org-less lookup/update collapses two orgs onto one row and the case is red there.
 *   [MUST-FAIL] org A and org B record the same goal and path -> two rows, each with its own counters (org-scoped ones too).
 *   [MUST-FAIL] a GET as org A returns only org A's rows, and a caller-supplied org_id cannot widen it.
 *   [CONTROL]   the same org recording twice updates its one row; a fresh row's org-scoped counters equal its first run.
 * The org is the CALLER'S (the session's here, the JWT's in production), never the body's: the POST used to take a
 * body org_id first, so any authenticated caller could write another org's counters by naming it.
 *   [MUST-FAIL] an org-A caller posting body org_id org-B is refused 403 and creates or changes no org-B row.
 *   [CONTROL]   an org-A caller posting no body org records under org A.
 */
import { describe, expect, test } from 'bun:test';
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

  type Row = Record<string, any>;
  const store: Row[] = [];
  const matches = (sql: string, v: Record<string, any>, r: Row): boolean =>
    r.goal_hash === v.goal_hash &&
    (!/path_signature = \$path_signature/.test(sql) || r.path_signature === v.path_signature) &&
    (!/org_id = \$org_id/.test(sql) || r.org_id === v.org_id) &&
    (!/org_id = \$caller_org/.test(sql) || r.org_id === v.caller_org);
  async function fakeQuery(sql: string, v: Record<string, any> = {}): Promise<any> {
    if (/CREATE goal_execution_paths CONTENT/.test(sql)) {
      const row: Row = { id: `goal_execution_paths:${store.length + 1}`, goal_hash: v.goal_hash, org_id: v.org_id, goal_text: v.goal_text, goal_category: v.goal_category,
        path_activities: v.path_activities, path_signature: v.path_signature, endpoint_output_shapes: v.endpoint_output_shapes ?? [], expected_output_shapes: v.expected_output_shapes ?? undefined,
        total_executions: 1, execution_count: 1, successful_executions: v.successful_executions, failed_executions: v.failed_executions,
        ...(/org_successful_executions/.test(sql) ? { org_successful_executions: v.successful_executions, org_failed_executions: v.failed_executions } : {}),
        thompson_alpha: v.thompson_alpha, thompson_beta: v.thompson_beta, success_rate: v.success_rate, avg_duration_ms: v.avg_duration_ms, avg_cost_usd: v.avg_cost_usd,
        avg_token_usage: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_executed_at: new Date().toISOString() };
      store.push(row); return [row];
    }
    if (/^\s*UPDATE goal_execution_paths/.test(sql)) {
      const hit = store.filter((r) => matches(sql, v, r));
      for (const r of hit) {
        r.total_executions += 1; r.successful_executions += v.success_delta; r.failed_executions += v.failure_delta;
        if (/org_successful_executions/.test(sql)) { r.org_successful_executions = (r.org_successful_executions ?? 0) + v.success_delta; r.org_failed_executions = (r.org_failed_executions ?? 0) + v.failure_delta; }
      }
      return hit;
    }
    if (/SELECT count\(\) AS total FROM goal_execution_paths/.test(sql)) return [{ total: store.filter((r) => matches(sql, v, r)).length }];
    if (/SELECT \* FROM goal_execution_paths/.test(sql)) return store.filter((r) => matches(sql, v, r));
    return [];
  }
  const body = (org: string, success: boolean) => ({ goal_text: 'count the ts files under repos/x/src', goal_category: 'meta', path_activities: ['satisfier:shellResult'], success, reached: success, duration_ms: 10, cost_usd: 0, expected_output_shapes: ['shellResult'], org_id: org });

  async function appAs(sessionOrg: string | null) {
    const { surrealDB } = await import('../db/surreal');
    (surrealDB as unknown as { query: unknown }).query = fakeQuery;
    const { Hono } = await import('hono');
    const gp = (await import('./goal-paths')).default;
    const app = new Hono();
    app.use('*', async (c, next) => { (c as any).set('session', { session_id: 't', org_id: sessionOrg, project_id: null, api_key: null, latest_job_id: null }); await next(); });
    app.route('/', gp);
    return app;
  }
  const post = async (app: any, b: Record<string, unknown>) => app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

  describe('goal paths are per org', () => {
    test('[MUST-FAIL] two orgs recording the same goal and path get two rows with their own counters', async () => {
      store.length = 0;
      expect((await post(await appAs('org-a'), body('org-a', true))).status).toBeLessThan(300);
      expect((await post(await appAs('org-b'), body('org-b', false))).status).toBeLessThan(300);
      expect(store.length).toBe(2);
      const a = store.find((r) => r.org_id === 'org-a')!; const b = store.find((r) => r.org_id === 'org-b')!;
      expect([a.successful_executions, a.failed_executions, a.org_successful_executions, a.org_failed_executions]).toEqual([1, 0, 1, 0]);
      expect([b.successful_executions, b.failed_executions, b.org_successful_executions, b.org_failed_executions]).toEqual([0, 1, 0, 1]);
    });

    test('[MUST-FAIL] a GET as org A returns only org A rows; a caller-supplied org_id cannot widen it', async () => {
      const app = await appAs('org-a');
      for (const q of ['', '&org_id=org-b']) {
        const r = await app.request(`/?goal_text=${encodeURIComponent('count the ts files under repos/x/src')}&limit=50${q}`);
        expect(r.status).toBe(200);
        const j: any = await r.json();
        // org_id is not in the response schema; org A's row is the one with org A's counters (1 reached, 0 failed).
        expect(j.paths.length).toBe(1);
        expect([j.paths[0].org_successful_executions, j.paths[0].org_failed_executions]).toEqual([1, 0]);
      }
    });

    test('[CONTROL] the same org recording again updates its own row only', async () => {
      const app = await appAs('org-a');
      expect((await post(app, body('org-a', true))).status).toBeLessThan(300);
      expect(store.length).toBe(2);
      const a = store.find((r) => r.org_id === 'org-a')!;
      expect([a.total_executions, a.org_successful_executions]).toEqual([2, 2]);
      expect(store.find((r) => r.org_id === 'org-b')!.total_executions).toBe(1);
    });

    test('[MUST-FAIL] an org-A caller naming org B in the body is refused and writes no org-B row', async () => {
      const r = await post(await appAs('org-a'), body('org-b', true));
      // The landing first: the defect is the org-B counter moving, the 403 is how the fix answers.
      expect(store.length).toBe(2);
      const b = store.find((r) => r.org_id === 'org-b')!;
      expect([b.total_executions, b.successful_executions, b.org_successful_executions]).toEqual([1, 0, 0]);
      expect(store.find((r) => r.org_id === 'org-a')!.total_executions).toBe(2);
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error?: { code?: string } }).error?.code).toBe('ORG_MISMATCH');
    });

    test('[CONTROL] an org-A caller with no body org records under org A', async () => {
      const { org_id: _drop, ...noOrg } = body('org-a', true);
      const before = { a: store.find((r) => r.org_id === 'org-a')!.total_executions, b: store.find((r) => r.org_id === 'org-b')!.total_executions };
      expect((await post(await appAs('org-a'), noOrg)).status).toBeLessThan(300);
      expect(store.length).toBe(2);
      expect(store.find((r) => r.org_id === 'org-a')!.total_executions).toBe(before.a + 1);
      expect(store.find((r) => r.org_id === 'org-b')!.total_executions).toBe(before.b);
    });
  });
}
