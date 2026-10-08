/**
 * THE UNGRADED-FAILURE ARM NEEDS TASK EVIDENCE; ABSENT IS NOT ZERO (check-first).
 *
 * classifyReach (reach-classify.ts) returns 'ungraded' for a `dispatcher_used:goal-host` outcome with no reach tag:
 * the walk is AWAITING its verdict, ungraded in BOTH directions. applyOutcomeToPosteriors then has the be6b5cd arm
 * (failedByTask) that blames an ungraded run "whose tasks threw" — read as
 * `(failure_count ?? 0) > 0 || (task_count ?? 0) === 0`. No caller supplies failure_count or task_count, so for a
 * caller that also carries no `tasks` (POST /v2/goal-paths, POST /executions) the absent count read as ZERO tasks and
 * every failed outcome was blamed, beta 1. MEASURED (node 1, 031e8a2): the leaf drops after POST /v2/goal-paths carry
 * beta_delta 1 — the "ungraded ⇒ SKIP" this route's comment promises did not hold.
 *
 * Pinned (in-process, recording db; the summary carries the deltas the learner applies):
 *   MUST-FAIL: a goal-host-tagged failed outcome with NO task evidence (no tasks, no counts) gets {0,0}.
 *   CONTROL (be6b5cd preserved): explicit failure_count 1 ⇒ beta 1; a tasks array, or tasks:null (the trace POST's
 *   "no tasks posted"), ⇒ unchanged (beta 1);
 *   an untagged failure is still self-evidencing (not-reached, beta).
 */
import { describe, expect, test } from 'bun:test';
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
  process.env.SURREALDB_NAMESPACE = 'activity-system';
  process.env.SURREALDB_DATABASE = 'learning_loop';
  process.env.POSTERIOR_COALESCE = '0';
  process.env.SURREALDB_URL = 'http://127.0.0.1:9';
  process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
  process.env.PRIOR_SEED_ENABLED = 'false';

  const { applyOutcomeToPosteriors } = await import('./posterior-update');
  const db = { query: async () => [], queryAll: async () => [] } as never;
  const GH = ['dispatcher_used:goal-host'];
  const run = (extra: Record<string, unknown>) =>
    applyOutcomeToPosteriors({ activity_id: 'gp-terminal', success: false, failure_mode: null, cost_usd: 0, tags: GH, ...extra } as never, db, 'organizations:o');

  describe('MUST-FAIL — no task evidence ⇒ an awaiting-verdict failure is not blamed', () => {
    test('goal-host-tagged, success:false, no tasks and no counts (the goal-paths call shape) ⇒ {0,0}', async () => {
      const s = await run({});
      expect({ a: s.alpha_delta, b: s.beta_delta }).toEqual({ a: 0, b: 0 });
    });
  });

  describe('CONTROL — the be6b5cd arm still blames when there IS task evidence', () => {
    test('explicit failure_count 1 ⇒ beta 1', async () => {
      const s = await run({ failure_count: 1, task_count: 1 });
      expect(s.beta_delta).toBe(1);
    });
    test('a tasks array present (the trace POST shape) ⇒ blamed as before', async () => {
      const s = await run({ tasks: [{ resolver: 'llm', status: 'failure' }] });
      expect(s.beta_delta).toBe(1);
    });
    test('tasks:null (the trace POST shape when no tasks were posted) is a real "no tasks" ⇒ blamed as before', async () => {
      const s = await run({ tasks: null });
      expect(s.beta_delta).toBe(1);
    });
    test('an untagged failure is self-evidencing (not-reached) ⇒ beta', async () => {
      const s = await run({ tags: [] });
      expect(s.beta_delta).toBeGreaterThan(0);
    });
  });
}
