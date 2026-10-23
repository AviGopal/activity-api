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
  ET = (await import('./execution-traces')).default as typeof ET;
  await import('../lib/posterior-update');
  classify = (await import('../lib/reach-classify')).classifyReach as typeof classify;
});

async function post(execId: string, body: Record<string, unknown>) {
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

  test('a declined outcome for an execution with no row persists nothing (updated 0)', async () => {
    const res = await ET.request('/reach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ execution_id: 'exec-missing', outcome: 'declined', decline: { class: 'needs_information' } }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, outcome: 'declined', updated: 0 });
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
