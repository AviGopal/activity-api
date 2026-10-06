/**
 * A TELEMETRY OR DECLINED RUN IS NEITHER CREDITED NOR BLAMED, EVEN WHEN A TASK FAILED (check-first).
 *
 * Core-loop bootstrap, credit from use (user ruling 2026-10-05).
 *
 * classifyReach marks a `telemetry:` or `declined:` tagged run UNGRADED (isReachInapplicable): it was
 * never attempting a goal, so a goal verdict does not apply to it. But applyOutcomeToPosteriors has a
 * second arm, failedByTask (be6b5cd), that charges β to an UNGRADED run when it failed with a failed
 * task or no task — added so a template whose tasks throw cannot hide behind "ungraded". That arm does
 * not exclude reach-inapplicable runs, so telemetry is blamed through it anyway.
 *
 * MEASURED (docs-session audit, node 1, 2026-10-05): auth_resolve_v1, the `telemetry:auth` emitter,
 * took beta_delta = 1 ×2,237 in 24 h on context_thompson_scores. lib/telemetry-class.ts already names
 * this as the "ungraded-failure arm … backdoor" (α 1 / β ~425k).
 *
 * Pinned (in-process, recording db; the summary carries the deltas the learner applies):
 *   MUST-FAIL: a telemetry-tagged failed run with a failed task gets β 0; same for a declined run.
 *   CONTROL: the arm be6b5cd added still fires for an ungraded goal-host run whose tasks threw (β 1),
 *   and an ungraded success is still {0,0}.
 */
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';
process.env.POSTERIOR_COALESCE = '0';
process.env.SURREALDB_URL = 'http://127.0.0.1:9';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';

import { describe, expect, test } from 'bun:test';

const { applyOutcomeToPosteriors } = await import('./posterior-update');
const db = { query: async () => [], queryAll: async () => [] } as never;

const run = (tags: string[], extra: Record<string, unknown> = {}) =>
  applyOutcomeToPosteriors({ activity_id: 'auth_resolve_v1', success: false, failure_mode: null, tags, failure_count: 1, task_count: 1, ...extra } as never, db, 'org-1');

describe('MUST-FAIL — reach-inapplicable runs are not blamed through the ungraded-failure arm', () => {
  test('a telemetry-tagged failed run with a failed task gets no β', async () => {
    const s = await run(['telemetry:auth']);
    expect({ a: s.alpha_delta, b: s.beta_delta }).toEqual({ a: 0, b: 0 });
  });

  test('a declined run with a failed task gets no β', async () => {
    const s = await run(['declined:out_of_scope']);
    expect({ a: s.alpha_delta, b: s.beta_delta }).toEqual({ a: 0, b: 0 });
  });

  test('a telemetry-tagged failed run with no tasks gets no β', async () => {
    const s = await run(['telemetry:auth'], { failure_count: 0, task_count: 0 });
    expect(s.beta_delta).toBe(0);
  });
});

describe('CONTROL — the ungraded-failure arm still blames a goal-host template whose tasks threw', () => {
  test('dispatcher_used:goal-host, failed with a failed task ⇒ β 1 (be6b5cd preserved)', async () => {
    const s = await run(['dispatcher_used:goal-host']);
    expect(s.beta_delta).toBe(1);
    expect(s.alpha_delta).toBe(0);
  });

  test('an ungraded success is neither credited nor blamed', async () => {
    const s = await applyOutcomeToPosteriors({ activity_id: 'x', success: true, failure_mode: null, tags: ['dispatcher_used:goal-host'] } as never, db, 'org-1');
    expect({ a: s.alpha_delta, b: s.beta_delta }).toEqual({ a: 0, b: 0 });
  });
});
