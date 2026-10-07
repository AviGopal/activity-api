/**
 * CHAIN-CREDIT HITS AND MISSES ARE READABLE (check-first).
 *
 * The chain-credit point lookup (c7f2b88) added chainCreditAncestorMisses(), and the aggregator already counted
 * posteriorDeltasDroppedNoRow(), but NOTHING READ EITHER: no route, no shape, no detector (the hollow-write class:
 * an instrument nobody reads). Live on node 1 after 13:12:44Z the only evidence was a warning line per miss; the
 * number of ancestor writes actually performed (hits) was not observable at all, so "FIX 1 works live" could not
 * be shown and "16 misses" had no denominator.
 *
 * THE RULE PINNED HERE:
 *   - posteriorCreditCounters() reports {chain_ancestor_hits, chain_ancestor_misses, deltas_dropped_no_row}:
 *     a hit is an ancestor whose execution row resolved and to which a non-zero delta was written; a miss is an
 *     ancestor with no readable execution row (nothing written).
 *   - The same numbers are a shape the system reads at use time: resolvePosteriorCreditCounters() answers
 *     {shape: "posteriorCreditCounters", body: {...}} (served from /v2/impulses/resolve, pointer.type
 *     "posteriorCreditCounters"), and /health carries them under checks.posterior_credit.
 *
 * Child bun probe (the chain-credit harness): POSTERIOR_COALESCE=0, a fake `execution` table that holds exec-gather
 * and not exec-ghost, SURREALDB_URL on a closed port.
 */
// Must precede the import: config.ts validates these at module load.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Counters = { chain_ancestor_hits?: number; chain_ancestor_misses?: number; deltas_dropped_no_row?: number };
type Probe = { before: Counters | null; after: Counters | null; shaped: { shape?: string; body?: Counters } | null; writes: string[] };

function probe(execution: Record<string, unknown>): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'credit-counters-'));
  try {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'probe.ts');
    writeFileSync(p, `
      const PU = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const TABLE = { 'exec-gather': { variant_id: 'satisfier:gather-variant' } };
      const writes = [];
      const db = { query: async (sql, vars) => {
        if (/UPDATE variant_performance_metrics/.test(sql)) writes.push(vars.activity_id);
        if (/FROM execution WHERE id IN/.test(sql)) return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => vars[k]).filter((id) => TABLE[id])
          .map((id) => ({ execution_id: id, variant_id: TABLE[id].variant_id, org_id: 'org-1' }));
        return [];
      } };
      const read = () => (typeof PU.posteriorCreditCounters === 'function' ? PU.posteriorCreditCounters() : null);
      const before = read();
      await PU.propagateCreditAlongChain(JSON.parse(process.env.EXEC), db, 'org-1');
      const after = read();
      const shaped = typeof PU.resolvePosteriorCreditCounters === 'function' ? PU.resolvePosteriorCreditCounters() : null;
      console.log('RESULT ' + JSON.stringify({ before, after, shaped, writes }));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', p], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        EXEC: JSON.stringify(execution),
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

// A failed composite (the consumer rejected the output) that consumed one resolvable and one unresolvable ancestor.
const ONE_HIT_ONE_MISS = { activity_id: 'leaf', composition_chain: ['exec-ghost', 'exec-gather'], success: false, failure_mode: { type: 'verifier_negative' }, consumed_producers: ['exec-ghost', 'exec-gather'] };

describe('chain-credit counters have a reader', () => {
  test('MUST-FAIL: after one hit and one miss, posteriorCreditCounters() reports hits=1 and misses=1', () => {
    const r = probe(ONE_HIT_ONE_MISS);
    expect(r.before).not.toBeNull();
    expect(r.after!.chain_ancestor_hits! - r.before!.chain_ancestor_hits!).toBe(1);
    expect(r.after!.chain_ancestor_misses! - r.before!.chain_ancestor_misses!).toBe(1);
    expect(typeof r.after!.deltas_dropped_no_row).toBe('number');
  });

  test('MUST-FAIL: the counters are a shape the system can read (posteriorCreditCounters)', () => {
    const r = probe(ONE_HIT_ONE_MISS);
    expect(r.shaped?.shape).toBe('posteriorCreditCounters');
    expect(r.shaped?.body?.chain_ancestor_hits).toBe(r.after!.chain_ancestor_hits);
    expect(r.shaped?.body?.chain_ancestor_misses).toBe(r.after!.chain_ancestor_misses);
  });

  test('MUST-FAIL: the resolve route serves the shape and /health carries the counters', () => {
    const impulses = readFileSync(join(import.meta.dir, '../routes/impulses.ts'), 'utf8');
    expect(impulses).toMatch(/case ['"]posteriorCreditCounters['"]/);
    const index = readFileSync(join(import.meta.dir, '../index.ts'), 'utf8');
    expect(index).toMatch(/posterior_credit/);
  });

  test('CONTROL: an ancestor that was not consumed is neither a hit nor a miss', () => {
    const r = probe({ ...ONE_HIT_ONE_MISS, consumed_producers: [] });
    expect(r.writes).toEqual([]);
    if (r.before && r.after) {
      expect(r.after.chain_ancestor_hits).toBe(r.before.chain_ancestor_hits);
      expect(r.after.chain_ancestor_misses).toBe(r.before.chain_ancestor_misses);
    }
  });
});
