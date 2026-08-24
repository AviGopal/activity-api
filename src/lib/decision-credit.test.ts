/**
 * Unit tests for buildDecisionOutcome (lib/decision-credit.ts) — the pure builder
 * that joins a Thompson selection to the outcome that followed it (law 12).
 *
 * The persist path (recordDecisionOutcome) is best-effort I/O tested at runtime;
 * these pin the join arithmetic and the null-safety that keeps option<T> columns
 * from being fed a rejecting NULL.
 */

import { describe, test, expect } from 'bun:test';

// decision-credit.ts imports the logger, which pulls in config at load time.
// Set the DB env before importing so the module loads (buildDecisionOutcome is pure).
process.env.SURREALDB_NAMESPACE ??= 'activity-system';
process.env.SURREALDB_DATABASE ??= 'learning_loop';
process.env.SURREALDB_URL ??= 'http://127.0.0.1:8000';
process.env.SURREALDB_USERNAME ??= 'test';
process.env.SURREALDB_PASSWORD ??= 'test';

const { buildDecisionOutcome } = await import('./decision-credit');

describe('buildDecisionOutcome', () => {
  test('joins a selection to its outcome and computes predicted success', () => {
    const rec = buildDecisionOutcome(
      { correlationId: 'sel_1', success: true, reached: true },
      { activity_id: 'a1', alpha: 3, beta: 1, thompson_sample: 0.8, selected_at: '2026-08-24T00:00:00Z' },
    );
    expect(rec).not.toBeNull();
    expect(rec!.activity_id).toBe('a1');
    expect(rec!.predicted_success).toBeCloseTo(0.75, 5); // 3/(3+1)
    expect(rec!.outcome_success).toBe(true);
    expect(rec!.reached).toBe(true);
    expect(rec!.thompson_sample).toBe(0.8);
  });

  test('returns null without a correlation id (no join key)', () => {
    expect(buildDecisionOutcome({ correlationId: null, success: true }, { activity_id: 'a1' })).toBeNull();
    expect(buildDecisionOutcome({ correlationId: undefined, success: true }, { activity_id: 'a1' })).toBeNull();
  });

  test('returns null when the selection was not found', () => {
    expect(buildDecisionOutcome({ correlationId: 'sel_x', success: false }, null)).toBeNull();
    expect(buildDecisionOutcome({ correlationId: 'sel_x', success: false }, undefined)).toBeNull();
  });

  test('predicted_success is null (not NaN) when alpha/beta are absent', () => {
    const rec = buildDecisionOutcome({ correlationId: 'sel_1', success: true }, { activity_id: 'a1' });
    expect(rec!.predicted_success).toBeNull();
    expect(rec!.thompson_sample).toBeNull();
  });

  test('predicted_success is null when alpha+beta is zero (no divide-by-zero)', () => {
    const rec = buildDecisionOutcome({ correlationId: 'sel_1', success: true }, { activity_id: 'a1', alpha: 0, beta: 0 });
    expect(rec!.predicted_success).toBeNull();
  });

  test('reached defaults to null (ungraded) when not supplied', () => {
    const rec = buildDecisionOutcome({ correlationId: 'sel_1', success: false }, { activity_id: 'a1', alpha: 1, beta: 1 });
    expect(rec!.reached).toBeNull();
    expect(rec!.outcome_success).toBe(false);
    expect(rec!.predicted_success).toBeCloseTo(0.5, 5);
  });

  test('a not-reached outcome records reached=false distinctly from ungraded=null', () => {
    const notReached = buildDecisionOutcome({ correlationId: 'c', success: true, reached: false }, { activity_id: 'a1' });
    expect(notReached!.reached).toBe(false);
  });
});
