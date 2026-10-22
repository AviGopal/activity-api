/**
 * The registration advertises the node this vessel serves as for on-behalf-of tokens.
 *
 * A surface mints an on-behalf-of token for { node, shape } and the label writer holds it to
 * thisNode() (FED_SUBSTRATE_ID, else the hostname). The registration is what a surface can read
 * to learn that node, so it must carry thisNode() itself: podId is the hostname, which is a
 * different value wherever the node has its own substrate id.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { DiscoveryClient } from './discovery-client';
import { thisNode } from '../middleware/jwtAuth';
import { config } from '../config';

describe('DiscoveryClient', () => {
  let client: DiscoveryClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    client = DiscoveryClient.getInstance();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    await client.shutdown();
    globalThis.fetch = originalFetch;
  });

  describe('node advertisement (on-behalf-of audience)', () => {
    async function capture(): Promise<any> {
      process.env.DISCOVERY_ENABLED = 'true';
      let capturedBody: any = null;
      globalThis.fetch = mock(async (_url: any, options: any) => {
        if (options?.method === 'POST' && options?.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return new Response(
          JSON.stringify({ success: true, vesselId: 'activity-api-test', expiresAt: Date.now() + 300000 }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      });
      await client.register();
      return capturedBody;
    }
    function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
      const saved: Record<string, string | undefined> = {};
      for (const k of Object.keys(vars)) {
        saved[k] = process.env[k];
        if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
      }
      return fn().finally(() => {
        for (const k of Object.keys(saved)) {
          if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
      });
    }

    it('MUST-FAIL: metadata.node is thisNode(), the substrate id, when it differs from the hostname', async () => {
      await withEnv({ FED_SUBSTRATE_ID: 'node-substrate-id', HOSTNAME: 'pod-hostname' }, async () => {
        const body = await capture();
        expect(body.metadata.node).toBe('node-substrate-id');
        expect(body.metadata.node).toBe(thisNode());
        expect(body.metadata.podId).toBe('pod-hostname');
      });
    });

    it('MUST-FAIL: metadata.node is thisNode() when no substrate id is set', async () => {
      await withEnv({ FED_SUBSTRATE_ID: undefined }, async () => {
        const body = await capture();
        expect(typeof body.metadata.node).toBe('string');
        expect(body.metadata.node).toBe(thisNode());
      });
    });

    it('CONTROL: the existing metadata fields are unchanged', async () => {
      await withEnv({ FED_SUBSTRATE_ID: 'node-substrate-id', HOSTNAME: 'pod-hostname' }, async () => {
        const body = await capture();
        expect(body.metadata.podId).toBe('pod-hostname');
        expect(body.metadata.port).toBe(config.port);
        expect(['k8s-cluster', 'docker', 'local']).toContain(body.metadata.environment);
        expect(body.vesselName).toBe('activity-api');
        expect(body.resolve_endpoint).toBe('/v2/impulses/resolve');
        expect(body.auth_scheme).toBe('ApiKey');
      });
    });
  });
});
