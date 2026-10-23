/**
 * The replication pull's exclude_origin is this node's identity as it is WHEN THE PULL IS MADE.
 *
 * It was read once at module load. In one bun process src/index.ts (imported by routes/health.test.ts)
 * loads this module before any node identity is set, so the identity froze as '' and every later pull went
 * out without exclude_origin: echo suppression off, with nothing to show it. The same holds for a live
 * process that loads the tick before its identity is in place.
 *   [MUST-FAIL] the module is loaded with no identity; the identity is set afterwards; the pull carries it.
 *   [CONTROL]   with no identity at pull time, exclude_origin is omitted rather than sent empty.
 * No mock.module (see mock-module-completeness.test.ts): spies on the real singletons, restored afterAll.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { discoveryClient } from '../services/discovery-client';
import { config } from '../config';

const originalNode = process.env.FED_SUBSTRATE_ID;
const originalSubstrate = process.env.SUBSTRATE_ID;
const spies = [
  spyOn(discoveryClient, 'isEnabled').mockImplementation(() => true),
  spyOn(discoveryClient, 'discoverVesselsForShape').mockImplementation((async () => ({
    vessels: [
      { vesselId: 'activity-api-local@peer-substrate', protocol: 'libp2p', libp2p_multiaddr: ['/ip4/10.0.0.2/tcp/4001/p2p/QmPEER'] },
    ],
  })) as never),
];
const realVesselId = config.discovery.vesselId;
const realFetch = globalThis.fetch;
const bodies: string[] = [];

let runTraceReplicationTick: () => Promise<void>;
beforeAll(async () => {
  config.discovery.vesselId = 'activity-api-local';
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.endsWith('/egress/resolve')) bodies.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ content: { shape: 'executionReplicationPull', count: 0, rows: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  // Load the module with NO node identity, as src/index.ts does when it loads first.
  delete process.env.FED_SUBSTRATE_ID;
  delete process.env.SUBSTRATE_ID;
  ({ runTraceReplicationTick } = await import('./trace-replication-tick'));
});
afterAll(() => {
  for (const s of spies) s.mockRestore();
  config.discovery.vesselId = realVesselId;
  globalThis.fetch = realFetch;
  if (originalNode === undefined) delete process.env.FED_SUBSTRATE_ID; else process.env.FED_SUBSTRATE_ID = originalNode;
  if (originalSubstrate === undefined) delete process.env.SUBSTRATE_ID; else process.env.SUBSTRATE_ID = originalSubstrate;
});

describe('trace replication pull: exclude_origin is read at use time', () => {
  test('[MUST-FAIL] an identity set after the module loaded is sent as exclude_origin', async () => {
    process.env.FED_SUBSTRATE_ID = 'identity-set-after-load';
    bodies.length = 0;
    await runTraceReplicationTick();
    expect(bodies.length).toBe(1);
    expect(JSON.parse(bodies[0]!).pointer.exclude_origin).toBe('identity-set-after-load');
  });

  test('[CONTROL] with no identity at pull time, exclude_origin is omitted', async () => {
    delete process.env.FED_SUBSTRATE_ID;
    bodies.length = 0;
    await runTraceReplicationTick();
    expect(bodies.length).toBe(1);
    expect(Object.keys(JSON.parse(bodies[0]!).pointer)).not.toContain('exclude_origin');
  });
});
