/**
 * Check-first: replication pull must keep the indexed executed_at range alone in a subquery.
 *
 * Gap replication-pull-or-on-origin-turns-the-indexed-range-into-a-full-table-scan (database
 * session, 10-02). `WHERE executed_at >= $since AND (origin_substrate_id IS NONE OR
 * origin_substrate_id != $excl) ORDER BY executed_at LIMIT $lim` plans as Iterate Table on
 * SurrealDB 2.3.3 (syzygy 26.3s, peers' replication ticks 40-78s). The same planner trap as the
 * composition-chain backfill (276cfb4): an `IS NONE OR` disjunction ANDed with an indexed
 * predicate. With the range in a subquery and the origin filter outside: 2.39s, identical rows.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
mock.module('../db/surreal', () => ({
  surrealDB: {
    async query(sql: string, params: Record<string, unknown> = {}) {
      calls.push({ sql, params });
      if (/SELECT\s+\*\s+FROM\s+execution\s+WHERE\s+id\s+IN/i.test(sql)) {
        return [{ id: 'execution:a', executed_at: '2026-10-02T00:00:01Z' }, { id: 'execution:b', executed_at: '2026-10-02T00:00:02Z' }];
      }
      return [{ id: 'execution:a', executed_at: '2026-10-02T00:00:01Z' }, { id: 'execution:b', executed_at: '2026-10-02T00:00:02Z' }];
    },
  },
  // Stubs to satisfy mock-module-completeness.test.ts
  getDbStats: async () => ({}),
  createAuthenticatedClient: async () => ({ query: async () => [], close: () => {} }),
  queryWithAuth: async () => [],
  dbStats: async () => ({}),
}));

const { runReplicationPull } = await import('./replication-pull');
const idSql = () => calls.find((c) => /ORDER\s+BY\s+executed_at/i.test(c.sql) && !/WHERE\s+id\s+IN/i.test(c.sql))!.sql;

describe('replication pull: the indexed range is not ORed with the origin filter', () => {
  beforeEach(() => { calls.length = 0; });

  test('with exclude_origin, executed_at range sits alone in a subquery and the origin filter, order and limit apply outside', async () => {
    await runReplicationPull({ since: '2026-10-01T00:00:00Z', limit: 500, exclude_origin: 'substrate-x' });
    const q = idSql();
    const inner = q.match(/FROM\s*\(\s*(SELECT[\s\S]*?FROM\s+execution\s+WHERE[\s\S]*?)\)/i);
    expect(inner).not.toBeNull();
    expect(inner![1]).toMatch(/executed_at\s*>=/i);
    expect(inner![1]).not.toMatch(/origin_substrate_id\s+IS\s+NONE\s+OR/i);
    const outer = q.replace(inner![0], 'FROM (…)');
    expect(outer).toMatch(/origin_substrate_id\s+IS\s+NONE\s+OR\s+origin_substrate_id\s*!=\s*\$excl/i);
    expect(outer).toMatch(/ORDER\s+BY\s+executed_at\s+ASC\s+LIMIT\s+\$lim/i);
  });

  test('control: without exclude_origin the pull still returns the hydrated rows in executed_at order', async () => {
    const r = await runReplicationPull({ since: '2026-10-01T00:00:00Z', limit: 500 });
    expect(r.shape).toBe('executionReplicationPull');
    expect(r.count).toBe(2);
    expect((r.rows as Array<{ id: string }>).map((x) => x.id)).toEqual(['execution:a', 'execution:b']);
  });
});
