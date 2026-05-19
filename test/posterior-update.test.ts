/**
 * Unit tests for applyOutcomeToPosteriors (Phase 18.3).
 *
 * No real DB required — a spy captures every db.query() call.
 * Each test asserts the correct (alpha_delta, beta_delta) pair
 * and checks the UpdateSummary fields.
 */

import { describe, test, expect, mock } from 'bun:test';
import {
  applyOutcomeToPosteriors,
  propagateCreditAlongChain,
  type DBQueryable,
  type TraceForPosterior,
  type ExecutionForChainCredit,
} from '../src/lib/posterior-update';
import { computeContextBucket } from '../src/utils/session-context';
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

/** DB mock that returns ancestor trace rows for the chain-credit SELECT. */
type AncestorRow = { execution_id: string; variant_id: string; task_description?: string; input_impulse_shapes?: string[] };
function makeDbWithTraces(ancestorRows: AncestorRow[]): { db: DBQueryable; calls: Array<{ sql: string; params: Record<string, unknown> }> } {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const db: DBQueryable = {
    async query(sql, params = {}) {
      calls.push({ sql, params });
      if (sql.includes('activity_execution_traces')) return ancestorRows as any;
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

// ---------------------------------------------------------------------------
// Tests: propagateCreditAlongChain (Phase 18.4)
// ---------------------------------------------------------------------------

/**
 * Helper to extract variant_performance_metrics calls for a given activity id.
 */
function getGlobalCalls(
  calls: Array<{ sql: string; params: Record<string, unknown> }>,
  activityId: string,
) {
  return calls.filter(
    c => c.sql.includes('variant_performance_metrics') && c.params.activity_id === activityId,
  );
}

describe('propagateCreditAlongChain — 18.4.5: success on 4-deep chain', () => {
  // Chain A→B→C→D. D is the leaf (already credited by applyOutcomeToPosteriors).
  // composition_chain stores ancestors root-first: [A, B, C] (D is NOT in chain).
  // Chain propagation should give:
  //   depth 1 (C): α += γ^1 = 0.5
  //   depth 2 (B): α += γ^2 = 0.25
  //   depth 3 (A): α += γ^3 = 0.125
  test('success: C gets α+=0.5, B gets α+=0.25, A gets α+=0.125', async () => {
    const { db, calls } = makeDb();

    const execution: ExecutionForChainCredit = {
      activity_id: 'D',
      composition_chain: ['A', 'B', 'C'], // ancestors only, root-first; D excluded
      success: true,
      failure_mode: null,
    };

    await propagateCreditAlongChain(execution, db, ORG);

    // C is at depth 1 (closest ancestor) — reversed chain is [C, B, A]
    const cCalls = getGlobalCalls(calls, 'C');
    expect(cCalls).toHaveLength(1);
    expect(cCalls[0].params.alpha_delta).toBeCloseTo(0.5);
    expect(cCalls[0].params.beta_delta).toBe(0);

    // B is at depth 2
    const bCalls = getGlobalCalls(calls, 'B');
    expect(bCalls).toHaveLength(1);
    expect(bCalls[0].params.alpha_delta).toBeCloseTo(0.25);
    expect(bCalls[0].params.beta_delta).toBe(0);

    // A is at depth 3
    const aCalls = getGlobalCalls(calls, 'A');
    expect(aCalls).toHaveLength(1);
    expect(aCalls[0].params.alpha_delta).toBeCloseTo(0.125);
    expect(aCalls[0].params.beta_delta).toBe(0);

    // D is the leaf — not in composition_chain, propagateCreditAlongChain does not write it
    const dCalls = getGlobalCalls(calls, 'D');
    expect(dCalls).toHaveLength(0);
  });

  test('success: total writes == 3 (one per ancestor in chain)', async () => {
    const { db, calls } = makeDb();
    await propagateCreditAlongChain(
      { activity_id: 'D', composition_chain: ['A', 'B', 'C'], success: true },
      db,
      ORG,
    );
    const globalWrites = calls.filter(c => c.sql.includes('variant_performance_metrics'));
    expect(globalWrites).toHaveLength(3);
  });

  test('depth cap: chains longer than 4 only write 4 ancestors', async () => {
    const { db, calls } = makeDb();
    await propagateCreditAlongChain(
      { activity_id: 'F', composition_chain: ['A', 'B', 'C', 'D', 'E'], success: true },
      db,
      ORG,
    );
    const globalWrites = calls.filter(c => c.sql.includes('variant_performance_metrics'));
    expect(globalWrites).toHaveLength(4); // capped at CREDIT_PROPAGATION_MAX_DEPTH=4
  });
});

describe('propagateCreditAlongChain — 18.4.6: cascading failure on 4-deep chain', () => {
  // Chain A→B→C→D. D fails with cascading, upstream_task_id points at a task
  // in B. Heuristic: propagate β to the direct parent (C, depth 1) only.
  // A receives nothing per spec 18.4.3.
  test('cascading: only direct parent (C, depth-1) gets β+=0.5', async () => {
    const { db, calls } = makeDb();

    const fm: FailureMode = {
      type: 'cascading',
      reason: 'upstream task in B failed',
      upstream_task_id: 'task-in-B',
    };

    const execution: ExecutionForChainCredit = {
      activity_id: 'D',
      composition_chain: ['A', 'B', 'C'],
      success: false,
      failure_mode: fm,
    };

    await propagateCreditAlongChain(execution, db, ORG);

    // C is at depth 1 — gets β += γ^1 = 0.5
    const cCalls = getGlobalCalls(calls, 'C');
    expect(cCalls).toHaveLength(1);
    expect(cCalls[0].params.alpha_delta).toBe(0);
    expect(cCalls[0].params.beta_delta).toBeCloseTo(0.5);

    // B is at depth 2 — receives nothing for cascading
    const bCalls = getGlobalCalls(calls, 'B');
    expect(bCalls).toHaveLength(0);

    // A is at depth 3 — receives nothing for cascading
    const aCalls = getGlobalCalls(calls, 'A');
    expect(aCalls).toHaveLength(0);
  });

  test('cascading: no writes to D (leaf not in chain)', async () => {
    const { db, calls } = makeDb();
    const fm: FailureMode = {
      type: 'cascading',
      reason: 'upstream',
      upstream_task_id: 'task-x',
    };
    await propagateCreditAlongChain(
      { activity_id: 'D', composition_chain: ['A', 'B', 'C'], success: false, failure_mode: fm },
      db,
      ORG,
    );
    const dCalls = getGlobalCalls(calls, 'D');
    expect(dCalls).toHaveLength(0);
  });
});

describe('propagateCreditAlongChain — edge cases', () => {
  test('empty chain → no DB writes', async () => {
    const { db, calls } = makeDb();
    await propagateCreditAlongChain(
      { activity_id: 'X', composition_chain: [], success: true },
      db,
      ORG,
    );
    expect(calls).toHaveLength(0);
  });

  test('ancestor with input_impulse_shapes → writes context_thompson_scores with per-ancestor bucket', async () => {
    const shapes = ['activityTemplate', 'goal'];
    const expectedBucket = computeContextBucket('some task', shapes, ORG);
    const { db, calls } = makeDbWithTraces([
      { execution_id: 'A', variant_id: 'A', task_description: 'some task', input_impulse_shapes: shapes },
    ]);
    await propagateCreditAlongChain(
      { activity_id: 'D', composition_chain: ['A'], success: true },
      db,
      ORG,
    );
    const bucketCalls = calls.filter(
      c => c.sql.includes('context_thompson_scores') && c.params.activity_id === 'A',
    );
    expect(bucketCalls).toHaveLength(1);
    expect(bucketCalls[0].params.context_bucket).toBe(expectedBucket);
  });

  test('ancestor missing input_impulse_shapes → no context_thompson_scores write (legacy skip)', async () => {
    const { db, calls } = makeDbWithTraces([
      { execution_id: 'A', variant_id: 'A' }, // no input_impulse_shapes
    ]);
    await propagateCreditAlongChain(
      { activity_id: 'D', composition_chain: ['A'], success: true },
      db,
      ORG,
    );
    const bucketCalls = calls.filter(c => c.sql.includes('context_thompson_scores'));
    expect(bucketCalls).toHaveLength(0);
  });

  test('per-ancestor bucket isolation: 3-deep chain [A, B, C] each gets own bucket', async () => {
    const shapesA = ['activityTemplate'];
    const shapesB = ['executionTrace', 'goal'];
    const shapesC = ['impulseRelevance'];
    const bucketA = computeContextBucket('task A', shapesA, ORG);
    const bucketB = computeContextBucket('task B', shapesB, ORG);
    const bucketC = computeContextBucket('task C', shapesC, ORG);

    const { db, calls } = makeDbWithTraces([
      { execution_id: 'A', variant_id: 'A', task_description: 'task A', input_impulse_shapes: shapesA },
      { execution_id: 'B', variant_id: 'B', task_description: 'task B', input_impulse_shapes: shapesB },
      { execution_id: 'C', variant_id: 'C', task_description: 'task C', input_impulse_shapes: shapesC },
    ]);
    await propagateCreditAlongChain(
      { activity_id: 'D', composition_chain: ['A', 'B', 'C'], success: true },
      db,
      ORG,
    );

    // C is depth 1 (closest), B depth 2, A depth 3
    const cBucketCall = calls.find(c => c.sql.includes('context_thompson_scores') && c.params.activity_id === 'C');
    const bBucketCall = calls.find(c => c.sql.includes('context_thompson_scores') && c.params.activity_id === 'B');
    const aBucketCall = calls.find(c => c.sql.includes('context_thompson_scores') && c.params.activity_id === 'A');

    expect(cBucketCall?.params.context_bucket).toBe(bucketC);
    expect(bBucketCall?.params.context_bucket).toBe(bucketB);
    expect(aBucketCall?.params.context_bucket).toBe(bucketA);

    // All three buckets are distinct (otherwise the test is vacuous)
    expect(new Set([bucketA, bucketB, bucketC]).size).toBe(3);
  });

  test('non-cascading failure propagates decayed β to all ancestors', async () => {
    const { db, calls } = makeDb();
    const fm: FailureMode = {
      type: 'verifier_negative',
      reason: 'check failed',
      validator_id: 'v1',
      failed_evidence: [],
    };
    await propagateCreditAlongChain(
      { activity_id: 'D', composition_chain: ['A', 'B'], success: false, failure_mode: fm },
      db,
      ORG,
    );
    // B depth 1: β += 0.5; A depth 2: β += 0.25
    const bCalls = getGlobalCalls(calls, 'B');
    expect(bCalls[0].params.beta_delta).toBeCloseTo(0.5);
    const aCalls = getGlobalCalls(calls, 'A');
    expect(aCalls[0].params.beta_delta).toBeCloseTo(0.25);
  });
});

describe('applyOutcomeToPosteriors — composition_chain fire-and-forget wiring', () => {
  test('trace with composition_chain triggers chain propagation writes', async () => {
    const { db, calls } = makeDb();
    await applyOutcomeToPosteriors(
      makeTrace({
        success: true,
        composition_chain: ['ancestor-A', 'ancestor-B'],
      }),
      db,
      ORG,
    );
    // Wait a tick for the fire-and-forget promise to settle
    await new Promise(r => setTimeout(r, 10));
    const ancestorBCalls = getGlobalCalls(calls, 'ancestor-B');
    expect(ancestorBCalls).toHaveLength(1);
    expect(ancestorBCalls[0].params.alpha_delta).toBeCloseTo(0.5);
  });

  test('trace without composition_chain does NOT trigger extra writes', async () => {
    const { db, calls } = makeDb();
    await applyOutcomeToPosteriors(makeTrace({ success: true }), db, ORG);
    await new Promise(r => setTimeout(r, 10));
    // Only the single variant_performance_metrics write for the leaf itself
    const allWrites = calls.filter(c => c.sql.includes('variant_performance_metrics'));
    expect(allWrites).toHaveLength(1);
  });
});
