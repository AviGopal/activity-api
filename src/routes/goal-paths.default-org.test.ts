/**
 * POST /v2/goal-paths MUST NOT LEARN UNDER A GUESSED ORG (check-first).
 *
 * MEASURED (node 1, 031e8a2): after the trace-poster fix, ~36/h leaf posterior deltas were still dropped under
 * org 'public' (the variant rows live under organizations:substrate); 50/56 drops immediately followed a
 * POST /v2/goal-paths. This route credited the terminal activity with `body.org_id ?? 'public'` — no JWT org, no
 * session org, no "defaulted" mark — and the delta it produced was beta 1, although its own comment says a
 * goal-host-tagged outcome is UNGRADED and skipped.
 *
 * Two defects, pinned separately:
 *   A. WRITE LEVEL (in-process, surrealDB.query replaced by a recorder, POSTERIOR_COALESCE=0 so the leaf write is
 *      the synchronous UPDATE): a failed goal path with no org writes NO leaf variant_performance_metrics delta.
 *      The positive control is the learner's own SKIPPED/APPLIED log line for the same activity, so a run where the
 *      credit call never happened cannot pass.
 *   B. CONTRACT (child `bun test` probe — it mocks ../lib/posterior-update, which must not leak into this file's
 *      process): the org handed to applyOutcomeToPosteriors is resolved like the trace POST (body, then JWT, then
 *      session), and with none it carries org_defaulted:true. CONTROL: an explicit org is passed through, unflagged.
 *      This is asserted at the contract and not at the write because, once (A) is fixed, this route produces no
 *      leaf delta for any org — the control can only be the call it makes.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { join as pathJoin, relative as pathRelative } from 'node:path';

// RUNS IN ITS OWN bun PROCESS. This file reads module-level state that other files in one `bun test` process set
// first and never reset: posterior-aggregator caches POSTERIOR_COALESCE at its first import (a file that sets it to
// '0' turns coalescing off for every later file), and the surrealDB client and logger are process-wide singletons that
// several suites mock or patch. So when this file is part of a larger run it registers ONE test that re-runs this file
// alone in a child `bun test` with a clean env, and asserts the child's counts; the real cases run only in the child,
// and set their env, patch the db and import the modules only there — nothing leaks back into the parent either.
const ISOLATED_ENV = 'ACTIVITY_API_ISOLATED_TEST';
const ISOLATED = process.env[ISOLATED_ENV] === import.meta.path;
if (!ISOLATED) {
  test('runs isolated in its own bun process (2 cases)', () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-4000))
      .toEqual({ exit: 0, pass: 2, fail: 0 });
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

  const LEAF = 'gp-default-org-terminal';
  const pathBody = (extra: Record<string, unknown> = {}) => ({
    goal_text: 'produce a report nobody tagged with an org',
    goal_category: 'meta',
    path_activities: ['gp-default-org-first', LEAF],
    success: false,
    duration_ms: 10,
    cost_usd: 0,
    ...extra,
  });

  describe('A — write level: a failed goal path with no org writes no leaf posterior delta', () => {
    test('no UPDATE variant_performance_metrics leaf write, and the learner did decide (SKIPPED) for this activity', async () => {
      const { surrealDB } = await import('../db/surreal');
      const { logger } = await import('../utils/logger');
      const writes: Array<{ org_id?: unknown; beta?: unknown }> = [];
      (surrealDB as unknown as { query: unknown }).query = async (sql: string, vars?: Record<string, unknown>) => {
        if (/UPDATE variant_performance_metrics/.test(sql) && vars && 'new_alpha' in vars) {
          writes.push({ org_id: vars.org_id, beta: vars.new_beta });
          return [{ id: 'variant_performance_metrics:x' }];
        }
        return [];
      };
      const decisions: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
      const origInfo = logger.info.bind(logger);
      (logger as unknown as { info: unknown }).info = (msg: string, ctx?: Record<string, unknown>) => {
        if (/posterior variant update (SKIPPED|APPLIED)/.test(msg) && ctx?.activity_id === LEAF) decisions.push({ msg, ctx });
        origInfo(msg, ctx);
      };
      try {
        const gp = (await import('./goal-paths')).default;
        const res = await gp.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pathBody()) });
        expect(res.status).toBe(200);
        // The credit call is fire-and-forget: wait (bounded) for its decision.
        for (let i = 0; i < 150 && decisions.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 100));
        expect(decisions.length, 'positive control: the learner never decided for this activity').toBeGreaterThan(0);
        expect(writes).toEqual([]);
        expect(decisions[0]!.msg).toContain('SKIPPED');
        expect(decisions[0]!.ctx.beta_delta).toBe(0);
      } finally {
        (logger as unknown as { info: unknown }).info = origInfo;
      }
    }, 30_000);
  });

  type Call = { orgId: string; org_defaulted?: boolean; activity_id?: string };

  /** Child `bun test` process: mocks posterior-update there, so the mock cannot leak into this file's process. */
  function contractProbe(cases: Array<{ name: string; body: Record<string, unknown>; jwtOrg?: string; sessionOrg?: string }>): Record<string, Call[]> {
    const dir = mkdtempSync(join(tmpdir(), 'gp-org-contract-'));
    try {
      const p = join(dir, 'probe.test.ts');
      const honoPath = Bun.resolveSync('hono', import.meta.dir);
      writeFileSync(p, `
        import { mock, test } from 'bun:test';
        const calls = [];
        mock.module(${JSON.stringify(join(import.meta.dir, '..', 'lib', 'posterior-update.ts'))}, () => ({
          applyOutcomeToPosteriors: async (trace, _db, orgId) => { calls.push({ orgId, org_defaulted: trace.org_defaulted, activity_id: trace.activity_id }); return {}; },
        }));
        test('probe', async () => {
          const { surrealDB } = await import(${JSON.stringify(join(import.meta.dir, '..', 'db', 'surreal.ts'))});
          surrealDB.query = async () => [];
          const { Hono } = await import(${JSON.stringify(honoPath)});
          const gp = (await import(${JSON.stringify(join(import.meta.dir, 'goal-paths.ts'))})).default;
          const CASES = JSON.parse(process.env.CASES);
          const out = {};
          for (const k of CASES) {
            const app = new Hono();
            app.use('*', async (c, next) => {
              if (k.jwtOrg) c.set('jwtAuth', { orgId: k.jwtOrg });
              if (k.sessionOrg) c.set('session', { session_id: 's', org_id: k.sessionOrg, project_id: null, api_key: null, latest_job_id: null });
              await next();
            });
            app.route('/', gp);
            calls.length = 0;
            const res = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(k.body) });
            if (res.status !== 200) throw new Error(k.name + ': status ' + res.status + ' ' + (await res.text()));
            for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
            out[k.name] = [...calls];
          }
          console.log('RESULT ' + JSON.stringify(out));
        }, 30000);
      `);
      const r = Bun.spawnSync(['bun', 'test', './probe.test.ts'], {
        cwd: dir,
        env: {
          HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '',
          SURREALDB_URL: 'http://127.0.0.1:9', SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
          SURREALDB_USERNAME: 'test', SURREALDB_PASSWORD: 'test', PRIOR_SEED_ENABLED: 'false',
          CASES: JSON.stringify(cases),
        },
        stdout: 'pipe', stderr: 'pipe', timeout: 90_000,
      });
      const all = r.stdout.toString() + '\n' + r.stderr.toString();
      const line = all.split('\n').find((l) => l.startsWith('RESULT '));
      expect(line, `probe produced no result: ${all.slice(-1500)}`).toBeDefined();
      return JSON.parse(line!.slice('RESULT '.length)) as Record<string, Call[]>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe('B — contract: the org handed to the learner is resolved like the trace POST', () => {
    test('no body/JWT/session org ⇒ org_defaulted:true; an explicit org (body, JWT or session) is passed unflagged', () => {
      const out = contractProbe([
        { name: 'none', body: pathBody() },
        { name: 'body', body: pathBody({ org_id: 'organizations:substrate' }) },
        { name: 'jwt', body: pathBody(), jwtOrg: 'organizations:jwt-org' },
        { name: 'session', body: pathBody(), sessionOrg: 'organizations:session-org' },
        { name: 'body-wins', body: pathBody({ org_id: 'organizations:body-org' }), jwtOrg: 'organizations:jwt-org' },
      ]);
      // MUST-FAIL: with no org at all the learner is told the org is a guess.
      expect(out.none).toEqual([{ orgId: 'public', org_defaulted: true, activity_id: LEAF }]);
      // CONTROL: an explicit body org is passed through and NOT flagged (its leaf delta is applied for that org).
      expect(out.body).toEqual([{ orgId: 'organizations:substrate', activity_id: LEAF }]);
      // MUST-FAIL: the JWT and session orgs were ignored, so these walks were credited under 'public'.
      expect(out.jwt).toEqual([{ orgId: 'organizations:jwt-org', activity_id: LEAF }]);
      expect(out.session).toEqual([{ orgId: 'organizations:session-org', activity_id: LEAF }]);
      // Precedence unchanged from the trace POST: body before JWT.
      expect(out['body-wins']).toEqual([{ orgId: 'organizations:body-org', activity_id: LEAF }]);
    }, 120_000);
  });
}
