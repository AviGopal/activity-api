// THE cts LANE: deltas coalesced per key, every pending key applied in ONE transaction per flush (CHANGE DB2).
//
//   [MUST-FAIL] three deltas to one key + one to another flush as ONE statement batch: BEGIN … COMMIT with two UPSERTs,
//               the first carrying the summed delta and n = 3.
//   [CONTROL]   the cap is counted ONCE per distinct capped template per flush, and only for capped keys.
//   [CONTROL]   a failed flush is logged and counted; its deltas are merged back and land on the next flush.
//   [CONTROL]   decay rides inside the expression only for a key that asked for it; a slug key is written by id.
import { beforeEach, describe, expect, it } from 'bun:test';
import { __resetContextLaneForTests, contextFlushSql, contextLaneStats, enqueueContextDelta, flushContextLane } from './context-posterior-lane';

const leaf = (bucket: string, a: number, b: number) => ({ kind: 'leaf' as const, orgId: 'org-x', templateId: 'tpl-A', signatureVersion: 1, bucket, alpha: a, beta: b, halfLifeSecs: 86400, cap: 200 });
beforeEach(() => __resetContextLaneForTests());

describe('the context_thompson_scores lane', () => {
  it('[MUST-FAIL] coalesces per key and applies every key in ONE transaction', async () => {
    const sent: Array<{ sql: string; params: Record<string, unknown> }> = [];
    enqueueContextDelta(leaf('s1', 1, 0)); enqueueContextDelta(leaf('s1', 1, 0)); enqueueContextDelta(leaf('s1', 0, 1));
    enqueueContextDelta(leaf('s2', 1, 0));
    await flushContextLane({ query: async (sql, params) => { sent.push({ sql, params: params ?? {} }); return []; } });
    expect(sent.length).toBe(1);
    const { sql, params } = sent[0]!;
    expect(sql.startsWith('BEGIN TRANSACTION;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT TRANSACTION;')).toBe(true);
    expect(sql.match(/UPSERT context_thompson_scores SET/g)?.length).toBe(2);
    expect(sql).not.toMatch(/LET \$existing|CREATE context_thompson_scores/);
    expect(params).toMatchObject({ k0_bucket: 's1', k0_da: 2, k0_db: 1, k0_n: 3, k1_bucket: 's2', k1_da: 1, k1_n: 1 });
    expect(contextLaneStats()).toMatchObject({ flushes: 1, keys_flushed: 2, pending_keys: 0 });
  });

  it('[CONTROL] the cap is counted once per capped template per flush', () => {
    const { sql } = contextFlushSql([
      { ...leaf('s1', 1, 0), n: 1 }, { ...leaf('s2', 1, 0), n: 1 },
      { kind: 'ancestor', orgId: 'org-x', templateId: 'tpl-B', signatureVersion: 1, bucket: 's1', alpha: 1, beta: 0, n: 1 },
    ]);
    expect(sql.match(/SELECT count\(\) FROM context_thompson_scores/g)?.length).toBe(1);
    expect(sql.match(/OR \$card0 < \$k\d_cap THEN/g)?.length).toBe(2);
  });

  it('[CONTROL] a failed flush is logged, counted, merged back, and lands on the next flush', async () => {
    enqueueContextDelta(leaf('s1', 1, 0));
    await flushContextLane({ query: async () => { throw new Error('conflict'); } });
    expect(contextLaneStats()).toMatchObject({ failed_flushes: 1, pending_keys: 1 });
    enqueueContextDelta(leaf('s1', 1, 0));
    const sent: Record<string, unknown>[] = [];
    await flushContextLane({ query: async (_s, p) => { sent.push(p ?? {}); return []; } });
    expect(sent[0]).toMatchObject({ k0_da: 2, k0_n: 2 });
    expect(contextLaneStats().pending_keys).toBe(0);
  });

  it('[CONTROL] decay only where asked; a slug key is written by its record id', () => {
    const { sql } = contextFlushSql([
      { ...leaf('s1', 1, 0), n: 1 },
      { kind: 'repair', orgId: 'org-x', templateId: 'tpl-A', signatureVersion: 2, bucket: 'r1', alpha: 1, beta: 0, n: 1 },
      { kind: 'cluster', orgId: 'org-x', templateId: 'tpl-A', signatureVersion: 1, bucket: 'cluster:7', alpha: 1, beta: 0, n: 1, slug: 'abc', clusterId: '7' },
    ]);
    expect(sql.match(/math::pow\(0\.5/g)?.length).toBe(2); // alpha and beta of the one decaying key
    expect(sql).toContain("UPSERT type::thing('context_thompson_scores', $k2_slug) SET");
  });
});
