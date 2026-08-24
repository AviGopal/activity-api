/**
 * Unit tests for aggregateSelectionCalibration (routes/execution-traces.ts).
 *
 * Regression guard for the reader joint of the selection→outcome chain. The prior
 * SQL used `LEFT JOIN activity_execution_traces` — ANSI JOIN, which SurrealDB 2.3.x
 * does not support, so the endpoint threw `Parse error` on EVERY call (against a
 * table decommissioned 07-14 besides). This helper is the JOIN-free replacement:
 * selections joined to outcomes in memory by correlation_id, against the live
 * `execution` table.
 */

import { describe, test, expect } from 'bun:test';

process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { aggregateSelectionCalibration } = await import('./execution-traces');

const sel = (over: Record<string, unknown> = {}) => ({
  activity_id: 'a1', org_id: 'organizations:substrate',
  correlation_id: 'sel_1', alpha: 3, beta: 1, thompson_sample: 0.7,
  selected_at: '2026-08-24T00:00:00Z', ...over,
});

describe('aggregateSelectionCalibration', () => {
  test('empty input yields empty output (the honest current state, not a crash)', () => {
    expect(aggregateSelectionCalibration([], new Map(), 1)).toEqual([]);
  });

  test('joins a selection to its outcome by correlation_id', () => {
    const rows = aggregateSelectionCalibration(
      [sel({ correlation_id: 'sel_1' })],
      new Map([['sel_1', { success: true, duration_ms: 100, cost_usd: 0.01, executed_at: '2026-08-24T00:01:00Z' }]]),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      activity_id: 'a1', total_selections: 1, executed_selections: 1,
      pending_selections: 0, successful_executions: 1, failed_executions: 0,
      actual_success_rate: 1, avg_duration_ms: 100, last_execution_at: '2026-08-24T00:01:00Z',
    });
    // predicted = 3/(3+1) = 0.75; actual = 1 → error 0.25
    expect(rows[0]!.avg_predicted_success).toBeCloseTo(0.75, 5);
    expect(rows[0]!.calibration_error as number).toBeCloseTo(0.25, 5);
  });

  test('a selection with no matching outcome is pending, not executed', () => {
    const rows = aggregateSelectionCalibration([sel({ correlation_id: 'sel_x' })], new Map(), 0);
    expect(rows[0]).toMatchObject({
      total_selections: 1, executed_selections: 0, pending_selections: 1,
      actual_success_rate: null, calibration_error: null,
    });
  });

  test('the min-executed floor drops activities below it (the old HAVING clause)', () => {
    // one selection, no execution → executed=0; min=1 drops it
    expect(aggregateSelectionCalibration([sel({ correlation_id: 'none' })], new Map(), 1)).toEqual([]);
  });

  test('groups by activity_id + org_id and averages predicted success', () => {
    const rows = aggregateSelectionCalibration(
      [
        sel({ correlation_id: 'c1', alpha: 1, beta: 1 }), // predicted 0.5
        sel({ correlation_id: 'c2', alpha: 3, beta: 1 }), // predicted 0.75
      ],
      new Map([
        ['c1', { success: true }],
        ['c2', { success: false }],
      ]),
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ total_selections: 2, executed_selections: 2, successful_executions: 1, failed_executions: 1 });
    expect(rows[0]!.avg_predicted_success).toBeCloseTo(0.625, 5); // (0.5+0.75)/2
    expect(rows[0]!.actual_success_rate).toBeCloseTo(0.5, 5);
  });

  test('two distinct activities produce two groups', () => {
    const rows = aggregateSelectionCalibration(
      [sel({ activity_id: 'a1', correlation_id: 'c1' }), sel({ activity_id: 'a2', correlation_id: 'c2' })],
      new Map([['c1', { success: true }], ['c2', { success: true }]]),
      1,
    );
    expect(rows.map((r) => r.activity_id).sort()).toEqual(['a1', 'a2']);
  });

  test('missing alpha/beta does not poison the predicted-success mean', () => {
    const rows = aggregateSelectionCalibration(
      [sel({ correlation_id: 'c1', alpha: null, beta: null }), sel({ correlation_id: 'c2', alpha: 3, beta: 1 })],
      new Map([['c1', { success: true }], ['c2', { success: true }]]),
      1,
    );
    expect(rows[0]!.avg_predicted_success).toBeCloseTo(0.75, 5); // only the valid one counts
  });
});
