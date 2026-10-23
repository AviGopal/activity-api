/**
 * CHECK for gap counted-subscriber-runs-credit-alpha-by-exit-status-with-no-reach-verdict-breaking-the-honest-reach-floor.
 *
 * A counted lifecycle-subscriber run is a clean exit with no reach verdict, so it is ungraded and must credit no
 * alpha (the honest-reach floor the trace path enforces).
 *   [MUST-FAIL] 8 completed-but-unreached counted runs write no Thompson delta, so alpha does not move; the run
 *               counters are still fed.
 *   [CONTROL]   a failed counted run still charges beta += fail, exactly once.
 * Logic reused from the fix's own test (src/lib/subscriber-run-counts.test.ts); the module is reached only through
 * its exports.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import * as mod from '../../src/lib/subscriber-run-counts';

type Call = [string, ...unknown[]];
function deps(calls: Call[]): mod.SubscriberCountsDeps {
  return {
    vpmCounters: async (v, o, e) => { calls.push(['vpm', v, o, e.runs, e.ok, e.fail]); return true; },
    thompson: async (v, o, a, b) => { calls.push(['thompson', v, o, a, b]); return 'enqueued'; },
    resolveParents: async () => new Map(),
    edge: async (p, ch, r, ok, o) => { calls.push(['edge', p, ch, r, ok, o]); },
  };
}

beforeEach(() => mod.__resetSubscriberCountsForTests());

describe('counted subscriber runs and the honest-reach floor', () => {
  test('[MUST-FAIL] 8 completed-but-unreached counted runs credit no alpha', async () => {
    const calls: Call[] = [];
    await mod.applySubscriberCounts({ batch_id: 'chk-ungraded', entries: [{ template_id: 'validator-dispatch', runs: 8, ok: 8, fail: 0 }] }, 'org-1', deps(calls));
    const alpha = calls.filter((c) => c[0] === 'thompson').reduce((s, c) => s + Number(c[3]), 0);
    expect(alpha).toBe(0);
    expect(calls.filter((c) => c[0] === 'thompson')).toEqual([]);
    expect(calls).toContainEqual(['vpm', 'validator-dispatch', 'org-1', 8, 8, 0]);
  });

  test('[CONTROL] a failed counted run still charges beta += fail, once', async () => {
    const calls: Call[] = [];
    await mod.applySubscriberCounts({ batch_id: 'chk-fail', entries: [{ template_id: 'slot-binding', runs: 2, ok: 0, fail: 2 }] }, 'org-1', deps(calls));
    expect(calls.filter((c) => c[0] === 'thompson')).toEqual([['thompson', 'slot-binding', 'org-1', 0, 2]]);
  });
});
