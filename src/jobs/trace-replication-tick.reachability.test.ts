/**
 * REACHABILITY (d): the 2-minute trace replication never dials a peer through a local egress that is not live, and a peer
 * that refuses this node's credential is skipped and logged as cross-authority evidence (never retried in the tick).
 *
 * Measured 2026-10-16 on a node whose federation transport is masked: the tick pulled through the dead egress every
 * 2 minutes ("Unable to connect"). Discovery now stamps such libp2p rows egress_unreachable (discovery part a). After the
 * user's 22:47:07Z ruling the transport is unmasked, and an enforcing hub answers this node's credential "unauthorized":
 * that is a cross-authority refusal, not a transport fault.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { discoveryClient } from '../services/discovery-client';
import { config } from '../config';
import { logger } from '../utils/logger';

// As the sibling replication tests do: this process's substrate id is set before the tick module is first imported (it
// reads it once, at import), so whichever file imports first gives a non-empty echo-suppression origin.
// Restored afterAll: a later file in the same process must not inherit this node identity (the learner reads it at use time).
const originalNode = process.env.FED_SUBSTRATE_ID;
process.env.FED_SUBSTRATE_ID = process.env.FED_SUBSTRATE_ID || 'this-substrate';

const asked: string[] = [];
let answer: (target: string) => Response = () => new Response(JSON.stringify({ content: { rows: [] } }), { status: 200 });
// No mock.module: it would outlive this file in a one-process run (mock-module-completeness.test.ts; measured: it broke
// trace-replication-tick.transport-hop.test.ts at the landing gate). No peer here returns rows, so the tick's only DB
// touches are the watermark read and write, which already swallow a missing database (as in the transport-hop test).
let rows: Array<Record<string, unknown>> = [];
const spies = [
  spyOn(discoveryClient, 'isEnabled').mockImplementation(() => true),
  spyOn(discoveryClient, 'discoverVesselsForShape').mockImplementation((async () => ({ vessels: rows })) as never),
];
const warns: string[] = [];
const warnSpy = spyOn(logger, 'warn').mockImplementation(((m: string) => { warns.push(String(m)); }) as never);
const realVesselId = config.discovery.vesselId;
const realFetch = globalThis.fetch;
let mod: typeof import('./trace-replication-tick');
beforeAll(async () => {
  config.discovery.vesselId = 'activity-api-local';
  globalThis.fetch = (async (_i: unknown, init?: { body?: unknown }) => {
    const target = String(JSON.parse(String(init?.body ?? '{}')).target ?? '');
    asked.push(target);
    return answer(target);
  }) as typeof fetch;
  mod = await import('./trace-replication-tick');
});
afterAll(() => { for (const s of spies) s.mockRestore(); warnSpy.mockRestore(); config.discovery.vesselId = realVesselId; globalThis.fetch = realFetch; if (originalNode === undefined) delete process.env.FED_SUBSTRATE_ID; else process.env.FED_SUBSTRATE_ID = originalNode; });
beforeEach(() => { asked.length = 0; warns.length = 0; answer = () => new Response(JSON.stringify({ content: { rows: [] } }), { status: 200 }); });

const peer = (id: string, ma: string, extra: Record<string, unknown> = {}) => ({ vesselId: id, protocol: 'libp2p', libp2p_multiaddr: [ma], ...extra });

describe('trace replication: reachability and cross-authority refusals', () => {
  test('[MUST-FAIL] a peer row stamped egress_unreachable is never dialled', async () => {
    rows = [peer('activity-api-local@hub', '/dns4/r/tcp/1/p2p/QmHUB', { egress_unreachable: true })];
    await mod.runTraceReplicationTick();
    expect(asked).toEqual([]);
  });

  test('[MUST-FAIL] a peer answering 401 is skipped and logged as a cross-authority refusal, not retried in the tick', async () => {
    rows = [peer('activity-api-local@hub', '/dns4/r/tcp/1/p2p/QmHUB')];
    answer = () => new Response('{}', { status: 401 });
    await mod.runTraceReplicationTick();
    expect(asked.length).toBe(1);
    expect(warns.some((w) => w.includes('refused this node') && w.includes('cross-authority'))).toBe(true);
  });

  test('[CONTROL] an auth refusal inside a 200 transport envelope is classified the same way', async () => {
    rows = [peer('activity-api-local@hub', '/dns4/r/tcp/1/p2p/QmHUB')];
    answer = () => new Response(JSON.stringify({ content: { value: JSON.stringify({ error: { code: 'INVALID_API_KEY' } }) } }), { status: 200 });
    await mod.runTraceReplicationTick();
    expect(warns.some((w) => w.includes('cross-authority'))).toBe(true);
  });

  test('[CONTROL] an unstamped, answering peer is still pulled', async () => {
    rows = [peer('activity-api-local@other', '/dns4/r/tcp/1/p2p/QmOTHER')];
    await mod.runTraceReplicationTick();
    expect(asked).toEqual(['/dns4/r/tcp/1/p2p/QmOTHER']);
  });

  test('[HELD-OUT] a stamped and an unstamped peer together: only the unstamped one is dialled', async () => {
    rows = [peer('activity-api-local@hub', '/dns4/r/tcp/1/p2p/QmHUB', { egress_unreachable: true }), peer('activity-api-local@other', '/dns4/r/tcp/1/p2p/QmOTHER')];
    await mod.runTraceReplicationTick();
    expect(asked).toEqual(['/dns4/r/tcp/1/p2p/QmOTHER']);
  });

  test('[UNIT] isAuthRefusalBody reads structured codes only', () => {
    expect(mod.isAuthRefusalBody({ value: JSON.stringify({ error: { code: 'INVALID_API_KEY' } }) })).toBe(true);
    expect(mod.isAuthRefusalBody({ code: 'caller_credential_required' })).toBe(true);
    expect(mod.isAuthRefusalBody({ value: JSON.stringify({ rows: [], note: 'unauthorized words in prose do not count' }) })).toBe(false);
    expect(mod.isAuthRefusalBody(null)).toBe(false);
  });
});
