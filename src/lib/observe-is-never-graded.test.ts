/**
 * AN OBSERVE EXECUTION IS NEVER GRADED, BY ANY READER OF THE ONE GATE (check-first).
 *
 * goal-host's observe dispatch (learning_mode "observe": a probe, a held-out measurement) tags its traces
 * learning_mode:observe; POST / and POST /reach stamp reach_observe:true on a row they recorded as observe. Before
 * this, classifyReach graded such a row on its reached:* tag like any other, so every reader of the gate learned from
 * a probe: posterior credit (applyOutcomeToPosteriors, called by the trace routes, goal-paths and activities), the
 * ribosome's extraction, the trace-aggregate failure-class counts and the shape-counter seed.
 *
 * Pinned (in-process, recording db; the summary carries the deltas the learner applies):
 *   MUST-FAIL: classifyReach answers 'ungraded' for an observe row whatever its reached:* tag says.
 *   MUST-FAIL: applyOutcomeToPosteriors moves nothing for an observe row: reached ⇒ no α; failed with a failed task
 *              (the ungraded-failure arm) ⇒ no β; a correlation tag ⇒ no decision outcome; no statement is sent.
 *   CONTROL:   the same rows without the observe tag grade exactly as before (reached ⇒ α, not-reached ⇒ β, and an
 *              ungraded goal-host run whose task threw still takes β through the ungraded-failure arm).
 */
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';
process.env.POSTERIOR_COALESCE = '0';
process.env.SURREALDB_URL = 'http://127.0.0.1:9';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
process.env.PRIOR_SEED_ENABLED = 'false';

import { describe, expect, test } from 'bun:test';
import { classifyReach, isObserveTrace, observeSkipCount } from './reach-classify';

const { applyOutcomeToPosteriors } = await import('./posterior-update');
const sent: string[] = [];
const db = { query: async (sql: string) => { sent.push(sql); return []; }, queryAll: async (sql: string) => { sent.push(sql); return []; } } as never;
const run = async (tags: string[], extra: Record<string, unknown> = {}) => {
  sent.length = 0;
  const s = await applyOutcomeToPosteriors({ activity_id: 'observe-gate-arm', execution_id: `e-${tags.join('|')}`, success: true, failure_mode: null, tags, ...extra } as never, db, 'org-1');
  return { a: s.alpha_delta, b: s.beta_delta, skipped: s.skipped_reason ?? null, statements: sent.length };
};

describe('MUST-FAIL — the one gate answers ungraded for an observe row', () => {
  test('classifyReach: learning_mode:observe or reach_observe:true wins over reached:true / reached:false', () => {
    expect(classifyReach({ success: true, tags: ['reached:true', 'learning_mode:observe'] })).toBe('ungraded');
    expect(classifyReach({ success: false, tags: ['reached:false', 'learning_mode:observe'] })).toBe('ungraded');
    expect(classifyReach({ success: true, tags: ['reached:true', 'reach_observe:true'] })).toBe('ungraded');
    expect(classifyReach({ success: false, tags: ['reach_observe:true'] })).toBe('ungraded');
    expect(isObserveTrace({ tags: ['learning_mode:learn'] })).toBe(false);
  });
  test('applyOutcomeToPosteriors: an observe row moves nothing and sends nothing, and the skip is counted', async () => {
    const before = observeSkipCount();
    expect(await run(['reached:true', 'learning_mode:observe', 'correlation:obs-c1'])).toEqual({ a: 0, b: 0, skipped: 'observe', statements: 0 });
    expect(await run(['dispatcher_used:goal-host', 'reach_observe:true'], { success: false, failure_count: 1, task_count: 1 })).toEqual({ a: 0, b: 0, skipped: 'observe', statements: 0 });
    expect(observeSkipCount()).toBe(before + 2);
  });
});

describe('CONTROL — rows without the observe tag grade as before', () => {
  test('classifyReach unchanged', () => {
    expect(classifyReach({ success: true, tags: ['reached:true', 'learning_mode:learn'] })).toBe('reached');
    expect(classifyReach({ success: true, tags: ['reached:false'] })).toBe('not-reached');
  });
  test('applyOutcomeToPosteriors: reached ⇒ α; not-reached ⇒ β; an ungraded goal-host run whose task threw ⇒ β', async () => {
    const r = await run(['reached:true', 'learning_mode:learn']);
    expect(r.a).toBeGreaterThan(0);
    expect(r.skipped).toBeNull();
    expect((await run(['reached:false'], { success: false })).b).toBeGreaterThan(0);
    expect((await run(['dispatcher_used:goal-host'], { success: false, failure_count: 1, task_count: 1 })).b).toBeGreaterThan(0);
  });
});
