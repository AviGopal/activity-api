/**
 * A DECLINED OUTCOME CAN BE WRITTEN ON THE WIRE, AND IT IS UNGRADED (REALIGNMENT §2.2: reached / failed / declined).
 *
 * POST /reach returned 400 unless `reached` was a boolean, so no producer could record that a run correctly refused:
 * a refusal reached the store as reached:false (blame) or not at all. goal-host already writes the declined contract
 * on its own durable trace (the declined:<class> tag plus metadata.decline {class, reason_text, decliner_id}), and
 * isReachInapplicable ungrades that tag. /reach now accepts { outcome: 'declined', decline: {...} } and writes the same
 * contract onto the authoritative execution row, grading nothing.
 *
 * In-process: surrealDB.query is replaced by a recorder that answers the pre-read, keeps each row's tags and metadata,
 * and applies the route's writes; POSTERIOR_COALESCE=0 so a leaf posterior write would be a synchronous UPDATE through
 * it. Nothing connects to a database. Run this file on its own (module-level env and the patched client are global).
 *   MUST-FAIL: a declined outcome is 200, tags the row declined:<class>, writes metadata.decline, leaves reached
 *              untouched, makes no leaf write and no reach_graded stamp; classifyReach then reads the row ungraded.
 *   MUST-FAIL: the same decline redelivered is reported persisted (idempotent) and not written again.
 *   MUST-FAIL: a declined outcome that also carries reached, or carries no valid class, is refused with 400.
 *   MUST-FAIL (caller guard): a declined post from a key of another org (or another account of the same org, or with
 *              no org) is 403 and the row is unchanged; this node's own key (METABOB_API_KEY) may decline any row,
 *              including one stored under a defaulted org, which no other caller may.
 *   MUST-FAIL (graded guard): a decline after a reached:false β charge is 409, β and the row unchanged; so is one
 *              after reached:true, and one on a row the insert graded. A missing row is 404 and writes nothing.
 *   CONTROLS:  reached:false still charges β+1 and reached:true credits α; a body without outcome:'declined' (even
 *              one carrying a decline object) is the boolean verdict; neither reached nor outcome is still 400.
 */
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL = 'http://127.0.0.1:9';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';
process.env.POSTERIOR_COALESCE = '0';
process.env.PRIOR_SEED_ENABLED = 'false';
process.env.RELEVANCE_SINK_ENDPOINT = 'http://127.0.0.1:9';

import { beforeAll, describe, expect, test } from 'bun:test';

const ORG = 'organizations:test';
type Row = { activity_id: string; success: boolean; tags: string[]; cost_usd: number; org_id: string; failure_mode: null; metadata?: Record<string, any>; reached?: boolean };
const rows: Record<string, Row> = {};
const leafWrites: Array<{ activity_id: unknown; new_alpha: number; new_beta: number }> = [];
const declineWrites: string[] = [];
const mirrors: Array<{ execution_id: unknown; reached: unknown }> = [];
const addTag = (execId: string, tag: string) => {
  const r = rows[execId];
  if (r) r.tags = [...new Set([...(r.tags ?? []), tag])];
};
const holdsDecline = (r: Row | undefined, v: Record<string, any>) =>
  !!r && r.tags.includes(v.declined_tag) && r.metadata?.decline?.class === v.decline_class && r.metadata?.decline?.reason_text === v.decline_reason;
let ET: { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
const NODE_KEY = 'node-key-for-the-declined-test';
process.env.METABOB_API_KEY = NODE_KEY;
// The caller each request authenticates as (what jwtAuthMiddleware would set); a request's Authorization header is
// sent as given, so presentsThisNodesKey reads it.
type Caller = { orgId?: string; accountId?: string; authorization?: string };
const OWNER: Caller = { orgId: ORG, authorization: 'ApiKey owner-key' };
let caller: Caller = OWNER;
let classify: (t: { success: boolean; execution_id?: string; activity_id?: string; tags?: string[] }) => string;

beforeAll(async () => {
  const { surrealDB } = await import('../db/surreal');
  (surrealDB as unknown as { query: unknown }).query = async (sql: string, vars: Record<string, any> = {}) => {
    const id = String(vars.execution_id);
    if (/^\s*SELECT variant_id, activity_id, success, tags/.test(sql) && /type::thing\('execution', \$execution_id\)/.test(sql)) {
      const r = rows[id];
      return r ? [r] : [];
    }
    if (/UPDATE variant_performance_metrics/.test(sql) && 'new_alpha' in vars) {
      leafWrites.push({ activity_id: vars.activity_id, new_alpha: Number(vars.new_alpha), new_beta: Number(vars.new_beta) });
      return [{ id: 'variant_performance_metrics:x' }];
    }
    if (/^\s*UPDATE type::thing\('execution', \$execution_id\) SET tags = array::union\(tags \?\? \[\], \[\$declined_tag\]\), metadata\.decline = \$decline WHERE !\(/.test(sql)) {
      const r = rows[id];
      if (!r || holdsDecline(r, vars)) return [[]];
      if (/CONTAINSANY \$blocking_tags/.test(sql) && (vars.blocking_tags as string[]).some((t) => r.tags.includes(t))) return [[]];
      declineWrites.push(id);
      addTag(id, vars.declined_tag);
      r.metadata = { ...(r.metadata ?? {}), decline: vars.decline };
      return [[{ id: `execution:${id}` }]];
    }
    if (/^\s*SELECT VALUE id FROM type::thing\('execution', \$execution_id\) WHERE tags CONTAINS \$declined_tag/.test(sql)) {
      return holdsDecline(rows[id], vars) ? [`execution:${id}`] : [];
    }
    const tagUnion = sql.match(/^\s*UPDATE type::thing\('execution', \$execution_id\) SET tags = array::union\(tags \?\? \[\], \['([^']+)'\]\)\s*$/);
    if (tagUnion) {
      addTag(id, tagUnion[1]!);
      return [[{ id: `execution:${id}` }]];
    }
    if (/^\s*UPDATE type::thing\('execution', \$execution_id\) SET reached = \$reached/.test(sql)) {
      mirrors.push({ execution_id: vars.execution_id, reached: vars.reached });
      if (rows[id]) rows[id]!.reached = vars.reached;
      addTag(id, vars.reached === true ? 'reached:true' : 'reached:false');
      return [[{ id: `execution:${id}` }]];
    }
    return [];
  };
  // Route first: posterior-update and posterior-aggregator import each other.
  const routes = (await import('./execution-traces')).default;
  const { Hono } = await import('hono');
  const h = new Hono();
  h.use('*', async (c, next) => {
    (c as any).set('jwtAuth', caller.orgId ? { jwtToken: 't', orgId: caller.orgId, ...(caller.accountId ? { accountId: caller.accountId } : {}), authType: 'apikey', keyId: 'k' } : null);
    await next();
  });
  h.route('/', routes);
  ET = { request: (path, init) => h.request(path, { ...init, headers: { ...(init?.headers as Record<string, string>), ...(caller.authorization ? { authorization: caller.authorization } : {}) } }) };
  await import('../lib/posterior-update');
  classify = (await import('../lib/reach-classify')).classifyReach as typeof classify;
});

async function post(execId: string, body: Record<string, unknown>, as: Caller = OWNER) {
  caller = as;
  rows[execId] ??= { activity_id: `act-${execId}`, success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, org_id: ORG, failure_mode: null };
  const before = { writes: leafWrites.length, declines: declineWrites.length, mirrors: mirrors.length };
  const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: execId, ...body }) });
  const json = await res.json().catch(() => null) as Record<string, any> | null;
  // A credit call is fire-and-forget: give it a bounded chance to land before reading the leaf writes.
  for (let i = 0; i < 10 && leafWrites.length === before.writes; i++) await new Promise((r) => setTimeout(r, 20));
  return {
    status: res.status,
    json,
    writes: leafWrites.slice(before.writes),
    declines: declineWrites.slice(before.declines),
    mirrors: mirrors.slice(before.mirrors),
  };
}

const DECLINE = { class: 'decomposition_refused', reason_text: 'needs_information: no edit site named', decliner_id: 'satisfier:gapDecomposition' };

describe('MUST-FAIL — a declined outcome is written on the wire, ungraded', () => {
  test('outcome:declined ⇒ 200, declined:<class> tag + metadata.decline, reached untouched, no posterior, no stamp', async () => {
    const r = await post('exec-declined', { outcome: 'declined', decline: DECLINE });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, execution_id: 'exec-declined', outcome: 'declined', declined: 'decomposition_refused', reached: null, updated: 1 });
    expect(r.declines).toEqual(['exec-declined']);
    const row = rows['exec-declined']!;
    expect(row.tags).toContain('declined:decomposition_refused');
    expect(row.metadata?.decline).toEqual(DECLINE);
    expect('reached' in row).toBe(false);
    expect(r.mirrors).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(row.tags).not.toContain('reach_graded:true');
    expect(row.tags.some((t) => t.startsWith('reached:'))).toBe(false);
    // The stored row reads ungraded through the one honest-reach primitive, even as a failed run.
    expect(classify({ success: false, execution_id: 'exec-declined', activity_id: row.activity_id, tags: [...row.tags.filter((t) => t !== 'dispatcher_used:goal-host'), 'reached:false'] })).toBe('ungraded');
  });

  test('the same decline redelivered ⇒ reported persisted (idempotent), not written again', async () => {
    const r = await post('exec-declined', { outcome: 'declined', decline: DECLINE });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ success: true, outcome: 'declined', updated: 1, idempotent: true });
    expect(r.declines).toEqual([]);
    expect(r.writes).toEqual([]);
  });

  test('a declined outcome that also carries reached, or no valid class, is refused with 400', async () => {
    expect((await post('exec-bad-1', { outcome: 'declined', reached: false, decline: DECLINE })).status).toBe(400);
    expect((await post('exec-bad-2', { outcome: 'declined' })).status).toBe(400);
    expect((await post('exec-bad-3', { outcome: 'declined', decline: { class: '' } })).status).toBe(400);
    expect((await post('exec-bad-4', { outcome: 'declined', decline: { class: 'has space' } })).status).toBe(400);
    for (const id of ['exec-bad-1', 'exec-bad-2', 'exec-bad-3', 'exec-bad-4']) {
      expect(rows[id]!.tags).toEqual(['dispatcher_used:goal-host']);
    }
    expect(declineWrites.filter((id) => id.startsWith('exec-bad-'))).toEqual([]);
  });

  test('a declined outcome for an execution with no row is 404 and persists nothing', async () => {
    caller = OWNER;
    const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: 'exec-missing', outcome: 'declined', decline: { class: 'needs_information' } }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ success: false, outcome: 'declined', refused: 'not_found', updated: 0 });
    expect(rows['exec-missing']).toBeUndefined();
  });
});

const snapshot = (id: string) => JSON.parse(JSON.stringify(rows[id]!));

describe('MUST-FAIL — (a) only the owner, or this node, may decline', () => {
  test("another org's key ⇒ 403, row unchanged, no write", async () => {
    rows['exec-foreign'] = { activity_id: 'act-exec-foreign', success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, org_id: ORG, failure_mode: null };
    const before = snapshot('exec-foreign');
    const r = await post('exec-foreign', { outcome: 'declined', decline: DECLINE }, { orgId: 'organizations:other', authorization: 'ApiKey other-key' });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ success: false, refused: 'forbidden', updated: 0 });
    expect(r.declines).toEqual([]);
    expect(rows['exec-foreign']).toEqual(before);
  });

  test('the same org spelled without the record prefix is the owner; another account of it is not', async () => {
    expect((await post('exec-bare-org', { outcome: 'declined', decline: DECLINE }, { orgId: 'test', authorization: 'ApiKey owner-key' })).status).toBe(200);
    rows['exec-acct'] = { activity_id: 'act-exec-acct', success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, org_id: ORG, failure_mode: null, ...({ account_id: 'acct-a' } as object) } as Row;
    const r = await post('exec-acct', { outcome: 'declined', decline: DECLINE }, { orgId: ORG, accountId: 'acct-b', authorization: 'ApiKey owner-key' });
    expect(r.status).toBe(403);
    expect(r.declines).toEqual([]);
  });

  test('a caller with no org ⇒ 403', async () => {
    const r = await post('exec-no-org', { outcome: 'declined', decline: DECLINE }, { authorization: 'ApiKey nobody' });
    expect(r.status).toBe(403);
    expect(rows['exec-no-org']!.tags).toEqual(['dispatcher_used:goal-host']);
  });

  test("a defaulted-org row: no other caller may decline it; this node's own key may, and may decline another org's row", async () => {
    rows['exec-public'] = { activity_id: 'act-exec-public', success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, org_id: 'public', failure_mode: null };
    expect((await post('exec-public', { outcome: 'declined', decline: DECLINE }, { orgId: 'public', authorization: 'ApiKey p' })).status).toBe(403);
    const node = await post('exec-public', { outcome: 'declined', decline: DECLINE }, { orgId: 'organizations:node', authorization: `ApiKey ${NODE_KEY}` });
    expect(node.status).toBe(200);
    expect(node.declines).toEqual(['exec-public']);
    rows['exec-other-org'] = { activity_id: 'act-exec-other-org', success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, org_id: 'organizations:other', failure_mode: null };
    expect((await post('exec-other-org', { outcome: 'declined', decline: DECLINE }, { orgId: 'organizations:node', authorization: `ApiKey ${NODE_KEY}` })).status).toBe(200);
  });
});

describe('MUST-FAIL — (b) an already graded execution is never declined', () => {
  test('decline after a reached:false β charge ⇒ 409, β and the row unchanged', async () => {
    const charged = await post('exec-charged', { reached: false });
    expect(charged.writes).toEqual([{ activity_id: 'act-exec-charged', new_alpha: 1, new_beta: 2 }]);
    const before = snapshot('exec-charged');
    const r = await post('exec-charged', { outcome: 'declined', decline: DECLINE });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ success: false, refused: 'already_graded', updated: 0 });
    expect(r.writes).toEqual([]);
    expect(r.declines).toEqual([]);
    expect(rows['exec-charged']).toEqual(before);
  });

  test('decline after reached:true ⇒ 409; on a row the insert graded ⇒ 409', async () => {
    await post('exec-credited', { reached: true });
    expect((await post('exec-credited', { outcome: 'declined', decline: DECLINE })).status).toBe(409);
    rows['exec-insert-graded'] = { activity_id: 'act-x', success: true, tags: ['insert_graded:true'], cost_usd: 0, org_id: ORG, failure_mode: null };
    const r = await post('exec-insert-graded', { outcome: 'declined', decline: DECLINE });
    expect(r.status).toBe(409);
    expect(rows['exec-insert-graded']!.tags).toEqual(['insert_graded:true']);
  });

  test('the write re-checks the guard: a verdict landing after the pre-read is not overwritten (409)', async () => {
    rows['exec-race'] = { activity_id: 'act-exec-race', success: true, tags: ['dispatcher_used:goal-host'], cost_usd: 0, org_id: ORG, failure_mode: null };
    const { surrealDB } = await import('../db/surreal');
    const q = (surrealDB as any).query;
    (surrealDB as any).query = async (sql: string, vars: Record<string, any> = {}) => {
      if (/metadata\.decline = \$decline WHERE/.test(sql) && vars.execution_id === 'exec-race') addTag('exec-race', 'reach_graded:true');
      return q(sql, vars);
    };
    try {
      const r = await post('exec-race', { outcome: 'declined', decline: DECLINE });
      expect(r.status).toBe(409);
      expect(rows['exec-race']!.tags.some((t) => t.startsWith('declined:'))).toBe(false);
    } finally {
      (surrealDB as any).query = q;
    }
  });
});

describe('CONTROLS — the boolean verdict is unchanged', () => {
  test('reached:false ⇒ β+1 on the arm, verdict mirrored', async () => {
    const r = await post('exec-not-reached', { reached: false });
    expect(r.status).toBe(200);
    expect(r.writes).toEqual([{ activity_id: 'act-exec-not-reached', new_alpha: 1, new_beta: 2 }]);
    expect(r.mirrors).toEqual([{ execution_id: 'exec-not-reached', reached: false }]);
  });

  test('reached:true ⇒ α credited', async () => {
    const r = await post('exec-reached', { reached: true });
    expect(r.status).toBe(200);
    expect(r.writes.length).toBe(1);
    expect(r.writes[0]!.new_alpha).toBeGreaterThan(1);
  });

  test('a decline object without outcome:declined is the boolean verdict (β+1, no decline written)', async () => {
    const r = await post('exec-no-outcome', { reached: false, decline: DECLINE });
    expect(r.status).toBe(200);
    expect(r.declines).toEqual([]);
    expect(r.writes).toEqual([{ activity_id: 'act-exec-no-outcome', new_alpha: 1, new_beta: 2 }]);
  });

  test('neither reached nor outcome:declined ⇒ 400, as before', async () => {
    expect((await post('exec-empty', {})).status).toBe(400);
    expect((await post('exec-other-outcome', { outcome: 'reached' })).status).toBe(400);
  });
});
