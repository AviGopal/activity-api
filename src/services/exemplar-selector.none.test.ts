/**
 * Check-first: an exemplar selection must not write a trace_digest whose success is NONE twice.
 *
 * Gap exemplar-selection-inserts-the-same-execution-twice-when-success-is-none (database session,
 * 10-02). Success exemplars come from `success != false` and failure exemplars from
 * `success != true`; a digest with success NONE matches BOTH, so its execution is inserted in
 * both loops and the second insert hits UNIQUE idx_exemplar_execution_id (syzygy: 169 index
 * violations in 15 min, most of the hub's db_query_failures). Unknown is not evidence: a NONE
 * digest belongs on neither side.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

type Digest = { id: string; execution_id: string; executed_at: string; success?: boolean };
let digests: Digest[] = [];
const writes: string[] = [];

function matches(sql: string, d: Digest): boolean {
  if (/success\s*!=\s*false/i.test(sql)) return d.success !== false;
  if (/success\s*!=\s*true/i.test(sql)) return d.success !== true;
  if (/success\s*=\s*true/i.test(sql) || /success\s*==\s*true/i.test(sql)) return d.success === true;
  if (/success\s*=\s*false/i.test(sql) || /success\s*==\s*false/i.test(sql)) return d.success === false;
  return true;
}

mock.module('../db/surreal', () => ({
  surrealDB: {
    async query(sql: string, params: Record<string, unknown> = {}) {
      if (/FROM\s+activity\s+WHERE\s+id/i.test(sql)) return [{ ev: 0.5 }];
      if (/^\s*(INSERT|UPSERT|CREATE|RELATE)\b/i.test(sql) || /\b(INSERT\s+INTO|UPSERT)\s+execution_exemplar/i.test(sql)) {
        writes.push(sql + ' ' + JSON.stringify(params));
        return [];
      }
      if (/FROM\s+trace_digest/i.test(sql)) return digests.filter((d) => matches(sql, d));
      return [];
    },
  },
  // Stubs to satisfy mock-module-completeness.test.ts
  getDbStats: async () => ({}),
  createAuthenticatedClient: async () => ({ query: async () => [], close: () => {} }),
  queryWithAuth: async () => [],
  dbStats: async () => ({}),
}));
// The real redis module, not a process-wide mock.module replacement: a `{ redis: null }`
// factory omits RedisClient (mock-module-completeness.test.ts) and hands null to every later
// test file that imports redis. The client connects lazily, so importing it is inert; stub the
// three calls the selector makes and put them back afterwards.
const { redis } = await import('../db/redis');
const redisSpies = [
  spyOn(redis, 'get').mockImplementation((async () => null) as never),
  spyOn(redis, 'set').mockImplementation((async () => undefined) as never),
  spyOn(redis, 'del').mockImplementation((async () => undefined) as never),
];
afterAll(() => { for (const s of redisSpies) s.mockRestore(); });

const { selectExemplarsForActivity } = await import('./exemplar-selector');
const timesWritten = (exec: string) => writes.reduce((n, w) => n + (w.split(`"${exec}"`).length - 1), 0);

describe('exemplar selection: success NONE is unknown, not both', () => {
  beforeEach(() => { writes.length = 0; });

  test('a digest with success NONE is written on neither side (no duplicate unique-index insert)', async () => {
    digests = [
      { id: 'trace_digest:d1', execution_id: 'exec-ok', executed_at: '2026-10-02T00:00:03Z', success: true },
      { id: 'trace_digest:d2', execution_id: 'exec-bad', executed_at: '2026-10-02T00:00:02Z', success: false },
      { id: 'trace_digest:d3', execution_id: 'exec-none', executed_at: '2026-10-02T00:00:01Z' },
    ];
    await selectExemplarsForActivity('activity:t1');
    expect(timesWritten('exec-none')).toBe(0);
  });

  test('control: with no NONE digests, each success and failure exemplar is written exactly once', async () => {
    digests = [
      { id: 'trace_digest:d1', execution_id: 'exec-ok', executed_at: '2026-10-02T00:00:03Z', success: true },
      { id: 'trace_digest:d2', execution_id: 'exec-bad', executed_at: '2026-10-02T00:00:02Z', success: false },
    ];
    await selectExemplarsForActivity('activity:t1');
    expect(timesWritten('exec-ok')).toBe(1);
    expect(timesWritten('exec-bad')).toBe(1);
  });
});
