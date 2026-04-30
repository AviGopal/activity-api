/**
 * Background: POST /v2/impulses returned HTTP 500 with Hono's
 * "Context is not finalized. Did you forget to return a Response object or
 * `await next()`?" error for every minibob impulse-storage call.
 *
 * Two compounding causes, both fixed:
 *
 * 1. `jwtAuthMiddleware` short-circuits on a missing Authorization header
 *    with `return c.json({...}, 401)`. The wrapper at `index.ts` did
 *    `await jwtAuthMiddleware(c, next)` (no `return`), so the Response was
 *    discarded. Hono saw the wrapper finish without `c.finalized=true` and
 *    threw the unfinalized-context error → HTTP 500.
 *
 * 2. The reject-by-default middleware (commit 2798831, 2026-04-25) blocked
 *    requests with only `X-Internal-Api-Key` (no `Authorization`) — but the
 *    impulse routes (POST /, GET /:id, GET /) explicitly accept that header
 *    as an alternative auth scheme for vessel-to-vessel calls. The middleware
 *    now passes those requests through with `jwtAuth=null`, letting the
 *    route handlers do their own validation.
 *
 * This test exercises the middleware in isolation against a mock route and
 * confirms (a) X-Internal-Api-Key requests are NOT 401'd, (b) requests with
 * neither header still return a clean 401 (not 500), and (c) the wrapper at
 * `src/index.ts` propagates the 401 Response through.
 */

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { jwtAuthMiddleware } from './jwtAuth';

function appWithMiddleware(): Hono {
  const app = new Hono();
  // Mirror the wrapper in src/index.ts (the wrapper that USED to drop the
  // Response). The wrapper now returns the middleware's result so 401
  // short-circuits propagate to the client.
  app.use('/v2/*', async (c, next) => {
    if (c.req.path.startsWith('/v2/auth/')) {
      await next();
      return;
    }
    return jwtAuthMiddleware(c, next);
  });
  app.post('/v2/impulses', (c) => c.json({ ok: true, jwtAuth: c.get('jwtAuth' as never) ?? null }));
  return app;
}

describe('jwtAuthMiddleware context finalization', () => {
  test('passes through X-Internal-Api-Key requests with jwtAuth=null', async () => {
    const app = appWithMiddleware();
    const res = await app.request('/v2/impulses', {
      method: 'POST',
      headers: {
        'X-Internal-Api-Key': 'test-internal-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ impulse_id: 'x', impulse_data: { type: 'memo' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.jwtAuth).toBeNull();
  });

  test('returns 401 (not 500 unfinalized-context) when no auth header at all', async () => {
    const app = appWithMiddleware();
    const res = await app.request('/v2/impulses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ impulse_id: 'x', impulse_data: { type: 'memo' } }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    // Crucially NOT the Hono unfinalized-context error
    expect(JSON.stringify(body)).not.toContain('Context is not finalized');
    expect(body?.error?.code).toBe('MISSING_AUTH');
  });

  test('still allows public path /health-style passthroughs (sanity)', async () => {
    const app = appWithMiddleware();
    // /v2/auth/* is the wrapper-internal exemption, used by login flows
    app.post('/v2/auth/login', (c) => c.json({ ok: true }));
    const res = await app.request('/v2/auth/login', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('regression: wrapper without return reproduces unfinalized-context 500', async () => {
    // Demonstrates the bug. The wrapper in src/index.ts USED to do
    //   await jwtAuthMiddleware(c, next);
    // discarding the Response from the middleware's c.json(401) short-circuit.
    // Hono then threw the "Context is not finalized" error, which was
    // surfaced as a 500.
    const app = new Hono();
    app.onError((err, c) => {
      // Mirror the global error handler in src/index.ts at runtime — it
      // returns 500 with the err.message for unhandled exceptions.
      return c.json(
        { error: 'Internal server error', message: err.message },
        500,
      );
    });
    app.use('/v2/*', async (c, next) => {
      // ⛔ Buggy form: no `return` — Response is discarded.
      await jwtAuthMiddleware(c, next);
    });
    app.post('/v2/impulses', (c) => c.json({ ok: true }));

    const res = await app.request('/v2/impulses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toContain('Context is not finalized');
  });
});
