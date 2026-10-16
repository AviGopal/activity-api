// N CONCURRENT TRACES ON ONE TEMPLATE: ONE cts ROW, THE SAME FINAL ALPHA/BETA AS SERIAL APPLICATION (CHANGE DB2).
//
// Against a scratch SurrealDB 2.3.10 built from the REAL schema and migrations (test/support/real-surreal.ts), the
// production writer applyOutcomeToPosteriors is called for 20 graded traces of one template and ONE new signature at
// once, then the aggregator flushes. Before DB2 each call ran LET SELECT / IF UPDATE ELSE CREATE, whose statements
// are separate transactions.
//
//   [MUST-FAIL] the burst reaches the database as ONE cts transaction (at most two flushes), not one read-then-create
//               script per trace; exactly ONE row for the key, all N observations in it, and the same final
//               alpha/beta as the same traces applied one at a time (the serial ground truth, a second key).
//   Measured on the parent (4e15bee), 2026-10-16: the old form made TWO rows for the one key (n = 18 each, deltas lost
//   and split) and sent 51 cts statements for the burst.
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.PRIOR_SEED_ENABLED = 'false';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startRealSurreal, type RealSurreal } from '../../test/support/real-surreal';

let db: RealSurreal;
let client: any;
beforeAll(async () => { db = await startRealSurreal(); client = await db.connectModuleClient(); }, 180_000);
afterAll(async () => { await db?.stop(); });

describe('concurrent traces on one template', () => {
  it('[MUST-FAIL] one row, alpha/beta as serial application', async () => {
    const PU = await import('./posterior-update');
    const AGG = await import('./posterior-aggregator');
    const N = 20;
    const traces = Array.from({ length: N }, (_, i) => ({
      execution_id: `exec-conc-${i}`, activity_id: 'tpl-conc', variant_id: 'tpl-conc', success: i % 4 !== 0,
      signature: 'sig-conc-new', signature_version: 1, tags: [i % 4 !== 0 ? 'reached:true' : 'reached:false'],
    }));
    db.calls.length = 0;
    await Promise.all(traces.map((t) => PU.applyOutcomeToPosteriors(t as never, client, 'org-conc')));
    await AGG.flushPosteriors({ db: client } as never);
    await AGG.flushPosteriors({ db: client } as never);
    const read = async (sig: string) => {
      const res = await db.sql(`USE NS \`activity-system\` DB learning_loop; SELECT alpha, beta, n_observations FROM context_thompson_scores WHERE org_id = 'org-conc' AND template_id = 'tpl-conc' AND signature_version = 1 AND context_bucket = '${sig}';`);
      return res[res.length - 1].result as Array<{ alpha: number; beta: number; n_observations: number }>;
    };
    const rows = await read('sig-conc-new');
    // cts statements the CONCURRENT burst sent (leaf signature rows; cluster rows keep their own slug UPSERT)
    const ctsStatements = db.calls.filter((c) => /context_thompson_scores/.test(c.sql) && !/type::thing\('context_thompson_scores'/.test(c.sql) && !/^\s*SELECT/i.test(c.sql)).length;
    // the SAME traces applied one at a time to a second key: the serial ground truth
    for (const t of traces) { await PU.applyOutcomeToPosteriors({ ...t, execution_id: `${t.execution_id}-s`, signature: 'sig-serial' } as never, client, 'org-conc'); await AGG.flushPosteriors({ db: client } as never); }
    await AGG.flushPosteriors({ db: client } as never);
    const serial = await read('sig-serial');
    console.log(`CONC rows=${rows.length} ${JSON.stringify(rows)} serial=${JSON.stringify(serial)} cts_statements=${ctsStatements}`);
    expect(ctsStatements).toBeLessThanOrEqual(2);
    expect(rows.length).toBe(1);
    expect(serial.length).toBe(1);
    expect(rows[0]!.n_observations).toBe(N);
    expect(rows[0]!.alpha).toBeCloseTo(serial[0]!.alpha, 3);
    expect(rows[0]!.beta).toBeCloseTo(serial[0]!.beta, 3);
  }, 120_000);
});
