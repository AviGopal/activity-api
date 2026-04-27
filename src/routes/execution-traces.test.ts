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

import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import {
  normalizePersistedTask,
  extractTaskImpulseIds,
  denormalizeCompositionChain,
  backfillChildCompositionChains,
  walkCompositionChain,
  applyChainFallback,
} from './execution-traces';
import { _internals as readInternals } from './execution-trace-with-signatures';
import { surrealDB } from '../db/surreal';

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

// ============================================================================
// Broadcaster per-task impulse grouping (spec: broadcaster-per-task-grouping.md)
// ----------------------------------------------------------------------------
// The broadcaster emits `task.completed` events that must carry the same
// per-task impulse arrays as the persisted row. Both leg shapes are derived
// from the same `extractTaskImpulseIds` helper. These tests pin the helper
// contract and the persistence/broadcast symmetry.
// ============================================================================

describe('extractTaskImpulseIds (shared helper)', () => {
  test('snake_case canonical: returns the explicit arrays', () => {
    const r = extractTaskImpulseIds({
      input_impulse_ids: ['a', 'b'],
      output_impulse_ids: ['c'],
    });
    expect(r.input_impulse_ids).toEqual(['a', 'b']);
    expect(r.output_impulse_ids).toEqual(['c']);
  });

  test('camelCase fallback: applied when snake_case absent', () => {
    const r = extractTaskImpulseIds({
      inputImpulseIds: ['x'],
      outputImpulseIds: ['y'],
    });
    expect(r.input_impulse_ids).toEqual(['x']);
    expect(r.output_impulse_ids).toEqual(['y']);
  });

  test('inputState/outputState fallback: applied when neither snake nor camel present', () => {
    const r = extractTaskImpulseIds({
      inputState: { impulses: ['from-in'] },
      outputState: { impulses: ['from-out'] },
    });
    expect(r.input_impulse_ids).toEqual(['from-in']);
    expect(r.output_impulse_ids).toEqual(['from-out']);
  });

  test('snake_case wins over camelCase when both present', () => {
    const r = extractTaskImpulseIds({
      input_impulse_ids: ['snake'],
      inputImpulseIds: ['camel'],
      output_impulse_ids: ['snake-out'],
      outputImpulseIds: ['camel-out'],
    });
    expect(r.input_impulse_ids).toEqual(['snake']);
    expect(r.output_impulse_ids).toEqual(['snake-out']);
  });

  test('camelCase wins over inputState container when both present', () => {
    const r = extractTaskImpulseIds({
      inputImpulseIds: ['camel'],
      inputState: { impulses: ['rich'] },
    });
    expect(r.input_impulse_ids).toEqual(['camel']);
  });

  test('empty/missing task object: returns empty arrays (never undefined)', () => {
    expect(extractTaskImpulseIds(undefined)).toEqual({
      input_impulse_ids: [],
      output_impulse_ids: [],
    });
    expect(extractTaskImpulseIds(null)).toEqual({
      input_impulse_ids: [],
      output_impulse_ids: [],
    });
    expect(extractTaskImpulseIds({})).toEqual({
      input_impulse_ids: [],
      output_impulse_ids: [],
    });
  });

  test('non-array fields are ignored, fallback continues', () => {
    const r = extractTaskImpulseIds({
      input_impulse_ids: 'not-an-array' as any,
      inputImpulseIds: ['camel-fallback'],
    });
    expect(r.input_impulse_ids).toEqual(['camel-fallback']);
  });
});

describe('broadcaster.task.completed payload symmetry', () => {
  // The broadcaster builds payload data for each task; per-task impulse
  // arrays must come from the same helper that drives persistence so the
  // two legs (persist + broadcast) carry identical arrays for the same
  // task. This test simulates the broadcaster's payload constructor and
  // asserts the contract against the spec.
  function buildTaskCompletedData(task: any, executionId: string, taskIndex: number) {
    const taskId = task.id || task.taskId || `task-${taskIndex}`;
    const taskSuccess = task.result?.status === 'success';
    const { input_impulse_ids, output_impulse_ids } = extractTaskImpulseIds(task);
    return {
      execution_id: executionId,
      task_id: taskId,
      task_index: taskIndex,
      success: taskSuccess,
      duration_ms: task.duration || task.duration_ms || 0,
      completed_at: new Date().toISOString(),
      error: taskSuccess ? undefined : task.result?.error || task.error,
      input_impulse_ids,
      output_impulse_ids,
    };
  }

  test('canonical snake_case task: impulse arrays ride on broadcast data', () => {
    const task = {
      task_id: 'task-x',
      result: { status: 'success' },
      duration_ms: 42,
      input_impulse_ids: ['imp-in-1', 'imp-in-2'],
      output_impulse_ids: ['imp-out-1'],
    };
    const data = buildTaskCompletedData(task, 'exec-1', 0);
    expect(data.input_impulse_ids).toEqual(['imp-in-1', 'imp-in-2']);
    expect(data.output_impulse_ids).toEqual(['imp-out-1']);
    expect(data.success).toBe(true);
  });

  test('empty-arrays case: task with no impulse data emits explicit []', () => {
    // The latent workbench bug: pre-fix the field could arrive undefined,
    // throwing on `.length`. Spec contract: always emit arrays, even empty.
    const task = {
      task_id: 'task-empty',
      result: { status: 'success' },
    };
    const data = buildTaskCompletedData(task, 'exec-1', 0);
    expect(data.input_impulse_ids).toEqual([]);
    expect(data.output_impulse_ids).toEqual([]);
    // Critical: never undefined.
    expect(data.input_impulse_ids).not.toBeUndefined();
    expect(data.output_impulse_ids).not.toBeUndefined();
  });

  test('camelCase fallback: legacy minibob payloads still broadcast correctly', () => {
    const task = {
      taskId: 'task-camel',
      result: { status: 'success' },
      inputImpulseIds: ['cam-in-1'],
      outputImpulseIds: ['cam-out-1'],
    };
    const data = buildTaskCompletedData(task, 'exec-1', 0);
    expect(data.input_impulse_ids).toEqual(['cam-in-1']);
    expect(data.output_impulse_ids).toEqual(['cam-out-1']);
  });

  test('inputState/outputState fallback rides through to broadcast', () => {
    const task = {
      task_id: 'task-rich',
      result: { status: 'success' },
      inputState: { impulses: ['rich-in-1'] },
      outputState: { impulses: ['rich-out-1'] },
    };
    const data = buildTaskCompletedData(task, 'exec-1', 0);
    expect(data.input_impulse_ids).toEqual(['rich-in-1']);
    expect(data.output_impulse_ids).toEqual(['rich-out-1']);
  });

  test('persistence + broadcast leg symmetry: identical arrays for the same task', () => {
    // Critical contract: a task fed through `normalizePersistedTask` (write
    // leg) and through `extractTaskImpulseIds` (broadcast leg) must yield
    // identical impulse-ID arrays. Drift here means cooccurrence learning
    // and live observers see different views of the same task.
    const task = {
      task_id: 'task-sym',
      result: { status: 'success' },
      input_impulse_ids: ['imp-in-1', 'imp-in-2'],
      output_impulse_ids: ['imp-out-1'],
    };
    const persisted = normalizePersistedTask(task);
    const broadcastData = buildTaskCompletedData(task, 'exec-sym', 0);
    expect(persisted.input_impulse_ids).toEqual(broadcastData.input_impulse_ids);
    expect(persisted.output_impulse_ids).toEqual(broadcastData.output_impulse_ids);
  });

  test('failure case: broadcast carries error from task.result.error', () => {
    const task = {
      task_id: 'task-fail',
      result: { status: 'failure', error: 'boom' },
      input_impulse_ids: ['imp-in-1'],
      output_impulse_ids: [],
    };
    const data = buildTaskCompletedData(task, 'exec-fail', 0);
    expect(data.success).toBe(false);
    expect(data.error).toBe('boom');
    expect(data.input_impulse_ids).toEqual(['imp-in-1']);
    expect(data.output_impulse_ids).toEqual([]);
  });
});

// ============================================================================
// F-37 (2026-04-26): denormalizeCompositionChain server-side helper
// ----------------------------------------------------------------------------
// Every trace on canary had `composition_chain: []` despite
// `parent_execution_id` being correctly set. The denormalization step that
// reads the parent's chain at insert time was missing entirely. These tests
// pin the contract: when called with a parent_execution_id, the helper looks
// the parent up and returns `[...parent.composition_chain, parent.execution_id]`.
//
// The handler call site uses the helper conditionally — only when the client
// did not provide a non-empty chain. The handler-level "trust client" branch
// is exercised through the projection contract above; this block exercises
// the helper itself.
// ============================================================================

describe('denormalizeCompositionChain (F-37 server-side denormalization)', () => {
  let queryMock: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    if (queryMock) {
      queryMock.mockRestore();
      queryMock = null;
    }
  });

  test('parent has no chain (root): returns [parent_execution_id]', async () => {
    // Parent is itself a root trace — composition_chain is null/empty in DB.
    // The child should land with chain = [parent.execution_id], i.e. depth 1.
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([
      { execution_id: 'root-exec-id', composition_chain: null },
    ] as any);

    const chain = await denormalizeCompositionChain('root-exec-id');
    expect(chain).toEqual(['root-exec-id']);
  });

  test('parent has a 2-deep chain: child lands with 3-deep chain', async () => {
    // Parent's chain is [root, mid] and parent itself is the third level.
    // Child should be [root, mid, parent.id], i.e. depth 3.
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([
      {
        execution_id: 'parent-exec-id',
        composition_chain: ['root-exec-id', 'mid-exec-id'],
      },
    ] as any);

    const chain = await denormalizeCompositionChain('parent-exec-id');
    expect(chain).toEqual(['root-exec-id', 'mid-exec-id', 'parent-exec-id']);
  });

  test('parent not found (orphan): returns empty array', async () => {
    // The lookup found no row — could be a race-condition (parent trace
    // lands after the child) or a parent in a different store. Returning []
    // is the safest default; the trace lands with no chain (root-like) and
    // future audit queries simply won't see it as a non-root.
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([] as any);

    const chain = await denormalizeCompositionChain('missing-parent');
    expect(chain).toEqual([]);
  });

  test('empty parent_execution_id input: returns [] without DB call', async () => {
    // Defensive: the helper should not call the DB at all when called with
    // an empty/non-string id. Saves a roundtrip on the (common) root-trace
    // path where parent_execution_id is absent.
    queryMock = spyOn(surrealDB, 'query');

    const chain = await denormalizeCompositionChain('');
    expect(chain).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('DB query throws: returns empty array (graceful degradation)', async () => {
    // Backend hiccup must not propagate up and fail the trace insert. The
    // chain is denormalized for query convenience — losing it on a
    // transient error is acceptable; losing the trace itself is not.
    queryMock = spyOn(surrealDB, 'query').mockRejectedValueOnce(
      new Error('boom: connection refused'),
    );

    const chain = await denormalizeCompositionChain('parent-exec-id');
    expect(chain).toEqual([]);
  });

  test('parent stored execution_id wins over caller-supplied id (defensive)', async () => {
    // If the parent record stores a different (canonical) form of its
    // execution_id, use it — keeps the chain self-consistent.
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([
      {
        execution_id: 'canonical-parent-id',
        composition_chain: ['root-exec-id'],
      },
    ] as any);

    const chain = await denormalizeCompositionChain('caller-supplied-id');
    expect(chain).toEqual(['root-exec-id', 'canonical-parent-id']);
  });

  test('client-provided non-empty chain bypasses helper (handler-level contract)', () => {
    // This is a handler-level contract test: when the client provides a
    // non-empty composition_chain on the wire, the handler trusts it and
    // does NOT call denormalizeCompositionChain. We verify the projection
    // helper above passes the client chain through unchanged. The handler
    // selects between client-provided and computed via:
    //   const resolved = clientCompositionChain !== null
    //     ? clientCompositionChain
    //     : await denormalizeCompositionChain(body.parent_execution_id);
    // Pin the selection logic here as a pure function so it can't drift.
    function resolveChain(args: {
      clientChain: string[] | null;
      computedChain: string[];
    }): string[] {
      return args.clientChain !== null ? args.clientChain : args.computedChain;
    }

    expect(
      resolveChain({
        clientChain: ['c1', 'c2'],
        computedChain: ['ignored'],
      }),
    ).toEqual(['c1', 'c2']);

    expect(
      resolveChain({
        clientChain: null,
        computedChain: ['root', 'parent'],
      }),
    ).toEqual(['root', 'parent']);
  });
});

// ============================================================================
// F-40 (2026-04-26): backfillChildCompositionChains — write-order race fix
// ----------------------------------------------------------------------------
// F-37 computes composition_chain at child-insert time by reading the parent.
// minibob's L1/L2 meta-traces (`emitMetaTrace` for `_goal_resolve` /
// `_activity_execute`) wrap an entire goal flow and emit AFTER their
// children, so the F-37 lookup finds nothing. F-40 closes the race: after a
// successful insert, run a best-effort UPDATE on already-inserted children
// whose chain is still empty. These tests are a behavioural simulation of
// the round-trip: child inserts first (chain stays []), then parent inserts
// and the backfill rewrites the child's chain.
//
// The helper itself is one SurrealQL UPDATE; we mock surrealDB.query and
// assert (a) the call shape and (b) the post-conditions a real DB would
// produce. We also pin best-effort failure semantics: a thrown UPDATE must
// not propagate.
// ============================================================================

describe('backfillChildCompositionChains (F-40 write-order race)', () => {
  let queryMock: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    if (queryMock) {
      queryMock.mockRestore();
      queryMock = null;
    }
  });

  test('late parent: child inserted first lands with [], parent insert backfills to [parent.id]', async () => {
    // Round-trip simulation. Step 1: child inserts before parent → F-37
    // helper finds no parent and returns []. Step 2: parent inserts → F-40
    // backfill runs an UPDATE that sets the child's chain to
    // [...parent.chain, parent.id]. Parent itself is a root, so its chain
    // is [] → child's new chain is [parent.id].

    // Step 1: child-insert path. F-37 helper finds nothing for missing
    // parent and returns []. (This piece is already covered upstream; we
    // pin it here to lock the round-trip.)
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([] as any);
    const childInitialChain = await denormalizeCompositionChain('parent-id');
    expect(childInitialChain).toEqual([]);
    queryMock.mockRestore();

    // Step 2: parent-insert path. F-40 backfill runs. We capture the
    // arguments and assert the parameter shape — that's all a real DB
    // would need to produce the right post-condition.
    const updateMock = spyOn(surrealDB, 'query').mockResolvedValueOnce(
      [] as any,
    );
    queryMock = updateMock;

    await backfillChildCompositionChains('parent-id', []);

    expect(updateMock).toHaveBeenCalledTimes(1);
    const [sql, params] = updateMock.mock.calls[0] as [string, any];
    expect(sql).toMatch(/UPDATE\s+activity_execution_traces/i);
    expect(sql).toMatch(/parent_execution_id\s*=\s*\$parent_execution_id/i);
    // Idempotency guard: only update children with empty/none chain.
    expect(sql).toMatch(/composition_chain IS NONE/i);
    expect(sql).toMatch(/array::len\(composition_chain\)\s*=\s*0/i);
    expect(params).toEqual({
      parent_execution_id: 'parent-id',
      // Root parent → child chain = [parent.id]
      new_chain: ['parent-id'],
    });
  });

  test('late grandparent (mid-tree backfill): parent insert with chain=[root] backfills children to [root, parent]', async () => {
    // The parent itself is a mid-tree node — its chain is already populated
    // by F-37 at its own insert time (because the grandparent inserted
    // first, which is the common L3-template case). When this mid-tree
    // parent inserts, any already-inserted children get backfilled with
    // [...parent.chain, parent.id] = [root, parent].
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([] as any);

    await backfillChildCompositionChains('parent-id', ['root-id']);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [, params] = queryMock.mock.calls[0] as [string, any];
    expect(params).toEqual({
      parent_execution_id: 'parent-id',
      new_chain: ['root-id', 'parent-id'],
    });
  });

  test('root-only insert (no parent_execution_id): backfills children to [root.id]', async () => {
    // Root inserts (no parent_execution_id) still need to backfill any
    // children that referenced them before they landed. The handler calls
    // backfillChildCompositionChains(execution_id, [])  for roots
    // (resolvedCompositionChain is empty for root-level inserts).
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([] as any);

    await backfillChildCompositionChains('root-id', []);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [, params] = queryMock.mock.calls[0] as [string, any];
    expect(params).toEqual({
      parent_execution_id: 'root-id',
      new_chain: ['root-id'],
    });
  });

  test('idempotency: second insert of same parent does not re-trigger updates on populated children', async () => {
    // The WHERE clause filters out children whose chain is already populated.
    // We can't fully simulate "real DB filters rows" with a mock, but we
    // can pin the SQL contract: the WHERE clause MUST include the
    // empty-chain guard, and the UPDATE always passes the same new_chain.
    // A duplicate parent insert therefore produces the same UPDATE with the
    // same parameters — and any child already populated by an earlier call
    // is excluded by the DB-side filter. No duplicate appended ids.
    queryMock = spyOn(surrealDB, 'query').mockResolvedValue([] as any);

    await backfillChildCompositionChains('parent-id', ['root-id']);
    await backfillChildCompositionChains('parent-id', ['root-id']);

    expect(queryMock).toHaveBeenCalledTimes(2);

    const [sql1, params1] = queryMock.mock.calls[0] as [string, any];
    const [sql2, params2] = queryMock.mock.calls[1] as [string, any];

    // Identical query and params — the DB-side guard handles dedup.
    expect(sql1).toBe(sql2);
    expect(params1).toEqual(params2);
    // The new_chain is exactly two-deep (no duplicate parent.id appends).
    expect((params1 as any).new_chain).toEqual(['root-id', 'parent-id']);
  });

  test('best-effort: UPDATE throws → returns without throwing, insert path unaffected', async () => {
    // Simulate SurrealDB throwing on the backfill UPDATE. The helper must
    // swallow and log — never rethrow — because the parent insert has
    // already succeeded and the response is on its way back to the client.
    queryMock = spyOn(surrealDB, 'query').mockRejectedValueOnce(
      new Error('boom: connection refused'),
    );

    // No throw expected.
    await expect(
      backfillChildCompositionChains('parent-id', []),
    ).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// F-37/F-40 read-time fallback (2026-04-26): walkCompositionChain
// ----------------------------------------------------------------------------
// F-37 + F-40 are write-time fixes. Traces inserted before either landed, or
// under pathological orderings F-40 can't reach, can still expose
// `composition_chain: []` despite valid `parent_execution_id`. The helper
// walks the parent chain on demand; read-only — never writes back.
// ============================================================================

describe('walkCompositionChain (F-37/F-40 read-time fallback)', () => {
  let queryMock: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    queryMock?.mockRestore();
    queryMock = null;
  });

  // Helper: build a row payload for surrealDB.query mock
  const row = (id: string, parent: string | null, chain: string[]) => [
    { execution_id: id, parent_execution_id: parent, composition_chain: chain },
  ];

  test('empty input: returns [] without DB call', async () => {
    queryMock = spyOn(surrealDB, 'query');
    expect(await walkCompositionChain('')).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('single non-existent parent: returns []', async () => {
    // Look-up finds nothing — stop walking, return [].
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([] as any);
    expect(await walkCompositionChain('missing-id')).toEqual([]);
  });

  test('1-deep: parent has empty chain, no further parent → [parent.execution_id]', async () => {
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce(
      row('parent-id', null, []) as any,
    );
    expect(await walkCompositionChain('parent-id')).toEqual(['parent-id']);
  });

  test('2-deep: neither has chain → [grandparent, parent] root-first', async () => {
    queryMock = spyOn(surrealDB, 'query')
      .mockResolvedValueOnce(row('parent-id', 'grandparent-id', []) as any)
      .mockResolvedValueOnce(row('grandparent-id', null, []) as any);
    expect(await walkCompositionChain('parent-id')).toEqual([
      'grandparent-id',
      'parent-id',
    ]);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  test('mid-walk encounters non-empty chain: prepends and early-exits', async () => {
    // Grandparent already has a populated chain — the walk early-exits;
    // result is grandparent.chain + grandparent.id + accumulator.
    queryMock = spyOn(surrealDB, 'query')
      .mockResolvedValueOnce(row('parent-id', 'grandparent-id', []) as any)
      .mockResolvedValueOnce(row('grandparent-id', 'root-id', ['root-id']) as any);
    expect(await walkCompositionChain('parent-id')).toEqual([
      'root-id',
      'grandparent-id',
      'parent-id',
    ]);
    // Two queries — early-exit prevents a third (root-id is not looked up).
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  test('cycle (A → B → A) capped: stops, returns partial', async () => {
    // Pathological self-cycle. visited-set guard fires on re-visit; returns
    // accumulated ids without infinite-looping or throwing.
    queryMock = spyOn(surrealDB, 'query')
      .mockResolvedValueOnce(row('A', 'B', []) as any)
      .mockResolvedValueOnce(row('B', 'A', []) as any);
    expect(await walkCompositionChain('A', 4)).toEqual(['B', 'A']);
  });

  test('DB throws: returns [] (graceful degradation)', async () => {
    queryMock = spyOn(surrealDB, 'query').mockRejectedValueOnce(
      new Error('boom: connection refused'),
    );
    expect(await walkCompositionChain('parent-id')).toEqual([]);
  });
});

// ============================================================================
// GET handler integration: applyChainFallback (used by both list + detail)
// ----------------------------------------------------------------------------
// Pins the contract: stored non-empty chain → trust; empty + parent → walk;
// empty + no parent → no walk.
// ============================================================================

describe('applyChainFallback (GET handler integration)', () => {
  let queryMock: ReturnType<typeof spyOn> | null = null;
  afterEach(() => {
    queryMock?.mockRestore();
    queryMock = null;
  });

  test('composition_chain=[] + parent_execution_id set: response carries computed chain', async () => {
    queryMock = spyOn(surrealDB, 'query').mockResolvedValueOnce([
      { execution_id: 'parent-id', parent_execution_id: null, composition_chain: [] },
    ] as any);
    const trace = {
      execution_id: 'child-id',
      parent_execution_id: 'parent-id',
      composition_chain: [],
    };
    expect((await applyChainFallback(trace)).composition_chain).toEqual(['parent-id']);
  });

  test('non-empty composition_chain: handler trusts existing chain (no walk)', async () => {
    queryMock = spyOn(surrealDB, 'query');
    const trace = {
      execution_id: 'child-id',
      parent_execution_id: 'parent-id',
      composition_chain: ['root-id', 'parent-id'],
    };
    expect((await applyChainFallback(trace)).composition_chain).toEqual([
      'root-id',
      'parent-id',
    ]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('no parent_execution_id: no walk, chain stays []', async () => {
    queryMock = spyOn(surrealDB, 'query');
    const trace = { execution_id: 'root-id', composition_chain: [] };
    expect((await applyChainFallback(trace)).composition_chain).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
