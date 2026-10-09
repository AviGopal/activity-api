/**
 * A NOT-REACHED VERDICT THE CALLER MARKS beta_withheld MUST MOVE NO POSTERIOR (check-first).
 *
 * goal-host can decide to withhold β for a not-reached walk (non-deterministic verdict, no consumed chain). Its
 * walk-complete verdict to POST /reach carried only execution_id/reached/completion_shapes/reason/goal_hash, so
 * /reach handed it to applyOutcomeToPosteriors and the arm took β=1 anyway.
 *
 * In-process: surrealDB.query is replaced by a recorder that answers the pre-read; POSTERIOR_COALESCE=0 so the leaf
 * write is the synchronous UPDATE through that recorder. Nothing connects to a database. Run this file on its own
 * (module-level env and the patched db client are process-wide).
 *   MUST-FAIL: beta_withheld:true, reached:false ⇒ no leaf write; the verdict mirror is still written; one log line.
 *   CONTROLS: genuine not-reached ⇒ β+1; explicit beta_withheld:false ⇒ β+1; reached:true ignores the field ⇒ α;
 *             a satisfier satellite ⇒ no write either way.
 */
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL = 'http://127.0.0.1:9';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';
process.env.POSTERIOR_COALESCE = '0';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';

import { beforeAll, describe, expect, spyOn, test } from 'bun:test';

const ORG = 'organizations:test';
type LeafWrite = { activity_id: unknown; new_alpha: number; new_beta: number };
const rows: Record<string, Record<string, unknown>> = {};
const leafWrites: LeafWrite[] = [];
const mirrors: Array<{ execution_id: unknown; reached: unknown }> = [];
const infos: Array<{ msg: string; meta: Record<string, unknown> }> = [];
let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

beforeAll(async () => {
  const { surrealDB } = await import('../db/surreal');
  (surrealDB as unknown as { query: unknown }).query = async (sql: string, vars?: Record<string, unknown>) => {
    if (/^\s*SELECT variant_id, activity_id, success, tags/.test(sql) && /type::thing\('execution', \$execution_id\)/.test(sql)) {
      const r = rows[String(vars?.execution_id)];
      return r ? [r] : [];
    }
    if (/UPDATE variant_performance_metrics/.test(sql) && vars && 'new_alpha' in vars) {
      leafWrites.push({ activity_id: vars.activity_id, new_alpha: Number(vars.new_alpha), new_beta: Number(vars.new_beta) });
      return [{ id: 'variant_performance_metrics:x' }];
    }
    if (/^\s*UPDATE type::thing\('execution', \$execution_id\) SET reached = \$reached/.test(sql)) {
      mirrors.push({ execution_id: vars?.execution_id, reached: vars?.reached });
      return [[{ id: `execution:${String(vars?.execution_id)}` }]];
    }
    return [];
  };
  const { logger } = await import('../utils/logger');
  const orig = logger.info.bind(logger);
  spyOn(logger, 'info').mockImplementation(((msg: string, meta?: Record<string, unknown>) => {
    infos.push({ msg, meta: meta ?? {} });
    return orig(msg, meta as never);
  }) as never);
  // Route first: posterior-update and posterior-aggregator import each other.
  ET = (await import('./execution-traces')).default as typeof ET;
  await import('../lib/posterior-update');
});

async function post(execId: string, body: Record<string, unknown>, activityId = `act-${execId}`) {
  rows[execId] = { activity_id: activityId, success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, org_id: ORG, failure_mode: null };
  const before = { writes: leafWrites.length, mirrors: mirrors.length, infos: infos.length };
  const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: execId, ...body }) });
  expect(res.status).toBe(200);
  // The credit call is fire-and-forget: wait (bounded) for a leaf write, or for the withheld line.
  const withheldLogged = () => infos.slice(before.infos).some((i) => i.msg.includes('[reach] β WITHHELD by caller'));
  for (let i = 0; i < 25 && leafWrites.length === before.writes && !withheldLogged(); i++) await new Promise((r) => setTimeout(r, 20));
  return {
    writes: leafWrites.slice(before.writes),
    mirrors: mirrors.slice(before.mirrors),
    withheld: infos.slice(before.infos).filter((i) => i.msg.includes('[reach] β WITHHELD by caller')),
  };
}

describe('MUST-FAIL — a caller-withheld not-reached verdict moves no posterior', () => {
  test('beta_withheld:true, reached:false ⇒ no leaf write, verdict still mirrored, one WITHHELD line', async () => {
    const r = await post('exec-withheld', { reached: false, beta_withheld: true, beta_withheld_reason: 'non-deterministic verdict, no consumed chain' });
    expect(r.writes).toEqual([]);
    expect(r.mirrors).toEqual([{ execution_id: 'exec-withheld', reached: false }]);
    expect(r.withheld.length).toBe(1);
    expect(r.withheld[0]!.meta).toMatchObject({
      execution_id: 'exec-withheld',
      activity_id: 'act-exec-withheld',
      reason: 'non-deterministic verdict, no consumed chain',
    });
  });
});

describe('CONTROLS — today\'s behaviour', () => {
  test('genuine not-reached (field absent) ⇒ β+1 on the arm', async () => {
    const r = await post('exec-genuine', { reached: false });
    expect(r.writes).toEqual([{ activity_id: 'act-exec-genuine', new_alpha: 1, new_beta: 2 }]);
    expect(r.withheld).toEqual([]);
  });

  test('explicit beta_withheld:false ⇒ β+1 on the arm', async () => {
    const r = await post('exec-false', { reached: false, beta_withheld: false });
    expect(r.writes).toEqual([{ activity_id: 'act-exec-false', new_alpha: 1, new_beta: 2 }]);
    expect(r.withheld).toEqual([]);
  });

  test('reached:true ignores beta_withheld ⇒ α credited', async () => {
    const r = await post('exec-reached', { reached: true, beta_withheld: true });
    expect(r.writes.length).toBe(1);
    expect(r.writes[0]!.new_alpha).toBeGreaterThan(1);
    expect(r.withheld).toEqual([]);
  });

  test('a satisfier satellite stays unchanged', async () => {
    const r = await post('walk-satisfier-x', { reached: false }, 'satisfier:x');
    expect(r.writes).toEqual([]);
    expect(r.mirrors).toEqual([{ execution_id: 'walk-satisfier-x', reached: false }]);
  });
});
