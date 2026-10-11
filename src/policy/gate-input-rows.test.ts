/**
 * THE GATE-INPUT SET IS BUILT FROM WHAT CLOSED READERS READ, AND THE ROUTE ENFORCES ALL OF IT.
 *
 * src/policy/gate-input-rows.ts is closed, so the lane cannot shrink GATE_INPUT_ROWS. This test keeps
 * it complete in the other direction: it reads every closed reader in this repo (CLOSED_READER_FILES)
 * STATICALLY from source, extracts each tuning-row name it reads, and fails when a name is in
 * neither GATE_INPUT_ROWS nor LEARNING_ROWS. A read whose name is not a string literal fails too
 * (fail closed: an unknown name is treated as a gate input until someone classifies it).
 *
 * Read forms extracted: getTuningParam(<name>, ...), getTuningParamList(<name>), a
 * `FROM substrate_tuning_param` query bound with `{ name: <name> }`, and a
 * `/v2/tuning-params/<name>` URL.
 *
 * Readers in other repos (development-vessel gap-to-feature.ts, super-repo scripts/substrate) cannot
 * be scanned from here; their row names are pinned below. A NEW reader there is not caught by this
 * test, only a set that drops one of the pinned names.
 */

import { describe, test, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

const store = new Map<string, unknown>();
async function query(sql: string, params: Record<string, unknown> = {}) {
  const name = String(params.name ?? '');
  if (/^UPSERT substrate_tuning_param/.test(sql)) { store.set(name, params.value); return [params]; }
  if (/FROM substrate_tuning_param/.test(sql)) return store.has(name) ? [{ param_value: store.get(name) }] : [];
  return [];
}

mock.module('../db/surreal', () => ({
  surrealDB: { query: async (sql: string, params?: Record<string, unknown>) => query(sql, params) },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
  // every real export, so the process-wide mock cannot break a later file's import
  getDbStats: () => ({}),
  dbStats: { snapshot: () => ({}) },
}));

const { GATE_INPUT_ROWS, LEARNING_ROWS, LEARNING_ROW_BOUNDS, CLOSED_READER_FILES, isGateInputRow } = await import('./gate-input-rows');
const { default: tuningParamsRoutes, isPolicyWritePrincipal } = await import('../routes/tuning-params');

const REPO = join(import.meta.dir, '..', '..');

interface Extracted { names: string[]; dynamic: string[] }

const LITERAL = /^(['"`])([^'"`$]+)\1$/;

function extractTuningReads(src: string): Extracted {
  const names: string[] = [];
  const dynamic: string[] = [];
  const take = (raw: string, where: string) => {
    const arg = raw.trim();
    const m = LITERAL.exec(arg);
    if (m) names.push(m[2]!);
    else dynamic.push(`${where}: ${arg}`);
  };
  for (const m of src.matchAll(/\bgetTuningParam(?:List)?\s*\(\s*([^,)]*)/g)) {
    if (m[1]!.trim().length === 0) continue; // `getTuningParam()` in prose names no row
    take(m[1]!, 'getTuningParam');
  }
  for (const m of src.matchAll(/FROM substrate_tuning_param/g)) {
    const tail = src.slice(m.index!, m.index! + 400);
    const b = /\bname:\s*([^,}\n]+)/.exec(tail);
    if (b) take(b[1]!, 'substrate_tuning_param query');
    else dynamic.push('substrate_tuning_param query: no { name: ... } binding found');
  }
  for (const m of src.matchAll(/tuning-params\/(\$\{[^}]*\}|[A-Za-z0-9_.]+)/g)) {
    const seg = m[1]!;
    if (seg.startsWith('${')) dynamic.push(`tuning-params URL: ${seg}`);
    else names.push(seg);
  }
  return { names, dynamic };
}

// Rows read by closed readers in OTHER repos (cannot be scanned from here).
const PINNED_EXTERNAL_GATE_ROWS = [
  // development-vessel src/resolvers/gap-to-feature.ts autoRevertRegressedLandings (GET /v2/tuning-params/:name)
  'AUTO_REVERT_MAX_AGE_MS',
  'AUTO_REVERT_STRIKE_LIMIT',
  'AUTO_REVERT_HOLD_REVIEW_MS',
  // super-repo scripts/substrate/substrate-pull-sync.sh tuning_param (and vessel-ctl.sh)
  'pull_sync.probe_window_max_seconds',
  'pull_sync.stall_seconds',
  'pull_sync.owed_restart_max_hold_seconds',
  'pull_sync.testgate_budget_defer_max',
  'pull_sync.testgate_skip_recheck_ticks',
  'pull_sync.bounce_defer_max_ticks',
  'pull_sync.bounce_defer_max_seconds',
];

describe('GATE_INPUT_ROWS covers every row a closed reader reads', () => {
  test('the extractor finds each read form (positive control on the detector)', () => {
    const src = [
      "await getTuningParam('A_ROW', undefined, 1);",
      "await getTuningParam(\n    'B_ROW',\n    undefined,\n    2,\n  );",
      "getTuningParamList('C_ROW')",
      "db.query('SELECT `value` AS param_value FROM substrate_tuning_param WHERE name = $name LIMIT 1', { name: 'D_ROW' })",
      'fetch(`${E}/v2/tuning-params/E_ROW`)',
      'getTuningParam(dynamicName, undefined, 3)',
      'fetch(`${E}/v2/tuning-params/${encodeURIComponent(name)}`)',
    ].join('\n');
    const x = extractTuningReads(src);
    expect(x.names.sort()).toEqual(['A_ROW', 'B_ROW', 'C_ROW', 'D_ROW', 'E_ROW']);
    expect(x.dynamic).toHaveLength(2);
  });

  test('MUST-FAIL: every tuning-row name read by a closed reader in this repo is classified (gate-input or learning), and none is dynamic', () => {
    const classified = new Set([...GATE_INPUT_ROWS, ...LEARNING_ROWS]);
    const unclassified: string[] = [];
    const dynamic: string[] = [];
    const seen: string[] = [];
    for (const f of CLOSED_READER_FILES) {
      const x = extractTuningReads(readFileSync(join(REPO, f), 'utf8'));
      // a reader file that yields nothing means the extractor no longer completes on it
      expect({ file: f, reads: x.names.length + x.dynamic.length > 0 }).toEqual({ file: f, reads: true });
      for (const n of x.names) { seen.push(n); if (!classified.has(n)) unclassified.push(`${f}: ${n}`); }
      for (const d of x.dynamic) dynamic.push(`${f}: ${d}`);
    }
    expect(unclassified).toEqual([]);
    expect(dynamic).toEqual([]);
    // the current readers, so a silent extractor regression cannot pass as "nothing unclassified"
    for (const n of ['TD_LAMBDA', 'YIELD_FLOOR', 'YIELD_COST_REF', 'YIELD_PROD_REF', 'EMBEDDING_PRIOR_ENABLED',
      'THOMPSON_DECAY_HALFLIFE_DAYS', 'CREDIT_PROPAGATION_EXCLUDED_ANCESTORS', 'RETIREMENT_MIN_EXECUTIONS', 'RETIREMENT_SUCCESS_FLOOR']) {
      expect(seen).toContain(n);
    }
  });

  test('MUST-FAIL: every row pinned from closed readers in other repos is a gate input', () => {
    expect(PINNED_EXTERNAL_GATE_ROWS.filter((n) => !GATE_INPUT_ROWS.includes(n))).toEqual([]);
  });

  test('MUST-FAIL: LEARNING_ROWS is exactly the two rows learningPolicyWriteback authors, and disjoint from the gate set', () => {
    expect([...LEARNING_ROWS].sort()).toEqual(['TD_LAMBDA', 'YIELD_FLOOR']);
    expect(LEARNING_ROWS.filter((n) => GATE_INPUT_ROWS.includes(n))).toEqual([]);
    expect(LEARNING_ROWS.filter((n) => isGateInputRow(n))).toEqual([]);
  });

  test('MUST-FAIL: every learning row has an envelope, equal to the writer\'s current clamps (learning-policy-writeback.ts l.41-42 @ 2ac7e4a2)', () => {
    expect(Object.keys(LEARNING_ROW_BOUNDS).sort()).toEqual([...LEARNING_ROWS].sort());
    expect(LEARNING_ROW_BOUNDS).toEqual({ TD_LAMBDA: { min: 0.3, max: 0.95 }, YIELD_FLOOR: { min: 0, max: 1 } });
  });
});

describe('the route enforces the whole set', () => {
  const FLEET_KEY_CTX = { orgId: 'org-1', userId: 'user-1', role: 'user', authType: 'apikey' as const, jwtToken: '', keyId: 'key-fleet', scopes: ['read', 'write'] };
  function app(): Hono {
    const a = new Hono();
    a.use('*', async (c, next) => { c.set('jwtAuth', FLEET_KEY_CTX as never); await next(); });
    a.route('/v2/tuning-params', tuningParamsRoutes);
    return a;
  }
  async function post(name: string, value = 1): Promise<number> {
    const res = await app().request('/v2/tuning-params', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, value }),
    });
    return res.status;
  }

  test('MUST-FAIL: the predicate itself refuses a policy-write credential with no key id or on-behalf-of (the route also refuses both; this pins the predicate on its own)', () => {
    const { keyId: _k, ...noKey } = { ...FLEET_KEY_CTX, scopes: ['policy:write'] };
    expect(isPolicyWritePrincipal(noKey as never)).toBe(false);
    expect(isPolicyWritePrincipal({ ...noKey, keyId: '  ' } as never)).toBe(false);
    expect(isPolicyWritePrincipal({ ...FLEET_KEY_CTX, scopes: ['policy:write'] } as never)).toBe(true);
    // obo is refused for every write at the route; the predicate refuses it on its own too
    expect(isPolicyWritePrincipal({ ...FLEET_KEY_CTX, scopes: ['policy:write'], obo: { node: 'peer', shape: 'x' } } as never)).toBe(false);
  });

  test('MUST-FAIL: a read/write key is refused 403 on EVERY gate-input row', async () => {
    const landed: string[] = [];
    for (const n of GATE_INPUT_ROWS) if ((await post(n)) !== 403) landed.push(n);
    expect(landed).toEqual([]);
  });

  test('CONTROL: a read/write key lands on every learning row (mid-envelope)', async () => {
    for (const n of LEARNING_ROWS) {
      const b = LEARNING_ROW_BOUNDS[n]!;
      expect(await post(n, (b.min + b.max) / 2)).toBe(200);
    }
  });
});
