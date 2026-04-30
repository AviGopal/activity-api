/**
 * /v2/impulses/resolve → discoverByShapesQuery
 *
 * activity-api advertises the `discoverByShapesQuery` shape so
 * meta-activities reach POST /v2/activities/discover-by-shapes through
 * the existing generic `impulse-resolve` resolver in minibob — no source changes
 * in the integrating vessel.
 *
 * These tests verify:
 *   - Validation errors (missing required_shapes, bad mode) flow through the
 *     ImpulseResolveResponse envelope (not the REST envelope).
 *   - The shape is advertised via `config.discovery.shapes`.
 *   - Auth is enforced consistent with every other shape.
 *   - Successful resolutions return the canonical {success: true, content, metadata}
 *     envelope with `content` JSON-encoding {activities, total} (matching the
 *     REST route's body for the same input).
 *
 * The full SQL path is exercised by `routes/discover-by-shapes.test.ts` (which
 * requires a live SurrealDB) — tests here that need a working DB lift the same
 * fixture pattern when DB is available, and otherwise assert structural contracts.
 */

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import impulsesRoutes from './impulses';
import activitiesRoutes from './activities';
import { config } from '../config';
import { surrealDB } from '../db/surreal';

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
  app.route('/v2/activities', activitiesRoutes);
  return app;
}

async function resolveShape(
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

async function postRest(
  app: Hono,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const res = await app.request('/v2/activities/discover-by-shapes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseBody = await res.json();
  return { status: res.status, body: responseBody };
}

/**
 * Probe whether SurrealDB is reachable for the integration sub-tests below.
 * If not, the path tests that require it are conditionally skipped (so the
 * unit-validation portion still runs in offline harnesses).
 */
async function dbIsReachable(): Promise<boolean> {
  try {
    await surrealDB.query('RETURN 1');
    return true;
  } catch {
    return false;
  }
}

describe('POST /v2/impulses/resolve → discoverByShapesQuery (validation)', () => {
  test('missing required_shapes returns 400 in resolve envelope', async () => {
    const app = buildAppWithStubAuth();
    const { status, body } = await resolveShape(app, {
      type: 'discoverByShapesQuery',
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
  });

  test('empty required_shapes array returns 400', async () => {
    const app = buildAppWithStubAuth();
    const { status, body } = await resolveShape(app, {
      type: 'discoverByShapesQuery',
      required_shapes: [],
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('unknown mode returns 400', async () => {
    const app = buildAppWithStubAuth();
    const { status, body } = await resolveShape(app, {
      type: 'discoverByShapesQuery',
      required_shapes: ['validation_result'],
      mode: 'lateral',
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('rejects unauthenticated requests (consistent with other shapes)', async () => {
    const app = new Hono();
    app.route('/v2/impulses', impulsesRoutes);
    const res = await app.request('/v2/impulses/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pointer: {
          type: 'discoverByShapesQuery',
          required_shapes: ['x'],
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  test('discoverByShapesQuery is advertised in discovery shapes', () => {
    expect(config.discovery.shapes).toContain('discoverByShapesQuery');
  });
});

describe('POST /v2/impulses/resolve → discoverByShapesQuery (parity with REST route)', () => {
  test('shape result == REST result for the same input (forward, no DB rows)', async () => {
    if (!(await dbIsReachable())) {
      // No live DB — skip the parity assertion. The validation tests above
      // cover the contract; this case asserts shape-vs-REST equivalence
      // when DB is reachable.
      return;
    }
    const app = buildAppWithStubAuth();

    const restResp = await postRest(app, {
      required_shapes: ['__nonexistent_shape_for_parity_test__'],
      limit: 5,
    });
    const shapeResp = await resolveShape(app, {
      type: 'discoverByShapesQuery',
      required_shapes: ['__nonexistent_shape_for_parity_test__'],
      limit: 5,
    });

    expect(restResp.status).toBe(200);
    expect(shapeResp.status).toBe(200);
    expect(shapeResp.body.success).toBe(true);
    expect(typeof shapeResp.body.content).toBe('string');

    const shapePayload = JSON.parse(shapeResp.body.content);
    expect(shapePayload.total).toBe(restResp.body.total);
    expect(Array.isArray(shapePayload.activities)).toBe(true);
    expect(shapePayload.activities.length).toBe(restResp.body.activities.length);

    // Metadata envelope is canonical for impulse-resolve consumers.
    expect(shapeResp.body.metadata.shape).toBe('discoverByShapesQuery');
    expect(shapeResp.body.metadata.rowCount).toBe(restResp.body.total);
  });

  test('candidates_with_scores mode flows through the shape handler', async () => {
    if (!(await dbIsReachable())) return;
    const app = buildAppWithStubAuth();

    const shapeResp = await resolveShape(app, {
      type: 'discoverByShapesQuery',
      required_shapes: ['__nonexistent_shape_for_parity_test__'],
      mode: 'candidates_with_scores',
      limit: 3,
    });

    expect(shapeResp.status).toBe(200);
    expect(shapeResp.body.success).toBe(true);
    const payload = JSON.parse(shapeResp.body.content);
    // Empty result is fine — what matters is the mode was accepted and the
    // envelope is canonical.
    expect(Array.isArray(payload.activities)).toBe(true);
    // composition_score key is present on every row when mode=candidates_with_scores
    // (null for rows with no edge data) — assert structurally if any rows exist.
    for (const a of payload.activities) {
      expect(a).toHaveProperty('composition_score');
    }
  });
});
