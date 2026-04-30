/**
 * Tests for goal_verification_label_write resolver (migration 101)
 *
 * Verifies:
 *   - Valid payload → 200 with record ID
 *   - Invalid `verdict` value → 400
 *   - Invalid `labeler` value → 400
 *   - Missing required fields → 400
 *   - No auth context → 401
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Stub SurrealDB — must be registered before importing the route.
// The `query` stub returns a fake created row so the resolver can extract
// the record id without a live DB.
// ---------------------------------------------------------------------------

let nextQueryResult: unknown = [{ id: 'goal_verification_labels:test123' }];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (_sql: string, _params?: Record<string, unknown>) => {
      return nextQueryResult;
    },
  },
  queryWithAuth: async (_token: string, _sql: string, _params?: Record<string, unknown>) => {
    return nextQueryResult;
  },
  createAuthenticatedClient: async () => ({}),
}));

// Import AFTER mock is registered.
const impulsesRoutes = (await import('./impulses')).default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('jwtAuth', jwtAuth);
    await next();
  });
  app.route('/v2/impulses', impulsesRoutes);
  return app;
}

const VALID_AUTH = {
  orgId: 'org-test',
  authType: 'apikey' as const,
  jwtToken: 'test-jwt',
  keyId: 'test-key',
  scopes: ['read', 'write'],
};

async function callResolve(app: Hono, pointer: Record<string, unknown>) {
  const res = await app.request('/v2/impulses/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointer }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const VALID_PAYLOAD = {
  type: 'goal_verification_label_write',
  goal: 'Add input validation to the impulse endpoint',
  execution_id: 'exec-abc123',
  activity_id: 'activity:add-validation',
  verdict: 'achieved',
  confidence: 0.92,
  labeler: 'human',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v2/impulses/resolve → goal_verification_label_write', () => {
  test('valid payload returns 200 with record id', async () => {
    nextQueryResult = [{ id: 'goal_verification_labels:abc' }];
    const app = buildApp(VALID_AUTH);
    const { status, body } = await callResolve(app, VALID_PAYLOAD);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const content = JSON.parse(body.content as string) as { id: string };
    expect(content.id).toBe('goal_verification_labels:abc');
    expect((body.metadata as Record<string, unknown>).shape).toBe('goal_verification_label');
  });

  test('valid payload with optional notes returns 200', async () => {
    nextQueryResult = [{ id: 'goal_verification_labels:xyz' }];
    const app = buildApp(VALID_AUTH);
    const { status, body } = await callResolve(app, {
      ...VALID_PAYLOAD,
      notes: 'Files were modified as expected',
      labeler: 'automated',
      verdict: 'partial',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('invalid verdict value returns 400', async () => {
    const app = buildApp(VALID_AUTH);
    const { status, body } = await callResolve(app, {
      ...VALID_PAYLOAD,
      verdict: 'maybe',
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error as string).toContain('verdict must be one of');
  });

  test('invalid labeler value returns 400', async () => {
    const app = buildApp(VALID_AUTH);
    const { status, body } = await callResolve(app, {
      ...VALID_PAYLOAD,
      labeler: 'robot',
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error as string).toContain('labeler must be one of');
  });

  test('missing required field (goal) returns 400', async () => {
    const app = buildApp(VALID_AUTH);
    const { goal: _omitted, ...withoutGoal } = VALID_PAYLOAD;
    const { status, body } = await callResolve(app, withoutGoal);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error as string).toContain('required');
  });

  test('missing required field (execution_id) returns 400', async () => {
    const app = buildApp(VALID_AUTH);
    const { execution_id: _omitted, ...withoutExecId } = VALID_PAYLOAD;
    const { status, body } = await callResolve(app, withoutExecId);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('missing confidence returns 400', async () => {
    const app = buildApp(VALID_AUTH);
    const { confidence: _omitted, ...withoutConfidence } = VALID_PAYLOAD;
    const { status, body } = await callResolve(app, withoutConfidence);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('no auth context returns 401', async () => {
    const app = buildApp(null);
    const { status, body } = await callResolve(app, VALID_PAYLOAD);

    expect(status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error as string).toContain('Authentication required');
  });
});
