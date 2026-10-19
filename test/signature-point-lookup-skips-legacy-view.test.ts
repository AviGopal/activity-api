import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { spawn, type Subprocess } from 'bun';
import { Surreal } from 'surrealdb';
import { runExecutionTraceWithSignatures } from '../src/routes/execution-trace-with-signatures';

/**
 * AN EXECUTION_ID THE LIVE TABLE HOLDS IS READ WITHOUT THE LEGACY VIEW.
 *
 * ribosome-extract's acquire_trace_signature resolves executionTraceWithSignatures {execution_id}
 * with an 8 s fetch timeout. queryExecutions() reads the id with a point lookup on the record
 * (`FROM type::thing("execution", $id)`), then ALSO ran the legacy read
 *   SELECT execution_id, executed_at FROM v_paradigm_execution_traces WHERE <tenant OR> AND execution_id = $id
 * unconditionally. v_paradigm_execution_traces is a DEFINE TABLE AS view over that same `execution`
 * table, so for a found id it can only return the row again; on SurrealDB 2.3.10 with ~245k rows the
 * call measured 4.7-7.0 s and every extraction since timed out. Gap:
 * ribosome-extract-cannot-fetch-its-trace-executionTraceWithSignatures-times-out-at-8s-so-no-reached-execution-becomes-a-template.
 *
 * The test calls the REAL exported reader against a throwaway in-memory SurrealDB built from the real
 * schema (020 tables, 115 content table, 212 view), seeded with SEED executions (~700 B rows), through a client
 * that records every statement it is handed. The defect is the view statement on the found-id path.
 * The controls keep the view as the fallback for an id the live table does not hold, and keep a
 * missing id a clean, quick empty answer.
 *
 * Needs the `surreal` binary (present in the substrate image). If it is missing the suite FAILS
 * rather than skipping: a silent skip reads as a pass.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID();
const NS = 'aatest';
const DB = 'learning_loop';
const ORG = 'organizations:o1';
const SEED = 20_000;
const BUDGET_MS = 8_000; // ribosome-extract acquire_trace_signature timeout_ms
const TARGET = 'e4242';
const LEGACY = 'legacy_only_1';
let proc: Subprocess | null = null;
let startError = '';
let db: Surreal | null = null;
const seen: string[] = [];
let spy: Surreal | null = null;

async function sql(text: string): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': NS, 'surreal-db': DB, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}

/** The same client, recording each statement the reader issues. */
function recording(inner: Surreal): Surreal {
  return new Proxy(inner, {
    get(t, p) {
      if (p === 'query') return (q: string, vars?: Record<string, unknown>) => { seen.push(String(q)); return (t as any).query(q, vars); };
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as Surreal;
}

const APIKEY = { orgId: ORG, accountId: null, authType: 'apikey' as const };
const viewReads = () => seen.filter((q) => q.includes('v_paradigm_execution_traces'));

beforeAll(async () => {
  const hardStop = setTimeout(() => proc?.kill(), 280_000);
  (hardStop as any).unref?.();
  try {
    proc = spawn(['surreal', 'start', 'memory', '--bind', `127.0.0.1:${PORT}`, '--log', 'none'], { env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: PASS }, stdout: 'ignore', stderr: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${URL_}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error('surreal did not answer /health within 6 s');
    await sql(readFileSync(ROOT + 'sql/schemas/020-paradigm-core-tables.surql', 'utf8'));
    await sql(readFileSync(ROOT + 'sql/migrations/115-execution-trace-content-table.surql', 'utf8').replace(/^USE .*$/m, ''));
    // SEED executions with a ~700 B trace blob (the live mean row is 714 B), all in the tenant.
    await sql(`FOR $i IN 0..${SEED} { CREATE type::thing('execution', 'e' + <string>$i) CONTENT { activity_id: 'a' + <string>($i % 7), input_impulses: [], output_impulses: [], success: $i % 2 = 0, duration_ms: 10, cost_usd: 0.0, tokens_in: 0, tokens_out: 0, org_id: '${ORG}', trace: { pad: string::repeat('x', 600), tasks: IF $i = 4242 { [{ id: 't1', status: 'success' }, { id: 't2', status: 'success' }] } ELSE { [] } }, executed_at: d'2026-01-01T00:00:00Z' + <duration> (<string>$i + 's'), created_at: d'2026-01-01T00:00:00Z' + <duration> (<string>$i + 's') } };`);
    await sql(readFileSync(ROOT + 'sql/migrations/212-restore-vpet-view.surql', 'utf8'));
    // An id only the view holds (a legacy row the live table no longer carries).
    await sql(`CREATE v_paradigm_execution_traces CONTENT { execution_id: '${LEGACY}', activity_id: 'legacy-act', success: true, duration_ms: 5, org_id: '${ORG}', executed_at: d'2025-06-01T00:00:00Z', created_at: d'2025-06-01T00:00:00Z' };`);
    db = new Surreal();
    await db.connect(`${URL_}/rpc`);
    await db.signin({ username: 'root', password: PASS });
    await db.use({ namespace: NS, database: DB });
    spy = recording(db);
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 300_000);

afterAll(async () => { try { await db?.close(); } catch { /* ignore */ } proc?.kill(); });

describe('executionTraceWithSignatures execution_id point read', () => {
  it('the instrument is live: surreal started, executions seeded, the view built, the legacy-only row present', async () => {
    expect(startError).toBe('');
    const n = await sql('SELECT count() AS n FROM execution WITH NOINDEX GROUP ALL;');
    expect(n[0].result[0].n).toBe(SEED);
    const v = await sql(`SELECT execution_id FROM v_paradigm_execution_traces WHERE execution_id IN ['${TARGET}', '${LEGACY}'];`);
    expect((v[0].result as any[]).map((r) => r.execution_id).sort()).toEqual([TARGET, LEGACY].sort());
    const live = await sql(`SELECT id FROM type::thing('execution', '${LEGACY}');`);
    expect(live[0].result).toEqual([]);
  }, 60_000);

  it('THE DEFECT: a found execution_id is read without the legacy view, within budget, same payload', async () => {
    seen.length = 0;
    const t0 = performance.now();
    const rep = await runExecutionTraceWithSignatures(spy as Surreal, { execution_id: TARGET, limit: 1 }, APIKEY);
    const ms = performance.now() - t0;
    expect(rep.count).toBe(1);
    const t = rep.traces[0];
    expect(t.execution_id).toBe(TARGET);
    expect(t.activity_id).toBe('a' + (4242 % 7));
    expect(t.status).toBe('success');
    expect(t.task_count).toBe(2);
    expect(t.tasks.map((x) => x.task_id)).toEqual(['t1', 't2']);
    expect(viewReads()).toEqual([]);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60_000);

  it('THE DEFECT, record-prefixed id form: execution:<id> is read without the legacy view', async () => {
    seen.length = 0;
    const rep = await runExecutionTraceWithSignatures(spy as Surreal, { execution_id: `execution:${TARGET}`, limit: 1 }, APIKEY);
    expect(rep.traces.map((x) => x.execution_id)).toEqual([TARGET]);
    expect(viewReads()).toEqual([]);
  }, 60_000);

  it('CONTROL: an id only the legacy view holds still resolves through the view', async () => {
    seen.length = 0;
    const rep = await runExecutionTraceWithSignatures(spy as Surreal, { execution_id: LEGACY, limit: 1 }, APIKEY);
    expect(rep.traces.map((x) => x.execution_id)).toEqual([LEGACY]);
    expect(rep.traces[0].activity_id).toBe('legacy-act');
    expect(viewReads().length).toBeGreaterThan(0);
  }, 60_000);

  it('CONTROL: a missing execution_id returns a clean empty answer quickly', async () => {
    const t0 = performance.now();
    const rep = await runExecutionTraceWithSignatures(spy as Surreal, { execution_id: 'no_such_execution', limit: 1 }, APIKEY);
    expect(rep.count).toBe(0);
    expect(rep.traces).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(BUDGET_MS);
  }, 60_000);
});
