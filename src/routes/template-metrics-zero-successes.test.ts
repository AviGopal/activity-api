/**
 * A stored successful_executions of 0 must reach the template listing as 0.
 *
 * THE REGRESSION THIS PINS. enrichTemplatesWithMetrics built the field as
 * `metric.successful_executions || metric.successes`. For a stored 0 with no legacy
 * `successes` column that is `0 || undefined`, so the listing reported the field as
 * missing. light-dispatch's retire sweep keeps an arm whose counter is missing
 * (`(m.successful_executions ?? 1) === 0`, deliberately fail-safe), so an arm that had
 * run many times and never once succeeded always read as having succeeded, and the
 * sweep retired nothing.
 *
 * Mocks `surrealDB.query` with spyOn (restored after each test), not mock.module.
 */

import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { surrealDB } from '../db/surreal';
import { enrichTemplatesWithMetrics } from './activities.templates-db';

type Row = Record<string, unknown>;

const enrichWith = async (ids: string[], rows: Row[]) => {
  let calls = 0;
  // The first query is the metrics read; any follow-up ("initial metrics" for unmatched
  // ids) returns nothing, so a template with no row really has no row.
  queryMock = spyOn(surrealDB, 'query').mockImplementation((async () => (calls++ === 0 ? rows : [])) as any);
  const out = await enrichTemplatesWithMetrics(ids.map((id) => ({ id, name: id }) as any));
  return new Map(out.map((t: any) => [String(t.id), t.metrics]));
};

let queryMock: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  if (queryMock) { queryMock.mockRestore(); queryMock = null; }
});

describe('template listing keeps a measured zero success count', () => {
  test('THE REGRESSION: a stored successful_executions 0 reaches the listing as 0', async () => {
    const m = await enrichWith(['never-succeeded-arm'], [
      { activity_id: 'never-succeeded-arm', total_executions: 12, successful_executions: 0, failed_executions: 12, thompson_alpha: 1, thompson_beta: 13 },
    ]);
    const metrics = m.get('never-succeeded-arm');
    expect(metrics).toBeDefined();
    expect(metrics.successful_executions).toBe(0);
    // The consumer's rule (light-dispatch shouldRetire): only an explicit 0 qualifies.
    expect((metrics.successful_executions ?? 1) === 0).toBe(true);
  });

  test('CONTROL: a missing counter still falls back to the legacy successes field', async () => {
    const m = await enrichWith(['legacy-arm'], [
      { activity_id: 'legacy-arm', total_executions: 9, successes: 4 },
    ]);
    expect(m.get('legacy-arm').successful_executions).toBe(4);
  });

  test('CONTROL: a positive count is unchanged', async () => {
    const m = await enrichWith(['working-arm'], [
      { activity_id: 'working-arm', total_executions: 20, successful_executions: 5, failed_executions: 15 },
    ]);
    expect(m.get('working-arm').successful_executions).toBe(5);
  });

  test('CONTROL: a template with no metrics row still has no metrics (fails safe for the sweep)', async () => {
    const m = await enrichWith(['fresh-arm', 'working-arm'], [
      { activity_id: 'working-arm', total_executions: 20, successful_executions: 5 },
    ]);
    expect(m.get('fresh-arm')).toBeUndefined();
  });
});
