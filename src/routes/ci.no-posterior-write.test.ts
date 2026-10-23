/**
 * A CI RESULT WRITES NO POSTERIOR (D8a follow-up: a second posterior writer on the variant row).
 *
 * POST /v2/activities/ci-result added +0.5 alpha on a CI pass (+0.5 beta on a fail) straight to the execution's
 * variant_performance_metrics row. That is a second posterior writer beside the one graded writer
 * (applyOutcomeToPosteriors, reach-gated): one execution graded reached by POST /reach and then sent a CI pass was
 * credited twice, and a CI pass credited an arm with no reach verdict at all.
 *
 * THE RULE PINNED HERE:
 *   - MUST-FAIL: a CI pass leaves the row's thompson_alpha/beta exactly as they were; so does a CI fail. With the one
 *     graded writer's alpha for that execution, the execution is credited once in total.
 *   - CONTROL: the CI result is still recorded: ci_status on the trace, ci_pass_count / ci_fail_count /
 *     ci_success_rate on the metrics row, metrics_updated in the response, and a pass still enqueues its deployment.
 *
 * Harness: the register-keeps-posterior pattern (spies on the real exports, restored afterAll; no mock.module); the
 * database is a recorder holding one trace and one metrics row, and the UPDATEs this route sends are applied to them.
 */

import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Hono } from 'hono';

const STUB_ORIGIN = 'http://localhost:9';
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= STUB_ORIGIN;
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

// ---- Network guard ----------------------------------------------------------
const forbiddenNet: string[] = [];
function forbidNetwork(what: string): never {
  forbiddenNet.push(what);
  throw new Error(`NETWORK GUARD: ${what}`);
}
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
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
const EXEC = 'exec_ci_d8a';
const VARIANT = 'ci-graded-arm';
const traces = new Map<string, Row>();
const vpm = new Map<string, Row>();
function answer(sql: string, params: any): any {
  if (/SELECT \* FROM execution_traces/.test(sql)) {
    const t = traces.get(String(params?.execution_id));
    return t ? [t] : [];
  }
  if (/UPDATE execution_traces/.test(sql)) {
    const t = traces.get(String(params?.execution_id));
    if (t) t.ci_status = { success: params.ci_success };
    return [];
  }
  if (/SELECT \* FROM variant_performance_metrics/.test(sql)) {
    const r = vpm.get(String(params?.variant_id));
    return r ? [r] : [];
  }
  if (/UPDATE variant_performance_metrics/.test(sql)) {
    const r = vpm.get(String(params?.variant_id));
    if (r) {
      // Applied as SurrealDB would: every SET column the statement names takes its bound value.
      for (const col of ['thompson_alpha', 'thompson_beta', 'ci_pass_count', 'ci_fail_count', 'ci_success_rate']) {
        if (new RegExp(`\\b${col}\\s*=\\s*\\$${col}\\b`).test(sql)) r[col] = params[col];
      }
    }
    return [];
  }
  return [];
}

const surrealMod = await import('../db/surreal');
const redisMod = await import('../db/redis');
const broadcasterMod = await import('../websocket/broadcaster');
const boredomMod = await import('./boredom');

const spies: Array<{ mockRestore(): void }> = [];
function stub(obj: any, key: string, impl: (...args: any[]) => unknown): void {
  if (obj == null || typeof obj[key] !== 'function') return;
  spies.push(spyOn(obj, key).mockImplementation(impl as never));
}
stub(surrealMod.surrealDB, 'query', async (sql: string, params: any) => answer(sql, params));
stub(surrealMod.surrealDB, 'connect', async () => { throw new Error('SurrealDB is not available in this test'); });
stub(redisMod.RedisClient, 'getInstance', () => ({ getClient: () => ({ del: async () => 0 }) }));
stub(broadcasterMod.broadcaster, 'emit', () => {});
const enqueued: string[] = [];
stub(boredomMod, 'enqueueTask', async (task: { id: string }) => { enqueued.push(task.id); });

afterAll(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  globalThis.fetch = originalFetch;
  (globalThis as any).WebSocket = originalWebSocket;
});

const ciMod = await import('./ci');
const app = new Hono();
app.route('/v2/activities', ciMod.default);

function seed(): void {
  traces.set(EXEC, { execution_id: EXEC, template_id: VARIANT });
  // A reach-graded posterior: alpha 7.5 / beta 2, as the one graded writer left it.
  vpm.set(VARIANT, { variant_id: VARIANT, thompson_alpha: 7.5, thompson_beta: 2, ci_pass_count: 3, ci_fail_count: 1 });
}
async function ci(success: boolean): Promise<{ status: number; body: any }> {
  const res = await app.request('/v2/activities/ci-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ execution_id: EXEC, branch: 'dev', commit: '0123456789abcdef', success, duration_ms: 1200 }),
  });
  return { status: res.status, body: await res.json() };
}

describe('MUST-FAIL — a CI result moves no alpha and no beta', () => {
  test('a CI pass leaves alpha 7.5 / beta 2 as the graded writer left them', async () => {
    seed();
    expect((await ci(true)).status).toBe(200);
    expect({ a: vpm.get(VARIANT)!.thompson_alpha, b: vpm.get(VARIANT)!.thompson_beta }).toEqual({ a: 7.5, b: 2 });
  });

  test('a CI fail leaves alpha 7.5 / beta 2 as well', async () => {
    seed();
    expect((await ci(false)).status).toBe(200);
    expect({ a: vpm.get(VARIANT)!.thompson_alpha, b: vpm.get(VARIANT)!.thompson_beta }).toEqual({ a: 7.5, b: 2 });
  });
});

describe('CONTROL — the CI result is still recorded', () => {
  test('a pass: ci_status on the trace, the CI counters move, metrics_updated, deployment enqueued', async () => {
    seed();
    enqueued.length = 0;
    const { status, body } = await ci(true);
    expect(status).toBe(200);
    expect(traces.get(EXEC)!.ci_status).toEqual({ success: true });
    expect({ p: vpm.get(VARIANT)!.ci_pass_count, f: vpm.get(VARIANT)!.ci_fail_count, r: vpm.get(VARIANT)!.ci_success_rate })
      .toEqual({ p: 4, f: 1, r: 0.8 });
    expect(body.metrics_updated).toBe(true);
    expect(body.deployment_enqueued).toBe(true);
    expect(enqueued.length).toBe(1);
  });

  test('a fail: the fail counter moves and nothing is enqueued', async () => {
    seed();
    enqueued.length = 0;
    const { body } = await ci(false);
    expect({ p: vpm.get(VARIANT)!.ci_pass_count, f: vpm.get(VARIANT)!.ci_fail_count }).toEqual({ p: 3, f: 2 });
    expect(body.metrics_updated).toBe(true);
    expect(enqueued.length).toBe(0);
  });
});

describe('network guard', () => {
  test('no fetch left the stub origin and no WebSocket was opened', () => {
    expect(forbiddenNet).toEqual([]);
  });
});
