/**
 * CHAIN CREDIT IS WRITTEN UNDER THE PRODUCER'S OWN ORG, AND A LOST DELTA SAYS WHY (check-first).
 *
 * Measured on node 1, 2026-10-07: after the satisfier-flush ordering fix, posteriorCreditCounters showed chain
 * hits 4 -> 17 with misses flat, but deltas_dropped_no_row 44 -> 111, and 41 of 42 sampled drops carried org
 * 'public'. A trace posted with no org lands under the 'public' fallback (execution-traces.ts traceOrgId), while
 * the producers it consumed have their variant rows under the substrate org. propagateCreditAlongChain wrote every
 * ancestor delta under the CONSUMER's org, so the UPDATE matched no row and the credit was discarded.
 *
 * THE RULE PINNED HERE:
 *   (c) the ancestor's delta is written under the org on the producer's OWN execution row (the point read the
 *       ancestor lookup already does); a producer row with no org gets NO write and is counted
 *       (chain_ancestor_org_unresolved). There is no default org of any kind.
 *   (a) a no-row drop is counted by where the delta came from (deltas_dropped_no_row_leaf / _ancestor), and each
 *       issued ancestor delta is kept in a bounded ring with its outcome (queued -> written | dropped_no_row).
 *   (b) each drop records {variant_id, org_tried, orgs_present}: the orgs that variant does have rows under.
 *
 * Child bun probe (the chain-credit harness): POSTERIOR_COALESCE=0 so the synchronous write runs against the fake db,
 * SURREALDB_URL on a closed port.
 */
// Must precede the import: config.ts validates these at module load.
process.env.SURREALDB_NAMESPACE = 'activity-system';
process.env.SURREALDB_DATABASE = 'learning_loop';

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Row = { org_id?: string; variant_id: string };
type Write = { activity_id: string; org_id: string; alpha_delta: number; beta_delta: number };
type Shaped = {
  chain_ancestor_hits: number; chain_ancestor_org_unresolved?: number;
  deltas_dropped_no_row: number; deltas_dropped_no_row_leaf?: number; deltas_dropped_no_row_ancestor?: number;
  recent_ancestor_deltas?: Array<{ variant_id: string; org_id: string; ancestor_execution_id?: string; status: string }>;
  recent_drops?: Array<{ variant_id: string; org_tried: string; orgs_present: string[] | null; kinds: string[] }>;
};
type Probe = { before: Shaped; after: Shaped; writes: Write[] };

function probe(opts: { table: Record<string, Row>; consumerOrg: string; updateMatches: boolean; orgsPresent?: string[] }): Probe {
  const dir = mkdtempSync(join(tmpdir(), 'chain-org-'));
  try {
    const p = join(dir, 'probe.ts');
    writeFileSync(p, `
      const PU = await import(${JSON.stringify(join(import.meta.dir, 'posterior-update.ts'))});
      const O = JSON.parse(process.env.OPTS);
      const writes = [];
      const db = { query: async (sql, vars) => {
        if (/UPDATE variant_performance_metrics/.test(sql)) { writes.push({ activity_id: vars.activity_id, org_id: vars.org_id, alpha_delta: vars.alpha_delta, beta_delta: vars.beta_delta }); return O.updateMatches ? [{ id: 'variant_performance_metrics:x' }] : []; }
        if (/SELECT VALUE org_id FROM variant_performance_metrics/.test(sql)) return O.orgsPresent ?? [];
        if (/FROM execution WHERE id IN/.test(sql)) return Object.keys(vars ?? {}).filter((k) => k.startsWith('a_')).map((k) => vars[k]).filter((id) => O.table[id])
          .map((id) => ({ execution_id: id, variant_id: O.table[id].variant_id, ...(O.table[id].org_id ? { org_id: O.table[id].org_id } : {}) }));
        return [];
      } };
      const read = () => PU.resolvePosteriorCreditCounters().body;
      const before = read();
      await PU.propagateCreditAlongChain({ activity_id: 'leaf-consumer', composition_chain: Object.keys(O.table), success: false,
        failure_mode: { type: 'verifier_negative' }, consumed_producers: Object.keys(O.table) }, db, O.consumerOrg);
      const after = read();
      console.log('RESULT ' + JSON.stringify({ before, after, writes }));
      process.exit(0);
    `);
    const r = Bun.spawnSync(['bun', p], {
      env: {
        HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '',
        POSTERIOR_COALESCE: '0', SURREALDB_URL: 'http://127.0.0.1:9', TD_LAMBDA: '0.5',
        SURREALDB_NAMESPACE: 'activity-system', SURREALDB_DATABASE: 'learning_loop',
        OPTS: JSON.stringify(opts),
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

const SUBSTRATE = 'organizations:substrate';

describe('chain credit is written under the producer org, and a lost delta says why', () => {
  test("MUST-FAIL (c): a consumer posted under 'public' credits its producer under the producer's own org", () => {
    const r = probe({ table: { 'exec-prod': { variant_id: 'satisfier:prod', org_id: SUBSTRATE } }, consumerOrg: 'public', updateMatches: true });
    expect(r.writes.map((w) => [w.activity_id, w.org_id])).toEqual([['satisfier:prod', SUBSTRATE]]);
    expect(r.after.chain_ancestor_hits - r.before.chain_ancestor_hits).toBe(1);
  });

  test('MUST-FAIL (c): a producer row with no org gets no write and is counted (no default org)', () => {
    const r = probe({ table: { 'exec-noorg': { variant_id: 'satisfier:noorg' } }, consumerOrg: 'public', updateMatches: true });
    expect(r.writes).toEqual([]);
    expect((r.after.chain_ancestor_org_unresolved ?? -1) - (r.before.chain_ancestor_org_unresolved ?? 0)).toBe(1);
    expect(r.after.chain_ancestor_hits - r.before.chain_ancestor_hits).toBe(0);
  });

  test('MUST-FAIL (a): a zero-row ancestor UPDATE counts as an ANCESTOR drop and the ring records it dropped', () => {
    const r = probe({ table: { 'exec-gone': { variant_id: 'satisfier:gone', org_id: SUBSTRATE } }, consumerOrg: 'public', updateMatches: false, orgsPresent: ['public'] });
    expect((r.after.deltas_dropped_no_row_ancestor ?? -1) - (r.before.deltas_dropped_no_row_ancestor ?? 0)).toBe(1);
    expect((r.after.deltas_dropped_no_row_leaf ?? -1) - (r.before.deltas_dropped_no_row_leaf ?? 0)).toBe(0);
    expect(r.after.deltas_dropped_no_row - r.before.deltas_dropped_no_row).toBe(1);
    const last = r.after.recent_ancestor_deltas?.at(-1);
    expect(last).toMatchObject({ variant_id: 'satisfier:gone', org_id: SUBSTRATE, ancestor_execution_id: 'exec-gone', status: 'dropped_no_row' });
  });

  test('MUST-FAIL (b): the drop records the org tried and the orgs the variant does have rows under', () => {
    const r = probe({ table: { 'exec-gone': { variant_id: 'satisfier:gone', org_id: SUBSTRATE } }, consumerOrg: 'public', updateMatches: false, orgsPresent: ['public', 'organizations:other'] });
    expect(r.after.recent_drops?.at(-1)).toEqual(expect.objectContaining({
      variant_id: 'satisfier:gone', org_tried: SUBSTRATE, orgs_present: ['public', 'organizations:other'], kinds: ['ancestor'],
    }));
  });

  test('(a) a matched ancestor UPDATE is recorded written in the ring and counts no drop', () => {
    const r = probe({ table: { 'exec-prod': { variant_id: 'satisfier:prod', org_id: SUBSTRATE } }, consumerOrg: SUBSTRATE, updateMatches: true });
    expect(r.after.deltas_dropped_no_row - r.before.deltas_dropped_no_row).toBe(0);
    expect(r.after.recent_ancestor_deltas?.at(-1)?.status).toBe('written');
  });
});
