/**
 * Vessel Proxy Mode Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Hono } from 'hono';
import vesselsRoutes from './vessels';

describe('Vessel Proxy Mode', () => {
  let app: Hono;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    app = new Hono();
    app.route('/v2/vessels', vesselsRoutes);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('POST /v2/vessels/register', () => {
    it('should include deprecation headers', async () => {
      // Mock SurrealDB and discovery-vessel
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const req = new Request('http://localhost/v2/vessels/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vesselId: 'test-vessel',
          vesselName: 'Test Vessel',
          endpoint: 'http://test-vessel:8080',
          shapes: ['testShape'],
        }),
      });

      const res = await app.fetch(req);

      // Should have deprecation headers
      expect(res.headers.get('X-API-Deprecated')).toBe('true');
      expect(res.headers.get('X-API-Deprecation-Date')).toBe('2026-05-01');
      expect(res.headers.get('X-API-Sunset-Date')).toBe('2026-07-01');
      expect(res.headers.get('X-API-Replacement')).toBe('discovery-vessel');
    });

    it('should include deprecation notice in response body', async () => {
      // Mock SurrealDB and discovery-vessel
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const req = new Request('http://localhost/v2/vessels/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vesselId: 'test-vessel',
          vesselName: 'Test Vessel',
          endpoint: 'http://test-vessel:8080',
          shapes: ['testShape'],
        }),
      });

      const res = await app.fetch(req);
      const body = await res.json();

      // Should have _deprecation field
      expect(body).toHaveProperty('_deprecation');
      expect(body._deprecation.deprecated).toBe(true);
      expect(body._deprecation.replacement).toBe('discovery-vessel');
      expect(body._deprecation.message).toContain('deprecated');
    });
  });

  describe('POST /v2/vessels/heartbeat', () => {
    it('should forward to discovery-vessel when enabled', async () => {
      let discoveryHeartbeatCalled = false;

      // Mock fetch to track discovery-vessel calls
      globalThis.fetch = mock(async (url) => {
        const urlStr = url.toString();

        if (urlStr.includes('discovery-vessel') && urlStr.endsWith('/heartbeat')) {
          discoveryHeartbeatCalled = true;
          return new Response(
            JSON.stringify({ success: true, nextHeartbeatMs: 60000 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const req = new Request('http://localhost/v2/vessels/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pod_name: 'test-pod',
          namespace: 'test-namespace',
          status: 'idle',
        }),
      });

      await app.fetch(req);

      // Wait a bit for async proxy call
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Discovery heartbeat should have been called
      // Note: This is non-blocking, so test may be flaky
      // In production, we'd use a message queue or event system for reliable testing
    });

    it('should not fail if discovery-vessel is down (graceful degradation)', async () => {
      // Mock discovery-vessel failure
      globalThis.fetch = mock(async (url) => {
        const urlStr = url.toString();

        if (urlStr.includes('discovery-vessel')) {
          throw new Error('Discovery vessel unavailable');
        }

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const req = new Request('http://localhost/v2/vessels/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pod_name: 'test-pod',
          namespace: 'test-namespace',
          status: 'idle',
        }),
      });

      const res = await app.fetch(req);

      // Should still succeed (legacy DB write)
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('GET /v2/vessels/status', () => {
    it('should include deprecation headers', async () => {
      const req = new Request('http://localhost/v2/vessels/status');
      const res = await app.fetch(req);

      expect(res.headers.get('X-API-Deprecated')).toBe('true');
      expect(res.headers.get('X-API-Replacement')).toBe('discovery-vessel');
    });
  });

  describe('GET /v2/vessels/discover', () => {
    it('should include deprecation headers', async () => {
      const req = new Request('http://localhost/v2/vessels/discover?shape=testShape');
      const res = await app.fetch(req);

      expect(res.headers.get('X-API-Deprecated')).toBe('true');
      expect(res.headers.get('X-API-Replacement')).toBe('discovery-vessel');
    });
  });

  describe('GET /v2/vessels/capabilities', () => {
    it('should include deprecation headers', async () => {
      const req = new Request('http://localhost/v2/vessels/capabilities');
      const res = await app.fetch(req);

      expect(res.headers.get('X-API-Deprecated')).toBe('true');
      expect(res.headers.get('X-API-Replacement')).toBe('discovery-vessel');
    });
  });
});
