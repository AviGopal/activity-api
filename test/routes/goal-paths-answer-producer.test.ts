/**
 * A shape-signature borrow must cover a target OTHER than the answer producer.
 *
 * Measured 2026-10-30: targets [llm_completion_dispatch, human_surface:ui_view] borrowed a one-step
 * [satisfier:llm_completion_dispatch] donor (12/12) at cover 0.50, and an unrelated goal borrowed the
 * same donor minutes later. The overlap was the answer channel (llm_completion_dispatch), not the
 * goal's purpose. Recorded target-set shares show llm_completion_dispatch in only ~7% of rows, so
 * this is cover arithmetic, not ubiquity: any two-target goal with the answer producer as one
 * target reaches 0.50 against any answer-only path.
 *
 * Driven through POST /recommend with only the store stubbed (no helper seam). Must-fail: the
 * R2-shaped request does not return the llm donor. Controls: [data, llm] still matches a path covering
 * the data shape; a pure [llm_completion_dispatch] target set gets no answer-only borrow (qa ruling);
 * an exact goal_hash reuse is unchanged.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';

type Handler = (sql: string, params?: Record<string, unknown>) => unknown;
let handler: Handler = () => [];

mock.module('../../src/db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params?: Record<string, unknown>) => handler(sql, params),
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
}));

const goalPathsApp = (await import('../../src/routes/goal-paths')).default;

const LLM = 'llm_completion_dispatch';

function row(goal_hash: string, path_activities: string[], endpoint: string[], succ: number, total: number) {
  return {
    goal_hash, path_activities, endpoint_output_shapes: endpoint, path_signature: `sig-${goal_hash}`,
    successful_executions: succ, total_executions: total, thompson_alpha: succ + 1, thompson_beta: total - succ + 1,
    success_rate: total ? succ / total : 0,
  };
}

// The 2ae9c3e1-shaped donor: one llm satisfier step, 12/12.
const llmDonor = row('donor-llm', [`satisfier:${LLM}`], [LLM], 12, 12);
const noteDonor = row('donor-note', ['satisfier:shellResult', `satisfier:${LLM}`, 'satisfier:memoryNote_write'], ['shellResult', LLM, 'memoryNote_write', 'memoryNote'], 1, 1);

function serve(o: { exact?: unknown[]; donors?: unknown[] }) {
  handler = (sql) => {
    if (sql.includes('CONTAINSANY $target_shapes')) return o.donors ?? [];
    if (sql.includes('FROM goal_execution_paths') && sql.includes('goal_hash = $goal_hash')) return o.exact ?? [];
    return [];
  };
}

async function recommend(target_shapes: string[]): Promise<Array<Record<string, unknown>>> {
  const res = await goalPathsApp.request('/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal_text: 'answer producer fixture goal', target_shapes, exploration_rate: 0, top_k: 5, seed: 7 }),
  });
  expect(res.status).toBe(200);
  const j = (await res.json()) as { recommended_paths?: Array<Record<string, unknown>> };
  return j.recommended_paths ?? [];
}

beforeEach(() => { handler = () => []; });

describe('shape-signature borrow needs a non-answer target in common', () => {
  test('MUST-FAIL: targets [llm_completion_dispatch, human_surface:ui_view] do not borrow the one-step llm donor', async () => {
    serve({ donors: [llmDonor] });
    const recs = await recommend([LLM, 'human_surface:ui_view']);
    expect(recs.filter((r) => r['goal_hash'] === 'donor-llm')).toEqual([]);
  });

  test('CONTROL: targets [memoryNote_write, llm_completion_dispatch] still match a path covering memoryNote_write', async () => {
    serve({ donors: [noteDonor, llmDonor] });
    const recs = await recommend(['memoryNote_write', LLM]);
    const hit = recs.find((r) => r['goal_hash'] === 'donor-note');
    expect(hit).toBeDefined();
    expect(hit!['match_mode']).toBe('shape_signature');
    expect(Number(hit!['shape_cover'])).toBe(1);
    expect(recs.some((r) => r['goal_hash'] === 'donor-llm')).toBe(false);
  });

  test('CONTROL: a pure [llm_completion_dispatch] target set gets no answer-only borrow', async () => {
    serve({ donors: [llmDonor] });
    const recs = await recommend([LLM]);
    expect(recs.filter((r) => r['match_mode'] === 'shape_signature')).toEqual([]);
  });

  test('CONTROL: an exact goal_hash reuse is unchanged', async () => {
    serve({ exact: [row('exact-own', [`satisfier:${LLM}`], [LLM], 24, 25)], donors: [llmDonor] });
    const recs = await recommend([LLM, 'human_surface:ui_view']);
    expect(recs.length).toBe(1);
    expect(recs[0]!['goal_hash']).toBe('exact-own');
    expect(recs[0]!['match_mode']).toBe('goal_hash');
  });
});
