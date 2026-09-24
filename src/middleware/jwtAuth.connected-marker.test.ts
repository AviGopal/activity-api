/**
 * The connected marker: authenticated requests that arrive from a non-loopback
 * address are recorded per key in `<install dir>/connected.json`, which
 * `substrate-status` reads for the `connected` level.
 *
 * Covers:
 *   1. loopback callers (vessels inside the container) never write it
 *   2. an external authenticated caller writes it, with remote + key id
 *   3. a repeat of the same key in the same process does not rewrite it
 *   4. another key arriving first (a federated peer on a hub) does not hide the
 *      emitted key: the emitted key's arrival takes the top-level fields, both are
 *      kept under `by_key_id` (the form substrate-status reads), and recording stops once the emitted key is seen
 *   5. an unauthenticated / rejected request never writes it
 *   6. a failed write never fails the request
 *   7. no server in c.env (tests, other adapters) is a silent no-op
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const validateApiKeyWithFallbackImpl = mock(async (apiKey: string) => ({
  authenticated: true,
  orgId: 'org-test',
  userId: 'user-test',
  keyId: `key-${apiKey}`,
  scopes: ['read', 'write'],
  authMethod: 'identity-vessel',
} as any));
const generateJwtTokenImpl = mock(async (_ctx: unknown) => 'eyJ.real-jwt.signature' as string | null);

mock.module('../services/auth', () => ({
  validateApiKeyWithFallback: validateApiKeyWithFallbackImpl,
  generateJwtToken: generateJwtTokenImpl,
}));

mock.module('../db/surreal', () => ({
  createAuthenticatedClient: async () => ({
    query: async () => [],
    close: async () => {},
  }),
}));

const { jwtAuthMiddleware, isLoopbackAddress, _resetConnectedMarkerForTest } = await import('./jwtAuth');
const { _resetAuthKeyCache } = await import('./auth-cache');

function appWithMiddleware(): Hono {
  const app = new Hono();
  app.use('/v2/*', async (c, next) => jwtAuthMiddleware(c, next));
  app.post('/v2/probe', (c) => c.json({ ok: true }));
  return app;
}

/** Bun passes the server as the second fetch argument; Hono exposes it as c.env. */
function serverFrom(address: string) {
  return { requestIP: (_req: Request) => ({ address, family: 'IPv4', port: 40000 }) };
}

async function settle(): Promise<void> {
  // The write is fire-and-forget; give its promise chain a few turns.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe('connected marker', () => {
  let dir: string;
  let saved: string | undefined;
  let savedKey: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'connected-marker-'));
    saved = process.env['SUBSTRATE_INSTALL_DIR'];
    savedKey = process.env['METABOB_API_KEY'];
    process.env['SUBSTRATE_INSTALL_DIR'] = join(dir, '.install');
    process.env['METABOB_API_KEY'] = 'emitted';
    _resetConnectedMarkerForTest();
    _resetAuthKeyCache();
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['SUBSTRATE_INSTALL_DIR'];
    else process.env['SUBSTRATE_INSTALL_DIR'] = saved;
    if (savedKey === undefined) delete process.env['METABOB_API_KEY'];
    else process.env['METABOB_API_KEY'] = savedKey;
    await rm(dir, { recursive: true, force: true });
  });

  test('classifies loopback addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.3.2.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.104')).toBe(false);
    expect(isLoopbackAddress('169.254.1.2')).toBe(false);
    expect(isLoopbackAddress('172.17.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.5')).toBe(false);
  });

  test('a loopback caller does not write the marker', async () => {
    const res = await appWithMiddleware().request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey k' } }, serverFrom('127.0.0.1'));
    expect(res.status).toBe(200);
    await settle();
    expect(await exists(join(dir, '.install', 'connected.json'))).toBe(false);
  });

  test('the first external authenticated request writes it; a repeat of the same key does not', async () => {
    const app = appWithMiddleware();
    const res = await app.request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey emitted' } }, serverFrom('10.0.0.104'));
    expect(res.status).toBe(200);
    await settle();
    const path = join(dir, '.install', 'connected.json');
    const rec = JSON.parse(await readFile(path, 'utf8'));
    expect(rec.remote).toBe('10.0.0.104');
    expect(rec.key_id).toBe('key-emitted');
    expect(rec.emitted_key).toBe(true);
    expect(rec.auth_type).toBe('apikey');
    expect(typeof rec.first_at).toBe('string');
    expect(rec.pid).toBe(process.pid);
    expect(rec.by_key_id['key-emitted'].remote).toBe('10.0.0.104');

    // A second external request in the same process leaves the record alone.
    await app.request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey emitted' } }, serverFrom('10.9.9.9'));
    await settle();
    const again = JSON.parse(await readFile(path, 'utf8'));
    expect(again.remote).toBe('10.0.0.104');
    expect(again.first_at).toBe(rec.first_at);
  });

  test('a peer key arriving first does not hide the emitted key', async () => {
    const app = appWithMiddleware();
    const path = join(dir, '.install', 'connected.json');
    await app.request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey spoke-a' } }, serverFrom('203.0.113.7'));
    await settle();
    const first = JSON.parse(await readFile(path, 'utf8'));
    // Until the emitted key arrives the top level names the first external key, so the
    // status reader says which key connected rather than passing.
    expect(first.key_id).toBe('key-spoke-a');
    expect(first.emitted_key).toBe(false);

    await app.request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey emitted' } }, serverFrom('10.0.0.104'));
    await settle();
    const rec = JSON.parse(await readFile(path, 'utf8'));
    expect(rec.key_id).toBe('key-emitted');
    expect(rec.emitted_key).toBe(true);
    expect(rec.remote).toBe('10.0.0.104');
    expect(Object.keys(rec.by_key_id).sort()).toEqual(['key-emitted', 'key-spoke-a']);

    // Recording stops once the emitted key is seen.
    await app.request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey spoke-b' } }, serverFrom('203.0.113.8'));
    await settle();
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(Object.keys(after.by_key_id).sort()).toEqual(['key-emitted', 'key-spoke-a']);
    expect(after.key_id).toBe('key-emitted');
  });

  test('a rejected request never writes it', async () => {
    const res = await appWithMiddleware().request('/v2/probe', { method: 'POST' }, serverFrom('10.0.0.104'));
    expect(res.status).toBe(401);
    await settle();
    expect(await exists(join(dir, '.install', 'connected.json'))).toBe(false);
  });

  test('a failed write never fails the request', async () => {
    // A regular FILE where the directory should be makes mkdir fail.
    await writeFile(join(dir, 'blocked'), 'not a directory');
    process.env['SUBSTRATE_INSTALL_DIR'] = join(dir, 'blocked', '.install');
    const res = await appWithMiddleware().request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey k' } }, serverFrom('10.0.0.104'));
    expect(res.status).toBe(200);
    await settle();
  });

  test('no server in c.env is a silent no-op', async () => {
    const res = await appWithMiddleware().request('/v2/probe', { method: 'POST', headers: { Authorization: 'ApiKey k' } });
    expect(res.status).toBe(200);
    await settle();
    expect(await exists(join(dir, '.install', 'connected.json'))).toBe(false);
  });
});
