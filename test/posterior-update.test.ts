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
import { computeStateSpaceSignature } from '../src/utils/session-context';
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
type AncestorRow = { execution_id: string; variant_id: string };
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

  test('ancestor without ancestor_signatures entry → no context_thompson_scores write', async () => {
    const { db, calls } = makeDbWithTraces([
      { execution_id: 'A', variant_id: 'A' },
    ]);
    await propagateCreditAlongChain(
      { activity_id: 'D', composition_chain: ['A'], success: true },
      db,
      ORG,
    );
    const ctsCalls = calls.filter(c => c.sql.includes('context_thompson_scores'));
    expect(ctsCalls).toHaveLength(0);
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

describe('propagateCreditAlongChain — §5: per-ancestor v1 signatures', () => {
  test('3-deep chain A→B→C→D: each ancestor gets its own conditional write with correct signature', async () => {
    const sigA = computeStateSpaceSignature({ shapes: ['activityTemplate'], provenance: [], missing: [] });
    const sigB = computeStateSpaceSignature({ shapes: ['executionTrace', 'goal'], provenance: [], missing: [] });
    const sigC = computeStateSpaceSignature({ shapes: ['impulseRelevance'], provenance: [], missing: [] });

    expect(new Set([sigA, sigB, sigC]).size).toBe(3);

    const { db, calls } = makeDbWithTraces([
      { execution_id: 'A', variant_id: 'A' },
      { execution_id: 'B', variant_id: 'B' },
      { execution_id: 'C', variant_id: 'C' },
    ]);

    await propagateCreditAlongChain(
      {
        activity_id: 'D',
        composition_chain: ['A', 'B', 'C'],
        success: true,
        ancestor_signatures: {
          A: { signature: sigA, signature_version: 1 },
          B: { signature: sigB, signature_version: 1 },
          C: { signature: sigC, signature_version: 1 },
        },
      },
      db,
      ORG,
    );

    // composition_chain reversed: C=depth-1, B=depth-2, A=depth-3
    const cSigCall = calls.find(c => c.sql.includes('context_thompson_scores') && c.params.activity_id === 'C');
    const bSigCall = calls.find(c => c.sql.includes('context_thompson_scores') && c.params.activity_id === 'B');
    const aSigCall = calls.find(c => c.sql.includes('context_thompson_scores') && c.params.activity_id === 'A');

    expect(cSigCall).toBeDefined();
    expect(cSigCall!.params.sig).toBe(sigC);
    expect(cSigCall!.params.sig_version).toBe(1);
    expect(cSigCall!.params.alpha_delta).toBeCloseTo(0.5);

    expect(bSigCall).toBeDefined();
    expect(bSigCall!.params.sig).toBe(sigB);
    expect(bSigCall!.params.alpha_delta).toBeCloseTo(0.25);

    expect(aSigCall).toBeDefined();
    expect(aSigCall!.params.sig).toBe(sigA);
    expect(aSigCall!.params.alpha_delta).toBeCloseTo(0.125);
  });

  test('partial ancestor_signatures: only ancestors with entries get conditional writes', async () => {
    const sigC = computeStateSpaceSignature({ shapes: ['impulseRelevance'], provenance: [], missing: [] });

    const { db, calls } = makeDbWithTraces([
      { execution_id: 'A', variant_id: 'A' },
      { execution_id: 'B', variant_id: 'B' },
      { execution_id: 'C', variant_id: 'C' },
    ]);

    await propagateCreditAlongChain(
      {
        activity_id: 'D',
        composition_chain: ['A', 'B', 'C'],
        success: true,
        ancestor_signatures: {
          C: { signature: sigC, signature_version: 1 },
        },
      },
      db,
      ORG,
    );

    const ctsCalls = calls.filter(c => c.sql.includes('context_thompson_scores'));
    expect(ctsCalls).toHaveLength(1);
    expect(ctsCalls[0].params.activity_id).toBe('C');
    expect(ctsCalls[0].params.sig).toBe(sigC);
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

// ---------------------------------------------------------------------------
// Tests: v1 signature conditional writes (task 2.3 / 2.4)
// ---------------------------------------------------------------------------

describe('applyOutcomeToPosteriors — v1 signature conditional writes', () => {
  test('(a) conditional write fires when signature present', async () => {
    const { db, calls } = makeDb();
    const sig = computeStateSpaceSignature({ shapes: ['codeFile', 'gitDiff'], provenance: [], missing: [] });

    await applyOutcomeToPosteriors(
      makeTrace({ success: true, signature: sig, signature_version: 1 }),
      db,
      ORG,
    );

    const sigWrites = calls.filter(c => c.sql.includes('context_thompson_scores'));
    expect(sigWrites).toHaveLength(1);
    expect(sigWrites[0].params.sig).toBe(sig);
    expect(sigWrites[0].params.sig_version).toBe(1);
    expect(sigWrites[0].params.alpha_delta).toBe(1);
    expect(sigWrites[0].params.beta_delta).toBe(0);
  });

  test('(b) signature-absent path: no context_thompson_scores write', async () => {
    const { db, calls } = makeDb();
    await applyOutcomeToPosteriors(makeTrace({ success: true }), db, ORG);

    const sigWrites = calls.filter(c => c.sql.includes('context_thompson_scores'));
    expect(sigWrites).toHaveLength(0);
  });

  test('(c) failure-mode rules apply per-bucket identically to global — verifier_negative → beta=1', async () => {
    const { db, calls } = makeDb();
    const sig = computeStateSpaceSignature({ shapes: ['analysisResult'], provenance: [], missing: [] });

    await applyOutcomeToPosteriors(
      makeTrace({
        success: false,
        failure_mode: { type: 'verifier_negative', reason: 'test', context: { validator_id: 'v1', failed_evidence: [] } },
        signature: sig,
        signature_version: 1,
      }),
      db,
      ORG,
    );

    const sigWrites = calls.filter(c => c.sql.includes('context_thompson_scores'));
    expect(sigWrites).toHaveLength(1);
    expect(sigWrites[0].params.alpha_delta).toBe(0);
    expect(sigWrites[0].params.beta_delta).toBe(1);
  });
});
