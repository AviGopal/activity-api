/**
 * β-LEAK REPLAY — must-fails (check-first) and controls.
 *
 * The replay undoes, once, the β that withheld executions leaked into variant_performance_metrics, for exactly
 * the CLEAN pairs of eligible arms in a shipped, sha-pinned list (here: the commit-1 FIXTURE list). The write
 * is a NON-FOLDING compensation queue in posterior-aggregator whose flush applies a row's items together with
 * its genuine Σδ in ONE transaction (CAS-guarded on the pre-read, ledger-keyed). See posterior-compensation.ts.
 *
 * In-process fake store: `FakeDb` answers the exact SQL constants the modules export and interprets the
 * compensation transaction BY CONTRACT ($__ok guard, dup check, UPDATE, one ledger CREATE per item, RETURN).
 * The SurrealQL itself is not executed against an engine here; that is verified live, not by this file.
 *
 * RUNS IN ITS OWN bun PROCESS (the posterior-drop-execution-id.test.ts pattern): posterior-aggregator caches
 * POSTERIOR_COALESCE at first import (another file sets it to '0' in-process) and holds module-level queues.
 * In a larger run this registers ONE test that re-runs this file alone in a child with a clean env and asserts
 * the child's counts. POSTERIOR_FLUSH_MS is set very large in the child so the aggregator's own timer can never
 * flush with the real client between an enqueue and the test's explicit flush.
 */
import { describe, expect, test, afterEach } from 'bun:test';
import { join as pathJoin, relative as pathRelative } from 'node:path';

const CASES = 37;
const ISOLATED_ENV = 'ACTIVITY_API_ISOLATED_TEST';
const ISOLATED = process.env[ISOLATED_ENV] === import.meta.path;
if (!ISOLATED) {
  test(`runs isolated in its own bun process (${CASES} cases)`, () => {
    const root = pathJoin(import.meta.dir, '..', '..');
    const r = Bun.spawnSync(['bun', 'test', './' + pathRelative(root, import.meta.path)], {
      cwd: root,
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '', TZ: 'UTC', [ISOLATED_ENV]: import.meta.path },
      stdout: 'pipe', stderr: 'pipe', timeout: 240_000,
    });
    const out = (r.stdout.toString() + '\n' + r.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const count = (k: string) => Number(out.match(new RegExp(`^\\s*(\\d+) ${k}\\s*$`, 'm'))?.[1] ?? -1);
    expect({ exit: r.exitCode, pass: count('pass'), fail: count('fail') }, out.split('\n').filter((l) => !l.startsWith('{') && !/^\d{4}-\d\d-\d\dT/.test(l)).join('\n').slice(-6000))
      .toEqual({ exit: 0, pass: CASES, fail: 0 });
  }, 250_000);
}

if (ISOLATED) {
  process.env.SURREALDB_NAMESPACE ??= 'activity-system';
  process.env.SURREALDB_DATABASE ??= 'learning_loop';
  process.env.SURREALDB_URL = 'http://127.0.0.1:9';
  process.env.SURREALDB_USERNAME ??= 'test';
  process.env.SURREALDB_PASSWORD ??= 'test';
  process.env.POSTERIOR_FLUSH_MS = '3600000';
  delete process.env.POSTERIOR_COALESCE;

  type Row = { row_id: string; thompson_alpha: number; thompson_beta: number; updated_at_s: string; successful_executions: number; failed_executions: number };
  type AnyRec = Record<string, any>;

  const ORG = 'organizations:substrate';
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-10-09T00:00:00.000Z');
  const NOW_ISO = new Date(NOW).toISOString();
  const LEAK = Date.parse('2026-10-04T00:00:00.000Z'); // the fixture's applied_ts: exactly 5 days before NOW
  const OP = { jwtToken: '', orgId: ORG, role: 'admin', scopes: ['read', 'write', 'admin'] } as AnyRec;

  // Loaded per test (dynamic import), so at a base without the modules every case fails on its own.
  async function mods() {
    await import('./posterior-update'); // it and posterior-aggregator import each other
    const PU = await import('./posterior-update');
    const AGG = await import('./posterior-aggregator');
    const PC = await import('./posterior-compensation');
    return { PU, AGG, PC };
  }

  // THE TRANSACTION'S LOAD-BEARING CLAUSES, written out here independently of the module. The fake interprets
  // the transaction by contract and cannot parse SurrealQL, so it REFUSES any transaction text that lacks one of
  // these: deleting the CAS guard (or the dup guard) from COMPENSATION_TXN_SQL then fails every write case,
  // instead of surviving because the fake re-implemented the guard in TS.
  const TXN_REQUIRED = [
    "LET $__rows = (SELECT thompson_alpha, thompson_beta, <string> (updated_at ?? '') AS updated_at_s FROM variant_performance_metrics WHERE variant_id = $variant_id AND org_id = $org_id LIMIT 2);",
    "LET $__dup = $keys.filter(|$k| record::exists(type::thing('posterior_compensation_ledger', $k)) AND type::thing('posterior_compensation_ledger', $k).status != 'cas_retry');",
    "LET $__cas = array::len($__rows) = $seen_rows\n  AND ($seen_rows != 1 OR ($__rows[0].thompson_alpha = $seen_alpha AND $__rows[0].thompson_beta = $seen_beta AND $__rows[0].updated_at_s = $seen_updated_at));",
    'LET $__ok = array::len($__dup) = 0 AND $__cas;',
    'WHERE variant_id = $variant_id AND org_id = $org_id AND $__ok = true AND $do_update = true RETURN AFTER);',
    '  IF $__ok {\n    UPSERT',
    '  } ELSE IF array::len($__dup) = 0 {\n    UPSERT',
  ];

  class FakeDb {
    /** Simulates the 2.3.10 silent-zero: every by-record-id ledger read returns no rows. */
    emptyLedgerReads = false;
    /** Simulates a composite-index read that drops a conjunct: the per-row ledger read returns every row. */
    foreignRowRead = false;
    vpm = new Map<string, Row[]>();
    ledger = new Map<string, AnyRec>();
    writes: string[] = [];
    beforeTxn: (() => void) | null = null;
    constructor(private M: Awaited<ReturnType<typeof mods>>) {}
    seed(arm: string, row: Partial<Row>) {
      this.vpm.set(`${arm}|${ORG}`, [{ row_id: `variant_performance_metrics:${arm}_r0`, thompson_alpha: 3, thompson_beta: 5, updated_at_s: NOW_ISO, successful_executions: 10, failed_executions: 10, ...row }]);
    }
    seedTwo(arm: string) {
      this.seed(arm, {});
      this.vpm.get(`${arm}|${ORG}`)!.push({ ...this.row(arm), row_id: `variant_performance_metrics:${arm}_r1` });
    }
    row(arm: string): Row { return this.vpm.get(`${arm}|${ORG}`)![0]; }
    async query<T = unknown>(sql: string, v: AnyRec = {}): Promise<T[]> {
      const { AGG, PC } = this.M;
      const rows = () => this.vpm.get(`${v.variant_id}|${v.org_id}`) ?? [];
      if (sql === AGG.COMPENSATION_ROW_SQL) return rows().slice(0, 2).map((r) => ({ ...r })) as T[];
      // A by-record-id ledger read: SELECT <fields> FROM posterior_compensation_ledger:⟨k⟩, … (missing ids yield no row).
      const byId = /^SELECT (.+?) FROM ((?:posterior_compensation_ledger:⟨[0-9a-f]{64}⟩(?:, )?)+)$/.exec(sql);
      if (byId) {
        if (this.emptyLedgerReads) return [] as T[];
        const ids = [...byId[2].matchAll(/⟨([0-9a-f]{64})⟩/g)].map((m) => m[1]);
        const wantAll = byId[1] === PC.LEDGER_READ_FIELDS;
        return ids.filter((k) => this.ledger.has(k)).map((k) => {
          const l = this.ledger.get(k)!;
          return wantAll ? { ...l } : { ledger_key: l.ledger_key, status: l.status, attempts: l.attempts };
        }) as T[];
      }
      if (sql === AGG.COMPENSATION_LEDGER_ROW_SQL) {
        return [...this.ledger.values()].filter((l) => this.foreignRowRead || (l.variant_id === v.variant_id && l.org_id === v.org_id))
          .map((l) => ({ ledger_key: l.ledger_key, variant_id: l.variant_id, org_id: l.org_id, status: l.status })) as T[];
      }
      if (sql === PC.COMPLETION_READ_SQL) return (this.ledger.has('complete') ? [{ ...this.ledger.get('complete') }] : []) as T[];
      if (sql === PC.COMPLETION_CREATE_SQL) {
        if (this.ledger.has('complete')) throw new Error('Database record already exists');
        this.ledger.set('complete', { ledger_key: 'complete', status: 'complete', list_sha: v.list_sha, eligible_total: v.eligible_total, at_s: NOW_ISO });
        this.writes.push('completion_create');
        return [{}] as T[];
      }
      if (sql.startsWith('SELECT VALUE org_id FROM variant_performance_metrics')) return [] as T[];
      if (sql === AGG.COMPENSATION_TXN_SQL) return [null, null, null, null, null, null, this.txn(sql, v)] as T[];
      throw new Error(`FakeDb: unexpected SQL ${sql.slice(0, 120)}`);
    }
    async queryAll(sql: string, v: AnyRec = {}): Promise<unknown[]> {
      if (sql !== this.M.AGG.COMPENSATION_TXN_SQL) throw new Error(`FakeDb.queryAll: unexpected SQL ${sql.slice(0, 120)}`);
      return [null, null, null, null, null, null, this.txn(sql, v)];
    }
    /** COMPENSATION_TXN_SQL by contract: guard, UPDATE, one UPSERT per item (decided status, or the miss status). */
    txn(sql: string, v: AnyRec): AnyRec {
      const missing = TXN_REQUIRED.filter((c) => !sql.includes(c));
      if (missing.length > 0) throw new Error(`FakeDb: transaction text lacks a required clause: ${missing.join(' | ')}`);
      this.writes.push('txn');
      if (this.beforeTxn) { const h = this.beforeTxn; this.beforeTxn = null; h(); }
      const rows = this.vpm.get(`${v.variant_id}|${v.org_id}`) ?? [];
      const dup = (v.keys as string[]).filter((k) => this.ledger.has(k) && this.ledger.get(k)!.status !== 'cas_retry');
      const r0 = rows[0];
      const cas = Math.min(rows.length, 2) === v.seen_rows
        && (v.seen_rows !== 1 || (r0.thompson_alpha === v.seen_alpha && r0.thompson_beta === v.seen_beta && r0.updated_at_s === v.seen_updated_at));
      const ok = dup.length === 0 && cas;
      const willUpdate = ok && v.do_update;
      const a = rows[0] ? (willUpdate ? { thompson_alpha: v.new_alpha, thompson_beta: v.new_beta } : rows[0]) : undefined;
      const at_s = new Date(v.now).toISOString();
      for (const it of v.items as AnyRec[]) {
        const { miss_status, record_after, ...fields } = it;
        if (ok) {
          this.ledger.set(it.ledger_key, { ...fields, ...(record_after ? { after: { alpha: a!.thompson_alpha, beta: a!.thompson_beta } } : {}), at_s });
          this.writes.push('ledger_upsert');
        } else if (dup.length === 0) {
          const { status: _s, before: _b, observed_row_ids: _o, ...rest } = fields;
          this.ledger.set(it.ledger_key, { ...rest, applied: 0, status: miss_status, at_s });
          this.writes.push('ledger_upsert');
        }
      }
      let updated = 0;
      if (willUpdate) {
        for (const r of rows) { r.thompson_alpha = v.new_alpha; r.thompson_beta = v.new_beta; r.updated_at_s = at_s; }
        updated = rows.length;
        this.writes.push('vpm_update');
      }
      return { ok, cas, dup, rows: rows.length, updated, after_alpha: a?.thompson_alpha, after_beta: a?.thompson_beta };
    }
  }

  async function setup(over: AnyRec = {}) {
    const M = await mods();
    const db = new FakeDb(M);
    const sleeps: number[] = [];
    const deps = {
      ...M.PC.defaultCompensationDeps(),
      db,
      inputs: () => M.PC.loadFrozenInputs(M.PC.DEFAULT_SOURCES),
      flush: () => M.AGG.flushPosteriors({ db, nowMs: NOW }),
      nowMs: () => NOW,
      sleep: async (ms: number) => { sleeps.push(ms); },
      outcomeTimeoutMs: 1_000,
      ...over,
    };
    const inputs = M.PC.loadFrozenInputs(M.PC.DEFAULT_SOURCES) as AnyRec;
    const key = (exec: string): string => [...inputs.pairs.values()].find((p: AnyRec) => p.exec_id === exec)!.ledger_key;
    // The WRITE paths are unreachable from the routes in this build (apply_requires_authorization); the mechanism
    // is exercised through unauthorizedApply. The ROUTES are exercised for auth, refusal, dry_run and verify.
    const one = (k: string, extra: AnyRec = {}) => M.PC.unauthorizedApply.key({ type: 'posteriorCompensation', ledger_key: k, ...extra }, deps as any);
    const applyArms = (p: AnyRec = {}) => M.PC.unauthorizedApply.arms({ type: 'posteriorCompensationReplay', ...p }, deps as any);
    const route1 = (k: string, auth: AnyRec | null = OP, extra: AnyRec = {}) => M.PC.resolvePosteriorCompensation({ type: 'posteriorCompensation', ledger_key: k, ...extra }, auth as any, deps as any);
    const replay = (p: AnyRec, auth: AnyRec | null = OP) => M.PC.resolvePosteriorCompensationReplay({ type: 'posteriorCompensationReplay', ...p }, auth as any, deps as any);
    const residue = (leakMs: number) => M.PU.decayedThompsonCounts(1, 2, leakMs, NOW).beta - 1;
    return { ...M, db, deps, sleeps, key, one, applyArms, route1, replay, residue, inputs };
  }

  /** Seed every eligible fixture arm with a row that will take its compensation without flooring. */
  function seedAll(db: FakeDb) {
    for (const a of ['fx-arm-a', 'fx-arm-c', 'fx-arm-d', 'fx-arm-e']) db.seed(a, { thompson_alpha: 3, thompson_beta: 5 });
  }

  afterEach(async () => {
    // Nothing a case queued may leak into the next case's flush.
    const { AGG } = await mods().catch(() => ({ AGG: null as any }));
    if (AGG && AGG.pendingCompensationCount() > 0) await AGG.flushPosteriors({ db: { query: async () => [] } as any, nowMs: NOW });
  });

  describe('β-leak replay — must-fails', () => {
    test('a ledger_key already in the ledger → already_compensated; β unchanged; no second write', async () => {
      const t = await setup();
      t.db.seed('fx-arm-a', { thompson_beta: 5 });
      const k = t.key('exec_fx_a1');
      const first = await t.one(k);
      expect((first.body as AnyRec).body.status).toBe('written');
      const beta1 = t.db.row('fx-arm-a').thompson_beta;
      const updates1 = t.db.writes.filter((w) => w === 'vpm_update').length;
      const second = await t.one(k);
      expect(second.status).toBe(200);
      expect((second.body as AnyRec).body.status).toBe('already_compensated');
      expect((second.body as AnyRec).body.applied).toBe(0);
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(beta1);
      expect(t.db.writes.filter((w) => w === 'vpm_update').length).toBe(updates1);
      expect([...t.db.ledger.keys()].filter((x) => x === k).length).toBe(1);
    });

    test('a re-run of the whole activity after a full run → 0 deltas (replay_complete), β and ledger unchanged', async () => {
      const t = await setup();
      seedAll(t.db);
      const run1 = await t.applyArms();
      expect((run1.body as AnyRec).body.replay_complete).toBe(true);
      expect((run1.body as AnyRec).body.totals.written).toBe(5);
      const snapshot = JSON.stringify([...t.db.vpm.entries()]);
      const ledgerSize = t.db.ledger.size;
      const writes = t.db.writes.length;
      const run2 = await t.applyArms();
      expect((run2.body as AnyRec).refused).toBe('replay_complete');
      expect(JSON.stringify([...t.db.vpm.entries()])).toBe(snapshot);
      expect(t.db.ledger.size).toBe(ledgerSize);
      expect(t.db.writes.length).toBe(writes);
    });

    test('a re-run over an arm before completion → every pair already_compensated, applied 0, β unchanged', async () => {
      const t = await setup();
      seedAll(t.db);
      await t.applyArms({ arm_ids: ['fx-arm-a'] });
      const beta = t.db.row('fx-arm-a').thompson_beta;
      const again = await t.applyArms({ arm_ids: ['fx-arm-a'] });
      const rec = (again.body as AnyRec).body.arms[0];
      expect(rec.counts.already_compensated).toBe(2);
      expect(rec.counts.written).toBe(0);
      expect(rec.applied_sum).toBe(0);
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(beta);
    });

    test('β that would cross the prior → floored, no posterior write, a ledger row records it', async () => {
      const t = await setup();
      t.db.seed('fx-arm-e', { thompson_alpha: 2, thompson_beta: 1.5 });
      const k = t.key('exec_fx_e1');
      const r = await t.one(k);
      expect((r.body as AnyRec).body.status).toBe('floored');
      expect((r.body as AnyRec).body.applied).toBe(0);
      expect(t.db.row('fx-arm-e').thompson_beta).toBe(1.5);
      expect(t.db.writes).not.toContain('vpm_update');
      expect(t.db.ledger.get(k)?.status).toBe('floored');
    });

    test('a row at its exit counts (α=s+1, β=f+1) → reset_since_leak, no posterior write', async () => {
      const t = await setup();
      t.db.seed('fx-arm-d', { thompson_alpha: 4, thompson_beta: 7, successful_executions: 3, failed_executions: 6 });
      const k = t.key('exec_fx_d1');
      const r = await t.one(k);
      expect((r.body as AnyRec).body.status).toBe('reset_since_leak');
      expect(t.db.row('fx-arm-d').thompson_beta).toBe(7);
      expect(t.db.writes).not.toContain('vpm_update');
      expect(t.db.ledger.get(k)?.status).toBe('reset_since_leak');
    });

    test('a racing genuine δ + a compensation on one row → β = decay(before) + δ − residue, exactly one ledger row', async () => {
      const t = await setup();
      const u = NOW - 2 * DAY; // stored two days ago, so the flush decays it
      t.db.seed('fx-arm-a', { thompson_alpha: 6, thompson_beta: 9, updated_at_s: new Date(u).toISOString() });
      expect(t.AGG.enqueueVariantDelta('fx-arm-a', ORG, 2, 1, 'leaf', undefined, 'exec-genuine')).toBe(true);
      const k = t.key('exec_fx_a1');
      const r = await t.one(k);
      const d = t.PU.decayedThompsonCounts(6, 9, u, NOW);
      expect((r.body as AnyRec).body.status).toBe('written');
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(d.beta + 1 - t.residue(LEAK));
      expect(t.db.row('fx-arm-a').thompson_alpha).toBe(d.alpha + 2);
      expect([...t.db.ledger.values()].filter((l) => l.variant_id === 'fx-arm-a').length).toBe(1);
      expect(t.db.writes.filter((w) => w === 'vpm_update').length).toBe(1);
    });

    test('a row that moves between the pre-read and the transaction → nothing written, re-queued, applied once on the next flush', async () => {
      const t = await setup();
      t.db.seed('fx-arm-a', { thompson_alpha: 3, thompson_beta: 5 });
      const k = t.key('exec_fx_a1');
      const p = t.AGG.enqueueCompensation({ ledgerKey: k, variantId: 'fx-arm-a', orgId: ORG, leakAtMs: LEAK, listSha: 'x' })!;
      t.db.beforeTxn = () => { const r = t.db.row('fx-arm-a'); r.thompson_beta = 8; r.updated_at_s = new Date(NOW - 1000).toISOString(); };
      await t.AGG.flushPosteriors({ db: t.db as any, nowMs: NOW });
      // The miss is RECORDED (cas_retry, attempt 1), never silent; the posterior is untouched.
      expect(t.db.ledger.get(k)?.status).toBe('cas_retry');
      expect(t.db.ledger.get(k)?.attempts).toBe(1);
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(8);
      expect(t.AGG.pendingCompensationCount()).toBe(1);
      await t.AGG.flushPosteriors({ db: t.db as any, nowMs: NOW });
      const o = await p;
      const d = t.PU.decayedThompsonCounts(3, 8, NOW - 1000, NOW);
      expect(o.status).toBe('written');
      expect(o.attempts).toBe(2);
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(d.beta - t.residue(LEAK));
      expect(t.db.ledger.size).toBe(1);
      expect(t.db.ledger.get(k)?.status).toBe('written');
    });

    test('a row that keeps moving → cas_retry each time, then TERMINAL cas_exhausted at the bound; never compensated', async () => {
      const t = await setup();
      t.db.seed('fx-arm-a', { thompson_alpha: 3, thompson_beta: 5 });
      const k = t.key('exec_fx_a1');
      const p = t.AGG.enqueueCompensation({ ledgerKey: k, variantId: 'fx-arm-a', orgId: ORG, leakAtMs: LEAK, listSha: 'x' })!;
      let racerBeta = 5;
      for (let i = 1; i <= t.AGG.CAS_MAX_ATTEMPTS; i++) {
        t.db.beforeTxn = () => { const r = t.db.row('fx-arm-a'); racerBeta += 1; r.thompson_beta = racerBeta; r.updated_at_s = new Date(NOW - i * 1000).toISOString(); };
        await t.AGG.flushPosteriors({ db: t.db as any, nowMs: NOW });
        expect(t.db.ledger.get(k)?.attempts).toBe(i);
        expect(t.db.ledger.get(k)?.status).toBe(i < t.AGG.CAS_MAX_ATTEMPTS ? 'cas_retry' : 'cas_exhausted');
      }
      const o = await p;
      expect(o.status).toBe('cas_exhausted');
      expect(o.applied).toBe(0);
      expect(t.AGG.pendingCompensationCount()).toBe(0);
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(racerBeta); // only the racer's writes
      expect(t.db.writes).not.toContain('vpm_update');
      expect(t.AGG.TERMINAL_LEDGER_STATUSES.has('cas_exhausted')).toBe(true);
      expect(t.AGG.TERMINAL_LEDGER_STATUSES.has('cas_retry')).toBe(false);
    });

    test('two rows match (variant, org) → TERMINAL skipped_ambiguous with the observed row ids; no posterior write; inertness reachable', async () => {
      const t = await setup();
      seedAll(t.db);
      t.db.seedTwo('fx-arm-c');
      const k = t.key('exec_fx_c1');
      const r = await t.one(k);
      const b = (r.body as AnyRec).body;
      expect(b.status).toBe('skipped_ambiguous');
      expect(b.observed_row_ids).toEqual(['variant_performance_metrics:fx-arm-c_r0', 'variant_performance_metrics:fx-arm-c_r1']);
      expect(t.db.ledger.get(k)?.status).toBe('skipped_ambiguous');
      expect(t.db.ledger.get(k)?.observed_row_ids).toEqual(b.observed_row_ids);
      expect(t.db.writes).not.toContain('vpm_update');
      // A terminal status: with every other eligible pair decided, the replay goes inert.
      const run = await t.applyArms();
      expect((run.body as AnyRec).body.replay_complete).toBe(true);
      expect(t.db.ledger.get('complete')?.status).toBe('complete');
    });

    test('a key ledgered by a racing writer between the pre-read and the transaction → nothing applied; settles already_compensated', async () => {
      const t = await setup();
      t.db.seed('fx-arm-a', { thompson_alpha: 3, thompson_beta: 5 });
      const k = t.key('exec_fx_a1');
      const p = t.AGG.enqueueCompensation({ ledgerKey: k, variantId: 'fx-arm-a', orgId: ORG, leakAtMs: LEAK, listSha: 'x' })!;
      t.db.beforeTxn = () => { t.db.ledger.set(k, { ledger_key: k, variant_id: 'fx-arm-a', org_id: ORG, status: 'written' }); };
      await t.AGG.flushPosteriors({ db: t.db as any, nowMs: NOW });
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(5);
      expect(t.db.writes).not.toContain('vpm_update');
      expect(t.AGG.pendingCompensationCount()).toBe(1);
      await t.AGG.flushPosteriors({ db: t.db as any, nowMs: NOW });
      const o = await p;
      expect(o.status).toBe('already_compensated');
      expect(o.applied).toBe(0);
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(5);
      expect(t.db.ledger.size).toBe(1);
    });

    test('a double compensation in one flush → 1 written + 1 already_compensated; β lowered once', async () => {
      const t = await setup();
      t.db.seed('fx-arm-a', { thompson_alpha: 3, thompson_beta: 5 });
      const k = t.key('exec_fx_a1');
      const req = { ledgerKey: k, variantId: 'fx-arm-a', orgId: ORG, leakAtMs: LEAK, listSha: 'x' };
      const p1 = t.AGG.enqueueCompensation(req)!;
      const p2 = t.AGG.enqueueCompensation(req)!;
      await t.AGG.flushPosteriors({ db: t.db as any, nowMs: NOW });
      const statuses = [(await p1).status, (await p2).status].sort();
      expect(statuses).toEqual(['already_compensated', 'written']);
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(5 - t.residue(LEAK));
      expect(t.db.ledger.size).toBe(1);
    });

    test('a 5-day-old leak → residue < 1, exactly the kernel applied to a unit β at leak_at', async () => {
      const t = await setup();
      const r = t.AGG.compensationResidue(LEAK, LEAK + 5 * DAY);
      expect(r).toBe(t.PU.decayedThompsonCounts(1, 2, LEAK, LEAK + 5 * DAY).beta - 1);
      expect(r).toBeLessThan(1);
      expect(r).toBeCloseTo(Math.pow(0.5, 5 / 30), 12);
      t.db.seed('fx-arm-c', { thompson_beta: 5 });
      const o = await t.one(t.key('exec_fx_c1'));
      expect((o.body as AnyRec).body.applied).toBe(t.residue(LEAK));
      expect((o.body as AnyRec).body.factor).toBe(t.AGG.compensationResidue(LEAK, NOW));
    });

    test('a well-formed key not in the list → not_in_frozen_list; nothing queued or written', async () => {
      const t = await setup();
      seedAll(t.db);
      const r = await t.one('0'.repeat(64));
      expect(r.status).toBe(422);
      expect((r.body as AnyRec).refused).toBe('not_in_frozen_list');
      expect(t.AGG.pendingCompensationCount()).toBe(0);
      expect(t.db.writes).toEqual([]);
    });

    test('a CLEAN key whose arm is not eligible → arm_not_eligible; nothing written', async () => {
      const t = await setup();
      t.db.seed('fx-arm-b', {});
      const r = await t.one(t.key('exec_fx_b1'));
      expect((r.body as AnyRec).refused).toBe('arm_not_eligible');
      expect(t.db.writes).toEqual([]);
    });

    test('any call after completion → replay_complete', async () => {
      const t = await setup();
      seedAll(t.db);
      for (const e of ['exec_fx_a1', 'exec_fx_a2', 'exec_fx_c1', 'exec_fx_d1', 'exec_fx_e1']) await t.one(t.key(e));
      expect(t.db.ledger.get('complete')?.status).toBe('complete');
      const writes = t.db.writes.length;
      for (const e of ['exec_fx_a1', 'exec_fx_b1', 'exec_fx_c2']) {
        const r = await t.one(t.key(e));
        expect((r.body as AnyRec).refused).toBe('replay_complete');
      }
      expect((await t.one('f'.repeat(64))).body.refused).toBe('replay_complete');
      expect(t.db.writes.length).toBe(writes);
    });

    test('a completion row present at boot is honoured: every call → replay_complete', async () => {
      const t = await setup();
      seedAll(t.db);
      t.db.ledger.set('complete', { ledger_key: 'complete', status: 'complete' });
      expect((await t.one(t.key('exec_fx_a1'))).body.refused).toBe('replay_complete');
      expect(t.db.writes).toEqual([]);
    });

    test('a list file whose sha ≠ the pin → every call refused, nothing written', async () => {
      const t = await setup();
      const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(pathJoin(tmpdir(), 'pc-'));
      const tampered = pathJoin(dir, 'list.tsv');
      writeFileSync(tampered, readFileSync(t.PC.REPLAY_LIST_PATH, 'utf8').replace('exec_fx_a1', 'exec_fx_aX'));
      t.deps.inputs = () => t.PC.loadFrozenInputs({ ...t.PC.DEFAULT_SOURCES, listPath: tampered });
      seedAll(t.db);
      const k = t.key('exec_fx_a2'); // a key that would be valid under the pinned file
      expect((await t.one(k)).body.refused).toBe('list_sha_mismatch');
      expect((await t.applyArms()).body.refused).toBe('list_sha_mismatch');
      expect((await t.replay({ mode: 'dry_run' })).body.refused).toBe('list_sha_mismatch');
      expect((await t.replay({ mode: 'verify' })).body.refused).toBe('list_sha_mismatch');
      expect(t.db.writes).toEqual([]);
    });

    test('an eligibility file whose sha ≠ the pin → every call refused', async () => {
      const t = await setup();
      const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(pathJoin(tmpdir(), 'pc-'));
      const tampered = pathJoin(dir, 'elig.tsv');
      writeFileSync(tampered, readFileSync(t.PC.ELIGIBILITY_PATH, 'utf8').replace('fx-arm-b\torganizations:substrate\t2\t0', 'fx-arm-b\torganizations:substrate\t1\t1'));
      t.deps.inputs = () => t.PC.loadFrozenInputs({ ...t.PC.DEFAULT_SOURCES, eligibilityPath: tampered });
      seedAll(t.db);
      expect((await t.one(t.key('exec_fx_b1'))).body.refused).toBe('eligibility_sha_mismatch');
      expect(t.db.writes).toEqual([]);
    });

    test('a non-operator caller → refused not_operator on both route shapes (reads included), nothing written', async () => {
      const t = await setup();
      seedAll(t.db);
      const k = t.key('exec_fx_a1');
      const member = { jwtToken: '', orgId: ORG, role: 'member', scopes: ['read', 'write'] };
      const oboAdmin = { ...OP, obo: { node: 'peer', shape: 'posteriorCompensation' } };
      for (const auth of [member, null, oboAdmin]) {
        const r = await t.route1(k, auth);
        expect(r.status).toBe(403);
        expect((r.body as AnyRec).refused).toBe('not_operator');
        for (const mode of ['apply', 'dry_run', 'verify']) expect((await t.replay({ mode }, auth)).body.refused).toBe('not_operator');
      }
      expect(t.db.writes).toEqual([]);
      expect(t.db.ledger.size).toBe(0);
    });

    test('an OPERATOR write through either route → apply_requires_authorization; nothing written, no ledger row', async () => {
      const t = await setup();
      seedAll(t.db);
      const snapshot = JSON.stringify([...t.db.vpm.entries()]);
      const r1 = await t.route1(t.key('exec_fx_a1'), OP);
      expect(r1.status).toBe(403);
      expect((r1.body as AnyRec).refused).toBe('apply_requires_authorization');
      for (const p of [{ mode: 'apply' }, { mode: 'apply', arm_ids: ['fx-arm-a'] }]) {
        const r = await t.replay(p, OP);
        expect(r.status).toBe(403);
        expect((r.body as AnyRec).refused).toBe('apply_requires_authorization');
      }
      // Admin scope is not a write bound: the bootstrap key's scope set is refused just the same.
      expect((await t.route1(t.key('exec_fx_a1'), { ...OP, role: undefined, scopes: ['read', 'write', 'admin'] })).body.refused).toBe('apply_requires_authorization');
      expect(t.AGG.pendingCompensationCount()).toBe(0);
      expect(t.db.writes).toEqual([]);
      expect(t.db.ledger.size).toBe(0);
      expect(JSON.stringify([...t.db.vpm.entries()])).toBe(snapshot);
    });

    test('an AMBIGUOUS pair is never compensated (refused by key; absent from every apply)', async () => {
      const t = await setup();
      seedAll(t.db);
      const amb = t.key('exec_fx_c2');
      const r = await t.one(amb);
      expect((r.body as AnyRec).refused).toBe('not_in_frozen_list');
      expect(String((r.body as AnyRec).detail)).toContain('AMBIGUOUS');
      const run = await t.applyArms();
      const armC = (run.body as AnyRec).body.arms.find((a: AnyRec) => a.arm_id === 'fx-arm-c');
      expect(armC.ledger_keys).not.toContain(amb);
      expect(armC.k).toBe(1);
      expect(t.db.ledger.has(amb)).toBe(false);
    });

    test('coalescing disabled → refused (both write paths), nothing queued', async () => {
      const t = await setup({ coalesceEnabled: () => false });
      seedAll(t.db);
      expect((await t.one(t.key('exec_fx_a1'))).body.refused).toBe('coalescing_disabled');
      expect((await t.applyArms()).body.refused).toBe('coalescing_disabled');
      expect(t.AGG.pendingCompensationCount()).toBe(0);
      expect(t.db.writes).toEqual([]);
    });

    test('posteriorCompensation accepts ONLY { ledger_key }: variant/org/delta fields are refused', async () => {
      const t = await setup();
      seedAll(t.db);
      for (const extra of [{ variant_id: 'fx-arm-a' }, { org_id: ORG }, { beta_delta: -1 }, { alpha_delta: 1 }]) {
        const r = await t.one(t.key('exec_fx_a1'), extra);
        expect((r.body as AnyRec).refused).toBe('unexpected_field');
      }
      expect(t.db.writes).toEqual([]);
    });
  });

  describe('β-leak replay — controls', () => {
    test('a fresh CLEAN pair on a fixture row → β lowered by exactly the residue; one ledger row `written`', async () => {
      const t = await setup();
      t.db.seed('fx-arm-c', { thompson_alpha: 4, thompson_beta: 5 });
      const k = t.key('exec_fx_c1');
      const r = await t.one(k);
      const b = (r.body as AnyRec).body;
      expect(b.status).toBe('written');
      expect(t.db.row('fx-arm-c').thompson_beta).toBe(5 - t.residue(LEAK));
      expect(t.db.row('fx-arm-c').thompson_alpha).toBe(4);
      expect(b.before).toEqual({ alpha: 4, beta: 5 });
      expect(b.after).toEqual({ alpha: 4, beta: 5 - t.residue(LEAK) });
      expect([...t.db.ledger.values()].filter((l) => l.ledger_key !== 'complete').map((l) => [l.ledger_key, l.status])).toEqual([[k, 'written']]);
    });

    test('the dry run writes nothing and plans k, β before, expected residue and β after the floor', async () => {
      const t = await setup();
      seedAll(t.db);
      t.db.seed('fx-arm-e', { thompson_beta: 1.5 });
      const before = JSON.stringify([...t.db.vpm.entries()]);
      const r = await t.replay({});
      expect(r.status).toBe(200);
      expect(t.db.writes).toEqual([]);
      expect(t.db.ledger.size).toBe(0);
      expect(JSON.stringify([...t.db.vpm.entries()])).toBe(before);
      const plan = (r.body as AnyRec).body;
      expect(plan.mode).toBe('dry_run');
      const a = plan.arms.find((x: AnyRec) => x.arm_id === 'fx-arm-a');
      expect(a.k).toBe(2);
      expect(a.before).toEqual({ alpha: 3, beta: 5 });
      expect(a.expected_residue).toBeCloseTo(t.residue(LEAK) + t.residue(Date.parse('2026-10-06T12:00:00Z')), 12);
      expect(a.beta_after_floor).toBeCloseTo(5 - a.expected_residue, 12);
      const e = plan.arms.find((x: AnyRec) => x.arm_id === 'fx-arm-e');
      expect(e.expected_floored).toBe(1);
      expect(plan.excluded_arms.map((x: AnyRec) => x.arm_id)).toEqual(['fx-arm-b']);
      // Mechanical diff against the frozen eligibility: every arm carries its CLEAN keys, k and eligibility.
      expect(a.eligible).toBe(true);
      expect(a.keys).toEqual([t.key('exec_fx_a1'), t.key('exec_fx_a2')]);
      expect(plan.excluded_arms[0]).toMatchObject({ arm_id: 'fx-arm-b', eligible: false, k: 1, keys: [t.key('exec_fx_b1')] });
      expect(plan.totals).toMatchObject({ arms: 4, keys: 5, k: 5, excluded_arms: 1, excluded_keys: 1 });
    });

    test('dry run accounts for ledger statuses and planned ambiguity: k counts only non-terminal keys', async () => {
      const t = await setup();
      seedAll(t.db);
      await t.applyArms({ arm_ids: ['fx-arm-a'] });
      t.db.seedTwo('fx-arm-c');
      // A cas_retry row is NOT terminal: its key still counts in k.
      t.db.ledger.set(t.key('exec_fx_d1'), { ledger_key: t.key('exec_fx_d1'), variant_id: 'fx-arm-d', org_id: ORG, status: 'cas_retry', attempts: 2 });
      const writes = t.db.writes.length;
      const plan = (await t.replay({})).body as AnyRec;
      expect(t.db.writes.length).toBe(writes);
      const arm = (id: string) => plan.body.arms.find((x: AnyRec) => x.arm_id === id);
      expect(arm('fx-arm-a')).toMatchObject({ k: 0, ledger_statuses: { written: 2 } });
      expect(arm('fx-arm-c')).toMatchObject({ row: 'ambiguous', k: 1, expected_skipped_ambiguous: 1, observed_row_ids: ['variant_performance_metrics:fx-arm-c_r0', 'variant_performance_metrics:fx-arm-c_r1'] });
      expect(arm('fx-arm-d')).toMatchObject({ k: 1, ledger_statuses: { cas_retry: 1 } });
      expect(plan.body.totals.ledger_statuses).toEqual({ written: 2, cas_retry: 1 });
      expect(plan.body.totals.expected_skipped_ambiguous).toBe(1);
    });

    test('the shipped fixture files match their pins; CLEAN ∩ ELIGIBLE is exactly the expected keys', async () => {
      const t = await setup();
      const inputs = t.PC.loadFrozenInputs() as AnyRec;
      expect(inputs.ok).toBe(true);
      expect([...inputs.keysByArm.keys()]).toEqual(['fx-arm-a', 'fx-arm-c', 'fx-arm-d', 'fx-arm-e']);
      expect(inputs.eligibleKeys).toEqual(['exec_fx_a1', 'exec_fx_a2', 'exec_fx_c1', 'exec_fx_d1', 'exec_fx_e1'].map(t.key));
      expect(t.key('exec_fx_a1')).toBe(t.PC.ledgerKeyOf({ node: 'fx-node', path: 'P1', withheld_ts: '2026-10-03T23:59:00.000000', arm_id: 'fx-arm-a', exec_id: 'exec_fx_a1' }));
    });

    test('leading `#` lines before the header: the sha pin covers the whole bytes; parsing yields the same rows', async () => {
      const t = await setup();
      const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { createHash } = await import('node:crypto');
      const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
      const dir = mkdtempSync(pathJoin(tmpdir(), 'pc-'));
      const list = pathJoin(dir, 'list.tsv');
      const elig = pathJoin(dir, 'elig.tsv');
      writeFileSync(list, '# frozen 2026-10-09T22:58:31Z\n# source: hub journal\n' + readFileSync(t.PC.REPLAY_LIST_PATH, 'utf8'));
      writeFileSync(elig, '# step-0 output\n' + readFileSync(t.PC.ELIGIBILITY_PATH, 'utf8'));
      const plain = t.PC.loadFrozenInputs() as AnyRec;
      // Pinned to the commented files' own bytes: accepted, and the same pairs/arms/keys as the plain files.
      const commented = t.PC.loadFrozenInputs({ listPath: list, listSha: sha(list), eligibilityPath: elig, eligibilitySha: sha(elig) }) as AnyRec;
      expect(commented.ok).toBe(true);
      expect([...commented.pairs.keys()]).toEqual([...plain.pairs.keys()]);
      expect([...commented.pairs.values()]).toEqual([...plain.pairs.values()]);
      expect([...commented.arms.values()]).toEqual([...plain.arms.values()]);
      expect(commented.eligibleKeys).toEqual(plain.eligibleKeys);
      // The `#` lines are inside the pin: the plain files' pins refuse the commented bytes.
      expect((t.PC.loadFrozenInputs({ ...t.PC.DEFAULT_SOURCES, listPath: list }) as AnyRec).refused).toBe('list_sha_mismatch');
      expect((t.PC.loadFrozenInputs({ ...t.PC.DEFAULT_SOURCES, eligibilityPath: elig }) as AnyRec).refused).toBe('eligibility_sha_mismatch');
    });

    test('apply goes one arm per write, spaced by the rate limit, and records per-arm before/after and sums', async () => {
      const t = await setup();
      seedAll(t.db);
      const r = await t.applyArms();
      const body = (r.body as AnyRec).body;
      expect(body.arms.map((a: AnyRec) => a.arm_id)).toEqual(['fx-arm-a', 'fx-arm-c', 'fx-arm-d', 'fx-arm-e']);
      expect(t.db.writes.filter((w) => w === 'txn').length).toBe(4); // one transaction per arm
      expect(t.sleeps.length).toBeGreaterThanOrEqual(3);
      for (const s of t.sleeps) expect(s).toBeLessThanOrEqual(5_000);
      const a = body.arms[0];
      expect(a.k).toBe(2);
      expect(a.before).toEqual({ alpha: 3, beta: 5 });
      expect(a.after).toEqual({ alpha: 3, beta: t.db.row('fx-arm-a').thompson_beta });
      expect(a.nominal_sum).toBe(2);
      expect(a.applied_sum).toBeCloseTo(5 - t.db.row('fx-arm-a').thompson_beta, 12);
      expect(body.totals.nominal_sum).toBe(5);
    });

    test('verify: an untouched row passes; a row pushed below the recorded AFTER (a reset) is FLAGGED', async () => {
      const t = await setup();
      seedAll(t.db);
      await t.applyArms();
      const ok = await t.replay({ mode: 'verify' });
      expect((ok.body as AnyRec).body.flags).toEqual([]);
      expect((ok.body as AnyRec).body.checked.length).toBe(4);
      // The ledger read is by record id; the count shows it actually returned the rows (not a silent zero).
      expect((ok.body as AnyRec).body.ledger_rows_read).toBe(5);
      const r = t.db.row('fx-arm-c');
      r.thompson_beta = 2; // overwritten below what decay alone could reach
      const bad = await t.replay({ mode: 'verify' });
      const flags = (bad.body as AnyRec).body.flags;
      expect(flags.map((f: AnyRec) => [f.arm_id, f.kind])).toEqual([['fx-arm-c', 'below_recorded_after']]);
      expect(flags[0].observed.beta).toBe(2);
      expect(typeof flags[0].boot_at).toBe('string');
    });

    test('QUERY SHAPE: no ledger read uses `IN $…`/CONTAINS/INSIDE (2.3.10 returns ZERO rows for an indexed field IN an array)', async () => {
      const t = await setup();
      const { readFileSync } = await import('node:fs');
      // The engine bug is invisible to the fake, so the statement SHAPE is pinned at the source.
      const bad = /\bIN\s+\$|\bCONTAINS\w*\b|\b(?:NOT|ANY|ALL|NONE)?INSIDE\b/i;
      // Negative control: the detector catches the shape that was here before.
      for (const op of ['ledger_key IN $keys', 'ledger_key INSIDE $keys', '$keys CONTAINSANY ledger_key', '$keys CONTAINSALL ledger_key', 'ledger_key NOTINSIDE $keys', '$keys CONTAINS ledger_key']) {
        expect(bad.test(`SELECT ledger_key, status FROM posterior_compensation_ledger WHERE ${op}`)).toBe(true);
      }
      const k = t.key('exec_fx_a1');
      const statements = [
        t.AGG.ledgerByIdsSql([k, t.key('exec_fx_a2')], 'ledger_key, status'),
        t.AGG.ledgerByIdsSql([k], t.PC.LEDGER_READ_FIELDS),
        t.AGG.COMPENSATION_LEDGER_ROW_SQL, t.AGG.COMPENSATION_ROW_SQL, t.AGG.COMPENSATION_TXN_SQL.replace(/FOR \$__it IN \$items/, ''),
        t.PC.COMPLETION_READ_SQL, t.PC.COMPLETION_CREATE_SQL,
      ];
      for (const sql of statements) expect({ sql, bad: bad.test(sql) }).toEqual({ sql, bad: false });
      expect(t.AGG.ledgerByIdsSql([k], 'status')).toBe(`SELECT status FROM posterior_compensation_ledger:⟨${k}⟩`);
      // A key that is not 64-hex never reaches a statement.
      expect(() => t.AGG.ledgerByIdsSql(["x⟩; DELETE posterior_compensation_ledger; --"], 'status')).toThrow();
      // And no new source line spells a ledger lookup with IN.
      for (const f of ['posterior-aggregator.ts', 'posterior-compensation.ts']) {
        const src = readFileSync(pathJoin(import.meta.dir, f), 'utf8');
        expect(src).not.toMatch(/FROM posterior_compensation_ledger WHERE ledger_key IN/);
      }
    });

    test('dry_run says which list it read: FIXTURE (file, pinned sha), never mistakable for the real list', async () => {
      const t = await setup();
      seedAll(t.db);
      const plan = ((await t.replay({})).body as AnyRec).body;
      expect(plan.list).toBe(`FIXTURE (replay-list.fixture.tsv, sha256 ${t.PC.REPLAY_LIST_SHA256})`);
      expect(plan.eligibility).toBe(`FIXTURE (eligibility.fixture.tsv, sha256 ${t.PC.ELIGIBILITY_SHA256})`);
      const v = ((await t.replay({ mode: 'verify' })).body as AnyRec).body;
      expect(v.list).toBe(plan.list);
      // A non-fixture file name is labelled FROZEN.
      const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { createHash } = await import('node:crypto');
      const dir = mkdtempSync(pathJoin(tmpdir(), 'pc-'));
      const real = pathJoin(dir, 'replay-list.tsv');
      writeFileSync(real, readFileSync(t.PC.REPLAY_LIST_PATH));
      const sha = createHash('sha256').update(readFileSync(real)).digest('hex');
      const inputs = t.PC.loadFrozenInputs({ ...t.PC.DEFAULT_SOURCES, listPath: real, listSha: sha }) as AnyRec;
      expect(inputs.list_label).toBe(`FROZEN (replay-list.tsv, sha256 ${sha})`);
    });

    test('verify on a ledger read that returns NOTHING after completion → success:false, ledger_rows_missing per arm', async () => {
      const t = await setup();
      seedAll(t.db);
      await t.applyArms();
      expect(t.db.ledger.get('complete')?.status).toBe('complete');
      t.db.emptyLedgerReads = true; // the 2.3.10 silent zero
      const r = ((await t.replay({ mode: 'verify' })).body as AnyRec);
      expect(r.success).toBe(false);
      expect(r.body.ledger_rows_read).toBe(0);
      expect(r.body.flags.map((f: AnyRec) => [f.arm_id, f.kind])).toEqual(
        ['fx-arm-a', 'fx-arm-c', 'fx-arm-d', 'fx-arm-e'].map((a) => [a, 'ledger_rows_missing']));
      expect(r.body.flags[0]).toMatchObject({ expected: { rows: 2 }, observed: { rows: 0 } });
    });

    test('verify with no expectation fails (no_expectation); expected_written short → written_rows_short; met → passes', async () => {
      const t = await setup();
      seedAll(t.db);
      const none = ((await t.replay({ mode: 'verify' })).body as AnyRec);
      expect(none.success).toBe(false);
      expect(none.body.flags.map((f: AnyRec) => f.kind)).toEqual(['no_expectation']);
      await t.applyArms({ arm_ids: ['fx-arm-a'] }); // not complete: only arm a
      const met = ((await t.replay({ mode: 'verify', arm_ids: ['fx-arm-a'], expected_written: { 'fx-arm-a': 2 } })).body as AnyRec);
      expect(met.body.flags).toEqual([]);
      expect(met.success).toBe(true);
      t.db.emptyLedgerReads = true;
      const short = ((await t.replay({ mode: 'verify', arm_ids: ['fx-arm-a'], expected_written: { 'fx-arm-a': 2 } })).body as AnyRec);
      expect(short.success).toBe(false);
      expect(short.body.flags).toEqual([expect.objectContaining({ arm_id: 'fx-arm-a', kind: 'written_rows_short', expected: { written: 2 }, observed: { written: 0 } })]);
    });

    test('a ledger row read that returns ANOTHER org\'s reset row is re-checked in app: dropped, the pair is not settled reset', async () => {
      const t = await setup();
      t.db.seed('fx-arm-a', { thompson_alpha: 3, thompson_beta: 5 });
      t.db.ledger.set('b'.repeat(64), { ledger_key: 'b'.repeat(64), variant_id: 'fx-arm-a', org_id: 'organizations:other', status: 'reset_since_leak' });
      t.db.foreignRowRead = true; // the read ignores org_id
      const r = await t.one(t.key('exec_fx_a1'));
      expect((r.body as AnyRec).body.status).toBe('written');
      expect(t.db.row('fx-arm-a').thompson_beta).toBe(5 - t.residue(LEAK));
    });

    test('TXN SHAPE: the CAS guard on α, β and <string> updated_at is in the transaction, and the fake refuses a transaction without it', async () => {
      const t = await setup();
      const sql = t.AGG.COMPENSATION_TXN_SQL;
      for (const clause of TXN_REQUIRED) expect({ clause, present: sql.includes(clause) }).toEqual({ clause, present: true });
      // The guard compares exactly the pre-read's three values.
      expect(sql).toContain('$__rows[0].thompson_alpha = $seen_alpha AND $__rows[0].thompson_beta = $seen_beta AND $__rows[0].updated_at_s = $seen_updated_at');
      // Instrument check: qa's mutant (e) — $__ok without $__cas — is refused by the fake, so it cannot pass.
      const mutant = sql.replace('LET $__ok = array::len($__dup) = 0 AND $__cas;', 'LET $__ok = array::len($__dup) = 0;');
      expect(mutant).not.toBe(sql);
      expect(() => t.db.txn(mutant, { keys: [], items: [] })).toThrow(/lacks a required clause/);
    });

    test('the ledger migration declares the UNIQUE ledger_key index and the nested before/after fields', async () => {
      const { readFileSync } = await import('node:fs');
      const s = readFileSync(pathJoin(import.meta.dir, '..', '..', 'sql', 'migrations', '218-posterior-compensation-ledger.surql'), 'utf8');
      expect(s).toMatch(/DEFINE INDEX IF NOT EXISTS \S+ ON posterior_compensation_ledger FIELDS ledger_key UNIQUE/);
      for (const f of ['before.alpha', 'before.beta', 'after.alpha', 'after.beta']) expect(s).toContain(`DEFINE FIELD IF NOT EXISTS ${f} `);
    });
  });
}
