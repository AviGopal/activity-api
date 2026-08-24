/**
 * Unit tests for aggregateDecisionCalibration (routes/execution-traces.ts).
 *
 * The reader joint that finally gives `decision_outcome` a consumer. Where
 * aggregateSelectionCalibration is anchored on thompson_selection_log (blind to the
 * walk / pathway-reuse paths that carry most traffic), this aggregates the universal
 * per-execution capture, so it covers those paths. The load-bearing design choice —
 * pinned here — is that it calibrates the posterior mean against the REACH rate, not
 * exit-status success: an infra probe that exits success but never reaches must NOT
 * read as well-calibrated just because success=true.
 */

import { describe, test, expect } from 'bun:test';

process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { aggregateDecisionCalibration } = await import('./execution-traces');

const row = (over: Record<string, unknown> = {}) => ({
  activity_id: 'a1', source: 'execution',
  predicted_success: 0.6, outcome_success: true, reached: true,
  executed_at: '2026-08-24T00:00:00Z', created_at: '2026-08-24T00:00:00Z', ...over,
});

describe('aggregateDecisionCalibration', () => {
  test('empty input yields empty output (honest current state, not a crash)', () => {
    expect(aggregateDecisionCalibration([], 1)).toEqual([]);
  });

  test('calibrates predicted mean against the REACH rate', () => {
    const rows = aggregateDecisionCalibration(
      [
        row({ predicted_success: 0.6, reached: true }),
        row({ predicted_success: 0.6, reached: false }),
      ],
      1,
    );
    expect(rows).toHaveLength(1);
    // avg predicted = 0.6; reach rate = 1/2 = 0.5; error = 0.1
    expect(rows[0]!.avg_predicted_success).toBeCloseTo(0.6, 5);
    expect(rows[0]!.actual_reach_rate).toBeCloseTo(0.5, 5);
    expect(rows[0]!.calibration_error as number).toBeCloseTo(0.1, 5);
    expect(rows[0]).toMatchObject({ activity_id: 'a1', source: 'execution', decisions: 2, reached_known: 2 });
  });

  test('THE DESIGN CHOICE: exit-status success is NOT the calibration target', () => {
    // An infra probe: predicted ~0 (collapsed posterior), exits success every time,
    // but reach is inapplicable/false. Calibrating against success would fabricate a
    // huge error (predicted 0 vs success 1); calibrating against reach is honest.
    const rows = aggregateDecisionCalibration(
      [
        row({ predicted_success: 0.0, outcome_success: true, reached: false }),
        row({ predicted_success: 0.0, outcome_success: true, reached: false }),
      ],
      1,
    );
    expect(rows[0]!.actual_reach_rate).toBeCloseTo(0, 5);
    expect(rows[0]!.actual_success_rate).toBeCloseTo(1, 5); // reported, not used
    // predicted 0 vs reach 0 → well-calibrated, error 0 (NOT 1 from the success view)
    expect(rows[0]!.calibration_error as number).toBeCloseTo(0, 5);
  });

  test('abstains (null error) when the reach verdict is unknown for the group', () => {
    const rows = aggregateDecisionCalibration(
      [row({ predicted_success: 0.6, reached: null, outcome_success: true })],
      1,
    );
    expect(rows[0]!.actual_reach_rate).toBeNull();
    expect(rows[0]!.calibration_error).toBeNull();
    expect(rows[0]!.reached_known).toBe(0);
  });

  test('splits by source: an execution-sourced row never pools with a selection-sourced one', () => {
    const rows = aggregateDecisionCalibration(
      [
        row({ source: 'execution', reached: true }),
        row({ source: 'selection', reached: false }),
      ],
      1,
    );
    expect(rows).toHaveLength(2);
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r]));
    expect(bySource.execution!.actual_reach_rate).toBeCloseTo(1, 5);
    expect(bySource.selection!.actual_reach_rate).toBeCloseTo(0, 5);
  });

  test('an absent/empty source is treated as selection-sourced (the recommend-join default)', () => {
    const rows = aggregateDecisionCalibration(
      [{ activity_id: 'a1', predicted_success: 0.5, outcome_success: true, reached: true }],
      1,
    );
    expect(rows[0]!.source).toBe('selection');
  });

  test('the min-decisions floor drops thin groups', () => {
    expect(aggregateDecisionCalibration([row()], 2)).toEqual([]);
    expect(aggregateDecisionCalibration([row(), row()], 2)).toHaveLength(1);
  });

  test('missing predicted_success does not poison the mean', () => {
    const rows = aggregateDecisionCalibration(
      [row({ predicted_success: null, reached: true }), row({ predicted_success: 0.8, reached: true })],
      1,
    );
    expect(rows[0]!.predicted_n).toBe(1);
    expect(rows[0]!.avg_predicted_success).toBeCloseTo(0.8, 5);
  });

  test('a row with no activity_id is skipped, not counted', () => {
    const rows = aggregateDecisionCalibration(
      [{ predicted_success: 0.5, reached: true } as any, row()],
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decisions).toBe(1);
  });
});
