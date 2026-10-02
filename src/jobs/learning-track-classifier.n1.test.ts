/**
 * Check-first: the classifier cycle must not re-read each template row it just listed.
 *
 * Gap learning-track-classifier-reads-each-template-row-again-after-the-cycle-already-listed-it.
 * Since 5e566e4 the cadence guard advances in process without writing last_classified_at,
 * so the cycle's "due" query keeps listing every template (up to 2000), and
 * classifyOneTemplate re-reads each row by id only for the in-process guard to skip it:
 * ~2,000 `FROM activity WHERE id = $id` reads per 3 min on the hub (database session, 10-02).
 * The cycle query should carry the row fields and pass the row in.
 */
import { describe, expect, mock, test, beforeEach } from 'bun:test';

const calls: string[] = [];
const DUE = ['t1', 't2', 't3', 't4', 't5'];

mock.module('../db/surreal', () => ({
  surrealDB: {
    async query(sql: string) {
      calls.push(sql);
      if (/FROM\s+activity\s+WHERE\s+id\s*=\s*\$id/i.test(sql)) {
        return [{ id: 'x', learning_track: null, last_classified_at: null, output_shapes: [] }];
      }
      if (/FROM\s+activity[\s\S]*execution_type\s*=\s*'template'/i.test(sql)) {
        return DUE.map((id) => ({ id, learning_track: null, last_classified_at: null, output_shapes: [] }));
      }
      if (/FROM\s+trace_digest/i.test(sql)) return []; // low sample -> skipped, cadence advanced in process
      return [];
    },
  },
  // Stubs to satisfy mock-module-completeness.test.ts
  getDbStats: async () => ({}),
  createAuthenticatedClient: async () => ({ query: async () => [], close: () => {} }),
  queryWithAuth: async () => [],
  dbStats: async () => ({}),
}));

const { runClassifierCycle } = await import('./learning-track-classifier');
const perTemplateReads = () => calls.filter((q) => /FROM\s+activity\s+WHERE\s+id\s*=\s*\$id/i.test(q)).length;
const cycleQueries = () => calls.filter((q) => /execution_type\s*=\s*'template'/i.test(q)).length;

describe('learning-track classifier cycle: no N+1 re-read of listed templates', () => {
  beforeEach(() => { calls.length = 0; });

  test('a cycle over 5 due templates issues no per-template activity read', async () => {
    const r = await runClassifierCycle();
    expect(perTemplateReads()).toBe(0);
    expect(r.evaluated).toBe(5);
  });

  test('control: a second cycle within cadence lists once, evaluates all 5 and reads no trace_digest', async () => {
    const r = await runClassifierCycle();
    expect(cycleQueries()).toBe(1);
    expect(r.evaluated).toBe(5);
    expect(calls.filter((q) => /FROM\s+trace_digest/i.test(q)).length).toBe(0);
  });
});
