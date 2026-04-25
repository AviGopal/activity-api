/**
 * WebSocket Reconnection and Catchup Protocol Tests
 *
 * Tests the WebSocket reconnection flow with catchup protocol:
 * 1. Client connects and authenticates
 * 2. Events are emitted
 * 3. Client disconnects (simulating network failure)
 * 4. More events are emitted while disconnected
 * 5. Client reconnects and requests catchup
 * 6. Client receives missed events
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { broadcaster } from './broadcaster';
import type { WebSocketMessage } from './types';

describe('WebSocket Reconnection with Catchup', () => {
  let mockClient: any;
  let receivedMessages: WebSocketMessage[] = [];
  let lastSeenSequence = 0;

  beforeAll(() => {
    // Create mock WebSocket client
    mockClient = {
      data: {
        authenticated: true,
        sessionId: 'test-session',
        orgId: 'test-org',
      },
      send: (message: string) => {
        const parsed = JSON.parse(message);
        receivedMessages.push(parsed);
        if (parsed.sequence !== undefined) {
          lastSeenSequence = parsed.sequence;
        }
      },
      getBufferedAmount: () => 0,
    };
  });

  afterAll(() => {
    // Clean up
    broadcaster.removeClient(mockClient);
  });

  test('client receives events in real-time when connected', () => {
    receivedMessages = [];

    // Add client to broadcaster
    broadcaster.addClient(mockClient);

    const initialCount = receivedMessages.length;
    const initialSequence = broadcaster.getCurrentSequence();

    // Emit a fine-grained event
    broadcaster.emit({
      type: 'task.started',
      data: {
        execution_id: 'reconnect-test-1',
        task_id: 'task-1',
        task_index: 0,
        description: 'Test task before disconnect',
        started_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    // Client should have received the event
    expect(receivedMessages.length).toBeGreaterThan(initialCount);

    const lastMessage = receivedMessages[receivedMessages.length - 1];
    expect(lastMessage.type).toBe('task.started');
    expect(lastMessage.sequence).toBeDefined();
    expect(lastMessage.sequence).toBeGreaterThan(initialSequence);
  });

  test('catchup sends missed events after reconnection', () => {
    const sequenceBeforeDisconnect = broadcaster.getCurrentSequence();

    // Simulate client disconnect (remove from broadcaster)
    broadcaster.removeClient(mockClient);
    receivedMessages = [];

    // Emit events while client is disconnected
    broadcaster.emit({
      type: 'task.completed',
      data: {
        execution_id: 'reconnect-test-1',
        task_id: 'task-1',
        task_index: 0,
        success: true,
        duration_ms: 500,
        completed_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    broadcaster.emit({
      type: 'tool.call',
      data: {
        execution_id: 'reconnect-test-1',
        task_id: 'task-1',
        tool_name: 'bash',
        resolver_tier: 'deterministic',
        latency_ms: 10,
        cost_usd: 0,
        timestamp: new Date().toISOString(),
      },
    } as WebSocketMessage);

    broadcaster.emit({
      type: 'task.started',
      data: {
        execution_id: 'reconnect-test-1',
        task_id: 'task-2',
        task_index: 1,
        description: 'Second task while disconnected',
        started_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    // Client should not have received these events (was disconnected)
    expect(receivedMessages.length).toBe(0);

    // Simulate reconnection
    broadcaster.addClient(mockClient);
    receivedMessages = [];

    // Client requests catchup with lastSeenSequence
    const sentCount = broadcaster.sendCatchup(mockClient, sequenceBeforeDisconnect);

    // Should have sent 3 missed events
    expect(sentCount).toBe(3);
    expect(receivedMessages.length).toBe(3);

    // Verify the catchup events are in order
    expect(receivedMessages[0].type).toBe('task.completed');
    expect(receivedMessages[1].type).toBe('tool.call');
    expect(receivedMessages[2].type).toBe('task.started');

    // All should have sequence numbers
    receivedMessages.forEach((msg, idx) => {
      expect(msg.sequence).toBeDefined();
      if (idx > 0) {
        expect(msg.sequence).toBeGreaterThan(receivedMessages[idx - 1].sequence!);
      }
    });
  });

  test('catchup returns 0 if client is already up to date', () => {
    const currentSequence = broadcaster.getCurrentSequence();

    receivedMessages = [];
    const sentCount = broadcaster.sendCatchup(mockClient, currentSequence);

    expect(sentCount).toBe(0);
    expect(receivedMessages.length).toBe(0);
  });

  test('catchup handles very old sequence numbers gracefully', () => {
    // Request catchup from sequence 0 (very old)
    receivedMessages = [];

    // Should send events from the buffer (up to BUFFER_SIZE)
    const sentCount = broadcaster.sendCatchup(mockClient, 0);

    // Should have sent some events (limited by buffer size)
    expect(sentCount).toBeGreaterThanOrEqual(0);

    // All messages should have ascending sequences
    for (let i = 1; i < receivedMessages.length; i++) {
      if (receivedMessages[i].sequence && receivedMessages[i - 1].sequence) {
        expect(receivedMessages[i].sequence).toBeGreaterThan(receivedMessages[i - 1].sequence!);
      }
    }
  });

  test('multiple clients can reconnect independently', () => {
    const client1 = {
      data: { authenticated: true, sessionId: 'session-1', orgId: 'org-1' },
      send: (message: string) => {},
      getBufferedAmount: () => 0,
    };

    const client2 = {
      data: { authenticated: true, sessionId: 'session-2', orgId: 'org-1' },
      send: (message: string) => {},
      getBufferedAmount: () => 0,
    };

    broadcaster.addClient(client1);
    broadcaster.addClient(client2);

    const seq1 = broadcaster.getCurrentSequence();

    // Disconnect client1
    broadcaster.removeClient(client1);

    // Emit event (only client2 receives it)
    broadcaster.emit({
      type: 'task.started',
      data: {
        execution_id: 'multi-client-test',
        task_id: 'task-1',
        task_index: 0,
        description: 'Test multi-client',
        started_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    const seq2 = broadcaster.getCurrentSequence();

    // Reconnect client1 and request catchup
    broadcaster.addClient(client1);
    const sentCount = broadcaster.sendCatchup(client1, seq1);

    // Should have sent 1 missed event to client1
    expect(sentCount).toBe(1);

    // Clean up
    broadcaster.removeClient(client1);
    broadcaster.removeClient(client2);
  });

  test('catchup respects event type filtering (fine-grained only)', () => {
    const seqBeforeCoarse = broadcaster.getCurrentSequence();

    // Emit a coarse-grained event (should not be buffered)
    broadcaster.emit({
      type: 'execution_completed',
      data: {
        execution_id: 'coarse-test',
        activity_id: 'test-activity',
        success: true,
        duration_ms: 1000,
        cost: 0.01,
        completed_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    // Emit a fine-grained event (should be buffered)
    broadcaster.emit({
      type: 'task.started',
      data: {
        execution_id: 'fine-grained-test',
        task_id: 'task-1',
        task_index: 0,
        description: 'Fine-grained test',
        started_at: new Date().toISOString(),
      },
    } as WebSocketMessage);

    receivedMessages = [];
    const sentCount = broadcaster.sendCatchup(mockClient, seqBeforeCoarse);

    // Should only send the fine-grained event
    expect(sentCount).toBeGreaterThanOrEqual(1);

    // Verify no coarse-grained events in catchup
    const hasCoarseEvent = receivedMessages.some(msg => msg.type === 'execution_completed');
    expect(hasCoarseEvent).toBe(false);
  });
});

describe('Network Failure Simulation', () => {
  test('simulates complete network failure and recovery', async () => {
    const mockClient = {
      data: { authenticated: true, sessionId: 'network-fail-test', orgId: 'test-org' },
      send: (message: string) => {},
      getBufferedAmount: () => 0,
    };

    broadcaster.addClient(mockClient);
    const sequenceBeforeFailure = broadcaster.getCurrentSequence();

    // Simulate network failure (disconnect)
    broadcaster.removeClient(mockClient);

    // Continue emitting events during outage
    for (let i = 0; i < 5; i++) {
      broadcaster.emit({
        type: 'task.started',
        data: {
          execution_id: `network-fail-${i}`,
          task_id: `task-${i}`,
          task_index: i,
          description: `Task during outage ${i}`,
          started_at: new Date().toISOString(),
        },
      } as WebSocketMessage);
    }

    const sequenceAfterOutage = broadcaster.getCurrentSequence();

    // Verify sequence advanced
    expect(sequenceAfterOutage).toBeGreaterThan(sequenceBeforeFailure);
    expect(sequenceAfterOutage).toBeGreaterThanOrEqual(sequenceBeforeFailure + 5);

    // Simulate recovery (reconnect)
    broadcaster.addClient(mockClient);
    const caughtUpCount = broadcaster.sendCatchup(mockClient, sequenceBeforeFailure);

    // Should have caught up with 5 events
    expect(caughtUpCount).toBe(5);

    // Clean up
    broadcaster.removeClient(mockClient);
  });

  test('handles rapid connect/disconnect cycles', () => {
    const mockClient = {
      data: { authenticated: true, sessionId: 'rapid-cycle-test', orgId: 'test-org' },
      send: (message: string) => {},
      getBufferedAmount: () => 0,
    };

    // Rapid connect/disconnect
    for (let i = 0; i < 10; i++) {
      broadcaster.addClient(mockClient);
      broadcaster.emit({
        type: 'task.started',
        data: {
          execution_id: `rapid-${i}`,
          task_id: `task-${i}`,
          task_index: i,
          description: `Rapid cycle ${i}`,
          started_at: new Date().toISOString(),
        },
      } as WebSocketMessage);
      broadcaster.removeClient(mockClient);
    }

    // Final reconnect
    broadcaster.addClient(mockClient);
    const sequence = broadcaster.getCurrentSequence();
    expect(sequence).toBeGreaterThan(0);

    // Clean up
    broadcaster.removeClient(mockClient);
  });
});
