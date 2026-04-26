/**
 * /v2/impulses/resolve → mcpTool
 *
 * Activity-api dispatches its write surface through the existing `*_write`
 * impulse shapes (see `case 'activityExecutionTrace_write'` in impulses.ts).
 * Per docs/specs/discovery-to-tools-bridge.md § "Relationship to impulse-write
 * resolver", that's the preferred dispatch path. The mcpTool resolver here is
 * therefore wired to advertise the shape but return an empty tool list, so
 * consumers fanning out to activity-api don't 4xx.
 *
 * These tests verify:
 *   - The resolver returns 200 (not 404) for `mcpTool` regardless of context
 *   - The envelope shape matches the spec's bridge contract
 *   - Auth is still enforced (consistent with every other shape)
 */

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import impulsesRoutes from './impulses';
import { config } from '../config';

/**
 * Mount the impulses router on a fresh Hono app with a stub-auth middleware
 * that injects a JwtAuthContext into the request context. Mirrors how
 * jwtAuthMiddleware sets `c.set('jwtAuth', ...)` in production.
 */
function buildAppWithStubAuth(): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('jwtAuth', {
      orgId: 'test-org',
      projectId: undefined,
      projectIds: undefined,
      instanceId: undefined,
      authType: 'jwt',
      jwtToken: 'stub-jwt-for-tests',
    });
    await next();
  });
  app.route('/v2/impulses', impulsesRoutes);
  return app;
}

async function resolve(
  app: Hono,
  pointer: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe('POST /v2/impulses/resolve → mcpTool (activity-api)', () => {
  test('empty context returns success with empty tool list', async () => {
    const app = buildAppWithStubAuth();
    const { status, body } = await resolve(app, { type: 'mcpTool' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.metadata.shape).toBe('mcpTool');
    expect(body.metadata.rowCount).toBe(0);
    // content is JSON-encoded array (consistent with other resolvers)
    expect(typeof body.content).toBe('string');
    expect(JSON.parse(body.content)).toEqual([]);
    expect(body.metadata.summary).toContain('0 tools');
  });

  test('returns vessel_id in metadata so consumer can attribute the empty result', async () => {
    const app = buildAppWithStubAuth();
    const { body } = await resolve(app, { type: 'mcpTool' });
    expect(body.metadata.vessel_id).toBe(config.discovery.vesselId);
  });

  test('context fields are accepted but do not change the empty response', async () => {
    const app = buildAppWithStubAuth();
    const { status, body } = await resolve(app, {
      type: 'mcpTool',
      context: {
        goal_keywords: ['concept', 'edge'],
        input_shapes: ['concept'],
        output_shapes: ['concept_edge'],
        task_description: 'Test task',
      },
      limit: 20,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.metadata.rowCount).toBe(0);
  });

  test('rejects unauthenticated requests (consistent with other shapes)', async () => {
    const app = new Hono();
    // No stub auth → requireAuthenticated() rejects
    app.route('/v2/impulses', impulsesRoutes);
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointer: { type: 'mcpTool' } }),
    });
    expect(res.status).toBe(401);
  });

  test('mcpTool shape is advertised in discovery config', async () => {
    expect(config.discovery.shapes).toContain('mcpTool');
  });
});
