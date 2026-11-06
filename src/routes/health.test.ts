/**
 * Health Endpoint Integration Tests
 *
 * src/index.ts has no default export: it starts its own Bun.serve on import, and
 * config (DISCOVERY_ENABLED among it) is frozen at process start. So each case
 * boots the real service in a child bun on a free port with its own env and
 * reads /health over HTTP. Redis, SurrealDB and discovery point at a closed port
 * unless the parent env names real ones, so nothing outside is reached.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

const CLOSED = 'http://127.0.0.1:9';
const children: Subprocess[] = [];

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = s.port as number;
  s.stop(true);
  return port;
}

/** Boot src/index.ts with the given discovery switch; resolve its first /health answer. */
async function bootAndProbe(discoveryEnabled: boolean): Promise<{ status: number; body: any }> {
  const port = freePort();
  const child = Bun.spawn(['bun', join(import.meta.dir, '..', 'index.ts')], {
    env: {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      PORT: String(port),
      DISCOVERY_ENABLED: String(discoveryEnabled),
      DISCOVERY_VESSEL_ENDPOINT: CLOSED,
      REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:9',
      SURREALDB_URL: process.env.SURREALDB_URL ?? CLOSED,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(child);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return { status: res.status, body: await res.json() };
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`activity-api child on :${port} never answered /health`);
}

describe('Health Endpoint with Discovery', () => {
  let enabled: { status: number; body: any };
  let disabled: { status: number; body: any };

  beforeAll(async () => {
    [enabled, disabled] = await Promise.all([bootAndProbe(true), bootAndProbe(false)]);
  }, 60_000);

  afterAll(() => {
    for (const c of children) c.kill();
  });

  it('should include discovery status in health check when enabled', () => {
    expect([200, 503]).toContain(enabled.status);

    const body = enabled.body;

    expect(body).toHaveProperty('service', 'activity-api');
    expect(body).toHaveProperty('version');
    expect(body).toHaveProperty('checks');
    expect(body.checks).toHaveProperty('discovery');

    const discoveryCheck = body.checks.discovery;

    // Discovery check should have status and registered fields
    expect(discoveryCheck).toHaveProperty('status');
    expect(discoveryCheck).toHaveProperty('registered');

    // Enabled: one of healthy, unhealthy, pending (never disabled)
    expect(['healthy', 'unhealthy', 'pending']).toContain(discoveryCheck.status);
  });

  it('should show discovery as disabled when DISCOVERY_ENABLED=false', () => {
    expect(disabled.body.checks.discovery.status).toBe('disabled');
    expect(disabled.body.checks.discovery.registered).toBe(false);
  });

  it('should not fail health check when discovery is down', () => {
    // Discovery points at a closed port, so it is down (or still pending).
    expect(enabled.body.checks.discovery.registered).toBe(false);

    // Overall status follows the critical services (Redis, SurrealDB) only.
    const { redis, surrealdb } = enabled.body.checks;
    const critical = redis.status !== 'unhealthy' && surrealdb.status !== 'unhealthy';
    expect(enabled.body.status).toBe(critical ? 'healthy' : 'unhealthy');
    expect(enabled.status).toBe(critical ? 200 : 503);
  });
});
