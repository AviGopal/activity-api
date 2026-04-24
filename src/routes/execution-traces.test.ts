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
