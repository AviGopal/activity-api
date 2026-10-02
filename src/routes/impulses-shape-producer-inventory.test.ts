/**
 * /v2/impulses/resolve → shape_producer_inventory reads discovery's real response.
 *
 * discovery-vessel answers a vesselCapability resolve with the ResolveResponse envelope
 * `{ content: { shape, vessels: [{ vesselId, ... }] }, metadata }` (discovery-vessel
 * src/resolvers.ts resolveVesselCapability, src/index.ts). The handler read a top-level
 * `vessels` with `id`, so every inventory answered count 0 / "no_producers" — the signal
 * slot-binding uses to choose forge_vessel_for_shape over binding an existing producer.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import impulsesRoutes from './impulses';

function app(): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('jwtAuth', { orgId: 'test-org', projectId: undefined, projectIds: undefined, instanceId: undefined, authType: 'jwt', jwtToken: 'stub' });
    await next();
  });
  a.route('/v2/impulses', impulsesRoutes);
  return a;
}

async function inventory(shape: string): Promise<Record<string, unknown>> {
  const res = await app().request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer: { type: 'shape_producer_inventory', shape } }),
  });
  const body = (await res.json()) as { content?: string };
  return JSON.parse(String(body.content ?? '{}'));
}

describe('shape_producer_inventory reads the discovery ResolveResponse envelope', () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env.DISCOVERY_VESSEL_ENDPOINT;
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  beforeEach(() => {
    process.env.DISCOVERY_VESSEL_ENDPOINT = 'http://discovery.test';
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).startsWith('http://discovery.test/')) {
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input as Request);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) delete process.env.DISCOVERY_VESSEL_ENDPOINT; else process.env.DISCOVERY_VESSEL_ENDPOINT = realEnv;
  });

  test('counts the producers discovery returns under content.vessels (by vesselId)', async () => {
    reply = { status: 200, body: { content: { shape: 'memoryNote', vessels: [{ vesselId: 'development-vessel', health_score: 1 }, { vesselId: 'concept-db', health_score: 0.9 }] }, metadata: { shape: 'vesselCapability' } } };
    const inv = await inventory('memoryNote');
    expect(inv.count).toBe(2);
    expect(inv.vessel_ids).toEqual(['development-vessel', 'concept-db']);
    expect(inv.health_summary).toBe('healthy');
  });

  test('a shape discovery has no producer for is still count 0 (control)', async () => {
    reply = { status: 200, body: { content: { shape: 'nope', vessels: [] }, metadata: { shape: 'vesselCapability' } } };
    const inv = await inventory('nope');
    expect(inv.count).toBe(0);
    expect(inv.health_summary).toBe('no_producers');
  });
});
