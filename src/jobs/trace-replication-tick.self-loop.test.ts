/**
 * Check-first: a substrate must not replicate traces from itself.
 *
 * Gap trace-replication-tick-pulls-from-its-own-substrate-through-its-own-relay (database
 * session, 10-02). runTraceReplicationTick drops peers only by `vesselId !== selfId`
 * ('activity-api-local'), so the hub's own federated row 'activity-api-local@syzygy-hub'
 * (FED_SUBSTRATE_ID=syzygy-hub) passes: syzygy pulled 1000 of its own rows over its own relay
 * and upserted them back, and the pull's timeouts kept the watermark from advancing. The reverse
 * direction of the substrate-local-shapes locality class.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.FED_SUBSTRATE_ID = 'syzygy-hub';
const pulledFrom: string[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: { async query() { return []; } },
  // Stubs to satisfy mock-module-completeness.test.ts
  getDbStats: async () => ({}),
  createAuthenticatedClient: async () => ({ query: async () => [], close: () => {} }),
  queryWithAuth: async () => [],
  dbStats: async () => ({}),
}));
mock.module('../services/discovery-client', () => ({
  discoveryClient: {
    isEnabled: () => true,
    async discoverVesselsForShape() {
      return {
        vessels: [
          { vesselId: 'activity-api-local', protocol: 'http' },
          { vesselId: 'activity-api-local@syzygy-hub', protocol: 'libp2p', libp2p_multiaddr: ['/ip4/10.0.0.1/tcp/4001/p2p/QmSELF'] },
          { vesselId: 'activity-api-local@other-substrate', protocol: 'libp2p', libp2p_multiaddr: ['/ip4/10.0.0.2/tcp/4001/p2p/QmOTHER'] },
        ],
      };
    },
  },
}));
mock.module('../config', () => ({ config: { discovery: { vesselId: 'activity-api-local' } } }));

let runTraceReplicationTick: () => Promise<void>;
beforeAll(async () => {
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    // pullFromPeer posts {target: <peer multiaddr>, pointer}; map the target back to its peer.
    const target = String(JSON.parse(String(init?.body ?? '{}')).target ?? '');
    if (target.endsWith('/QmSELF')) pulledFrom.push('activity-api-local@syzygy-hub');
    if (target.endsWith('/QmOTHER')) pulledFrom.push('activity-api-local@other-substrate');
    return new Response(JSON.stringify({ content: { shape: 'executionReplicationPull', count: 0, rows: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  ({ runTraceReplicationTick } = await import('./trace-replication-tick'));
});

describe('trace replication: never pull from your own substrate', () => {
  beforeEach(() => { pulledFrom.length = 0; });

  test('a peer row whose federated suffix is this substrate (FED_SUBSTRATE_ID) is not pulled', async () => {
    await runTraceReplicationTick();
    expect(pulledFrom.filter((p) => p.endsWith('@syzygy-hub'))).toEqual([]);
  });

  test('control: a peer on another substrate is still pulled', async () => {
    await runTraceReplicationTick();
    expect(pulledFrom.some((p) => p.endsWith('@other-substrate'))).toBe(true);
  });
});
