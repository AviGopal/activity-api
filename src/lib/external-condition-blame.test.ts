/**
 * A FAILURE INSIDE A CONFIRMED EXTERNAL CONDITION IS UNATTRIBUTED (environment): the learner's blame step, end to end
 * through applyOutcomeToPosteriors (environment-failure-classifier-misses-aborted-and-socket-closed-so-outages-blame-arms,
 * FOLD; traces-recorded-during-a-hub-outage-replay-later-as-arm-blame-because-the-learner-cannot-see-the-outage).
 *
 * Before: a failure with no environmental reason, or a reached:false verdict, recorded during an outage was charged
 * beta 1 to whichever arm ran, and a trace replayed after the outage was judged as if it had happened at arrival.
 *
 *   MUST-FAIL: a reasonless failure and a reached:false verdict inside a confirmed window write {0,0}, no alpha;
 *     an unconfirmed window withholds the write (REVIEW) and logs the line naming the trace id; a replayed trace whose
 *     recorded_at is inside a past window is unattributed although it arrives after the window closed.
 *   CONTROL: a non-environment failure outside any window still costs beta 1; a success inside a window still credits
 *     alpha; a verifier_negative inside a window keeps beta 1; the same replayed trace without recorded_at keeps beta 1.
 *
 * This node's development-vessel is stood in for by globalThis.fetch (the list read and the by-id re-read); the db is
 * a recording stub (the summary carries the deltas the learner applies). Fixture names are placeholders.
 */
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:9';
process.env.RELEVANCE_SINK_ENDPOINT ??= 'http://127.0.0.1:9';
process.env.PRIOR_SEED_ENABLED ??= 'false';

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

const { applyOutcomeToPosteriors } = await import('./posterior-update');
const PU = (await import('./posterior-update')) as Record<string, any>;
const EC = (await import('./external-condition').catch(() => ({}))) as Record<string, any>;
const { logger } = await import('../utils/logger');
const db = { query: async () => [], queryAll: async () => [] } as never;

const NODE = 'node-a';
const RULE: string = PU.CONDITION_ATTRIBUTION_RULE ?? 'absent';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
// An outage that ENDED 2 h ago (so a live trace now is outside it), and one still covering now.
const PAST = { down: iso(now - 3 * 3600_000), up: iso(now - 2 * 3600_000) };
const CURRENT = { down: iso(now - 600_000), up: iso(now + 600_000) };
const rec = (id: string, win: { down: string; up: string }, over: Record<string, unknown> = {}) => ({
  id, shape: 'externalCondition', status: 'open', source: 'operator',
  body: {
    kind: 'POWER-LOSS host reboot', node: NODE, unit: 'ALL', ...win, times: 'observed',
    source: { observer: 'research', method: 'journal read' }, evidence: 'file:infra-events.json#events[0]',
    attribution_rule: RULE, confirmed: true, ...over,
  },
  attested: { by: 'operator', key_id: 'key_cred1', at: win.down, sig: 'x' }, attested_verified: true,
});

let pool: Array<Record<string, any>> = [];
const originalFetch = globalThis.fetch;
const originalNode = process.env.FED_SUBSTRATE_ID;
let warn: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  process.env.FED_SUBSTRATE_ID = NODE;
  EC._resetExternalConditionCandidatesForTests?.();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    if (u === 'http://127.0.0.1:8090/v2/impulses/resolve') {
      const p = JSON.parse(String(init?.body ?? '{}'))?.impulse ?? {};
      const impulses = typeof p.id === 'string' ? pool.filter((r) => r.id === p.id) : pool.filter((r) => r.shape === p.shape && r.status === 'open');
      return Response.json({ shape: 'poolImpulse', body: { impulses, count: impulses.length } });
    }
    throw new TypeError('unexpected network call in test: ' + u);
  }) as unknown as typeof fetch;
  // RECORD ONLY, never call through (an earlier file in one process may have left logger.warn spied).
  warn = spyOn(logger, 'warn').mockImplementation((() => {}) as never);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  warn?.mockRestore();
  pool = [];
});
afterAll(() => {
  if (originalNode === undefined) delete process.env.FED_SUBSTRATE_ID; else process.env.FED_SUBSTRATE_ID = originalNode;
});

let n = 0;
const grade = (extra: Record<string, unknown>) => applyOutcomeToPosteriors({
  activity_id: 'arm-under-test', execution_id: `exec-cond-${++n}`, success: false, failure_mode: null,
  cost_usd: 0, tasks: [{ output_impulse_ids: [] }], ...extra,
} as never, db, 'organizations:o');
const deltas = (s: { alpha_delta: number; beta_delta: number }) => ({ a: s.alpha_delta, b: s.beta_delta });

describe('MUST-FAIL — inside a confirmed window the failure is unattributed (environment)', () => {
  test('a failure with no reason: {0,0}, no alpha', async () => {
    pool = [rec('cond-now', CURRENT)];
    const s = await grade({});
    expect(deltas(s)).toEqual({ a: 0, b: 0 });
    expect(s.skipped_reason).toBe('environment_condition');
  });

  test('an execution_error whose reason no pattern recognises: {0,0}', async () => {
    pool = [rec('cond-now', CURRENT)];
    expect(deltas(await grade({ failure_mode: { type: 'execution_error', reason: 'no llm_completion producer' } }))).toEqual({ a: 0, b: 0 });
  });

  test('a reached:false verdict on a run that exited cleanly: {0,0}', async () => {
    pool = [rec('cond-now', CURRENT)];
    expect(deltas(await grade({ success: true, tags: ['reached:false'] }))).toEqual({ a: 0, b: 0 });
  });
});

describe('MUST-FAIL — an unconfirmed window → REVIEW: no write, counted and logged with the trace id', () => {
  test('confirmed:false withholds the write and logs the REVIEW line naming the execution', async () => {
    pool = [rec('cond-unconf', CURRENT, { confirmed: false })];
    const before = PU.externalConditionCounters?.().review_withheld ?? 0;
    const s = await grade({ execution_id: 'exec-review-1' });
    expect(deltas(s)).toEqual({ a: 0, b: 0 });
    expect(s.skipped_reason).toBe('condition_review');
    const line = warn!.mock.calls.find((c) => String(c[0]).includes('WITHHELD for REVIEW'));
    expect(line?.[1]).toMatchObject({ execution_id: 'exec-review-1', record_id: 'cond-unconf', holder: 'key_cred1', beta_withheld: 1 });
    expect(PU.externalConditionCounters().review_withheld).toBe(before + 1);
  });

  test('estimated times withhold the write too', async () => {
    pool = [rec('cond-est', CURRENT, { times: 'estimated' })];
    expect((await grade({})).skipped_reason).toBe('condition_review');
  });
});

describe('MUST-FAIL — a replayed trace is judged by the window of its ORIGINAL time', () => {
  test('recorded_at inside a past window, arriving now (after it closed): unattributed', async () => {
    pool = [rec('cond-past', PAST)];
    const s = await grade({ recorded_at: iso(now - 2.5 * 3600_000) });
    expect(deltas(s)).toEqual({ a: 0, b: 0 });
    expect(s.skipped_reason).toBe('environment_condition');
  });
});

describe('CONTROL — blame and credit outside the rule are unchanged', () => {
  test('a non-environment failure outside any window costs beta 1', async () => {
    pool = [rec('cond-past', PAST)];
    expect(deltas(await grade({ failure_mode: { type: 'execution_error', reason: 'assertion failed: expected 2 got 3' } }))).toEqual({ a: 0, b: 1 });
  });

  test('a LATE verdict with no parseable time of its own is judged by no window, not at arrival: beta 1', async () => {
    pool = [rec('cond-now', CURRENT)];
    expect(deltas(await grade({ success: true, tags: ['reached:false'], grading_occasion: 'reach' }))).toEqual({ a: 0, b: 1 });
    expect(deltas(await grade({ success: true, tags: ['reached:false'], grading_occasion: 'reach', recorded_at: 'NONE' }))).toEqual({ a: 0, b: 1 });
  });

  test('the same replayed trace WITHOUT recorded_at is judged at arrival and keeps beta 1', async () => {
    pool = [rec('cond-past', PAST)];
    expect(deltas(await grade({}))).toEqual({ a: 0, b: 1 });
  });

  test('a success inside a confirmed window still credits alpha (never moved to or from success)', async () => {
    pool = [rec('cond-now', CURRENT)];
    const s = await grade({ success: true, tags: ['reached:true'] });
    expect(s.alpha_delta).toBeGreaterThan(0);
  });

  test('a success outside any window still credits alpha', async () => {
    pool = [];
    expect((await grade({ success: true, tags: ['reached:true'] })).alpha_delta).toBeGreaterThan(0);
  });

  test('a red check (verifier_negative) inside a confirmed window keeps beta 1', async () => {
    pool = [rec('cond-now', CURRENT)];
    expect(deltas(await grade({ failure_mode: { type: 'verifier_negative' } }))).toEqual({ a: 0, b: 1 });
  });
});
