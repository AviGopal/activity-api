/**
 * Discovery Client Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { DiscoveryClient } from './discovery-client';

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

  describe('isEnabled', () => {
    it('should return false when DISCOVERY_ENABLED=false', () => {
      process.env.DISCOVERY_ENABLED = 'false';
      const testClient = DiscoveryClient.getInstance();
      expect(testClient.isEnabled()).toBe(false);
    });

    it('should return true when DISCOVERY_ENABLED=true', () => {
      process.env.DISCOVERY_ENABLED = 'true';
      const testClient = DiscoveryClient.getInstance();
      expect(testClient.isEnabled()).toBe(true);
    });
  });

  describe('register', () => {
    it('should successfully register with discovery-vessel', async () => {
      // Mock successful registration
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            vesselId: 'activity-api-test',
            expiresAt: Date.now() + 300000,
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      });

      const success = await client.register();

      expect(success).toBe(true);
      expect(client.isRegistered()).toBe(true);
      expect(client.getLastError()).toBeNull();
    });

    it('should handle registration failure gracefully', async () => {
      // Mock failed registration
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({ error: 'Registration failed' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      });

      const success = await client.register();

      expect(success).toBe(false);
      expect(client.isRegistered()).toBe(false);
      expect(client.getLastError()).toContain('HTTP 400');
    });

    it('should retry on network errors', async () => {
      let attempts = 0;

      globalThis.fetch = mock(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Network error');
        }
        return new Response(
          JSON.stringify({
            success: true,
            vesselId: 'activity-api-test',
            expiresAt: Date.now() + 300000,
          }),
          {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      });

      const success = await client.register();

      expect(success).toBe(true);
      expect(attempts).toBe(3);
      expect(client.isRegistered()).toBe(true);
    });
  });

  describe('sendHeartbeat', () => {
    it('should send heartbeat when registered', async () => {
      // First register
      globalThis.fetch = mock(async (url) => {
        const urlStr = url.toString();

        if (urlStr.endsWith('/register')) {
          return new Response(
            JSON.stringify({
              success: true,
              vesselId: 'activity-api-test',
              expiresAt: Date.now() + 300000,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (urlStr.endsWith('/heartbeat')) {
          return new Response(
            JSON.stringify({
              success: true,
              nextHeartbeatMs: 60000,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response('Not found', { status: 404 });
      });

      await client.register();
      const success = await client.sendHeartbeat();

      expect(success).toBe(true);
      expect(client.isRegistered()).toBe(true);
    });

    it('should not send heartbeat when not registered', async () => {
      const success = await client.sendHeartbeat();
      expect(success).toBe(false);
    });

    it('should handle heartbeat failure and mark as unregistered', async () => {
      // Register first
      globalThis.fetch = mock(async (url) => {
        const urlStr = url.toString();

        if (urlStr.endsWith('/register')) {
          return new Response(
            JSON.stringify({
              success: true,
              vesselId: 'activity-api-test',
              expiresAt: Date.now() + 300000,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (urlStr.endsWith('/heartbeat')) {
          return new Response(
            JSON.stringify({ error: 'Vessel not found' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response('Not found', { status: 404 });
      });

      await client.register();
      expect(client.isRegistered()).toBe(true);

      const success = await client.sendHeartbeat();

      expect(success).toBe(false);
      expect(client.isRegistered()).toBe(false);
    });
  });

  describe('deregister', () => {
    it('should successfully deregister', async () => {
      globalThis.fetch = mock(async (url) => {
        const urlStr = url.toString();

        if (urlStr.endsWith('/register')) {
          return new Response(
            JSON.stringify({
              success: true,
              vesselId: 'activity-api-test',
              expiresAt: Date.now() + 300000,
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (urlStr.includes('/vessels/')) {
          return new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response('Not found', { status: 404 });
      });

      await client.register();
      const success = await client.deregister();

      expect(success).toBe(true);
      expect(client.isRegistered()).toBe(false);
    });
  });

  describe('heartbeatManager', () => {
    it('should start and stop heartbeat manager', () => {
      client.startHeartbeatManager();
      // Manager should be running (no exception)

      client.stopHeartbeatManager();
      // Manager should be stopped (no exception)
    });

    it('should not start heartbeat manager when disabled', () => {
      process.env.DISCOVERY_ENABLED = 'false';
      const testClient = DiscoveryClient.getInstance();

      testClient.startHeartbeatManager();
      // Should not throw, just log and return
    });
  });

  describe('updateMetrics', () => {
    it('should update execution metrics', () => {
      client.updateMetrics({
        executionsCompleted: 10,
        errorRate: 0.05,
        avgLatencyMs: 250,
      });

      // Metrics should be updated (verified via heartbeat payload)
    });
  });

  describe('resolver contract (Wave 1)', () => {
    // These tests lock in the resolver contract advertised to discovery-vessel
    // so Wave 1D (minibob generic resolver) can dispatch against this vessel
    // without hardcoded knowledge. See super-repo CLAUDE.md auth section.
    it('should advertise resolve_endpoint, request_format, auth_scheme, timeout in registration payload', async () => {
      process.env.DISCOVERY_ENABLED = 'true';
      let capturedBody: any = null;

      globalThis.fetch = mock(async (_url: any, options: any) => {
        if (options?.method === 'POST' && options?.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return new Response(
          JSON.stringify({
            success: true,
            vesselId: 'activity-api-test',
            expiresAt: Date.now() + 300000,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const success = await client.register();

      expect(success).toBe(true);
      expect(capturedBody).not.toBeNull();
      expect(capturedBody.resolve_endpoint).toBe('/v2/impulses/resolve');
      expect(capturedBody.resolve_request_format).toBe('pointer');
      expect(capturedBody.auth_scheme).toBe('ApiKey');
      expect(capturedBody.resolve_timeout_ms).toBe(10000);
    });

    it('should keep contract fields alongside pre-existing registration fields', async () => {
      process.env.DISCOVERY_ENABLED = 'true';
      let capturedBody: any = null;

      globalThis.fetch = mock(async (_url: any, options: any) => {
        if (options?.method === 'POST' && options?.body) {
          capturedBody = JSON.parse(options.body as string);
        }
        return new Response(
          JSON.stringify({
            success: true,
            vesselId: 'activity-api-test',
            expiresAt: Date.now() + 300000,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      });

      await client.register();

      // Contract fields must not clobber pre-existing payload shape
      expect(capturedBody.vesselName).toBe('metabob-activity-api');
      expect(capturedBody.protocol).toBe('http');
      expect(Array.isArray(capturedBody.shapes)).toBe(true);
      expect(capturedBody.metadata).toBeDefined();
    });
  });
});
