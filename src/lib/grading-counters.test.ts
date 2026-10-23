/**
 * THE NOT-GRADED COUNTERS ARE READABLE WHERE METRICS ARE READ.
 *
 * A goal-path record with no reach verdict writes nothing (routes/goal-paths.ts), and a declined /reach outcome is
 * recorded ungraded or refused (routes/execution-traces.ts). Each is counted per process, but a count nothing serves
 * is invisible: a sender that stopped sending booleans would look exactly like a quiet one. GET /metrics/db now
 * carries them as `grading` (lib/grading-counters.ts).
 *
 * In-process (child bun): surrealDB.query replaced by a recorder; the goal-path route is driven directly.
 *   [MUST-FAIL] gradingCounters() exists and names goal_path_reach_ungraded, reach_declined_recorded,
 *               reach_declined_refused and reach_observe_skips.
 *   [MUST-FAIL] a goal-path record with no reached moves goal_path_reach_ungraded by exactly 1 (null too).
 *   [CONTROL]   a graded record (reached:true / reached:false) does not move it.
 *   [MUST-FAIL] GET /metrics/db (src/index.ts) returns the counters as `grading`. index.ts starts the server when
 *               imported, so this reads the handler's source: it must call gradingCounters() and return `grading`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { relative as pathRelative, join as pathJoin } from 'node:path';

const ISOLATED_ENV = 'ACTIVITY_API_ISOLATED_TEST';
const ISOLATED = process.env[ISOLATED_ENV] === import.meta.path;
if (!ISOLATED) {
  test('runs isolated in its own bun process (4 cases)', () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-4000))
      .toEqual({ exit: 0, pass: 4, fail: 0 });
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

  async function fakeQuery(sql: string): Promise<any> {
    if (/CREATE goal_execution_paths CONTENT/.test(sql)) return [{ id: 'goal_execution_paths:new' }];
    return [];
  }
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } | null = null;
  async function record(verdict: { success: boolean; reached?: boolean | null }) {
    if (!app) {
      const { surrealDB } = await import('../db/surreal');
      (surrealDB as unknown as { query: unknown }).query = fakeQuery;
      const { Hono } = await import('hono');
      const gp = (await import('../routes/goal-paths')).default;
      const h = new Hono();
      h.use('*', async (c, next) => { (c as any).set('session', { session_id: 't', org_id: 'org-counters', project_id: null, api_key: null, latest_job_id: null }); await next(); });
      h.route('/', gp);
      app = h;
    }
    const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      goal_text: 'count the grading counters for the metrics test', goal_category: 'meta',
      path_activities: ['satisfier:gapSummary'], duration_ms: 10, cost_usd: 0, ...verdict,
    }) });
    expect(res.status).toBe(200);
  }
  async function counters(): Promise<Record<string, any>> {
    const mod = (await import('./grading-counters')) as Record<string, any>;
    expect(typeof mod.gradingCounters).toBe('function');
    return await mod.gradingCounters();
  }

  describe('the not-graded counters', () => {
    test('[MUST-FAIL] gradingCounters names every counter', async () => {
      const c = await counters();
      expect(Object.keys(c).sort()).toEqual(['goal_path_reach_ungraded', 'reach_declined_recorded', 'reach_declined_refused', 'reach_observe_skips', 'since'].sort());
      expect(Object.keys(c.reach_declined_refused).sort()).toEqual(['already_graded', 'forbidden', 'not_found', 'unverified']);
    }, 30_000);

    test('[MUST-FAIL] a goal-path record with no reached moves goal_path_reach_ungraded by exactly 1', async () => {
      const before = (await counters()).goal_path_reach_ungraded;
      await record({ success: true });
      expect((await counters()).goal_path_reach_ungraded).toBe(before + 1);
      await record({ success: false, reached: null });
      expect((await counters()).goal_path_reach_ungraded).toBe(before + 2);
    }, 30_000);

    test('[CONTROL] a graded record does not move it', async () => {
      const before = (await counters()).goal_path_reach_ungraded;
      await record({ success: true, reached: true });
      await record({ success: true, reached: false });
      expect((await counters()).goal_path_reach_ungraded).toBe(before);
    }, 30_000);

    test('[MUST-FAIL] GET /metrics/db returns them as `grading`', () => {
      const p = pathJoin(import.meta.dir, '..', 'index.ts');
      const src = existsSync(p) ? readFileSync(p, 'utf8') : '';
      const start = src.indexOf("app.get('/metrics/db'");
      expect(start).toBeGreaterThan(-1);
      const handler = src.slice(start, src.indexOf('\n});', start));
      expect(handler).toContain("await import('./lib/grading-counters')");
      expect(handler).toContain('grading = await gradingCounters()');
      expect(handler).toMatch(/return c\.json\(\{[^}]*\bgrading\b[^}]*\}\)/);
    }, 30_000);
  });
}
