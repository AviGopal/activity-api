/**
 * CHECK for gap activity-re-register-resets-posteriors-to-exit-status-counts-erasing-reach-and-chain-credit.
 *
 * The row's must-fail: an arm whose alpha/beta sit above its exit-status counts (earned by reach grading or chain
 * credit) keeps them across a re-register. Control: a brand-new arm still gets the neutral prior.
 * Logic reused from the fix's own test (src/routes/activities.register-keeps-posterior.test.ts), with the module
 * paths moved to this directory; the route under test is reached only through the module's default export and
 * variantMetricsRecordId.
 */
/**
 * RE-REGISTERING A TEMPLATE DOES NOT REWRITE ITS POSTERIOR FROM EXIT-STATUS COUNTERS (D8a).
 *
 * POST /templates ran a "reconcile" before its metrics UPSERT: wherever the stored thompson_alpha/beta differed from
 * (successful_executions + 1, failed_executions + 1), it overwrote them with those counts. The counters count EXIT
 * STATUS (a clean exit is a success whether or not it reached), so every (re-)registration of a template replaced its
 * reach-graded posterior with exit-status alpha, with no verdict anywhere: a 0%-reached arm with 40 clean exits came
 * back from a re-register at alpha 41.
 *
 * THE RULE PINNED HERE:
 *   - MUST-FAIL: re-registering a template with a graded posterior (alpha 7.5, beta 2) and exit counters (40 / 2)
 *     leaves alpha/beta exactly as they were.
 *   - CONTROL: the register-time metrics UPSERT still seeds a NEW row's posterior at the neutral prior (1, 1) and
 *     keeps an existing row's values (thompson_alpha ?? 1.0).
 *
 * Harness: spies on the real exports, restored afterAll (no mock.module); the database is a recorder holding one
 * variant_performance_metrics row, and the statements this route sends against it are applied to that row.
 */

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';

const STUB_ORIGIN = 'http://127.0.0.1:9';
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= STUB_ORIGIN;
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';
process.env.POSTERIOR_COALESCE ??= '0';
process.env.PRIOR_SEED_ENABLED ??= 'false';
process.env.RELEVANCE_SINK_ENDPOINT ??= STUB_ORIGIN;

// ---- Network guard ----------------------------------------------------------
// The database is a recorder below, so nothing here needs the network. A fetch outside the stub origin, or any
// WebSocket, is recorded and thrown; the test that caused it fails in afterEach and the summary test fails too
// (the route swallows most errors, so a throw alone would be silent).
const forbiddenNet: string[] = [];
const outbound: string[] = [];
function forbidNetwork(what: string): never {
  forbiddenNet.push(what);
  throw new Error(`NETWORK GUARD: ${what}`);
}
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  outbound.push(url);
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* not a URL */ }
  if (origin !== STUB_ORIGIN) forbidNetwork(`fetch ${url}`);
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
(globalThis as any).WebSocket = class GuardedWebSocket {
  constructor(url: unknown) { forbidNetwork(`WebSocket ${String(url)}`); }
};
let forbiddenSeen = 0;
afterEach(() => {
  const fresh = forbiddenNet.slice(forbiddenSeen);
  forbiddenSeen = forbiddenNet.length;
  expect(fresh).toEqual([]);
});

type Row = Record<string, unknown>;
const queries: { sql: string; params: any }[] = [];
// The one metrics row the route can touch, by record slug.
const vpm = new Map<string, Row>();
function answer(sql: string, params: any): any {
  queries.push({ sql, params });
  // The register-time posterior reconcile (if the route still sends it): applied as SurrealDB would.
  if (/thompson_alpha\s*=\s*\(IF successful_executions = NONE THEN 0 ELSE successful_executions END\) \+ 1/.test(sql)) {
    const row = vpm.get(String(params?.slug));
    if (row) {
      const a = Number(row.successful_executions ?? 0) + 1;
      const b = Number(row.failed_executions ?? 0) + 1;
      if (row.thompson_alpha !== a || row.thompson_beta !== b) { row.thompson_alpha = a; row.thompson_beta = b; }
    }
    return [];
  }
  const up = /UPSERT\s+variant_performance_metrics:`([^`]+)`\s+SET/.exec(sql);
  if (up) {
    const slug = up[1]!;
    const row = vpm.get(slug) ?? {};
    row.thompson_alpha = row.thompson_alpha ?? 1.0;
    row.thompson_beta = row.thompson_beta ?? 1.0;
    row.successful_executions = row.successful_executions ?? 0;
    row.failed_executions = row.failed_executions ?? 0;
    vpm.set(slug, row);
    return [[row]];
  }
  return [];
}

const surrealMod = await import('../../src/db/surreal');
const redisMod = await import('../../src/db/redis');
const broadcasterMod = await import('../../src/websocket/broadcaster');
const paradigmMod = await import('../../src/db/paradigm');
const variantCreatorMod = await import('../../src/services/variant-creator');

const spies: Array<{ mockRestore(): void }> = [];
function stub(obj: any, key: string, impl: (...args: any[]) => unknown): void {
  if (obj == null || typeof obj[key] !== 'function') return;
  spies.push(spyOn(obj, key).mockImplementation(impl as never));
}
stub(surrealMod.surrealDB, 'query', async (sql: string, params: any) => answer(sql, params));
stub(surrealMod.surrealDB, 'queryAll', async (sql: string, params: any) => answer(sql, params));
stub(surrealMod.surrealDB, 'getInstance', async () => ({}));
stub(surrealMod.surrealDB, 'connect', async () => { throw new Error('SurrealDB is not available in this test'); });
stub(surrealMod, 'queryWithAuth', async (_token: string, sql: string, params: any) => answer(sql, params));
stub(surrealMod, 'createAuthenticatedClient', async () => ({}));
const redisProto = redisMod.RedisClient?.prototype;
stub(redisProto, 'del', async () => 0);
stub(redisProto, 'get', async () => null);
stub(redisProto, 'set', async () => 'OK');
stub(redisProto, 'sadd', async () => 0);
stub(redisProto, 'smembers', async () => []);
stub(redisProto, 'srem', async () => 0);
stub(redisProto, 'withLock', async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn());
stub(redisProto, 'getClient', () => null);
stub(broadcasterMod.broadcaster, 'emit', () => {});
stub(paradigmMod, 'insertActivity', async () => null);
stub(paradigmMod, 'insertExecution', async () => null);
stub(paradigmMod, 'isDualWriteEnabled', () => false);
stub(paradigmMod, 'transformToLegacyTemplate', (t: any) => t);
stub(paradigmMod, 'normalizeActivityId', (id: string) => id.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''));
stub(variantCreatorMod, 'autoCreateVariantIfNeeded', async () => null);
stub(variantCreatorMod, 'checkAndRetireTemplate', async () => false);

afterAll(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  globalThis.fetch = originalFetch;
  (globalThis as any).WebSocket = originalWebSocket;
});

const activitiesMod = await import('../../src/routes/activities');
const app = new Hono();
app.use('*', async (c, next) => {
  c.set('jwtAuth' as any, { orgId: 'organizations:test', jwtToken: '', authType: 'apikey', keyId: 'key-test', scopes: ['read', 'write'] });
  await next();
});
app.route('/v2/activities', activitiesMod.default);

const template = (id: string) => ({
  id,
  name: `D8a re-register fixture ${id}`,
  description: 'A template re-registered after it has a graded posterior',
  category: 'tool',
  tasks: [{ id: 't1', description: 'one', prompt: { template: 'do thing' } }],
  scope: 'global' as const,
  public: false,
  output_shapes: ['tool_output'],
});
async function register(id: string): Promise<number> {
  const res = await app.request('/v2/activities/templates', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(template(id)),
  });
  return res.status;
}

describe('MUST-FAIL — re-registration leaves a graded posterior alone', () => {
  test('alpha 7.5 / beta 2 with exit counters 40 / 2: after re-register, still 7.5 / 2', async () => {
    const id = 'd8a-reregistered-arm';
    const slug = activitiesMod.variantMetricsRecordId(id, null);
    vpm.set(slug, { thompson_alpha: 7.5, thompson_beta: 2, successful_executions: 40, failed_executions: 2 });
    expect(await register(id)).toBeLessThan(400);
    expect(queries.some((q) => /variant_performance_metrics/.test(q.sql))).toBe(true);
    expect({ a: vpm.get(slug)!.thompson_alpha, b: vpm.get(slug)!.thompson_beta }).toEqual({ a: 7.5, b: 2 });
  });
});

describe('CONTROL — the register-time UPSERT seeds a new row at the neutral prior', () => {
  test('a first registration creates the row at alpha 1 / beta 1', async () => {
    const id = 'd8a-new-arm';
    const slug = activitiesMod.variantMetricsRecordId(id, null);
    vpm.delete(slug);
    expect(await register(id)).toBeLessThan(400);
    expect({ a: vpm.get(slug)?.thompson_alpha, b: vpm.get(slug)?.thompson_beta }).toEqual({ a: 1, b: 1 });
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
