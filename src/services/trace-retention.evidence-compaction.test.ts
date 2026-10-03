/**
 * CHECK-FIRST: retention never deletes graded or labelled evidence without first COMPACTING it.
 *
 * GAP: the-trace-ceiling-valve-evicts-oldest-first-across-all-kinds-so-gradable-history-is-deleted-
 * to-make-room-for-telemetry (widened to every retention phase). Measured 2026-10-03 on node 1 (db
 * fork, positive-controlled): one retention sweep on SurrealDB 2.3.10 deleted 2,015 reach_graded
 * executions. Every deleting phase is evidence-blind today:
 *   - the STRATUM reservoir (a uniform random sample of each over-cap stratum's cold tail) has no
 *     exemption and no compaction for graded rows;
 *   - the global-ceiling valve's range drain and id fallback are oldest-first and kind-blind;
 *   - the telemetry drain deletes every cold row of a declared id, graded or not.
 *
 * qa's ruling (the expected fix): a phase may let a trace BODY go, but a graded or labelled row's
 * observation record — execution id, observation (the verdict), instrument, horizon, code version,
 * at — is written to a small durable store BEFORE its delete. The trace store is not the archive;
 * the refold needs observations, not bodies. The valve, in addition, evicts non-gradable rows first
 * and, when only gradable rows remain over the cap, deletes none of them and SAYS so.
 *
 * "Graded or labelled evidence" (the protected predicate these tests pin):
 *   - `reached` is a boolean (a reached:false verdict is evidence too), or tags carry 'reach_graded:true';
 *   - or its id is the `execution_id` of a goal_verification_labels row (REALIGNMENT §2.2's record);
 *   - or its id is the `execution_id` of a `trace_evidence_ref` row whose `open` is not false, with
 *     `source` 'gap' (an open gap cites it) or 'attempt_ledger' (the causal attempt ledger cites it).
 *
 * SEAMS PINNED HERE (constraints on the fix):
 *   - observation store: table `execution_observation`, one row per execution, `execution_id` =
 *     meta::id(execution.id) (the same string key execution_trace_content uses), fields
 *     {execution_id, observation, instrument, horizon, code_version, at};
 *   - external references: table `trace_evidence_ref {execution_id, source, ref, open}`. The gap
 *     store and the attempt ledger live on development-vessel as files; this table is the in-store
 *     address retention can read at use time. Its writers are NOT exercised here;
 *   - the valve's "only gradable rows left over the cap" signal: getLastCeilingOutcome() reports
 *     stoppedBy 'protected_only' with `remaining` = the surplus it declined to delete (the gap seam
 *     today is a hardcoded network POST, which a test cannot observe).
 *
 * ORDER IS MEASURED IN THE DATABASE, not inferred from statement text: a DELETE event on `execution`
 * records, inside the deleting transaction, whether the row's observation record already existed.
 * That accepts both a separate compaction statement and a same-transaction write-then-delete, and
 * rejects a write after the delete. The INSTRUMENT tests prove the event can read both false and true,
 * and every must-fail test also requires one audit row per row actually removed, so a silent event
 * cannot make "no uncompacted protected delete" pass vacuously.
 *
 * Runs against a THROWAWAY SurrealDB named by SCRATCH_SURREALDB_URL (same guard as
 * trace-retention.drain.test.ts: loopback only, never the substrate's DB ports, its own database);
 * SKIPPED without it.
 */
const SCRATCH = process.env.SCRATCH_SURREALDB_URL ?? '';
const TEST_DB = 'retention_evidence_compaction_test';
if (SCRATCH) {
  const u = new URL(SCRATCH);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || ['8000', '18000'].includes(u.port)) {
    throw new Error(`refusing non-scratch SurrealDB for a destructive test: ${SCRATCH}`);
  }
  process.env.SURREALDB_URL = SCRATCH;
  process.env.SURREALDB_NAMESPACE = 'activity-system';
  process.env.SURREALDB_DATABASE = TEST_DB;
  process.env.SURREALDB_USERNAME = 'root';
  process.env.SURREALDB_PASSWORD = process.env.SCRATCH_SURREALDB_PASS ?? 'root';
}

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { readFileSync } from 'fs';

const mig = (f: string) => readFileSync(new URL(`../../sql/migrations/${f}`, import.meta.url), 'utf8');
const COUNTER_MIGRATION = mig('213-shape-score-counter.surql');
const LABEL_MIGRATIONS = [
  mig('101-goal-verification-labels.surql'),
  mig('183-relax-goal-verification-labeler-assert.surql'),
  mig('192-grounded-assertion-fields.surql'),
];

const run = SCRATCH ? describe : describe.skip;

type Mod = typeof import('./trace-retention');
let M: Mod;
let db: typeof import('../db/surreal')['surrealDB'];
let clearTuning: () => void;

const DAY = 86_400_000;
const HOT_MS = 2 * 3600_000;
const TELE = 'auth_resolve_v1';
const ORG = 'organizations:o';

async function q<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
  return db.query<T>(sql, params);
}
async function total(): Promise<number> {
  return Number((await q<{ count: number }>('SELECT count() FROM execution GROUP ALL'))[0]?.count ?? 0);
}
const countOf = async (aid: string) =>
  Number((await q<{ count: number }>('SELECT count() FROM execution WHERE activity_id = $a GROUP ALL', { a: aid }))[0]?.count ?? 0);
const exists = async (eid: string) =>
  (await q<string>('SELECT VALUE meta::id(id) FROM type::thing("execution", $e)', { e: eid })).length === 1;
async function setTuning(name: string, value: number | string): Promise<void> {
  await q('UPSERT type::thing("substrate_tuning_param", $name) SET name = $name, `value` = $value', { name, value });
}
async function declare(list: string | null) {
  await q('DELETE substrate_tuning_param WHERE name = "TRACE_RETENTION_TELEMETRY_ACTIVITIES"');
  if (list !== null) await q('CREATE substrate_tuning_param SET name = "TRACE_RETENTION_TELEMETRY_ACTIVITIES", `value` = $v', { v: list });
  clearTuning();
}

type Kind = 'graded_reached' | 'graded_not_reached' | 'labelled' | 'gap_ref' | 'ledger_ref' | 'ungraded' | 'telemetry';
const PROTECTED_KINDS: ReadonlySet<Kind> = new Set(['graded_reached', 'graded_not_reached', 'labelled', 'gap_ref', 'ledger_ref']);
/** Every protected execution id seeded in the current test. */
let protectedIds = new Set<string>();

/**
 * Seed `n` cold rows of one kind, `ageDays` old (one second apart, oldest first), with ids `${prefix}NNNNN`.
 * Protected kinds also write their reference (label row / trace_evidence_ref row).
 */
async function seed(kind: Kind, n: number, opts: { prefix: string; activity?: string; ageDays: number; success?: boolean }): Promise<string[]> {
  const now = Date.now();
  const rows: Array<Record<string, unknown>> = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${opts.prefix}${String(i).padStart(5, '0')}`;
    ids.push(id);
    const r: Record<string, unknown> = {
      id,
      activity_id: opts.activity ?? (kind === 'telemetry' ? TELE : `act-${kind}`),
      org_id: ORG,
      success: opts.success ?? true,
      executed_at: new Date(now - opts.ageDays * DAY + i * 1000),
    };
    if (kind === 'graded_reached') { r['reached'] = true; r['tags'] = ['reach_graded:true', 'reached:true']; }
    if (kind === 'graded_not_reached') { r['reached'] = false; r['tags'] = ['reach_graded:true', 'reached:false']; }
    if (kind === 'telemetry') r['tags'] = ['telemetry:auth'];
    rows.push(r);
  }
  for (let i = 0; i < rows.length; i += 500) await q('INSERT INTO execution $rows RETURN NONE', { rows: rows.slice(i, i + 500) });
  for (const id of ids) {
    const r = rows.find((x) => x['id'] === id)!;
    if (kind === 'labelled') {
      await q(
        'CREATE goal_verification_labels CONTENT { org_id: $o, goal: "g", execution_id: $e, activity_id: $a, verdict: "achieved", confidence: 0.9, labeler: "human" }',
        { o: ORG, e: id, a: r['activity_id'] },
      );
    }
    if (kind === 'gap_ref') await q('CREATE trace_evidence_ref CONTENT { execution_id: $e, source: "gap", ref: "gap-under-test", open: true }', { e: id });
    if (kind === 'ledger_ref') await q('CREATE trace_evidence_ref CONTENT { execution_id: $e, source: "attempt_ledger", ref: "attempt-key-under-test" }', { e: id });
    if (PROTECTED_KINDS.has(kind)) protectedIds.add(id);
  }
  return ids;
}

/** The in-DB audit the DELETE event writes: one row per deleted execution. */
async function audit(): Promise<Array<{ eid: string; had_obs: boolean }>> {
  return q<{ eid: string; had_obs: boolean }>('SELECT eid, had_obs FROM retention_audit');
}
/**
 * Run `fn`, then return what it removed and every protected id it deleted WITHOUT an observation
 * record in place first. Fails loudly if the audit missed any removed row (a silent instrument).
 */
async function measured(fn: () => Promise<unknown>): Promise<{ removed: number; uncompacted: string[]; protectedDeleted: string[]; deleted: string[] }> {
  const before = await total();
  await fn();
  const removed = before - (await total());
  const a = await audit();
  expect(a.length).toBe(removed); // the instrument saw every delete, so a clean result is not vacuous
  return {
    removed,
    deleted: a.map((x) => x.eid),
    protectedDeleted: a.filter((x) => protectedIds.has(x.eid)).map((x) => x.eid).sort(),
    uncompacted: a.filter((x) => protectedIds.has(x.eid) && x.had_obs !== true).map((x) => x.eid).sort(),
  };
}

function cfgFor(cap: number, over: Partial<ReturnType<Mod['loadTraceRetentionConfig']>> = {}) {
  return {
    ...M.loadTraceRetentionConfig({} as NodeJS.ProcessEnv),
    enabled: true,
    dryRun: false,
    hotWindowMs: HOT_MS,
    activities: [],
    overrides: {},
    autoDiscover: false,
    globalCeiling: cap,
    globalCeilingBytes: 0,
    globalCeilingEnabled: true,
    orphanReapEnabled: false,
    ceilingPerSweepCap: 1_000_000,
    ceilingBudgetMs: 60_000,
    ...over,
  };
}
/** A strata-only sweep (valve off) over the given activities, each capped at `cap` per status. */
function strataCfg(activities: string[], cap: number) {
  return cfgFor(1_000_000, {
    globalCeilingEnabled: false,
    activities,
    overrides: Object.fromEntries(activities.map((a) => [a, { successCap: cap, failureCap: cap }])),
  });
}
const cut = () => new Date(Date.now() - HOT_MS).toISOString();

run('retention compacts graded/labelled evidence before any delete (real SurrealDB)', () => {
  beforeAll(async () => {
    const { config } = await import('../config');
    if (config.surrealdb.url !== SCRATCH || config.surrealdb.database !== TEST_DB) {
      throw new Error(`client resolved ${config.surrealdb.url}/${config.surrealdb.database}, not the scratch DB — refusing`);
    }
    M = await import('./trace-retention');
    db = (await import('../db/surreal')).surrealDB;
    if (typeof (db as { queryAll?: unknown }).queryAll !== 'function') {
      throw new Error('../db/surreal is mocked in this process — run this file on its own');
    }
    const TP = await import('../lib/tuning-params');
    const TC = await import('../lib/telemetry-class');
    clearTuning = () => { TP.__clearTuningParamCache(); TP.__clearTuningParamListCache(); TC.__clearTelemetryClassCache(); };
  });

  beforeEach(async () => {
    protectedIds = new Set();
    await q([
      'execution', 'execution_observation', 'retention_audit', 'goal_verification_labels', 'trace_evidence_ref',
      'shape_score_counter', 'shape_score_counted', 'shape_score_counter_seed', 'substrate_tuning_param',
      'trace_store_counters', 'variant_performance_metrics', 'reach_history', 'execution_trace_content',
    ].map((t) => `REMOVE TABLE IF EXISTS ${t};`).join(' '));
    await q('DEFINE TABLE execution SCHEMALESS; DEFINE INDEX idx_execution_executed_at ON execution FIELDS executed_at; DEFINE INDEX idx_execution_activity ON execution FIELDS activity_id;');
    // The instrument: on every delete of an execution, record whether its observation record already
    // existed at that moment (inside the deleting transaction, so a same-transaction write counts).
    await q('DEFINE EVENT retention_order_audit ON TABLE execution WHEN $event = "DELETE" THEN { CREATE retention_audit SET eid = meta::id($before.id), had_obs = count((SELECT id FROM execution_observation WHERE execution_id = meta::id($before.id))) > 0, at = time::now() };');
    await q(COUNTER_MIGRATION);
    for (const m of LABEL_MIGRATIONS) await q(m);
    await q('DEFINE TABLE substrate_tuning_param SCHEMALESS;');
    await setTuning('TRACE_RETENTION_DRAIN_BATCH', 40);
    await setTuning('TRACE_RETENTION_DRAIN_PAUSE_MS', 0);
    await declare(null);
    M.__resetStrataCursorForTest();
  });

  // ── The instrument, both polarities (green at base) ─────────────────────────────────────────────

  test('EVIDENCE-RETENTION INSTRUMENT: a protected row deleted with no observation record is audited had_obs=false', async () => {
    const [id] = await seed('graded_reached', 1, { prefix: 'ia', ageDays: 3 });
    const r = await measured(() => q('DELETE type::thing("execution", $e) RETURN NONE', { e: id }));
    expect(r.removed).toBe(1);
    expect(r.uncompacted).toEqual([id!]);
  });

  test('EVIDENCE-RETENTION INSTRUMENT: a record written first in the SAME transaction is audited had_obs=true; one written after is not', async () => {
    const [a, b] = await seed('labelled', 2, { prefix: 'ib', ageDays: 3 });
    const r = await measured(() => db.queryAll(
      `BEGIN TRANSACTION;
       UPSERT type::thing("execution_observation", $a) SET execution_id = $a, observation = "achieved", instrument = "probe", horizon = NONE, code_version = NONE, at = time::now();
       DELETE type::thing("execution", $a) RETURN NONE;
       DELETE type::thing("execution", $b) RETURN NONE;
       UPSERT type::thing("execution_observation", $b) SET execution_id = $b, observation = "achieved", instrument = "probe", horizon = NONE, code_version = NONE, at = time::now();
       COMMIT TRANSACTION;`,
      { a, b },
    ));
    expect(r.removed).toBe(2);
    expect(r.uncompacted).toEqual([b!]); // compaction AFTER the delete is caught
  });

  // ── MUST-FAIL today ─────────────────────────────────────────────────────────────────────────────

  test('EVIDENCE-RETENTION STRATUM: the reservoir deletes no graded row whose observation record was not written first; ungraded rows are still sampled and deleted', async () => {
    // One stratum (mixed-act / success), 200 cold rows, half graded, cap 10: at base the uniform
    // sample deletes ~95% of the graded half uncompacted.
    const ungraded = await seed('ungraded', 100, { prefix: 'su', activity: 'mixed-act', ageDays: 4 });
    await seed('graded_reached', 50, { prefix: 'sg', activity: 'mixed-act', ageDays: 3 });
    await seed('graded_not_reached', 50, { prefix: 'sn', activity: 'mixed-act', ageDays: 2 });
    const r = await measured(() => M.runTraceRetentionSweep(strataCfg(['mixed-act'], 10)));
    expect(r.uncompacted).toEqual([]);
    const ungradedSet = new Set(ungraded);
    expect(r.deleted.filter((e) => ungradedSet.has(e)).length).toBeGreaterThan(0);
  });

  test('EVIDENCE-RETENTION COMPACTION: every graded or labelled row a phase deletes has {execution_id, observation, instrument, horizon, code_version, at} written BEFORE its delete', async () => {
    // An all-evidence stratum over its cap: the trace bodies may go, the observations may not.
    // Non-vacuous by construction: the reservoir must still bound this stratum (the trace store is
    // not the archive), so rows ARE deleted, and each one must have been compacted first.
    await seed('graded_reached', 40, { prefix: 'cr', activity: 'evidence-act', ageDays: 4 });
    await seed('graded_not_reached', 40, { prefix: 'cn', activity: 'evidence-act', ageDays: 3 });
    await seed('labelled', 40, { prefix: 'cl', activity: 'evidence-act', ageDays: 2 });
    const r = await measured(() => M.runTraceRetentionSweep(strataCfg(['evidence-act'], 10)));
    expect(r.removed).toBeGreaterThan(0);
    expect(r.protectedDeleted.length).toBe(r.removed);
    expect(r.uncompacted).toEqual([]);
    const obs = await q<Record<string, unknown>>('SELECT * FROM execution_observation WHERE execution_id IN $ids', { ids: r.protectedDeleted });
    const byId = new Map(obs.map((o) => [String(o['execution_id']), o]));
    for (const eid of r.protectedDeleted) {
      const o = byId.get(eid);
      expect(o, `observation record for ${eid}`).toBeDefined();
      expect(o!['observation'] ?? null).not.toBeNull();
      expect(typeof o!['instrument']).toBe('string');
      expect(String(o!['instrument']).length).toBeGreaterThan(0);
      for (const k of ['horizon', 'code_version', 'at']) expect(Object.keys(o!)).toContain(k);
      expect(o!['at'] ?? null).not.toBeNull();
    }
  });

  test('EVIDENCE-RETENTION VALVE: over the cap with old gradable rows and newer telemetry, telemetry and other non-gradable rows go first and NO gradable row is deleted', async () => {
    const graded = await seed('graded_reached', 50, { prefix: 'vg', ageDays: 5 }); // oldest
    await seed('ungraded', 100, { prefix: 'vu', ageDays: 3 });
    await seed('telemetry', 100, { prefix: 'vt', ageDays: 1 }); // newest cold
    await declare(TELE);
    // 250 rows, cap 100: surplus 150 = all 100 telemetry + 50 of the non-gradable rows.
    const r = await measured(() => M.runCeilingDrainTick(cfgFor(100)));
    expect(r.protectedDeleted).toEqual([]);
    expect(await countOf('act-graded_reached')).toBe(graded.length);
    expect(await countOf(TELE)).toBe(0);
    expect(await total()).toBe(100); // the cap is still reached, from non-gradable rows only
  });

  test('EVIDENCE-RETENTION VALVE: over the cap with ONLY gradable cold rows, the valve deletes nothing and reports the protected surplus (stoppedBy protected_only)', async () => {
    await seed('graded_reached', 80, { prefix: 'og', ageDays: 4 });
    await seed('graded_not_reached', 70, { prefix: 'on', ageDays: 3 });
    const r = await measured(() => M.runCeilingDrainTick(cfgFor(100)));
    expect(r.removed).toBe(0);
    expect(await total()).toBe(150);
    expect(M.getLastCeilingOutcome()).toMatchObject({ remaining: 50, stoppedBy: 'protected_only' });
  });

  test('EVIDENCE-RETENTION DRAINS: the range drain deletes no graded or labelled row without compaction', async () => {
    await seed('graded_reached', 20, { prefix: 'rg', ageDays: 5 });
    await seed('labelled', 20, { prefix: 'rl', ageDays: 4 });
    await seed('ungraded', 40, { prefix: 'ru', ageDays: 3 });
    const policy = await M.loadDrainPolicy();
    const r = await measured(() => M.drainColdByRange({ cutIso: cut(), target: 60, budgetUntil: Date.now() + 30_000, policy }));
    expect(r.removed).toBeGreaterThan(0);
    expect(r.uncompacted).toEqual([]);
  });

  test('EVIDENCE-RETENTION DRAINS: the telemetry drain deletes no graded or labelled row without compaction', async () => {
    // A declared telemetry id (no counter rows, no VPM credit, so the class guard accepts it) whose
    // cold tail also holds a reach-graded not-reached row, a labelled row, and rows an open gap and
    // the attempt ledger cite.
    const plain = await seed('telemetry', 30, { prefix: 'tp', ageDays: 3 });
    await seed('graded_not_reached', 1, { prefix: 'tn', activity: TELE, ageDays: 3 });
    await seed('labelled', 1, { prefix: 'tl', activity: TELE, ageDays: 3 });
    await seed('gap_ref', 1, { prefix: 'tg', activity: TELE, ageDays: 3 });
    await seed('ledger_ref', 1, { prefix: 'tk', activity: TELE, ageDays: 3 });
    await declare(TELE);
    const policy = await M.loadDrainPolicy();
    const r = await measured(() => M.drainTelemetryClass({ cutIso: cut(), target: 1000, budgetUntil: Date.now() + 30_000, policy }));
    expect(r.uncompacted).toEqual([]);
    const plainSet = new Set(plain);
    expect(r.deleted.filter((e) => plainSet.has(e)).length).toBe(plain.length); // plain telemetry still drains
  });

  // ── Each external reference counts as protected (one fixture each; must-fail today) ─────────────

  for (const kind of ['labelled', 'gap_ref', 'ledger_ref'] as const) {
    const label = { labelled: 'goal_verification_labels', gap_ref: 'an OPEN gap (trace_evidence_ref source gap)', ledger_ref: 'the attempt ledger (trace_evidence_ref source attempt_ledger)' }[kind];
    test(`EVIDENCE-RETENTION PROTECTED: a cold row referenced by ${label} survives the valve while non-gradable rows remain`, async () => {
      const [ref] = await seed(kind, 1, { prefix: `p${kind[0]}`, ageDays: 5 }); // the oldest row in the store
      await seed('ungraded', 60, { prefix: 'pu', ageDays: 3 });
      const r = await measured(() => M.runCeilingDrainTick(cfgFor(51))); // surplus 10
      expect(r.protectedDeleted).toEqual([]);
      expect(await exists(ref!)).toBe(true);
      expect(await total()).toBe(51);
    });
  }

  // ── CONTROLS (green at base, must stay green under the fix) ─────────────────────────────────────

  test('EVIDENCE-RETENTION CONTROL: a telemetry-only store over the cap is trimmed exactly to the cap', async () => {
    await seed('telemetry', 300, { prefix: 'ct', ageDays: 2 });
    await declare(TELE);
    const r = await measured(() => M.runTraceRetentionSweep(cfgFor(200)));
    expect(r.removed).toBe(100);
    expect(await total()).toBe(200);
  });

  test('EVIDENCE-RETENTION CONTROL: ungraded, unlabelled cold rows are deleted as before (stratum reservoir, then valve)', async () => {
    await seed('ungraded', 100, { prefix: 'cu', activity: 'plain-act', ageDays: 3 });
    const s = await measured(() => M.runTraceRetentionSweep(strataCfg(['plain-act'], 10)));
    expect(s.removed).toBe(90);
    expect(await countOf('plain-act')).toBe(10);
    await q('DELETE retention_audit');
    const v = await measured(() => M.runCeilingDrainTick(cfgFor(4)));
    expect(v.removed).toBe(6);
    expect(await total()).toBe(4);
  });

  test('EVIDENCE-RETENTION CONTROL: observation records survive a full sweep (incl. the orphan reap) and a refold query reads them by execution id', async () => {
    // Records compacted by an earlier sweep: their executions are already gone.
    const gone = ['old00001', 'old00002', 'old00003'];
    for (const e of gone) {
      await q('UPSERT type::thing("execution_observation", $e) SET execution_id = $e, observation = true, instrument = "reach_verdict", horizon = NONE, code_version = NONE, at = time::now()', { e });
    }
    await seed('ungraded', 120, { prefix: 'ru', ageDays: 3 });
    await M.runTraceRetentionSweep(cfgFor(100, { orphanReapEnabled: true, orphanReapMinAgeMs: 0 }));
    expect(await total()).toBe(100);
    const read = await q<{ execution_id: string; observation: unknown; instrument: string }>(
      'SELECT execution_id, observation, instrument FROM execution_observation WHERE execution_id IN $ids ORDER BY execution_id', { ids: gone });
    expect(read.map((o) => o.execution_id)).toEqual(gone);
    expect(read.every((o) => o.observation === true && o.instrument === 'reach_verdict')).toBe(true);
  });
});
