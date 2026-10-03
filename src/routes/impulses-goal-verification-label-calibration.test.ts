/**
 * goal_verification_label: the CALIBRATION fields round-trip.
 *
 * A blind calibration sheet (human-surface) writes human verdicts on sealed runs with
 * purpose:"calibration", window_id and sample_draw_id, then reads them back for its
 * judge-accuracy report. Readers that turn labels into credit or overrides (goal-host's
 * oracle-label consumer) skip rows whose purpose is "calibration" — which only works if the
 * purpose actually reaches the row. Two things must hold:
 *   - the write path binds the three fields into the CREATE, and
 *   - the SCHEMAFULL table defines them (a migration), or SurrealDB never stores them.
 *
 * The store below is a small in-memory stand-in that honours BOTH: a CREATE keeps only the
 * CONTENT keys the route writes AND that some migration defines on goal_verification_labels;
 * a SELECT applies the route's `field = $field` conditions newest-first.
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dir, '../../sql/migrations');

function definedLabelFields(): Set<string> {
  const fields = new Set<string>(['id']);
  for (const f of readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith('.surql')) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    for (const m of sql.matchAll(/DEFINE FIELD (?:OVERWRITE |IF NOT EXISTS )?(\w+)\s+ON (?:TABLE )?goal_verification_labels\b/g)) {
      fields.add(m[1]!);
    }
  }
  return fields;
}

type Row = Record<string, unknown>;
const store: Row[] = [];
let seq = 0;
const createSql: string[] = [];

function runSql(sql: string, params: Record<string, unknown> = {}): Row[] {
  if (/^\s*CREATE goal_verification_labels CONTENT/.test(sql)) {
    createSql.push(sql);
    const schema = definedLabelFields();
    const row: Row = { id: `goal_verification_labels:${++seq}` };
    const body = sql.slice(sql.indexOf('{') + 1, sql.lastIndexOf('}'));
    for (const line of body.split('\n')) {
      const m = line.match(/^\s*(\w+):\s*(.+?),?\s*$/);
      if (!m) continue;
      const [, key, expr] = m as unknown as [string, string, string];
      if (!schema.has(key)) continue; // SCHEMAFULL: an undefined field is not stored
      if (/time::now\(\)/.test(expr)) { row[key] = seq; continue; }
      const ref = expr.match(/\$(\w+)/);
      if (!ref) continue;
      const v = params[ref[1]!];
      if (v === null || v === undefined) continue; // NONE
      row[key] = v;
    }
    store.push(row);
    return [row];
  }
  if (/^\s*SELECT \* FROM goal_verification_labels/.test(sql)) {
    // `field = $p` keeps equal rows; `field != $p` keeps rows whose field is ABSENT or differs
    // (SurrealDB: NONE != 'x' is true — verified on the 2.3.10 engine, see the commit).
    const conds = [...sql.matchAll(/(\w+) (!?=) \$(\w+)/g)].map((m) => [m[1]!, m[2]!, m[3]!] as const);
    const rows = store
      .filter((r) => conds.every(([f, op, p]) => (op === '=' ? r[f] === params[p] : r[f] !== params[p])))
      .sort((a, b) => Number(b.created_at) - Number(a.created_at));
    return rows.slice(0, Number(params.limit ?? 20));
  }
  throw new Error('unexpected SQL in calibration test: ' + sql.slice(0, 80));
}

mock.module('../db/surreal', () => ({
  surrealDB: { query: async (sql: string, params?: Record<string, unknown>) => runSql(sql, params) },
  queryWithAuth: async (_t: string, sql: string, params?: Record<string, unknown>) => runSql(sql, params),
  createAuthenticatedClient: async () => ({}),
  // every real export, so the global mock cannot break a later file's import
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
}));

const impulsesRoutes = (await import('./impulses')).default;

const AUTH = { orgId: 'org-test', authType: 'apikey' as const, jwtToken: 'test-jwt', keyId: 'k', scopes: ['read', 'write'] };

function app(): Hono {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('jwtAuth', AUTH as never); await next(); });
  a.route('/v2/impulses', impulsesRoutes);
  return a;
}

async function resolve(pointer: Record<string, unknown>) {
  const res = await app().request('/v2/impulses/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pointer }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const BASE = {
  type: 'goal_verification_label_write',
  goal: 'summarise the open gaps',
  activity_id: 'activity:summarise',
  verdict: 'not_achieved',
  confidence: 0.9,
  labeler: 'human',
};

async function readByExec(execution_id: string, extra: Record<string, unknown> = {}) {
  const r = await resolve({ type: 'goal_verification_label', execution_id, ...extra });
  expect(r.status).toBe(200);
  return JSON.parse(r.body.content) as Row[];
}

describe('goal_verification_label: calibration fields round-trip', () => {
  test('MUST-FAIL: purpose, window_id and sample_draw_id written are read back on the row', async () => {
    const w = await resolve({ ...BASE, execution_id: 'exec-cal-1', purpose: 'calibration', window_id: 'win-2026-10-03', sample_draw_id: 'draw-7' });
    expect(w.status).toBe(200);
    const rows = await readByExec('exec-cal-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe('calibration');
    expect(rows[0]!.window_id).toBe('win-2026-10-03');
    expect(rows[0]!.sample_draw_id).toBe('draw-7');
  });

  test('MUST-FAIL: a purpose filter on read returns only that purpose (the calibration report)', async () => {
    await resolve({ ...BASE, execution_id: 'exec-mixed', verdict: 'achieved' });
    await resolve({ ...BASE, execution_id: 'exec-mixed', purpose: 'calibration', window_id: 'win-a', sample_draw_id: 'draw-1' });
    const all = await readByExec('exec-mixed');
    expect(all).toHaveLength(2);
    const cal = await readByExec('exec-mixed', { purpose: 'calibration' });
    expect(cal).toHaveLength(1);
    expect(cal[0]!.sample_draw_id).toBe('draw-1');
  });

  test('CONTROL: a label without the fields is written and read exactly as before', async () => {
    const w = await resolve({ ...BASE, execution_id: 'exec-plain' });
    expect(w.status).toBe(200);
    const rows = await readByExec('exec-plain');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('not_achieved');
    expect('purpose' in rows[0]!).toBe(false);
    expect('window_id' in rows[0]!).toBe(false);
    expect('sample_draw_id' in rows[0]!).toBe(false);
  });

  test('CONTROL: an unrecognised purpose is stored, never rejected (a fire-and-forget writer must not 500)', async () => {
    const w = await resolve({ ...BASE, execution_id: 'exec-other', purpose: 'something-new' });
    expect(w.status).toBe(200);
  });

  test('MUST-FAIL: a plain label\'s CREATE never names the calibration fields (writes survive a missing 216)', async () => {
    // Measured on a local SurrealDB 3.0.5 with migrations 101/183/192 and NOT 216: a CREATE that
    // names `purpose` is rejected ("no such field exists") EVEN WHEN the value is NONE. If the
    // CREATE always named the fields, every label write — the fire-and-forget oracle feed
    // included — would die until 216 applied. Only a label that carries the fields may name them.
    createSql.length = 0;
    const w = await resolve({ ...BASE, execution_id: 'exec-plain-sql' });
    expect(w.status).toBe(200);
    expect(createSql).toHaveLength(1);
    expect(createSql[0]).not.toMatch(/\b(purpose|window_id|sample_draw_id)\b/);
    createSql.length = 0;
    await resolve({ ...BASE, execution_id: 'exec-cal-sql', purpose: 'calibration', window_id: 'w', sample_draw_id: 'd' });
    expect(createSql[0]).toMatch(/\bpurpose\b/);
    expect(createSql[0]).toMatch(/\bwindow_id\b/);
    expect(createSql[0]).toMatch(/\bsample_draw_id\b/);
  });

  test('MUST-FAIL: exclude_purpose skips calibration rows server side — 15 newer calibration rows cannot hide the older human row at limit 1', async () => {
    await resolve({ ...BASE, execution_id: 'exec-masked', verdict: 'achieved', notes: 'the ordinary human verdict' });
    for (let i = 0; i < 15; i++) {
      await resolve({ ...BASE, execution_id: 'exec-masked', purpose: 'calibration', window_id: 'win-m', sample_draw_id: `draw-${i}` });
    }
    const rows = await readByExec('exec-masked', { limit: 1, exclude_purpose: 'calibration' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notes).toBe('the ordinary human verdict');
    expect(rows[0]!.purpose).toBeUndefined();
    // a row with a DIFFERENT purpose is not excluded
    await resolve({ ...BASE, execution_id: 'exec-masked', purpose: 'something-new', notes: 'other purpose' });
    const rows2 = await readByExec('exec-masked', { limit: 1, exclude_purpose: 'calibration' });
    expect(rows2[0]!.notes).toBe('other purpose');
  });

  test('CONTROL: without exclude_purpose the read is unchanged — the newest row comes first, calibration or not', async () => {
    await resolve({ ...BASE, execution_id: 'exec-unfiltered', verdict: 'achieved', notes: 'human' });
    await resolve({ ...BASE, execution_id: 'exec-unfiltered', purpose: 'calibration', window_id: 'w', sample_draw_id: 'd' });
    const rows = await readByExec('exec-unfiltered', { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe('calibration');
    // an empty exclude_purpose is ignored, not turned into a filter
    const rows2 = await readByExec('exec-unfiltered', { limit: 1, exclude_purpose: '' });
    expect(rows2[0]!.purpose).toBe('calibration');
  });

  test('the migration defines the fields as option<string> with no ASSERT', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.surql'));
    const defs = files.flatMap((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8').split('\n'))
      .filter((l) => /^DEFINE FIELD/.test(l) && /ON goal_verification_labels/.test(l) && /\b(purpose|window_id|sample_draw_id)\b/.test(l));
    expect(defs).toHaveLength(3);
    for (const d of defs) {
      expect(d).toContain('TYPE option<string>');
      expect(d).not.toContain('ASSERT');
    }
  });
});
