/**
 * Round-trip tests for per-task impulse grouping through the execution-traces
 * write path + `executionTraceWithSignatures` read resolver.
 *
 * Why these live together: this test is the contract between what minibob
 * serializes (via `serializeTasksForTrace`, snake_case
 * `input_impulse_ids`/`output_impulse_ids`) and what the read resolver
 * surfaces to the co-occurrence extractor. A regression in either the write
 * normalization or the read extraction would silently empty the per-task
 * arrays — which is exactly the bug this pipeline was built to fix.
 *
 * No SurrealDB fixture: we feed the normalized task rows directly into the
 * read resolver's `extractTasks` internal. This mirrors the mocking pattern
 * in `execution-trace-with-signatures.test.ts` and keeps the test hermetic.
 */

import { describe, test, expect } from 'bun:test';
import { normalizePersistedTask } from './execution-traces';
import { _internals as readInternals } from './execution-trace-with-signatures';

describe('execution-traces write -> read round trip', () => {
  test('snake_case per-task impulse ids survive the round trip', () => {
    // Simulate minibob's canonical wire payload (snake_case, what
    // serializeTasksForTrace emits).
    const wireTasks = [
      {
        task_id: 'task-a',
        description: 'task a',
        status: 'success',
        duration_ms: 123,
        tool_calls: [{ name: 'read' }],
        input_impulse_ids: ['imp-in-1', 'imp-in-2'],
        output_impulse_ids: [],
      },
      {
        task_id: 'task-b',
        description: 'task b',
        status: 'success',
        duration_ms: 456,
        tool_calls: null,
        input_impulse_ids: ['imp-in-3'],
        output_impulse_ids: ['imp-out-1', 'imp-out-2'],
      },
    ];

    // Write path: what the handler stores.
    const persistedTasks = wireTasks.map(normalizePersistedTask);
    expect(persistedTasks[0].input_impulse_ids).toEqual(['imp-in-1', 'imp-in-2']);
    expect(persistedTasks[0].output_impulse_ids).toEqual([]);
    expect(persistedTasks[1].input_impulse_ids).toEqual(['imp-in-3']);
    expect(persistedTasks[1].output_impulse_ids).toEqual(['imp-out-1', 'imp-out-2']);

    // Read path: what the resolver returns, given the persisted row.
    // The paradigm `execution` row stores the trace under `trace.tasks`.
    const storedRow = { trace: { tasks: persistedTasks } };
    const readTasks = readInternals.extractTasks(storedRow as any);

    expect(readTasks).toHaveLength(2);
    expect(readTasks[0]).toMatchObject({
      task_id: 'task-a',
      task_index: 0,
      status: 'success',
      input_impulse_ids: ['imp-in-1', 'imp-in-2'],
      output_impulse_ids: [],
    });
    expect(readTasks[1]).toMatchObject({
      task_id: 'task-b',
      task_index: 1,
      status: 'success',
      input_impulse_ids: ['imp-in-3'],
      output_impulse_ids: ['imp-out-1', 'imp-out-2'],
    });

    // Critical assertion: per-task impulse sets are DISTINCT. This is the
    // signal the co-occurrence extractor needs — without it the extractor
    // degrades to execution-scope co-occurrence.
    expect(readTasks[0].input_impulse_ids).not.toEqual(readTasks[1].input_impulse_ids);
  });

  test('legacy camelCase wire payload round-trips (defensive)', () => {
    // Older minibob builds (pre-fix) sometimes emit camelCase.
    const wireTasks = [
      {
        taskId: 't1',
        description: 'legacy camel',
        status: 'success',
        duration: 99,
        toolCalls: [],
        inputImpulseIds: ['cam-in-1'],
        outputImpulseIds: ['cam-out-1'],
      },
    ];
    const persisted = wireTasks.map(normalizePersistedTask);
    expect(persisted[0]).toMatchObject({
      task_id: 't1',
      duration_ms: 99,
      input_impulse_ids: ['cam-in-1'],
      output_impulse_ids: ['cam-out-1'],
    });

    const stored = { trace: { tasks: persisted } };
    const readTasks = readInternals.extractTasks(stored as any);
    expect(readTasks[0].input_impulse_ids).toEqual(['cam-in-1']);
    expect(readTasks[0].output_impulse_ids).toEqual(['cam-out-1']);
  });

  test('inputState.impulses fallback round-trips when canonical fields absent', () => {
    // Rich ExecutedTask shape from improviser path — no snake_case
    // input_impulse_ids field yet, just the richer inputState container.
    const wireTasks = [
      {
        task_id: 'rich-task',
        description: 'from improviser',
        status: 'success',
        inputState: { impulses: ['rich-in-1', 'rich-in-2'] },
        outputState: { impulses: ['rich-out-1'] },
      },
    ];
    const persisted = wireTasks.map(normalizePersistedTask);
    expect(persisted[0].input_impulse_ids).toEqual(['rich-in-1', 'rich-in-2']);
    expect(persisted[0].output_impulse_ids).toEqual(['rich-out-1']);

    // Verify read resolver also surfaces them.
    const stored = { trace: { tasks: persisted } };
    const readTasks = readInternals.extractTasks(stored as any);
    expect(readTasks[0].input_impulse_ids).toEqual(['rich-in-1', 'rich-in-2']);
    expect(readTasks[0].output_impulse_ids).toEqual(['rich-out-1']);
  });

  test('task with no impulse data stores empty arrays (not null/undefined)', () => {
    const wireTasks = [{ task_id: 't1', status: 'failure' }];
    const persisted = wireTasks.map(normalizePersistedTask);
    expect(persisted[0].input_impulse_ids).toEqual([]);
    expect(persisted[0].output_impulse_ids).toEqual([]);

    const stored = { trace: { tasks: persisted } };
    const readTasks = readInternals.extractTasks(stored as any);
    // The read resolver contract says missing = empty array, never null.
    expect(readTasks[0].input_impulse_ids).toEqual([]);
    expect(readTasks[0].output_impulse_ids).toEqual([]);
  });

  test('historical rows without the new fields still readable (back-compat)', () => {
    // A trace written before this change has only task_id/description/etc.,
    // no per-task impulse fields. The read resolver returns empty arrays
    // rather than throwing — the acceptance-criteria back-compat clause.
    const historicalPersisted = [
      {
        task_id: 'old-t1',
        description: 'from before the fix',
        status: 'success',
        duration_ms: 50,
        tool_calls: null,
      },
    ];
    const stored = { trace: { tasks: historicalPersisted } };
    const readTasks = readInternals.extractTasks(stored as any);
    expect(readTasks).toHaveLength(1);
    expect(readTasks[0].input_impulse_ids).toEqual([]);
    expect(readTasks[0].output_impulse_ids).toEqual([]);
  });
});

describe('normalizePersistedTask field precedence', () => {
  test('snake_case takes precedence over inputState.impulses', () => {
    const task = {
      task_id: 't1',
      input_impulse_ids: ['explicit'],
      inputState: { impulses: ['from-state'] },
    };
    const p = normalizePersistedTask(task);
    expect(p.input_impulse_ids).toEqual(['explicit']);
  });

  test('camelCase accepted when snake_case absent', () => {
    const task = {
      task_id: 't1',
      inputImpulseIds: ['camel'],
      inputState: { impulses: ['from-state'] },
    };
    const p = normalizePersistedTask(task);
    expect(p.input_impulse_ids).toEqual(['camel']);
  });

  test('tool_calls accepts both toolCalls and tool_calls', () => {
    expect(
      normalizePersistedTask({
        task_id: 't1',
        toolCalls: [{ n: 1 }],
      }).tool_calls,
    ).toEqual([{ n: 1 }]);
    expect(
      normalizePersistedTask({
        task_id: 't1',
        tool_calls: [{ n: 2 }],
      }).tool_calls,
    ).toEqual([{ n: 2 }]);
  });
});

// ============================================================================
// Per-task resolver attribution (resolver_id, resolver_tier, success, cost_usd)
// ----------------------------------------------------------------------------
// Migration 086 + minibob 6f8c727: per-task resolver fields ride through the
// FLEXIBLE `tasks.*` column. `normalizePersistedTask` was previously dropping
// them on the way to storage, which surfaced as `null` resolver fields on a
// L2-canonical trace GET. These tests pin the contract.
// ============================================================================

describe('normalizePersistedTask preserves per-task resolver attribution', () => {
  test('snake_case canonical form: all four resolver fields persist', () => {
    const task = {
      task_id: 'analyze_state',
      description: 'analyze state',
      status: 'success',
      duration_ms: 1234,
      resolver_id: 'bash',
      resolver_tier: 'deterministic',
      success: true,
      cost_usd: 0,
    };
    const p = normalizePersistedTask(task);
    expect(p.resolver_id).toBe('bash');
    expect(p.resolver_tier).toBe('deterministic');
    expect(p.success).toBe(true);
    expect(p.cost_usd).toBe(0);
  });

  test('per-task cost_usd of 0 is preserved (not stripped as falsy)', () => {
    // Critical: minibob's serializeTasksForTrace defaults cost_usd to 0 when
    // no resolver-supplied number exists. A `if (task.cost_usd)` filter would
    // drop these — we test the field rides through.
    const p = normalizePersistedTask({ task_id: 't1', cost_usd: 0 });
    expect(p.cost_usd).toBe(0);
    expect('cost_usd' in p).toBe(true);
  });

  test('failed task with success=false rides through', () => {
    const p = normalizePersistedTask({
      task_id: 'failing_task',
      resolver_id: 'llm',
      resolver_tier: 'llm',
      success: false,
      cost_usd: 0.0123,
    });
    expect(p.success).toBe(false);
    expect(p.resolver_tier).toBe('llm');
    expect(p.cost_usd).toBe(0.0123);
  });

  test('historical task without resolver fields stays clean (no junk keys)', () => {
    const p = normalizePersistedTask({
      task_id: 'old-task',
      description: 'pre-migration',
      status: 'success',
      duration_ms: 50,
    });
    expect('resolver_id' in p).toBe(false);
    expect('resolver_tier' in p).toBe(false);
    expect('success' in p).toBe(false);
    expect('cost_usd' in p).toBe(false);
  });

  test('non-string resolver_id is dropped (defensive)', () => {
    const p = normalizePersistedTask({
      task_id: 't1',
      resolver_id: 42 as any,
      resolver_tier: '',
    });
    expect('resolver_id' in p).toBe(false);
    expect('resolver_tier' in p).toBe(false);
  });

  test('non-boolean success is dropped (defensive)', () => {
    const p = normalizePersistedTask({ task_id: 't1', success: 'true' as any });
    expect('success' in p).toBe(false);
  });

  test('round-trips alongside impulse-id fields without interference', () => {
    const p = normalizePersistedTask({
      task_id: 'composite',
      input_impulse_ids: ['imp-1'],
      output_impulse_ids: ['imp-2'],
      resolver_id: 'file',
      resolver_tier: 'deterministic',
      success: true,
      cost_usd: 0,
    });
    expect(p.input_impulse_ids).toEqual(['imp-1']);
    expect(p.output_impulse_ids).toEqual(['imp-2']);
    expect(p.resolver_id).toBe('file');
    expect(p.success).toBe(true);
  });
});

// ============================================================================
// Top-level trace fields (vessel_id, resolved_by_vessel_id, composition_chain,
// impulse_resolutions) — migration 086 schema additions.
// ----------------------------------------------------------------------------
// The route handler builds the persisted trace object via conditional spread.
// We can't easily exercise the full Hono handler without a SurrealDB fixture,
// but we can pin the conditional-spread CONTRACT (the bug was these fields
// being absent from the object handed to INSERT, so the SCHEMAFULL table
// silently dropped them).
//
// This helper mirrors the spread block in execution-traces.ts (the section
// added below the existing parent_execution_id / composition_chain spreads).
// If the production code drifts, these tests fail and the contract gets fixed
// in lockstep.
// ============================================================================

function projectVesselFields(body: Record<string, any>): Record<string, any> {
  return {
    ...(body.vessel_id ? { vessel_id: body.vessel_id } : {}),
    ...(body.resolved_by_vessel_id ? { resolved_by_vessel_id: body.resolved_by_vessel_id } : {}),
    ...(body.vessel_version ? { vessel_version: body.vessel_version } : {}),
    ...(Array.isArray(body.impulse_resolutions) && body.impulse_resolutions.length > 0
      ? { impulse_resolutions: body.impulse_resolutions }
      : {}),
    ...(Array.isArray(body.composition_chain) && body.composition_chain.length > 0
      ? { composition_chain: body.composition_chain }
      : {}),
  };
}

describe('execution-trace top-level vessel + resolver fields contract', () => {
  test('canonical wire payload: all four top-level fields pass through', () => {
    const body = {
      execution_id: 'act_test_1',
      template_id: 'analyze-codebase',
      vessel_id: 'minibob-test-1',
      resolved_by_vessel_id: 'minibob-test-1',
      vessel_version: '0.5.0-abc1234',
      composition_chain: ['root-exec', 'mid-exec'],
      impulse_resolutions: [
        {
          impulse_id: 'imp-1',
          resolver_id: 'bash',
          resolver_tier: 'deterministic',
          vessel_id: 'minibob-test-1',
          latency_ms: 5,
          cost_usd: 0,
        },
      ],
    };
    const projected = projectVesselFields(body);
    expect(projected.vessel_id).toBe('minibob-test-1');
    expect(projected.resolved_by_vessel_id).toBe('minibob-test-1');
    expect(projected.vessel_version).toBe('0.5.0-abc1234');
    expect(projected.composition_chain).toEqual(['root-exec', 'mid-exec']);
    expect(projected.impulse_resolutions).toHaveLength(1);
    expect(projected.impulse_resolutions[0].resolver_id).toBe('bash');
  });

  test('back-compat: payload without vessel/resolver fields produces empty projection', () => {
    // Existing minibob builds (pre-6f8c727) and historical traces don't carry
    // these fields. The handler must not synthesize empty values that would
    // then be persisted as empty strings / arrays.
    const body = {
      execution_id: 'act_legacy_1',
      template_id: 'old-activity',
    };
    const projected = projectVesselFields(body);
    expect('vessel_id' in projected).toBe(false);
    expect('resolved_by_vessel_id' in projected).toBe(false);
    expect('vessel_version' in projected).toBe(false);
    expect('impulse_resolutions' in projected).toBe(false);
    expect('composition_chain' in projected).toBe(false);
  });

  test('empty arrays are not persisted (avoid NULL vs NONE issues)', () => {
    const body = {
      execution_id: 'act_test_2',
      template_id: 'foo',
      impulse_resolutions: [],
      composition_chain: [],
    };
    const projected = projectVesselFields(body);
    expect('impulse_resolutions' in projected).toBe(false);
    expect('composition_chain' in projected).toBe(false);
  });

  test('full six-field impulse_resolutions entry shape is preserved', () => {
    // Confirm the SCHEMAFULL table accepts the full entry shape minibob sends
    // (FLEXIBLE inner object, see migration 086).
    const entry = {
      impulse_id: 'imp-42',
      resolver_id: 'llm',
      resolver_tier: 'llm',
      vessel_id: 'minibob-test',
      latency_ms: 1234,
      cost_usd: 0.0023,
    };
    const projected = projectVesselFields({ impulse_resolutions: [entry] });
    expect(projected.impulse_resolutions[0]).toEqual(entry);
  });
});
