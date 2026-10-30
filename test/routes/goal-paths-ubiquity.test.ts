/**
 * The shape-signature arm must not borrow a pathway on a shape nearly every goal targets.
 *
 * Measured 2026-10-30: targets [llm_completion_dispatch, human_surface:ui_view] borrowed a one-step
 * [satisfier:llm_completion_dispatch] donor (12/12) at cover 0.50, because llm_completion_dispatch is
 * in nearly every walk's inferred targets; an unrelated goal borrowed the same donor minutes later.
 * A shape whose share of recent target sets (goal_execution_paths.expected_output_shapes) is at or
 * over the shaped threshold no longer counts toward cover.
 *
 * Must-fail: the R2-shaped request no longer returns that donor. Controls: a path covering a
 * non-ubiquitous target (memoryNote_write) still matches; an exact goal_hash reuse is untouched and
 * never reads the share; a failed share read is fail-open (today's cover).
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';

type Handler = (sql: string, params?: Record<string, unknown>) => unknown;
const queryLog: string[] = [];
let handler: Handler = () => [];

mock.module('../../src/db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params?: Record<string, unknown>) => {
      queryLog.push(sql);
      return handler(sql, params);
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
}));

const goalPathsApp = (await import('../../src/routes/goal-paths')).default;
const { _resetUbiquityCache, measureTargetShare, ubiquitousAmong } = await import('../../src/lib/ubiquitous-shapes');

const LLM = 'llm_completion_dispatch';

/** 200 recent target sets: every one names the llm shape, 30% memoryNote_write, 5% the ui view. */
function recentTargetSets(): Array<{ expected_output_shapes: string[]; updated_at: string }> {
  return Array.from({ length: 200 }, (_, i) => ({
    expected_output_shapes: [LLM, ...(i % 10 < 3 ? ['memoryNote_write'] : []), ...(i % 20 === 0 ? ['human_surface:ui_view'] : [])],
    updated_at: new Date(Date.UTC(2026, 9, 30, 0, 0, i)).toISOString(),
  }));
}

function row(goal_hash: string, path_activities: string[], endpoint: string[], succ: number, total: number) {
  return {
    goal_hash, path_activities, endpoint_output_shapes: endpoint, path_signature: `sig-${goal_hash}`,
    successful_executions: succ, total_executions: total, thompson_alpha: succ + 1, thompson_beta: total - succ + 1,
    success_rate: total ? succ / total : 0,
  };
}

const llmDonor = row('donor-llm', [`satisfier:${LLM}`], [LLM], 12, 12);
const noteDonor = row('donor-note', ['satisfier:shellResult', `satisfier:${LLM}`, 'satisfier:memoryNote_write'], ['shellResult', LLM, 'memoryNote_write', 'memoryNote'], 1, 1);

function serve(o: { exact?: unknown[]; donors?: unknown[]; recent?: () => unknown }) {
  handler = (sql) => {
    if (sql.includes('expected_output_shapes, updated_at')) return (o.recent ?? recentTargetSets)();
    if (sql.includes('CONTAINSANY $target_shapes')) return o.donors ?? [];
    if (sql.includes('FROM goal_execution_paths') && sql.includes('goal_hash = $goal_hash')) return o.exact ?? [];
    return [];
  };
}

async function recommend(target_shapes: string[]): Promise<Array<Record<string, unknown>>> {
  const res = await goalPathsApp.request('/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal_text: 'ubiquity fixture goal', target_shapes, exploration_rate: 0, top_k: 5, seed: 7 }),
  });
  expect(res.status).toBe(200);
  const j = (await res.json()) as { recommended_paths?: Array<Record<string, unknown>> };
  return j.recommended_paths ?? [];
}

beforeEach(() => { queryLog.length = 0; handler = () => []; _resetUbiquityCache(); });

describe('shape-signature cover leaves out ubiquitous target shapes', () => {
  test('MUST-FAIL: targets [llm, ui_view] no longer borrow a one-step llm pathway at cover 0.50', async () => {
    serve({ donors: [llmDonor] });
    const recs = await recommend([LLM, 'human_surface:ui_view']);
    expect(recs.filter((r) => r['goal_hash'] === 'donor-llm')).toEqual([]);
  });

  test('CONTROL: targets [llm, memoryNote_write] still match a path covering memoryNote_write', async () => {
    serve({ donors: [noteDonor, llmDonor] });
    const recs = await recommend([LLM, 'memoryNote_write']);
    const hit = recs.find((r) => r['goal_hash'] === 'donor-note');
    expect(hit).toBeDefined();
    expect(hit!['match_mode']).toBe('shape_signature');
    expect(Number(hit!['shape_cover'])).toBeGreaterThanOrEqual(0.5);
    expect(recs.some((r) => r['goal_hash'] === 'donor-llm')).toBe(false);
  });

  test('CONTROL: an exact goal_hash reuse is unchanged and never reads the share', async () => {
    serve({ exact: [row('exact-own', [`satisfier:${LLM}`], [LLM], 24, 25)], donors: [llmDonor] });
    const recs = await recommend([LLM, 'human_surface:ui_view']);
    expect(recs.length).toBe(1);
    expect(recs[0]!['goal_hash']).toBe('exact-own');
    expect(recs[0]!['match_mode']).toBe('goal_hash');
    expect(queryLog.some((q) => q.includes('expected_output_shapes, updated_at'))).toBe(false);
  });

  test('CONTROL: a failed share read is fail-open (cover as before: the llm donor at 0.50)', async () => {
    serve({ donors: [llmDonor], recent: () => { throw new Error('store unavailable'); } });
    const recs = await recommend([LLM, 'human_surface:ui_view']);
    const hit = recs.find((r) => r['goal_hash'] === 'donor-llm');
    expect(hit).toBeDefined();
    expect(Number(hit!['shape_cover'])).toBe(0.5);
  });
});

describe('the measured share', () => {
  test('counts rows with a recorded target set only, once per row', () => {
    const m = measureTargetShare([
      { expected_output_shapes: ['a', 'a', 'b'] }, { expected_output_shapes: ['a'] }, {}, { expected_output_shapes: null },
    ]);
    expect(m.rows).toBe(2);
    expect(m.share.get('a')).toBe(1);
    expect(m.share.get('b')).toBe(0.5);
  });

  test('too few rows, or a threshold of 1, names nothing ubiquitous', () => {
    const m = measureTargetShare(Array.from({ length: 10 }, () => ({ expected_output_shapes: ['a'] })));
    expect([...ubiquitousAmong(['a'], m, 0.5, 100)]).toEqual([]);
    expect([...ubiquitousAmong(['a'], m, 1, 1)]).toEqual([]);
    expect([...ubiquitousAmong(['a'], m, 0.5, 5)]).toEqual(['a']);
  });
});
