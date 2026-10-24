/**
 * THE ACCESS LOG NAMES THE CALLER.
 *
 * The hub's activity-api access log (hono/logger) printed method, path, status and elapsed time only, so a query storm
 * on GET /v2/activities/templates could be counted but not traced to the key or node sending it. The access log now
 * appends `caller=<label>`, read from the context the auth middleware set: the key id identity's validation returned,
 * the on-behalf-of node when there is one, `anon` when nobody authenticated. Driven through the real jwtAuthMiddleware
 * with identity's validation mocked:
 *   [MUST-FAIL] an authenticated API-key request's outgoing line names its key id (`caller=key:<id>`);
 *   [MUST-FAIL] an unauthenticated request's outgoing line says `caller=anon`;
 *   [CONTROL]   no secret material: the raw credential string appears in no log line, for a key that validates and
 *               for one that does not;
 *   [CONTROL]   the incoming/outgoing line shape is hono/logger's (`<-- GET /p`, `--> GET /p 200 <n>ms ...`), and
 *               index.ts mounts this logger instead of hono/logger.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';

const FIXTURE_ID_LABEL = ['fixture', 'id', 'label'].join('-');
// Obviously fake, random per run: the assertion is that this exact string is never printed.
const RAW_KEY = `fixture-credential-${crypto.randomUUID()}`;
const BAD_KEY = `fixture-bad-credential-${crypto.randomUUID()}`;

mock.module('../services/auth', () => ({
  validateApiKeyWithFallback: async (apiKey: string) =>
    apiKey === RAW_KEY
      ? { authenticated: true, orgId: 'org-fixture', userId: 'user-fixture', keyId: FIXTURE_ID_LABEL, scopes: ['read'] }
      : { authenticated: false, reason: 'invalid' },
  generateJwtToken: async () => 'fixture-jwt',
  validateBearerViaIdentity: async () => ({ authenticated: false, reason: 'not used by this test' }),
}));

mock.module('../db/surreal', () => ({
  createAuthenticatedClient: async () => ({ query: async () => [], close: async () => {} }),
}));

const accessLogModule = await import('./access-log').catch(() => null);
const { jwtAuthMiddleware } = await import('./jwtAuth');
const { _resetAuthKeyCache } = await import('./auth-cache');

let lines: string[] = [];

function app(): Hono {
  const a = new Hono();
  if (!accessLogModule) throw new Error('src/middleware/access-log.ts (the caller-attributing access log) is missing');
  a.use('/*', accessLogModule.accessLog((l: string) => { lines.push(l); }));
  a.use('/v2/*', async (c, next) => jwtAuthMiddleware(c, next));
  a.get('/v2/activities/templates', (c) => c.json({ templates: [] }));
  a.get('/health', (c) => c.json({ ok: true }));
  return a;
}

beforeEach(() => { lines = []; _resetAuthKeyCache(); });

describe('access log caller attribution', () => {
  test('[MUST-FAIL] an authenticated request names its key id', async () => {
    const res = await app().request('/v2/activities/templates?limit=100', { headers: { Authorization: `ApiKey ${RAW_KEY}` } });
    expect(res.status).toBe(200);
    const out = lines.find((l) => l.startsWith('-->'));
    expect(out).toBeDefined();
    expect(out!).toContain(`caller=key:${FIXTURE_ID_LABEL}`);
  });

  test('[MUST-FAIL] an unauthenticated request logs caller=anon', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    const out = lines.find((l) => l.startsWith('-->'));
    expect(out!).toMatch(/ caller=anon$/);
  });

  test('[CONTROL] the raw credential never appears in the log', async () => {
    await app().request('/v2/activities/templates', { headers: { Authorization: `ApiKey ${RAW_KEY}` } });
    const refused = await app().request('/v2/activities/templates', { headers: { Authorization: `ApiKey ${BAD_KEY}` } });
    expect(refused.status).toBe(401);
    expect(lines.length).toBe(4);
    for (const l of lines) {
      expect(l).not.toContain(RAW_KEY);
      expect(l).not.toContain(BAD_KEY);
    }
    expect(lines[3]).toMatch(/ caller=anon$/);
  });

  test("[CONTROL] the line shape is hono/logger's and index.ts mounts this logger", async () => {
    await app().request('/v2/activities/templates?offset=200', { headers: { Authorization: `ApiKey ${RAW_KEY}` } });
    expect(lines[0]).toBe('<-- GET /v2/activities/templates?offset=200');
    expect(lines[1]).toMatch(/^--> GET \/v2\/activities\/templates\?offset=200 200 \d+(ms|s) caller=\S+$/);
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/app\.use\('\/\*', accessLog\(\)\)/);
    expect(src).not.toMatch(/from 'hono\/logger'/);
  });
});
