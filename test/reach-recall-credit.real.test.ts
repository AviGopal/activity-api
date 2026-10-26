// A VERDICT GRADED AT INSERT CREDITS ITS RECALLED CONCEPTS ONCE, AND THE ONCE-MARKER PERSISTS (real engine).
//
// Against a scratch SurrealDB built from the REAL schema and migrations (test/support/real-surreal.ts), driving the
// real POST /reach route over an `execution` row stamped as the insert stamps a reached walk (reached:true,
// insert_graded:true). `execution` is SCHEMAFULL, which silently drops undeclared fields, so the marker rides on the
// declared `tags` array:
//   [MUST-FAIL] /reach with recalled_concept_ids emits ONE graded execution_completed carrying them and the row's org,
//               and recall_credited:true is on the row when re-read from the engine;
//   [ONCE]      a second /reach emits nothing; two CONCURRENT /reach calls on a fresh row emit exactly one;
//   [ENGINE]    the conditional marker UPDATE changes a row once, then matches nothing, including on a row whose
//               tags are NONE.
// Redis and the websocket broadcaster (recorded) are stubbed; outbound fetch is answered locally.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { startRealSurreal, useRealModules, type RealSurreal } from './support/real-surreal';

const ORG = 'organizations:reach-recall-credit-probe';
const USE = 'USE NS `activity-system` DB learning_loop;';
const word = () => Array.from(crypto.getRandomValues(new Uint8Array(7)), (b) => String.fromCharCode(97 + (b % 26))).join('');
const ARM = `rrc-arm-${word()}`;
const IDS = ['concept:concept_alpha', 'concept_beta'];
const MARKER = 'recall_credited:true';

let db: RealSurreal | null = null;
let app: Hono | null = null;
let startError = '';
const spies: Array<{ mockRestore(): void }> = [];
const originalFetch = globalThis.fetch;
const originalCoalesce = process.env.POSTERIOR_COALESCE;
let restoreModules: () => void = () => {};
const emitted: Array<{ type: string; data?: Record<string, unknown> }> = [];

function gradedAtInsert(id: string, tags: string | null = "['dispatcher_used:goal-host', 'reached:true', 'insert_graded:true']"): string {
  return `CREATE execution:\`${id}\` CONTENT { activity_id: '${ARM}', input_impulses: [], output_impulses: [], success: true, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', executed_at: time::now() - 1m, created_at: time::now(), status: 'success', reached: true${tags === null ? '' : `, tags: ${tags}`} };`;
}
async function tagsOf(id: string): Promise<string[]> {
  const r = await db!.sql(`${USE} SELECT tags FROM execution:\`${id}\`;`);
  return (r[r.length - 1].result[0]?.tags as string[] | undefined) ?? [];
}
async function reach(id: string, body: Record<string, unknown>): Promise<number> {
  const res = await app!.request('/v2/activities/execution-traces/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: id, ...body }) });
  await res.text();
  return res.status;
}
const completedFor = (id: string) => emitted.filter((e) => e.type === 'execution_completed' && e.data?.execution_id === id);
async function settle(): Promise<void> { await Bun.sleep(600); }

beforeAll(async () => {
  try {
    process.env.POSTERIOR_COALESCE = '1';
    await import('../src/lib/posterior-update');
    restoreModules = await useRealModules(['src/lib/tuning-params', 'src/lib/prior-seed', 'src/lib/embedding-lookup-cache', 'src/lib/posterior-aggregator',
      'src/db/paradigm', 'src/websocket/broadcaster', 'src/services/variant-creator']);
    db = await startRealSurreal();
    await db.connectModuleClient();
    globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const redisMod = await import('../src/db/redis');
    const broadcasterMod = await import('../src/websocket/broadcaster');
    const stub = (obj: any, key: string, impl: (...args: any[]) => unknown) => {
      if (obj == null || typeof obj[key] !== 'function') return;
      spies.push(spyOn(obj, key).mockImplementation(impl as never));
    };
    const redisProto = (redisMod as any).RedisClient?.prototype;
    stub(redisProto, 'del', async () => 0);
    stub(redisProto, 'get', async () => null);
    stub(redisProto, 'set', async () => 'OK');
    stub(redisProto, 'sadd', async () => 0);
    stub(redisProto, 'smembers', async () => []);
    stub(redisProto, 'srem', async () => 0);
    stub(redisProto, 'withLock', async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn());
    stub(redisProto, 'getClient', () => null);
    stub((broadcasterMod as any).broadcaster, 'emit', (e: any) => { emitted.push(e); });
    const ET = (await import('../src/routes/execution-traces')).default;
    app = new Hono();
    app.use('*', async (c, next) => { (c as any).set('session', { session_id: 't', org_id: ORG, project_id: null, api_key: null, latest_job_id: null }); await next(); });
    app.route('/v2/activities/execution-traces', ET);
    await db.sql(`${USE} ${[gradedAtInsert('rrc-once'), gradedAtInsert('rrc-concurrent'), gradedAtInsert('rrc-engine'), gradedAtInsert('rrc-engine-none', null)].join('\n')}`);
  } catch (e) {
    startError = `cannot start: ${e instanceof Error ? e.message : String(e)}`;
  }
}, 240_000);
afterAll(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  globalThis.fetch = originalFetch;
  restoreModules();
  if (originalCoalesce === undefined) delete process.env.POSTERIOR_COALESCE; else process.env.POSTERIOR_COALESCE = originalCoalesce;
  await db?.stop();
});

describe('POST /reach on the real engine: a verdict graded at insert credits its recalled concepts once', () => {
  it('the engine started', () => { expect(startError).toBe(''); });

  it('MUST-FAIL: one graded event with the ids and the row org, and the marker persists on re-read', async () => {
    expect(await tagsOf('rrc-once')).not.toContain(MARKER);
    expect(await reach('rrc-once', { reached: true, recalled_concept_ids: IDS })).toBe(200);
    await settle();
    const ev = completedFor('rrc-once');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ execution_id: 'rrc-once', reached: true, verdict: true, org_id: ORG, recalled_concept_ids: IDS });
    expect(await tagsOf('rrc-once')).toContain(MARKER);
  }, 30_000);

  it('ONCE: a second identical /reach emits nothing', async () => {
    expect(await reach('rrc-once', { reached: true, recalled_concept_ids: IDS })).toBe(200);
    await settle();
    expect(completedFor('rrc-once')).toHaveLength(1);
  }, 30_000);

  it('ONCE: two concurrent /reach calls emit exactly one', async () => {
    const st = await Promise.all([
      reach('rrc-concurrent', { reached: true, recalled_concept_ids: IDS }),
      reach('rrc-concurrent', { reached: true, recalled_concept_ids: IDS }),
    ]);
    await settle();
    expect(st).toEqual([200, 200]);
    expect(completedFor('rrc-concurrent')).toHaveLength(1);
    expect((await tagsOf('rrc-concurrent')).filter((t) => t === MARKER)).toHaveLength(1);
  }, 30_000);

  it('ENGINE: the conditional marker UPDATE changes a row once, then nothing (tags set, and tags NONE)', async () => {
    const q = `UPDATE type::thing('execution', $execution_id) SET tags = array::union(tags ?? [], [$marker]) WHERE (tags ?? []) CONTAINSNOT $marker`;
    for (const id of ['rrc-engine', 'rrc-engine-none']) {
      const first = await db!.sdk.query(q, { execution_id: id, marker: MARKER });
      const second = await db!.sdk.query(q, { execution_id: id, marker: MARKER });
      expect((first[0] as unknown[]).length).toBe(1);
      expect((second[0] as unknown[]).length).toBe(0);
      expect(await tagsOf(id)).toContain(MARKER);
    }
  }, 30_000);
});
