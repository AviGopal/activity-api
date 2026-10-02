/**
 * The replication pull hands activity-api's own key to the federation transport as a HEADER
 * on the local hop, and never puts it in the pointer.
 *
 * Once the transport's ingress admits callers by their own credential (it no longer lends the
 * node's key), a pull that crosses with no credential is refused: executionReplicationPull is
 * trust_group. The transport moves the local hop's Authorization header into the wire pointer
 * itself, so the pointer stays credential-free.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { discoveryClient } from '../services/discovery-client';
import { config } from '../config';

const FAKE_KEY = 'mb-test-activity-api-transport-hop-0123456789';
process.env.FED_SUBSTRATE_ID = 'this-substrate';

// No mock.module (it would outlive this file; see mock-module-completeness.test.ts). With no
// peer rows returned, the tick's only DB touches are the watermark read and write, both of
// which already swallow a missing database. As in trace-replication-tick.self-loop.test.ts:
// spy on the real singletons and restore them after.
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
const realKeys = { m: process.env.METABOB_API_KEY, a: process.env.ACTIVITY_API_KEY };
const calls: Array<{ url: string; authorization: string | null; body: string }> = [];

let runTraceReplicationTick: () => Promise<void>;
beforeAll(async () => {
  config.discovery.vesselId = 'activity-api-local';
  process.env.METABOB_API_KEY = FAKE_KEY;
  delete process.env.ACTIVITY_API_KEY;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push({ url, authorization: new Headers(init?.headers ?? {}).get('authorization'), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ content: { shape: 'executionReplicationPull', count: 0, rows: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  ({ runTraceReplicationTick } = await import('./trace-replication-tick'));
});
afterAll(() => {
  for (const s of spies) s.mockRestore();
  config.discovery.vesselId = realVesselId;
  globalThis.fetch = realFetch;
  if (realKeys.m === undefined) delete process.env.METABOB_API_KEY; else process.env.METABOB_API_KEY = realKeys.m;
  if (realKeys.a !== undefined) process.env.ACTIVITY_API_KEY = realKeys.a;
});

describe('trace replication pull over the federation transport', () => {
  test('the egress hop carries the caller key as a header; the pointer does not', async () => {
    calls.length = 0;
    await runTraceReplicationTick();
    const egress = calls.filter((c) => c.url.endsWith('/egress/resolve'));
    expect(egress.length).toBe(1);
    const c = egress[0]!;
    expect(c.authorization).toBe(`ApiKey ${FAKE_KEY}`);
    expect(c.body).not.toContain(FAKE_KEY);
    expect(c.body).not.toContain('_auth');
    expect(c.body.toLowerCase()).not.toContain('authorization');
    const sent = JSON.parse(c.body);
    expect(sent.target).toBe('/ip4/10.0.0.2/tcp/4001/p2p/QmPEER');
    expect(sent.pointer.type).toBe('executionReplicationPull');
    expect(Object.keys(sent.pointer).sort()).toEqual(['exclude_origin', 'limit', 'since', 'type']);
  });

  test('with no key configured, nothing is attached and the pull still goes out', async () => {
    const saved = process.env.METABOB_API_KEY;
    delete process.env.METABOB_API_KEY;
    try {
      calls.length = 0;
      await runTraceReplicationTick();
      const egress = calls.filter((c) => c.url.endsWith('/egress/resolve'));
      expect(egress.length).toBe(1);
      expect(egress[0]!.authorization).toBeNull();
    } finally {
      process.env.METABOB_API_KEY = saved;
    }
  });
});
