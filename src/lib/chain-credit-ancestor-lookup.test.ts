/**
 * CHAIN CREDIT GOES TO THE ANCESTOR'S VARIANT, AND AN UNKNOWN ANCESTOR GETS NOTHING (check-first).
 *
 * propagateCreditAlongChain maps each ancestor EXECUTION id to the variant that ran it and writes the
 * decayed delta to that variant's variant_performance_metrics row. The map was read from
 * v_paradigm_execution_traces, a materialized view built out of band (migration 212) that stopped
 * following writes at 2026-09-28 (0 rows for 10-06 against 22,402 executions on node 1). Every
 * lookup missed, the code fell back to the execution id itself, and the UPDATE
 * `WHERE variant_id = <execution id>` matched no row: each chain credit was dropped silently.
 *
 * THE RULE PINNED HERE. The variant comes from the ancestor's own `execution` row (a point lookup by
 * record id; variant_id ?? activity_id, as the view projected it). An ancestor with no readable row
 * has no known variant: nothing is written for it, and it is counted (chainCreditAncestorMisses).
 *
 * The fake `execution` table below answers only the point lookup, maps each execution id to a
 * DIFFERENTLY named variant, and has no row for the ghost. The same query against the real schema is
 * checked by chain-credit-ancestor-lookup.real-schema.check.ts (run by name: it needs a real
 * SurrealDB, which this suite's gate cannot start).
 *
 * Child bun probe (same harness as consumer-outcome-credits-producer.test.ts): POSTERIOR_COALESCE=0 so
 * the ancestor deltas go through the injected recording db; SURREALDB_URL on a closed port.
 */
// Must precede the import: config.ts validates these at module load.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Write = { activity_id: string; alpha_delta: number; beta_delta: number };
type Probe = { writes: Write[]; misses: number | null };

// execution id -> the row the fake `execution` table holds for it.
const EXECUTION: Record<string, { variant_id?: string; activity_id: string }> = {
  'exec-gather': { variant_id: 'satisfier:gather-variant', activity_id: 'gather' },
  'exec-plan': { variant_id: 'plan-variant', activity_id: 'plan' },
  'exec-novar': { activity_id: 'satisfier:novar-activity' }, // no variant_id: activity_id stands in
};

/** Run propagateCreditAlongChain in a child bun against the fake table; return its writes and miss count. */
function probe(execution: Record<string, unknown>): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'chain-lookup-'));
  try {
    const p = join(dir, 'probe.ts');
    writeFileSync(p, `
      const PU = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const TABLE = JSON.parse(process.env.TABLE);
      const writes = [];
      const db = { query: async (sql, vars) => {
        if (/UPDATE variant_performance_metrics/.test(sql)) writes.push({ activity_id: vars.activity_id, alpha_delta: vars.alpha_delta, beta_delta: vars.beta_delta });
        if (/FROM execution WHERE id IN/.test(sql)) return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => vars[k]).filter((id) => TABLE[id])
          .map((id) => ({ execution_id: id, variant_id: TABLE[id].variant_id ?? TABLE[id].activity_id }));
        return [];
      } };
      const m0 = typeof PU.chainCreditAncestorMisses === 'function' ? PU.chainCreditAncestorMisses() : null;
      await PU.propagateCreditAlongChain(JSON.parse(process.env.EXEC), db, 'org-1');
      const m1 = typeof PU.chainCreditAncestorMisses === 'function' ? PU.chainCreditAncestorMisses() : null;
      console.log('RESULT ' + JSON.stringify({ writes, misses: m0 === null ? null : m1 - m0 }));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', p], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        EXEC: JSON.stringify(execution), TABLE: JSON.stringify(EXECUTION),
      },
      stdout: 'pipe', stderr: 'pipe',
    });
    const line = r.stdout.toString().split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `probe produced no result: ${r.stderr.toString().slice(0, 400)}`).toBeDefined();
    return JSON.parse(line!.slice('RESULT '.length)) as Probe;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const touched = (ws: Write[]) => ws.map((w) => w.activity_id).sort();
const failedComposite = (chain: string[], consumed: string[]) =>
  ({ activity_id: 'leaf', composition_chain: chain, success: false, failure_mode: { type: 'verifier_negative' }, consumed_producers: consumed });

describe('chain credit resolves each ancestor through its own execution row', () => {
  test('MUST-FAIL: a consumed producer of a failed composite is blamed on ITS variant, not on its execution id', () => {
    const r = probe(failedComposite(['exec-gather', 'exec-plan'], ['exec-gather']));
    expect(touched(r.writes)).toEqual(['satisfier:gather-variant']);
    expect(r.writes[0]!.beta_delta).toBeGreaterThan(0);
  });

  test('MUST-FAIL: a producer row with no variant_id is credited to its activity_id, as the view projected variant_id', () => {
    const r = probe({ activity_id: 'leaf', composition_chain: ['exec-novar'], success: true, consumed_producers: ['exec-novar'] });
    expect(touched(r.writes)).toEqual(['satisfier:novar-activity']);
    expect(r.writes[0]!.alpha_delta).toBeGreaterThan(0);
  });

  test('MUST-FAIL: an ancestor with no execution row gets no write and is counted as a miss', () => {
    const r = probe(failedComposite(['exec-ghost', 'exec-plan'], ['exec-ghost']));
    expect(r.misses).toBe(1);
    expect(r.writes).toEqual([]);
  });

  test('CONTROL: an ancestor that was not consumed is neither credited nor blamed (the data-flow rule is unchanged)', () => {
    const r = probe(failedComposite(['exec-gather', 'exec-plan'], ['exec-gather']));
    expect(touched(r.writes)).not.toContain('plan-variant');
    expect(touched(r.writes)).not.toContain('exec-plan');
  });
});
