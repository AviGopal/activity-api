/**
 * A failed heartbeat re-registers IMMEDIATELY, inside the same failure handling.
 *
 * A failed heartbeat usually means discovery restarted and lost its in-memory record.
 * Leaving re-registration to the next heartbeat-manager tick keeps this vessel
 * unroutable for up to a full heartbeatIntervalMs, so sendHeartbeat() must call
 * register() itself before it returns. The heartbeat manager is never started here,
 * so the only path that can call register() is sendHeartbeat()'s own failure branch.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { DiscoveryClient } from './discovery-client';

function stubDiscovery(heartbeatOk: boolean): void {
  globalThis.fetch = mock(async (url: any) => {
    const urlStr = url.toString();
    if (urlStr.endsWith('/register')) {
      return new Response(
        JSON.stringify({ success: true, vesselId: 'activity-api-test', expiresAt: Date.now() + 300000 }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (urlStr.endsWith('/heartbeat')) {
      return heartbeatOk
        ? new Response(JSON.stringify({ success: true, nextHeartbeatMs: 60000 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(JSON.stringify({ error: 'Vessel not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
    }
    return new Response('Not found', { status: 404 });
  }) as any;
}

describe('DiscoveryClient re-registration after a failed heartbeat', () => {
  let client: DiscoveryClient;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    client = DiscoveryClient.getInstance();
    originalFetch = globalThis.fetch;
    // No real backoff waits: retries still happen, they just do not sleep.
    (client as any).sleep = async () => {};
  });

  afterEach(async () => {
    await client.shutdown();
    delete (client as any).sleep;
    globalThis.fetch = originalFetch;
  });

  it('a failed heartbeat calls register() before sendHeartbeat() returns', async () => {
    stubDiscovery(false);
    expect(await client.register()).toBe(true);
    expect((client as any).heartbeatTimer).toBeNull();

    const registerSpy = spyOn(client, 'register');
    try {
      const ok = await client.sendHeartbeat();
      expect(ok).toBe(false);
      expect(registerSpy).toHaveBeenCalledTimes(1);
      // The immediate re-registration succeeded against the stub, so the vessel is routable again.
      expect(client.isRegistered()).toBe(true);
    } finally {
      registerSpy.mockRestore();
    }
  });

  it('control: a successful heartbeat does not call register()', async () => {
    stubDiscovery(true);
    expect(await client.register()).toBe(true);

    const registerSpy = spyOn(client, 'register');
    try {
      const ok = await client.sendHeartbeat();
      expect(ok).toBe(true);
      expect(registerSpy).not.toHaveBeenCalled();
      expect(client.isRegistered()).toBe(true);
    } finally {
      registerSpy.mockRestore();
    }
  });
});
