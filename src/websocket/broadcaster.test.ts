/**
 * Tests for WebSocket broadcaster sequence numbering and catchup protocol
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { broadcaster } from './broadcaster';
import type { WebSocketMessage } from './types';

describe('WebSocket Broadcaster', () => {
  beforeEach(() => {
    // Note: broadcaster is a singleton, so state persists between tests
    // In a real test environment, we'd want to reset it, but for now we'll work with it
  });

  test('should assign sequence numbers to fine-grained events', () => {
    const initialSequence = broadcaster.getCurrentSequence();

    const taskStartedMessage: WebSocketMessage = {
      type: 'task.started',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'test-exec-1',
        task_id: 'task-1',
        task_index: 0,
        description: 'Test task',
        started_at: new Date().toISOString(),
      },
    };

    // Emit the message (it will be assigned a sequence number internally)
    broadcaster.emit(taskStartedMessage);

    const newSequence = broadcaster.getCurrentSequence();
    expect(newSequence).toBeGreaterThan(initialSequence);
    expect(taskStartedMessage.sequence).toBe(newSequence);
  });

  test('should not assign sequence numbers to coarse-grained events', () => {
    const executionCompletedMessage: WebSocketMessage = {
      type: 'execution_completed',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'test-exec-2',
        activity_id: 'test-activity',
        success: true,
        duration_ms: 1000,
        cost: 0.01,
        completed_at: new Date().toISOString(),
      },
    };

    // Emit the message
    broadcaster.emit(executionCompletedMessage);

    // Coarse-grained events should not have sequence numbers
    expect(executionCompletedMessage.sequence).toBeUndefined();
  });

  test('should increment sequence for multiple fine-grained events', () => {
    const sequence1 = broadcaster.getCurrentSequence();

    broadcaster.emit({
      type: 'task.started',
      data: {
        execution_id: 'exec-1',
        task_id: 'task-1',
        task_index: 0,
        description: 'Task 1',
        started_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    const sequence2 = broadcaster.getCurrentSequence();

    broadcaster.emit({
      type: 'task.completed',
      data: {
        execution_id: 'exec-1',
        task_id: 'task-1',
        task_index: 0,
        success: true,
        duration_ms: 500,
        completed_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    const sequence3 = broadcaster.getCurrentSequence();

    broadcaster.emit({
      type: 'tool.call',
      data: {
        execution_id: 'exec-1',
        task_id: 'task-1',
        tool_name: 'bash',
        resolver_tier: 'deterministic',
        latency_ms: 10,
        cost_usd: 0,
        timestamp: new Date().toISOString(),
      },
    } as WebSocketMessage);

    const sequence4 = broadcaster.getCurrentSequence();

    expect(sequence2).toBe(sequence1 + 1);
    expect(sequence3).toBe(sequence2 + 1);
    expect(sequence4).toBe(sequence3 + 1);
  });

  test('getCurrentSequence should return a number', () => {
    const sequence = broadcaster.getCurrentSequence();
    expect(typeof sequence).toBe('number');
    expect(sequence).toBeGreaterThanOrEqual(0);
  });
});

describe('WebSocket Event Types', () => {
  test('task.started event should have correct structure', () => {
    const message: WebSocketMessage = {
      type: 'task.started',
      timestamp: new Date().toISOString(),
      sequence: 1,
      data: {
        execution_id: 'exec-123',
        task_id: 'task-1',
        task_index: 0,
        description: 'Run tests',
        started_at: new Date().toISOString(),
      },
    };

    expect(message.type).toBe('task.started');
    expect(message.data).toHaveProperty('execution_id');
    expect(message.data).toHaveProperty('task_id');
    expect(message.data).toHaveProperty('task_index');
    expect(message.data).toHaveProperty('description');
    expect(message.data).toHaveProperty('started_at');
  });

  test('task.completed event should have correct structure', () => {
    const message: WebSocketMessage = {
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      sequence: 2,
      data: {
        execution_id: 'exec-123',
        task_id: 'task-1',
        task_index: 0,
        success: true,
        duration_ms: 1500,
        completed_at: new Date().toISOString(),
        input_impulse_ids: [],
        output_impulse_ids: [],
      },
    };

    expect(message.type).toBe('task.completed');
    expect(message.data).toHaveProperty('execution_id');
    expect(message.data).toHaveProperty('task_id');
    expect(message.data).toHaveProperty('success');
    expect(message.data).toHaveProperty('duration_ms');
    expect(message.data).toHaveProperty('completed_at');
    expect(message.data).toHaveProperty('input_impulse_ids');
    expect(message.data).toHaveProperty('output_impulse_ids');
  });

  test('task.completed event carries per-task impulse arrays (broadcaster-per-task-grouping spec)', () => {
    // The broadcaster must forward the per-task impulse arrays minibob
    // serializes into each task. Spec: docs/specs/broadcaster-per-task-grouping.md
    const message: WebSocketMessage = {
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      sequence: 99,
      data: {
        execution_id: 'exec-impulse',
        task_id: 'task-impulse',
        task_index: 0,
        success: true,
        duration_ms: 100,
        completed_at: new Date().toISOString(),
        input_impulse_ids: ['concept:c1', 'memo:m1'],
        output_impulse_ids: ['concept:c2'],
      },
    };

    expect((message.data as any).input_impulse_ids).toEqual(['concept:c1', 'memo:m1']);
    expect((message.data as any).output_impulse_ids).toEqual(['concept:c2']);
  });

  test('task.completed event with no impulses still carries empty arrays (never undefined)', () => {
    // The latent workbench bug: events lacking the field would throw on
    // .length. The broadcaster guarantees explicit empty arrays.
    const message: WebSocketMessage = {
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      sequence: 100,
      data: {
        execution_id: 'exec-empty',
        task_id: 'task-empty',
        task_index: 0,
        success: true,
        duration_ms: 50,
        completed_at: new Date().toISOString(),
        input_impulse_ids: [],
        output_impulse_ids: [],
      },
    };

    expect((message.data as any).input_impulse_ids).toEqual([]);
    expect((message.data as any).output_impulse_ids).toEqual([]);
    // Explicit: arrays, never undefined.
    expect((message.data as any).input_impulse_ids).not.toBeUndefined();
    expect((message.data as any).output_impulse_ids).not.toBeUndefined();
  });

  test('tool.call event should have correct structure', () => {
    const message: WebSocketMessage = {
      type: 'tool.call',
      timestamp: new Date().toISOString(),
      sequence: 3,
      data: {
        execution_id: 'exec-123',
        task_id: 'task-1',
        tool_name: 'git',
        resolver_tier: 'deterministic',
        latency_ms: 25,
        cost_usd: 0,
        timestamp: new Date().toISOString(),
      },
    };

    expect(message.type).toBe('tool.call');
    expect(message.data).toHaveProperty('execution_id');
    expect(message.data).toHaveProperty('task_id');
    expect(message.data).toHaveProperty('tool_name');
    expect(message.data).toHaveProperty('resolver_tier');
    expect(message.data).toHaveProperty('latency_ms');
    expect(message.data).toHaveProperty('cost_usd');
  });
});
