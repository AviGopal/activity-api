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

  // impulse.resolved event body contract.
  // The flat-payload form is canonical; `body` is OPTIONAL and present only
  // when the broadcaster could source resolved-impulse content from the
  // matching output_impulses[] entry. See src/websocket/types.ts
  // (ImpulseResolvedMessage) for the formal contract.
  test('impulse.resolved event should have correct flat structure with body', () => {
    const validationBody = {
      passed: true,
      confidence: 0.9,
      validator_id: 'v1',
      evidence: [],
      messages: [],
    };
    const message: WebSocketMessage = {
      type: 'impulse.resolved',
      timestamp: new Date().toISOString(),
      sequence: 4,
      data: {
        execution_id: 'exec-123',
        task_id: 'task-1',
        impulse_id: 'imp-validation-result-1',
        shape: 'validation_result',
        resolver_id: 'validation',
        resolver_tier: 'deterministic',
        vessel_id: 'minibob-canary',
        latency_ms: 12,
        cost_usd: 0,
        body: validationBody,
        timestamp: new Date().toISOString(),
      },
    };

    expect(message.type).toBe('impulse.resolved');
    // Canonical flat fields.
    expect(message.data).toHaveProperty('execution_id');
    expect(message.data).toHaveProperty('impulse_id');
    expect(message.data).toHaveProperty('resolver_id');
    expect(message.data).toHaveProperty('resolver_tier');
    expect(message.data).toHaveProperty('vessel_id');
    expect(message.data).toHaveProperty('latency_ms');
    expect(message.data).toHaveProperty('cost_usd');
    // shape + task_id + body are optional but present here.
    expect(message.data).toHaveProperty('shape');
    expect(message.data).toHaveProperty('task_id');
    expect(message.data).toHaveProperty('body');
    // The body is the resolved impulse content — opaque to the broadcaster
    // but recoverable by consumers (e.g. workbench's parseValidationResult).
    expect(message.data.body).toEqual(validationBody);
  });

  test('impulse.resolved event omits body when content not available', () => {
    // Contract: `body` is optional. When the trace doesn't carry
    // matching content (e.g. file-pointer impulses where content lives on
    // disk only), the field is omitted. Consumers MUST treat absent body as
    // a non-error — the impulse is still considered resolved.
    const message: WebSocketMessage = {
      type: 'impulse.resolved',
      timestamp: new Date().toISOString(),
      sequence: 5,
      data: {
        execution_id: 'exec-456',
        impulse_id: 'imp-file-1',
        resolver_id: 'file',
        resolver_tier: 'deterministic',
        vessel_id: 'minibob-canary',
        latency_ms: 3,
        cost_usd: 0,
        timestamp: new Date().toISOString(),
      },
    };

    expect(message.type).toBe('impulse.resolved');
    expect(message.data).toHaveProperty('impulse_id');
    expect(message.data).not.toHaveProperty('body');
  });

  test('impulse.resolved event gets sequence number from broadcaster', () => {
    const initialSequence = broadcaster.getCurrentSequence();
    const message: WebSocketMessage = {
      type: 'impulse.resolved',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'exec-seq',
        impulse_id: 'imp-seq-1',
        resolver_id: 'memo',
        resolver_tier: 'deterministic',
        vessel_id: 'minibob',
        latency_ms: 1,
        cost_usd: 0,
        timestamp: new Date().toISOString(),
      },
    };

    broadcaster.emit(message);

    const newSequence = broadcaster.getCurrentSequence();
    expect(newSequence).toBe(initialSequence + 1);
    // The broadcaster mutates the message in-place, assigning sequence.
    expect(message.sequence).toBe(newSequence);
  });
});
