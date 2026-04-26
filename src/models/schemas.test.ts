/**
 * Schema unit tests
 *
 * Covers the failure_mode taxonomy added by sibling spec
 * 2026-04-26-validators-and-failure-modes and its integration with
 * StoreExecutionTraceRequestSchema.
 */

import { describe, expect, test } from 'bun:test';
import {
  FailureModeSchema,
  StoreExecutionTraceRequestSchema,
} from './schemas';

const baseTrace = {
  execution_id: 'exec-1',
  template_id: 'tmpl-1',
  status: 'failure' as const,
  duration_ms: 1234,
  cost_usd: 0.01,
  execution_trace: {
    tasks: [],
    impulsesCreated: [],
    filesModified: [],
  },
};

describe('FailureModeSchema', () => {
  test('accepts verifier_negative with validator + evidence', () => {
    const parsed = FailureModeSchema.parse({
      type: 'verifier_negative',
      reason: 'output failed required check',
      validator_id: 'validator-1',
      failed_evidence: [
        { check_id: 'check-a', details: 'expected non-empty', location: 'tasks[0].output' },
        { check_id: 'check-b' },
      ],
    });
    expect(parsed).toBeDefined();
  });

  test('accepts budget_exhausted with budget_type/consumed/allowed', () => {
    const parsed = FailureModeSchema.parse({
      type: 'budget_exhausted',
      reason: 'cost over limit',
      budget_type: 'cost',
      consumed: 1.5,
      allowed: 1.0,
    });
    expect(parsed).toBeDefined();

    const durationVariant = FailureModeSchema.parse({
      type: 'budget_exhausted',
      reason: 'duration over limit',
      budget_type: 'duration',
      consumed: 30000,
      allowed: 10000,
    });
    expect(durationVariant).toBeDefined();
  });

  test('accepts safety_breach with depth + limit', () => {
    const parsed = FailureModeSchema.parse({
      type: 'safety_breach',
      reason: 'composition depth exceeded',
      breach_type: 'depth',
      limit: 5,
      ancestor_chain: ['root', 'parent', 'child'],
    });
    expect(parsed).toBeDefined();
  });

  test('safety_breach.limit is optional (cycle case)', () => {
    const parsed = FailureModeSchema.parse({
      type: 'safety_breach',
      reason: 'cycle detected',
      breach_type: 'cycle',
      ancestor_chain: ['a', 'b', 'a'],
    });
    expect(parsed).toBeDefined();
  });

  test('accepts cascading without upstream_failure_mode', () => {
    const parsed = FailureModeSchema.parse({
      type: 'cascading',
      reason: 'upstream task failed',
      upstream_task_id: 'task-7',
    });
    expect(parsed).toBeDefined();
  });

  test('accepts cascading with recursive upstream_failure_mode', () => {
    const parsed = FailureModeSchema.parse({
      type: 'cascading',
      reason: 'upstream task failed',
      upstream_task_id: 'task-7',
      upstream_failure_mode: {
        type: 'verifier_negative',
        reason: 'check rejected output',
        validator_id: 'validator-9',
        failed_evidence: [{ check_id: 'check-c' }],
      },
    });
    expect(parsed).toBeDefined();
  });

  test('accepts user_abort with abort_source', () => {
    const parsed = FailureModeSchema.parse({
      type: 'user_abort',
      reason: 'user pressed cancel',
      abort_source: 'cli-sigint',
    });
    expect(parsed).toBeDefined();
  });

  test('rejects cross-variant fields (verifier_negative carrying budget_type)', () => {
    const result = FailureModeSchema.safeParse({
      type: 'verifier_negative',
      reason: 'mixed variant',
      // verifier_negative requires validator_id + failed_evidence; supplying
      // budget_type alone (and omitting required fields) must fail.
      budget_type: 'cost',
      consumed: 1,
      allowed: 0.5,
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown type discriminator', () => {
    const result = FailureModeSchema.safeParse({
      type: 'gremlin',
      reason: 'mystery',
    });
    expect(result.success).toBe(false);
  });

  test('rejects safety_breach with bad breach_type', () => {
    const result = FailureModeSchema.safeParse({
      type: 'safety_breach',
      reason: 'whoops',
      breach_type: 'fatigue',
      ancestor_chain: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('StoreExecutionTraceRequestSchema with failure_mode', () => {
  test('accepts a trace without failure_mode (optional)', () => {
    const parsed = StoreExecutionTraceRequestSchema.parse(baseTrace);
    expect(parsed.failure_mode).toBeUndefined();
  });

  test('accepts a trace with verifier_negative failure_mode', () => {
    const parsed = StoreExecutionTraceRequestSchema.parse({
      ...baseTrace,
      failure_mode: {
        type: 'verifier_negative',
        reason: 'rejected by validator',
        validator_id: 'validator-1',
        failed_evidence: [{ check_id: 'check-a' }],
      },
    });
    expect(parsed.failure_mode).toBeDefined();
  });

  test('accepts a trace with safety_breach (cycle, no limit)', () => {
    const parsed = StoreExecutionTraceRequestSchema.parse({
      ...baseTrace,
      failure_mode: {
        type: 'safety_breach',
        reason: 'cycle detected',
        breach_type: 'cycle',
        ancestor_chain: ['a', 'b', 'a'],
      },
    });
    expect(parsed.failure_mode).toBeDefined();
  });

  test('rejects a trace with malformed failure_mode', () => {
    const result = StoreExecutionTraceRequestSchema.safeParse({
      ...baseTrace,
      failure_mode: {
        type: 'budget_exhausted',
        reason: 'missing fields',
        // missing budget_type, consumed, allowed
      },
    });
    expect(result.success).toBe(false);
  });
});
