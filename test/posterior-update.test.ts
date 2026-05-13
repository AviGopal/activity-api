/**
 * Unit tests for applyOutcomeToPosteriors (Phase 18.3).
 *
 * No real DB required — a spy captures every db.query() call.
 * Each test asserts the correct (alpha_delta, beta_delta) pair
 * and checks the UpdateSummary fields.
 */

import { describe, test, expect, mock } from 'bun:test';
import { applyOutcomeToPosteriors, type DBQueryable, type TraceForPosterior } from '../src/lib/posterior-update';
import type { FailureMode } from '../src/models/schemas';

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

function makeDb(): { db: DBQueryable; calls: Array<{ sql: string; params: Record<string, unknown> }> } {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db: DBQueryable = {
    async query(sql, params = {}) {
      calls.push({ sql, params });
      return [];
    },
  };
  return { db, calls };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<TraceForPosterior> = {}): TraceForPosterior {
  return {
    activity_id: 'test-activity',
    variant_id: 'test-activity',
    success: true,
    failure_mode: null,
    org_id: 'org-test',
    ...overrides,
  };
}

const ORG = 'org-test';

// ---------------------------------------------------------------------------
// Tests: delta rules
// ---------------------------------------------------------------------------

describe('applyOutcomeToPosteriors — delta rules', () => {
  test('success → alpha_delta=1, beta_delta=0', async () => {
    const { db, calls } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: true, failure_mode: null }),
      db,
      ORG,
    );

    expect(summary.alpha_delta).toBe(1);
    expect(summary.beta_delta).toBe(0);
    expect(summary.failure_mode_type).toBeNull();
    expect(summary.warnings).toHaveLength(0);
    // DB write should have fired because alpha_delta !== 0
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const writeCall = calls.find(c => c.sql.includes('variant_performance_metrics'));
    expect(writeCall).toBeDefined();
    expect(writeCall!.params.alpha_delta).toBe(1);
    expect(writeCall!.params.beta_delta).toBe(0);
  });

  test('verifier_negative → alpha_delta=0, beta_delta=1', async () => {
    const { db } = makeDb();
    const fm: FailureMode = {
      type: 'verifier_negative',
      reason: 'check failed',
      validator_id: 'v1',
      failed_evidence: [],
    };
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: false, failure_mode: fm }),
      db,
      ORG,
    );

    expect(summary.alpha_delta).toBe(0);
    expect(summary.beta_delta).toBe(1);
    expect(summary.failure_mode_type).toBe('verifier_negative');
    expect(summary.warnings).toHaveLength(0);
  });

  test('budget_exhausted → alpha_delta=0, beta_delta=0.5', async () => {
    const { db } = makeDb();
    const fm: FailureMode = {
      type: 'budget_exhausted',
      reason: 'cost limit hit',
      budget_type: 'cost',
      consumed: 10,
      allowed: 5,
    };
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: false, failure_mode: fm }),
      db,
      ORG,
    );

    expect(summary.alpha_delta).toBe(0);
    expect(summary.beta_delta).toBe(0.5);
    expect(summary.failure_mode_type).toBe('budget_exhausted');
    expect(summary.warnings).toHaveLength(0);
  });

  test('safety_breach → alpha_delta=0, beta_delta=1', async () => {
    const { db } = makeDb();
    const fm: FailureMode = {
      type: 'safety_breach',
      reason: 'depth exceeded',
      breach_type: 'depth',
      limit: 5,
      ancestor_chain: ['a', 'b', 'c', 'd', 'e'],
    };
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: false, failure_mode: fm }),
      db,
      ORG,
    );

    expect(summary.alpha_delta).toBe(0);
    expect(summary.beta_delta).toBe(1);
    expect(summary.failure_mode_type).toBe('safety_breach');
    expect(summary.warnings).toHaveLength(0);
  });

  test('cascading → alpha_delta=0, beta_delta=0', async () => {
    const { db, calls } = makeDb();
    const fm: FailureMode = {
      type: 'cascading',
      reason: 'upstream failed',
      upstream_task_id: 'task-1',
    };
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: false, failure_mode: fm }),
      db,
      ORG,
    );

    expect(summary.alpha_delta).toBe(0);
    expect(summary.beta_delta).toBe(0);
    expect(summary.failure_mode_type).toBe('cascading');
    expect(summary.warnings).toHaveLength(0);
    // No DB write when both deltas are 0
    const writeCall = calls.find(c => c.sql.includes('variant_performance_metrics'));
    expect(writeCall).toBeUndefined();
  });

  test('user_abort → alpha_delta=0, beta_delta=0', async () => {
    const { db, calls } = makeDb();
    const fm: FailureMode = {
      type: 'user_abort',
      reason: 'ctrl+c',
      abort_source: 'ctrl_c',
    };
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: false, failure_mode: fm }),
      db,
      ORG,
    );

    expect(summary.alpha_delta).toBe(0);
    expect(summary.beta_delta).toBe(0);
    expect(summary.failure_mode_type).toBe('user_abort');
    expect(summary.warnings).toHaveLength(0);
    // No DB write when both deltas are 0
    const writeCall = calls.find(c => c.sql.includes('variant_performance_metrics'));
    expect(writeCall).toBeUndefined();
  });

  test('null failure_mode on failed trace → beta_delta=1 + warning', async () => {
    const { db } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ success: false, failure_mode: null }),
      db,
      ORG,
    );

    expect(summary.alpha_delta).toBe(0);
    expect(summary.beta_delta).toBe(1);
    expect(summary.failure_mode_type).toBeNull();
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('failure_mode null on failed trace');
  });
});

// ---------------------------------------------------------------------------
// Tests: activity_id resolution
// ---------------------------------------------------------------------------

describe('applyOutcomeToPosteriors — activity_id resolution', () => {
  test('uses activity_variant_id when present', async () => {
    const { db, calls } = makeDb();
    await applyOutcomeToPosteriors(
      makeTrace({ activity_id: 'base-id', activity_variant_id: 'variant-id', success: true }),
      db,
      ORG,
    );
    const writeCall = calls.find(c => c.sql.includes('variant_performance_metrics'));
    expect(writeCall!.params.activity_id).toBe('variant-id');
  });

  test('falls back to variant_id when activity_variant_id absent', async () => {
    const { db, calls } = makeDb();
    await applyOutcomeToPosteriors(
      makeTrace({ activity_id: 'base-id', variant_id: 'v-id', success: true }),
      db,
      ORG,
    );
    const writeCall = calls.find(c => c.sql.includes('variant_performance_metrics'));
    expect(writeCall!.params.activity_id).toBe('v-id');
  });

  test('falls back to activity_id as last resort', async () => {
    const { db, calls } = makeDb();
    const trace: TraceForPosterior = {
      activity_id: 'only-id',
      success: true,
      failure_mode: null,
    };
    await applyOutcomeToPosteriors(trace, db, ORG);
    const writeCall = calls.find(c => c.sql.includes('variant_performance_metrics'));
    expect(writeCall!.params.activity_id).toBe('only-id');
  });
});

// ---------------------------------------------------------------------------
// Tests: impulse_relevance side-write on verifier_negative
// ---------------------------------------------------------------------------

describe('applyOutcomeToPosteriors — impulse_relevance writes', () => {
  test('verifier_negative with input impulse ids triggers impulse_relevance writes', async () => {
    const { db, calls } = makeDb();
    const fm: FailureMode = {
      type: 'verifier_negative',
      reason: 'check failed',
      validator_id: 'v1',
      failed_evidence: [],
    };
    const summary = await applyOutcomeToPosteriors(
      makeTrace({
        success: false,
        failure_mode: fm,
        tasks: [
          { input_impulse_ids: ['imp-1', 'imp-2'] },
          { input_impulse_ids: ['imp-3'] },
        ],
      }),
      db,
      ORG,
    );

    expect(summary.impulse_relevance_writes).toBe(3);
    const relevanceCalls = calls.filter(c => c.sql.includes('impulse_relevance_metrics'));
    expect(relevanceCalls).toHaveLength(3);
  });

  test('null failure_mode on failed trace also triggers impulse_relevance writes', async () => {
    const { db, calls } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({
        success: false,
        failure_mode: null,
        tasks: [{ input_impulse_ids: ['imp-a'] }],
      }),
      db,
      ORG,
    );

    expect(summary.impulse_relevance_writes).toBe(1);
    const relevanceCalls = calls.filter(c => c.sql.includes('impulse_relevance_metrics'));
    expect(relevanceCalls).toHaveLength(1);
  });

  test('success trace does not trigger impulse_relevance writes', async () => {
    const { db, calls } = makeDb();
    await applyOutcomeToPosteriors(
      makeTrace({
        success: true,
        tasks: [{ input_impulse_ids: ['imp-x'] }],
      }),
      db,
      ORG,
    );

    const relevanceCalls = calls.filter(c => c.sql.includes('impulse_relevance_metrics'));
    expect(relevanceCalls).toHaveLength(0);
  });

  test('budget_exhausted trace does not trigger impulse_relevance writes', async () => {
    const { db, calls } = makeDb();
    const fm: FailureMode = {
      type: 'budget_exhausted',
      reason: 'cost',
      budget_type: 'cost',
      consumed: 5,
      allowed: 1,
    };
    await applyOutcomeToPosteriors(
      makeTrace({
        success: false,
        failure_mode: fm,
        tasks: [{ input_impulse_ids: ['imp-y'] }],
      }),
      db,
      ORG,
    );

    const relevanceCalls = calls.filter(c => c.sql.includes('impulse_relevance_metrics'));
    expect(relevanceCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: UpdateSummary fields
// ---------------------------------------------------------------------------

describe('applyOutcomeToPosteriors — UpdateSummary', () => {
  test('summary.activity_id matches resolved id', async () => {
    const { db } = makeDb();
    const summary = await applyOutcomeToPosteriors(
      makeTrace({ variant_id: 'my-variant', success: true }),
      db,
      ORG,
    );
    expect(summary.activity_id).toBe('my-variant');
  });

  test('no warnings on clean success path', async () => {
    const { db } = makeDb();
    const summary = await applyOutcomeToPosteriors(makeTrace({ success: true }), db, ORG);
    expect(summary.warnings).toHaveLength(0);
  });
});
