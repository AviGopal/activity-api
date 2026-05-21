/**
 * Tests for test_report_write resolver — spec A.3.2
 *
 * Verifies the auto-tag rule: any test_report written without a
 * test_registration_id pointer MUST carry caveats:["unregistered"].
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Stub SurrealDB — avoids live-DB dependency.
// The write resolver reads the created row's id from the first result row;
// we return a fake row so the handler can extract it.
// ---------------------------------------------------------------------------

const FAKE_ID = 'test_report:autotag_test_001';

mock.module('../src/db/surreal', () => ({
  surrealDB: {
    query: async (_sql: string, _params?: Record<string, unknown>) => {
      return [{ id: FAKE_ID }];
    },
  },
  queryWithAuth: async (_token: string, _sql: string, _params?: Record<string, unknown>) => {
    return [{ id: FAKE_ID }];
  },
  createAuthenticatedClient: async () => ({}),
  executeAsAuth: async (_auth: unknown, _sql: string, _params?: Record<string, unknown>) => {
    return [{ id: FAKE_ID }];
  },
}));

const impulsesRoutes = (await import('../src/routes/impulses')).default;

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
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

const MINIMAL_REPORT = {
  test_id: 'validation/scripts/test-slot-binding-chain',
  run_id: 'run-2026-05-20-001',
  passed: true,
  passes: [],
  witnesses: [],
};

describe('test_report_write — spec A.3.2 auto-tag unregistered', () => {
  test('report WITHOUT test_registration_id gets caveats:["unregistered"]', async () => {
    const app = buildApp(VALID_AUTH);
    const { status, body } = await callResolve(app, {
      type: 'test_report_write',
      body: MINIMAL_REPORT,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const content = JSON.parse(body.content as string);
    expect(content.caveats).toContain('unregistered');
  });

  test('report WITH test_registration_id does NOT get unregistered caveat', async () => {
    const app = buildApp(VALID_AUTH);
    const { status, body } = await callResolve(app, {
      type: 'test_report_write',
      body: {
        ...MINIMAL_REPORT,
        test_registration_id: 'test_registration:known_test',
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const content = JSON.parse(body.content as string);
    expect(content.caveats).not.toContain('unregistered');
  });

  test('report with existing caveats keeps them when unregistered caveat is added', async () => {
    const app = buildApp(VALID_AUTH);
    const { status, body } = await callResolve(app, {
      type: 'test_report_write',
      body: {
        ...MINIMAL_REPORT,
        caveats: ['single_witness'],
        // no test_registration_id
      },
    });

    expect(status).toBe(200);
    const content = JSON.parse(body.content as string);
    expect(content.caveats).toContain('unregistered');
    expect(content.caveats).toContain('single_witness');
  });

  test('missing body returns 400', async () => {
    const app = buildApp(VALID_AUTH);
    const { status } = await callResolve(app, { type: 'test_report_write' });
    expect(status).toBe(400);
  });

  test('unauthenticated request returns 401', async () => {
    const app = buildApp(undefined);
    const { status } = await callResolve(app, {
      type: 'test_report_write',
      body: MINIMAL_REPORT,
    });
    expect(status).toBe(401);
  });
});
