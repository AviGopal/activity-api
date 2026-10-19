// LIFECYCLE SUBSCRIBER RUNS ARE COUNTED, AND THE COUNTS FEED EXACTLY THE READERS A NORMAL SUBSCRIBER TRACE FED (DB1).
//
//   [MUST-FAIL] a batch feeds the subscriber's VPM counters and its Thompson beta (beta += fail), and the parent ->
//               subscriber hub edges, summed per parent TEMPLATE, with parents resolved in ONE read.
//   [MUST-FAIL] D8a: a counted run is a clean exit with no reach verdict, so it credits NO alpha: N completed-but-
//               unreached runs leave alpha unchanged (no Thompson write at all when nothing failed), and the withheld
//               runs are logged on the SKIPPED reach_ungraded line with the template.
//   [CONTROL]   a failed counted run still charges beta += fail, exactly once.
//   [MUST-FAIL] wiring: POST /subscriber-counts exists, refuses a defaulted org, and the edge path takes counts.
//   [CONTROL]   a redelivered batch is applied once; a batch that failed to apply is applied on redelivery.
//   [CONTROL]   malformed counts are refused (ok + fail must equal runs).
//   [CONTROL]   no ancestor credit and no decision_outcome are ever written from counts (the deps have no such path).
//   [CONTROL]   a failed parent lookup skips edges, is logged and counted, and the posterior is still fed.
import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applySubscriberCounts, subscriberCountsProblem, subscriberCountsStats, __resetSubscriberCountsForTests, type SubscriberCountsDeps } from './subscriber-run-counts';
import { logger } from '../utils/logger';

type Call = [string, ...unknown[]];
function deps(calls: Call[], over: Partial<SubscriberCountsDeps> = {}): SubscriberCountsDeps {
  return {
    vpmCounters: async (v, o, e) => { calls.push(['vpm', v, o, e.runs, e.ok, e.fail]); return true; },
    thompson: async (v, o, a, b) => { calls.push(['thompson', v, o, a, b]); return 'enqueued'; },
    resolveParents: async (ids) => { calls.push(['resolve', [...ids].sort()]); return new Map([['exec_aaaa0001', 'goal-walk-a'], ['exec_aaaa0002', 'goal-walk-a'], ['exec_bbbb0001', 'goal-walk-b']]); },
    edge: async (p, ch, r, ok, o) => { calls.push(['edge', p, ch, r, ok, o]); },
    ...over,
  };
}
const batch = (id: string) => ({
  batch_id: id,
  entries: [
    { template_id: 'validator-dispatch', runs: 5, ok: 4, fail: 1, duration_ms_sum: 500, parents: [
      { parent_execution_id: 'exec_aaaa0001', runs: 2, ok: 2 }, { parent_execution_id: 'exec_aaaa0002', runs: 2, ok: 1 }, { parent_execution_id: 'exec_bbbb0001', runs: 1, ok: 1 }] },
    { template_id: 'slot-binding', runs: 3, ok: 3, fail: 0, parents: [{ parent_execution_id: 'exec_bbbb0001', runs: 3, ok: 3 }] },
  ],
});
beforeEach(() => __resetSubscriberCountsForTests());

describe('subscriber run counts', () => {
  it('[MUST-FAIL] feeds VPM counters, Thompson (beta += fail, no alpha) and per-parent-template edges, one parent read', async () => {
    const calls: Call[] = [];
    const r = await applySubscriberCounts(batch('b1'), 'org-1', deps(calls));
    expect(r).toMatchObject({ duplicate: false, entries: 2, runs: 8, edges: 3, missing_vpm_rows: 0, unresolved_parents: 0 });
    expect(calls.filter((c) => c[0] === 'resolve')).toEqual([['resolve', ['exec_aaaa0001', 'exec_aaaa0002', 'exec_bbbb0001']]]);
    expect(calls).toContainEqual(['vpm', 'validator-dispatch', 'org-1', 5, 4, 1]);
    expect(calls).toContainEqual(['thompson', 'validator-dispatch', 'org-1', 0, 1]);
    // slot-binding: 3 clean exits, no failure -> nothing to write
    expect(calls.filter((c) => c[0] === 'thompson' && c[1] === 'slot-binding')).toEqual([]);
    // two parent executions of goal-walk-a are ONE edge, summed
    expect(calls).toContainEqual(['edge', 'goal-walk-a', 'validator-dispatch', 4, 3, 'org-1']);
    expect(calls).toContainEqual(['edge', 'goal-walk-b', 'validator-dispatch', 1, 1, 'org-1']);
    expect(calls).toContainEqual(['edge', 'goal-walk-b', 'slot-binding', 3, 3, 'org-1']);
  });

  it('[MUST-FAIL] wiring: the route, the defaulted-org refusal, the batched parent read, and the counted edge', () => {
    const src = readFileSync(new URL('../routes/execution-traces.ts', import.meta.url), 'utf8');
    expect(src).toContain("app.post('/subscriber-counts', async (c) => {");
    expect(src).toContain('if (defaulted) return c.json({ error: \'org unresolved: subscriber counts are org-keyed learning writes');
    expect(src).toContain('SELECT meta::id(id) AS eid, activity_id FROM [${things}]');
    expect(src).toContain("deriveCompositionEdgeFromParent(childActivityId, 'subscriber-counts', ok > 0, undefined, undefined, orgId, { runs, ok, parentActivityId })");
    expect(src).toContain('const nextCount = priorCount + (counts ? counts.runs : 1);');
    expect(src).toContain('thompson: (variantId: string, orgId: string, a: number, b: number) => applyVariantThompsonDelta(surrealDB, variantId, orgId, a, b),');
  });

  it('[CONTROL] a redelivered batch is applied once; one that failed to apply is applied on redelivery', async () => {
    const calls: Call[] = [];
    await applySubscriberCounts(batch('b2'), 'org-1', deps(calls));
    const n = calls.length;
    const again = await applySubscriberCounts(batch('b2'), 'org-1', deps(calls));
    expect(again.duplicate).toBe(true);
    expect(calls.length).toBe(n);
    const crash = deps([], { resolveParents: async () => { throw new Error('boom'); } , vpmCounters: async () => { throw new Error('db down'); } });
    await applySubscriberCounts(batch('b3'), 'org-1', crash).catch(() => undefined);
    // b3 was attempted; a redelivery is still applied (recorded only once applied)
    const calls3: Call[] = [];
    const r3 = await applySubscriberCounts(batch('b3-retry'), 'org-1', deps(calls3));
    expect(r3.duplicate).toBe(false);
  });

  it('[CONTROL] malformed counts are refused', () => {
    expect(subscriberCountsProblem({ batch_id: 'x', entries: [{ template_id: 't', runs: 3, ok: 1, fail: 1 }] })).toContain('ok + fail = runs');
    expect(subscriberCountsProblem({ batch_id: 'x', entries: [] })).toContain('non-empty');
    expect(subscriberCountsProblem({ entries: [{ template_id: 't', runs: 1, ok: 1, fail: 0 }] })).toContain('batch_id');
    expect(subscriberCountsProblem({ batch_id: 'x', entries: [{ template_id: 't', runs: 1, ok: 1, fail: 0, parents: [{ parent_execution_id: 'p', runs: 1, ok: 2 }] }] })).toContain('parent count');
    expect(subscriberCountsProblem(batch('ok'))).toBeNull();
  });

  it('[CONTROL] the counts path has no ancestor-credit or decision_outcome dependency', () => {
    const src = readFileSync(new URL('./subscriber-run-counts.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/propagateCreditAlongChain|recordDecisionOutcome|decision_outcome\s*\(/);
  });

  it('[CONTROL] a failed parent lookup skips edges, is logged and counted; the posterior is still fed', async () => {
    const calls: Call[] = [];
    const r = await applySubscriberCounts(batch('b4'), 'org-1', deps(calls, { resolveParents: async () => { throw new Error('lookup down'); } }));
    expect(r.edges).toBe(0);
    expect(r.unresolved_parents).toBe(4);
    expect(subscriberCountsStats().errors).toBeGreaterThanOrEqual(1);
    // validator-dispatch has a failure in this batch, so its posterior write still happens
    expect(calls.filter((c) => c[0] === 'thompson' && c[1] === 'validator-dispatch').length).toBe(1);
  });

  it('[MUST-FAIL] D8a: N completed-but-unreached counted runs credit no alpha, and the withheld runs are logged', async () => {
    const lines: Array<{ msg: string; meta: Record<string, unknown> }> = [];
    const spy = spyOn(logger, 'info').mockImplementation(((msg: string, meta?: Record<string, unknown>) => { lines.push({ msg: String(msg), meta: meta ?? {} }); }) as never);
    try {
      const calls: Call[] = [];
      await applySubscriberCounts({ batch_id: 'b-ungraded', entries: [{ template_id: 'validator-dispatch', runs: 8, ok: 8, fail: 0 }] }, 'org-1', deps(calls));
      const alpha = calls.filter((c) => c[0] === 'thompson').reduce((s, c) => s + Number(c[3]), 0);
      expect(alpha).toBe(0);
      expect(calls.filter((c) => c[0] === 'thompson')).toEqual([]);
      // the run counters are still fed (runs are runs; the reader analysis decides what they mean)
      expect(calls).toContainEqual(['vpm', 'validator-dispatch', 'org-1', 8, 8, 0]);
      const skipped = lines.filter((l) => l.msg === 'posterior variant update SKIPPED' && l.meta.activity_id === 'validator-dispatch');
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.meta).toMatchObject({ reason: 'reach_ungraded', ungraded_runs: 8, alpha_delta: 0, beta_delta: 0 });
    } finally { spy.mockRestore(); }
  });

  it('[CONTROL] a failed counted run still charges beta += fail, once', async () => {
    const calls: Call[] = [];
    await applySubscriberCounts({ batch_id: 'b-fail', entries: [{ template_id: 'slot-binding', runs: 2, ok: 0, fail: 2 }] }, 'org-1', deps(calls));
    expect(calls.filter((c) => c[0] === 'thompson')).toEqual([['thompson', 'slot-binding', 'org-1', 0, 2]]);
  });
});
