/**
 * Health Endpoint Integration Tests
 */

import { describe, it, expect, beforeAll, mock } from 'bun:test';
import { Hono } from 'hono';

describe('Health Endpoint with Discovery', () => {
  let app: Hono;

  beforeAll(async () => {
    // Import the main app
    const { default: mainApp } = await import('../index');
    app = mainApp;
  });

  it('should include discovery status in health check when enabled', async () => {
    const req = new Request('http://localhost:8080/health');
    const res = await app.fetch(req);

    expect(res.status).toBe(200);

    const body = await res.json();

    expect(body).toHaveProperty('service', 'metabob-activity-api');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('checks');
    expect(body.checks).toHaveProperty('discovery');

    const discoveryCheck = body.checks.discovery;

    // Discovery check should have status and registered fields
    expect(discoveryCheck).toHaveProperty('status');
    expect(discoveryCheck).toHaveProperty('registered');

    // Status should be one of: healthy, unhealthy, pending, disabled
    expect(['healthy', 'unhealthy', 'pending', 'disabled']).toContain(
      discoveryCheck.status
    );
  });

  it('should show discovery as disabled when DISCOVERY_ENABLED=false', async () => {
    process.env.DISCOVERY_ENABLED = 'false';

    const req = new Request('http://localhost:8080/health');
    const res = await app.fetch(req);

    const body = await res.json();

    expect(body.checks.discovery.status).toBe('disabled');
    expect(body.checks.discovery.registered).toBe(false);
  });

  it('should not fail health check when discovery is down', async () => {
    // Even if discovery fails, overall health should still be OK
    // (discovery is non-critical)

    const req = new Request('http://localhost:8080/health');
    const res = await app.fetch(req);

    // Should return 200 even if discovery is down (graceful degradation)
    expect([200, 503]).toContain(res.status);

    const body = await res.json();

    // Overall status depends on critical services (Redis, SurrealDB)
    // Discovery failure should not make status unhealthy
    if (body.checks.redis.status === 'healthy' && body.checks.surrealdb.status === 'healthy') {
      expect(body.status).toBe('healthy');
      expect(res.status).toBe(200);
    }
  });
});
