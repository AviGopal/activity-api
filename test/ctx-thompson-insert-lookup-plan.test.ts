import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type Subprocess } from 'bun';

/**
 * THE INSERT-PATH CONTEXT WRITE MUST USE AN INDEX, WITHOUT LOSING OR MERGING CELLS.
 *
 * Every execution insert (POST /v2/activities/execution-traces) awaits a read-modify-write on
 * context_thompson_scores (ctxSql, and rdSql for re-derived buckets): a `LET $existing` lookup,
 * then UPDATE or CREATE. Both the lookup and the UPDATE filter with accountIdScopedWhere():
 * `(account_id = $account_id OR (account_id IS NONE AND org_id = $org_id))`. SurrealDB 2.3.3
 * cannot plan that disjunction onto idx_ctx_ts_bucket / idx_ctx_ts_versioned, so both plan as
 * `Iterate Table`.
 *
 * Measured on node 1 2026-10-03 (read-only EXPLAIN FULL + timed runs): 222 ms per lookup on
 * 31,448 rows, growing +633 rows/day (~2 %/day), on the request path the walk awaits
 * (insert p50 86 ms, p99 8 s). The indexed form measured 24 ms.
 * Gap: the-trace-ingest-request-path-scans-two-whole-tables-for-learning-writes.
 *
 * A second hazard shapes the fix. On SurrealDB < 2.3.8 (surrealdb#6060) a composite index with an
 * unconstrained MIDDLE column returns 0 rows: idx_ctx_ts_versioned is (org_id, template_id,
 * signature_version, context_bucket), so an indexed filter that omits signature_version can
 * silently miss the existing row and CREATE a duplicate. Measured on node 1: forced onto that
 * index, 20/20 live keys returned 0. Every filter must therefore constrain signature_version,
 * and the rows it reads must equal a WITH NOINDEX run of the same filter.
 *
 * Two fix shapes are accepted, and both are held to the same behaviour:
 *   (1) keep LET/UPDATE/CREATE with indexed, signature_version-constrained filters;
 *   (2) UPSERT a deterministic record id. This also removes the read-then-create race behind the
 *       duplicate cells (context-posterior-upsert-is-read-then-create…), but a wrong id merges
 *       tenants or versions — so the write behaviour below runs the REAL block for either shape.
 *
 * The test runs the REAL SQL text (found by its `const ctxSql` / `const rdSql` definition anywhere
 * under src/, exported or not) against a throwaway in-memory SurrealDB built from the real
 * migrations (088, 095, 099, 130). A source-text check could be satisfied by renaming a helper;
 * the planner and the resulting rows cannot.
 *
 * Needs the `surreal` binary (present in the substrate image). If it is missing every test FAILS
 * — the instrument test names the cause — rather than skipping: a silent skip reads as a pass.
 */

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, 'utf8');
const PORT = 19_000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;
const PASS = crypto.randomUUID(); // per-run credential for the throwaway instance
const MIGRATIONS = ['088-context-thompson-scores', '095-account-id-additive', '099-account-id-permissions', '130-state-space-signature'];
// Record ids are random, so which index the planner picks varies by copy; the read checks run
// against DBS independent copies of the fixture.
const DBS = 10;
let proc: Subprocess | null = null;
let startError = '';

async function sql(text: string, db = 'd0'): Promise<any[]> {
  const r = await fetch(`${URL_}/sql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'surreal-ns': 't', 'surreal-db': db, Authorization: 'Basic ' + btoa(`root:${PASS}`) },
    body: text,
  });
  return (await r.json()) as any[];
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  }, 60_000);
}

/** The SQL text of `const <name> = \`…\`` wherever it is defined under src/, with the
 *  account-scope helper expanded to the text it returns at runtime. */
function blockSql(name: string): string {
  const hits = tsFiles(ROOT + 'src').filter((f) => readFileSync(f, 'utf8').includes(`const ${name} = \``));
  if (hits.length !== 1) throw new Error(`expected exactly one definition of ${name} under src/, found ${hits.length}`);
  const src = readFileSync(hits[0], 'utf8');
  const start = src.indexOf(`const ${name} = \``) + `const ${name} = \``.length;
  let block = src.slice(start, src.indexOf('`;', start));
  if (block.includes('${accountIdScopedWhere()}')) {
    const helper = read('src/routes/activities.templates-db.ts').match(/export function accountIdScopedWhere\(\): string \{\s*return '([^']+)';/);
    if (!helper) throw new Error('accountIdScopedWhere() body not found');
    block = block.split('${accountIdScopedWhere()}').join(helper[1]);
  }
  if (/\$\{/.test(block)) throw new Error(`${name}: unexpanded interpolation in SQL: ${block}`);
  return block.replace(/--[^\n]*/g, ''); // SQL line comments carry no behaviour
}

/** Every WHERE filter the block applies to context_thompson_scores. */
function filters(block: string): string[] {
  const out: string[] = [];
  const re = /\bWHERE\b([\s\S]*?)(?=\bLIMIT\b|\bELSE\b|\bEND\b|\bRETURN\b|;|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push(m[1].trim().replace(/\)\s*$/, '').trim());
  return out;
}

function binds(account: string | null, org: string, template = 't1', bucket = 'b1', da = 1, db = 0): string {
  // A caller without an account binds `traceAccountId ?? null`, i.e. SurrealDB NULL, never NONE.
  // The distinction matters: `account_id = NONE` matches every org's legacy rows, `= NULL` matches none.
  return `LET $account_id = ${account ? `'${account}'` : 'NULL'}; LET $org_id = '${org}'; LET $template_id = '${template}'; LET $bucket = '${bucket}'; LET $alpha_delta = ${da}; LET $beta_delta = ${db};`;
}

async function last(text: string, db: string): Promise<any> {
  const res = await sql(text, db);
  const bad = res.find((x) => x.status !== 'OK');
  if (bad) throw new Error(`query failed: ${JSON.stringify(bad.result)}`);
  return res[res.length - 1].result;
}

async function planOps(where: string): Promise<string[]> {
  const r = await last(`${binds(null, 'organizations:o1')} SELECT * FROM context_thompson_scores WHERE ${where} EXPLAIN FULL;`, 'd0');
  return (r as any[]).map((x) => String(x.operation));
}

const ids = (rows: any[]) => rows.map((r) => String(r.id)).sort();
async function readRows(where: string, account: string | null, org: string, db: string, noindex = false): Promise<string[]> {
  return ids(await last(`${binds(account, org)} SELECT id FROM context_thompson_scores ${noindex ? 'WITH NOINDEX ' : ''}WHERE ${where};`, db));
}

async function engineVersion(): Promise<[number, number, number]> {
  const m = (await (await fetch(`${URL_}/version`)).text()).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error('engine version unreadable');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function seed(db: string, withV1 = false): Promise<void> {
  for (const f of MIGRATIONS) await sql(read(`sql/migrations/${f}.surql`), db);
  // Decoys share every index prefix with the target rows (same org + template, same org + bucket),
  // so whichever index the planner picks, matching rows sit among many non-matching ones.
  await sql(`FOR $i IN 1..200 { CREATE context_thompson_scores CONTENT { org_id: 'organizations:o1', template_id: 't1', context_bucket: 'b' + <string>($i % 7 + 2), signature_version: 0, alpha: 1.0, beta: 1.0, n_observations: 0 } };`, db);
  await sql(`FOR $i IN 1..200 { CREATE context_thompson_scores CONTENT { org_id: 'organizations:o1', template_id: 't' + <string>($i % 20 + 2), context_bucket: 'b1', signature_version: 0, alpha: 1.0, beta: 1.0, n_observations: 0 } };`, db);
  await sql(`FOR $i IN 1..200 { CREATE context_thompson_scores CONTENT { org_id: 'organizations:o' + <string>($i % 2 + 2), template_id: 't' + <string>($i % 20 + 2), context_bucket: 'b' + <string>($i % 7 + 1), signature_version: 0, alpha: 1.0, beta: 1.0, n_observations: 0 } };`, db);
  await sql(`CREATE context_thompson_scores:acct CONTENT { org_id: 'organizations:o1', account_id: 'accounts:a1', template_id: 't1', context_bucket: 'b1', signature_version: 0, alpha: 5.0, beta: 1.0, n_observations: 4 };`, db);
  await sql(`CREATE context_thompson_scores:legacy CONTENT { org_id: 'organizations:o1', template_id: 't1', context_bucket: 'b1', signature_version: 0, alpha: 3.0, beta: 1.0, n_observations: 2 };`, db);
  await sql(`CREATE context_thompson_scores:other CONTENT { org_id: 'organizations:o2', template_id: 't1', context_bucket: 'b1', signature_version: 0, alpha: 9.0, beta: 1.0, n_observations: 8 };`, db);
  // The same (org, template, bucket) under signature_version 1: a v0 write must never touch it.
  if (withV1) await sql(`CREATE context_thompson_scores:v1 CONTENT { org_id: 'organizations:o1', template_id: 't1', context_bucket: 'b1', signature_version: 1, alpha: 7.0, beta: 1.0, n_observations: 6 };`, db);
}

/** Count and summed n_observations of the (t1, b1) cells, keyed org|account|version, by table scan. */
async function cells(db: string): Promise<Record<string, number>> {
  const rows = await last(`SELECT org_id, account_id, signature_version, n_observations FROM context_thompson_scores WITH NOINDEX WHERE template_id = 't1' AND context_bucket = 'b1';`, db);
  const out: Record<string, number> = {};
  for (const r of rows as any[]) {
    const k = `${r.org_id}|${r.account_id ?? '-'}|v${r.signature_version}`;
    out[k] = (out[k] ?? 0) + 1;
    out[`${k}#obs`] = (out[`${k}#obs`] ?? 0) + Number(r.n_observations ?? 0);
  }
  return out;
}

let writeDb = 0;
async function freshDb(): Promise<string> { const db = `w${writeDb++}`; await seed(db, true); return db; }

beforeAll(async () => {
  const hardStop = setTimeout(() => proc?.kill(), 180_000); // never outlive a wedged run
  (hardStop as any).unref?.();
  try {
    proc = spawn(['surreal', 'start', 'memory', '--bind', `127.0.0.1:${PORT}`, '--user', 'root', '--pass', PASS, '--log', 'none'], { stdout: 'ignore', stderr: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${URL_}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error('surreal did not answer /health within 6 s');
    for (let d = 0; d < DBS; d++) await seed(`d${d}`);
  } catch (e) {
    startError = `cannot spawn surreal: ${e instanceof Error ? e.message : String(e)}`;
    proc?.kill();
  }
}, 120_000);

afterAll(() => { proc?.kill(); });

describe('context_thompson_scores insert-path write', () => {
  it('the instrument is live: surreal started, the real migrations defined the indexes and account_id', async () => {
    expect(startError).toBe('');
    const info = await sql('INFO FOR TABLE context_thompson_scores;');
    expect(Object.keys(info[0].result.indexes ?? {})).toEqual(expect.arrayContaining(['idx_ctx_ts_bucket', 'idx_ctx_ts_template', 'idx_ctx_ts_versioned']));
    // SCHEMAFULL drops undefined fields silently; without account_id the tenant cases would be vacuous.
    expect((await sql('SELECT account_id FROM context_thompson_scores:acct;'))[0].result[0]?.account_id).toBe('accounts:a1');
  }, 60_000);

  it('CONTROL: the planner reports a known full scan as Iterate Table, and a known indexed form as Iterate Index', async () => {
    expect((await planOps(`alpha > 0`))[0]).toBe('Iterate Table');
    expect((await planOps(`org_id = $org_id AND template_id = $template_id AND signature_version = 0 AND context_bucket = $bucket`))[0]).toBe('Iterate Index');
  }, 60_000);

  it('CONTROL: the NOINDEX equivalence check sees the middle-column hazard where the engine has it', async () => {
    const [maj, min, pat] = await engineVersion();
    const fixed = maj > 2 || (maj === 2 && (min > 3 || (min === 3 && pat >= 8)));
    let gaps = 0;
    for (let d = 0; d < DBS; d++) {
      const forced = ids(await last(`${binds(null, 'organizations:o1')} SELECT id FROM context_thompson_scores WITH INDEX idx_ctx_ts_versioned WHERE org_id = $org_id AND template_id = $template_id AND context_bucket = $bucket;`, `d${d}`));
      const scanned = await readRows(`org_id = $org_id AND template_id = $template_id AND context_bucket = $bucket`, null, 'organizations:o1', `d${d}`, true);
      if (forced.length < scanned.length) gaps++;
    }
    expect(gaps).toBe(fixed ? 0 : DBS);
  }, 60_000);

  for (const v of ['ctxSql', 'rdSql']) {
    it(`THE DEFECT: every ${v} filter plans onto an index and constrains signature_version`, async () => {
      const block = blockSql(v);
      const fs = filters(block);
      if (fs.length === 0) {
        // Shape (2): no filter at all means a point write by record id; its keying is held by the write tests.
        expect(block).toMatch(/UPSERT\s+type::thing\(\s*['"]context_thompson_scores['"]/);
        return;
      }
      for (const f of fs) {
        expect(f).toMatch(/signature_version\s*=/);
        const ops = await planOps(f);
        expect(ops).not.toContain('Iterate Table');
        expect(ops[0]).toBe('Iterate Index');
      }
    }, 60_000);

    it(`${v} filters read exactly what a full scan reads, and keep tenant scope`, async () => {
      for (const f of filters(blockSql(v))) {
        for (let d = 0; d < DBS; d++) {
          const db = `d${d}`;
          for (const [acc, org] of [['accounts:a1', 'organizations:o1'], [null, 'organizations:o1'], [null, 'organizations:o2'], [null, 'organizations:o9']] as const) {
            expect(await readRows(f, acc, org, db)).toEqual(await readRows(f, acc, org, db, true));
          }
          const byAccount = await readRows(f, 'accounts:a1', 'organizations:o1', db);
          expect(byAccount.length).toBeGreaterThan(0);
          for (const id of byAccount) expect(['context_thompson_scores:acct', 'context_thompson_scores:legacy']).toContain(id);
          expect(await readRows(f, null, 'organizations:o1', db)).toEqual(['context_thompson_scores:legacy']);
          expect((await readRows(f, null, 'organizations:o9', db)).length).toBe(0);
        }
      }
    }, 60_000);

    it(`${v} writes are idempotent per key and never cross an org or an account`, async () => {
      const block = blockSql(v);
      const db = await freshDb();
      const before = await cells(db);
      // The same legacy key three times: still one cell, three more observations.
      for (let i = 0; i < 3; i++) await last(`${binds(null, 'organizations:o1')} ${block}`, db);
      // A new org: exactly one new cell, in that org.
      await last(`${binds(null, 'organizations:o3')} ${block}`, db);
      // An account caller.
      await last(`${binds('accounts:a1', 'organizations:o1')} ${block}`, db);
      const after = await cells(db);
      if (process.env.CTX_TEST_DEBUG) console.log(v, JSON.stringify({ before, after }));
      expect(after['organizations:o1|-|v0']).toBe(1);
      expect(after['organizations:o1|-|v0#obs']).toBeGreaterThanOrEqual(before['organizations:o1|-|v0#obs'] + 3);
      expect(after['organizations:o3|-|v0']).toBe(1);
      expect(after['organizations:o3|-|v0#obs']).toBe(1);
      expect(after['organizations:o1|accounts:a1|v0']).toBe(1);
      expect(after['organizations:o1|accounts:a1|v0#obs']).toBe(before['organizations:o1|accounts:a1|v0#obs'] + 1);
      expect(after['organizations:o2|-|v0']).toBe(1);
      expect(after['organizations:o2|-|v0#obs']).toBe(before['organizations:o2|-|v0#obs']);
    }, 60_000);

    it(`THE DEFECT: a ${v} write never touches the signature_version 1 cell of the same key`, async () => {
      const block = blockSql(v);
      const db = await freshDb();
      const before = await cells(db);
      await last(`${binds(null, 'organizations:o1')} ${block}`, db);
      await last(`${binds('accounts:a1', 'organizations:o1')} ${block}`, db);
      const after = await cells(db);
      expect(after['organizations:o1|-|v1']).toBe(1);
      expect(after['organizations:o1|-|v1#obs']).toBe(before['organizations:o1|-|v1#obs']);
    }, 60_000);
  }
});
