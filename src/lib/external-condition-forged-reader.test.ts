/**
 * A LANE EDIT TO THE READER CANNOT MAKE A FAILURE UNATTRIBUTED (qa ruling, option (i)).
 *
 * external-condition.ts (the candidate list read) is lane-open. posterior-update.ts (closed) uses what it returns only to
 * choose record ids, re-reads each one BY ID from this node's development-vessel and judges that copy. So a reader edited
 * to return a forged "confirmed" record can only cause a REVIEW or a refusal, never {0,0} by unattribution.
 *
 *   MUST-FAIL: a forged confirmed record the node does not hold is REFUSED and the arm keeps beta 1; a forged
 *     "confirmed" copy of a real UNCONFIRMED record is judged on the real copy (REVIEW, not unattributed); a forged copy
 *     of a real record with its window widened is judged on the real window (no match: beta 1).
 *   CONTROL: the same reader returning a real confirmed record's copy unchanged is unattributed (the path works).
 *
 * The edited reader is stood in for at the one input the closed module takes from it: the candidate LIST. The fetch
 * stub answers the list read (the reader's) from `forged` and the by-id re-read (the closed module's) from `held`, this
 * node's real pool. That is equivalent to any edit of external-condition.ts: whatever such an edit returns, the closed
 * module consumes it only as that list. No mock.module: it is process-global in bun and would replace the reader for
 * every later file in a one-process suite.
 */
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:9';
process.env.RELEVANCE_SINK_ENDPOINT ??= 'http://127.0.0.1:9';
process.env.PRIOR_SEED_ENABLED ??= 'false';

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

// The LANE EDIT: the candidate list says whatever `forged` holds.
let forged: unknown[] = [];

const PU = (await import('./posterior-update')) as Record<string, any>;
const EC = (await import('./external-condition').catch(() => ({}))) as Record<string, any>;
const { applyOutcomeToPosteriors } = PU;
const db = { query: async () => [], queryAll: async () => [] } as never;

const NODE = 'node-a';
const RULE: string = PU.CONDITION_ATTRIBUTION_RULE ?? 'absent';
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const CURRENT = { down: iso(now - 600_000), up: iso(now + 600_000) };
const PAST = { down: iso(now - 3 * 3600_000), up: iso(now - 2 * 3600_000) };
const rec = (id: string, win: { down: string; up: string }, over: Record<string, unknown> = {}) => ({
  id, shape: 'externalCondition', status: 'open', source: 'operator',
  body: {
    kind: 'ABRT core-dump', node: NODE, unit: 'ALL', ...win, times: 'observed',
    source: { observer: 'research', method: 'journal read' }, evidence: 'file:infra-events.json#events[0]',
    attribution_rule: RULE, confirmed: true, ...over,
  },
  attested: { by: 'operator', key_id: 'key_cred1', at: win.down, sig: 'x' }, attested_verified: true,
});

let held: Array<Record<string, any>> = [];
const originalFetch = globalThis.fetch;
const originalNode = process.env.FED_SUBSTRATE_ID;
beforeEach(() => {
  process.env.FED_SUBSTRATE_ID = NODE;
  EC._resetExternalConditionCandidatesForTests?.();
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input);
    if (u === 'http://127.0.0.1:8090/v2/impulses/resolve') {
      const p = JSON.parse(String(init?.body ?? '{}'))?.impulse ?? {};
      // The list read is the reader's (forged); the by-id re-read is the closed module's (this node's real pool).
      const impulses = typeof p.id === 'string' ? held.filter((r) => r.id === p.id) : forged;
      return Response.json({ shape: 'poolImpulse', body: { impulses, count: impulses.length } });
    }
    throw new TypeError('unexpected network call in test: ' + u);
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; held = []; forged = []; });
afterAll(() => {
  if (originalNode === undefined) delete process.env.FED_SUBSTRATE_ID; else process.env.FED_SUBSTRATE_ID = originalNode;
});

let n = 0;
const grade = () => applyOutcomeToPosteriors({
  activity_id: 'arm-under-test', execution_id: `exec-forged-${++n}`, success: false, failure_mode: null, cost_usd: 0, tasks: [],
} as never, db, 'organizations:o');

describe('MUST-FAIL — a forged record from the reader is never unattributed', () => {
  test('a forged confirmed record the node does not hold: refused, the arm keeps beta 1', async () => {
    forged = [rec('forged-1', CURRENT)];
    held = [];
    const s = await grade();
    expect({ a: s.alpha_delta, b: s.beta_delta }).toEqual({ a: 0, b: 1 });
    expect(s.skipped_reason).not.toBe('environment_condition');
  });

  test('a forged "confirmed" copy of a real unconfirmed record: judged on the real copy, REVIEW', async () => {
    held = [rec('cond-real', CURRENT, { confirmed: false })];
    forged = [rec('cond-real', CURRENT, { confirmed: true })];
    const s = await grade();
    expect(s.skipped_reason).toBe('condition_review');
  });

  test('a forged copy of a real record with its window widened: judged on the real window, beta 1', async () => {
    held = [rec('cond-old', PAST)];
    forged = [rec('cond-old', CURRENT)];
    const s = await grade();
    expect({ a: s.alpha_delta, b: s.beta_delta }).toEqual({ a: 0, b: 1 });
  });

  test('a forged attestation on a row the node holds unattested: refused, beta 1', async () => {
    held = [{ ...rec('cond-unatt', CURRENT), attested: undefined, attested_verified: false }];
    forged = [rec('cond-unatt', CURRENT)];
    const s = await grade();
    expect({ a: s.alpha_delta, b: s.beta_delta }).toEqual({ a: 0, b: 1 });
  });
});

describe('CONTROL — the reader returning a real confirmed record unchanged', () => {
  test('is unattributed', async () => {
    held = [rec('cond-ok', CURRENT)];
    forged = [rec('cond-ok', CURRENT)];
    const s = await grade();
    expect({ a: s.alpha_delta, b: s.beta_delta, r: s.skipped_reason }).toEqual({ a: 0, b: 0, r: 'environment_condition' });
  });
});
