/**
 * Phase G1 (2026-04-28): WebSocket broadcaster account_id tests.
 * OpenSpec: activity-api-account-id-migration-2026-04-28
 *
 * Verifies each broadcast event type carries the additive tenancy fields
 * (`org_id`, `account_id`) introduced in Phase G1. Fields are optional
 * (nullable) so legacy callers w/o auth context still emit a structurally
 * valid payload — but every event MUST include both keys.
 *
 * Approach: drive the broadcaster directly with synthetic payloads (no
 * server, no DB). Capture emitted messages by patching the broadcaster's
 * internal client set with a single fake authenticated client.
 *
 * Covered: task.started, task.completed, tool.call, impulse.resolved
 * (execution-traces.ts); execution_started, execution_completed,
 * template_updated, variant_created, template_retired, feedback_recorded
 * (activities.ts); ci_result (ci.ts).
 */

import { describe, expect, test } from 'bun:test';
import { broadcaster } from './broadcaster';
import type { WebSocketMessage } from './types';

interface FakeWS {
  data: { authenticated: boolean };
  send: (payload: string) => void;
  sent: string[];
}

function makeFakeClient(): FakeWS {
  const sent: string[] = [];
  return {
    data: { authenticated: true },
    send(p: string) { sent.push(p); },
    sent,
  };
}

function emitAndCapture(message: WebSocketMessage): Record<string, unknown> {
  const fake = makeFakeClient();
  // Mirror the cast pattern used by broadcaster.test.ts to access internals.
  const internal = broadcaster as unknown as { clients: Set<unknown> };
  internal.clients.add(fake as unknown);
  try {
    broadcaster.emit(message);
    expect(fake.sent.length).toBeGreaterThan(0);
    return JSON.parse(fake.sent[fake.sent.length - 1]!).data as Record<string, unknown>;
  } finally {
    internal.clients.delete(fake as unknown);
  }
}

const ORG = 'orgs:acme';
const ACCT = 'accounts:acme-prod';

// Each entry is a representative payload for one event type. The `data`
// field on every emit MUST carry org_id + account_id.
const fixtures: Array<{ name: string; msg: WebSocketMessage }> = [
  {
    name: 'task.started',
    msg: {
      type: 'task.started',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'e1', task_id: 't0', task_index: 0,
        description: 'demo', started_at: new Date().toISOString(),
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'task.completed',
    msg: {
      type: 'task.completed',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'e2', task_id: 't0', task_index: 0,
        success: true, duration_ms: 100,
        completed_at: new Date().toISOString(),
        input_impulse_ids: ['i1'], output_impulse_ids: ['o1'],
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'tool.call',
    msg: {
      type: 'tool.call',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'e3', task_id: 't0', tool_name: 'bash',
        resolver_tier: 'deterministic', latency_ms: 5, cost_usd: 0,
        timestamp: new Date().toISOString(),
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'impulse.resolved',
    msg: {
      type: 'impulse.resolved',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'e4', impulse_id: 'imp-0', resolver_id: 'bash',
        resolver_tier: 'deterministic', vessel_id: 'minibob',
        latency_ms: 5, cost_usd: 0,
        timestamp: new Date().toISOString(),
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'execution_started',
    msg: {
      type: 'execution_started',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'e5', activity_id: 'activity:foo',
        variant_id: 'activity:foo', org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'execution_completed',
    msg: {
      type: 'execution_completed',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'e6', activity_id: 'activity:foo',
        variant_id: 'activity:foo', success: true,
        duration_ms: 200, cost: 0.01,
        completed_at: new Date().toISOString(),
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'template_updated',
    msg: {
      type: 'template_updated',
      timestamp: new Date().toISOString(),
      data: {
        activity_id: 'activity:foo', variant_id: 'activity:foo',
        metrics: {
          success_rate: 0.5, avg_duration_ms: 100, avg_cost_usd: 0.01,
          thompson_alpha: 1, thompson_beta: 1,
        },
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'variant_created',
    msg: {
      type: 'variant_created',
      timestamp: new Date().toISOString(),
      data: {
        parent_activity_id: 'activity:foo', variant_id: 'activity:foo-v2',
        variant_generation: 2, reason: 'failures', modifications: [],
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'template_retired',
    msg: {
      type: 'template_retired',
      timestamp: new Date().toISOString(),
      data: {
        activity_id: 'activity:foo', reason: 'poor_performance',
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'feedback_recorded',
    msg: {
      type: 'feedback_recorded',
      timestamp: new Date().toISOString(),
      data: {
        activity_id: 'activity:foo', direction: 'positive', intensity: 1,
        multiplier: 2, affected_activities: ['activity:foo'],
        org_id: ORG, account_id: ACCT,
      },
    } as WebSocketMessage,
  },
  {
    name: 'ci_result (auth-less webhook → both null)',
    msg: {
      type: 'ci_result',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'e-ci', template_id: 'activity:foo', success: true,
        branch: 'dev', commit: 'abc', duration_ms: 1000,
        ci_provider: 'github_actions',
        timestamp: new Date().toISOString(),
        org_id: null, account_id: null,
      },
    } as WebSocketMessage,
  },
];

describe('Phase G1: every broadcast event carries account_id + org_id', () => {
  for (const { name, msg } of fixtures) {
    test(name, () => {
      const data = emitAndCapture(msg);
      // Both keys MUST be present — even when value is null. Consumers
      // distinguish "field absent" (older event) from "field null" (no
      // auth context) by key presence.
      expect('org_id' in data).toBe(true);
      expect('account_id' in data).toBe(true);
      const expected = (msg.data as Record<string, unknown>);
      expect(data.org_id).toBe(expected.org_id as never);
      expect(data.account_id).toBe(expected.account_id as never);
    });
  }

  test('task.started preserves all original fields alongside tenancy', () => {
    const data = emitAndCapture(fixtures[0]!.msg);
    expect(data.execution_id).toBe('e1');
    expect(data.task_id).toBe('t0');
    expect(data.org_id).toBe(ORG);
    expect(data.account_id).toBe(ACCT);
  });

  test('task.completed preserves per-task impulse arrays alongside tenancy', () => {
    const data = emitAndCapture(fixtures[1]!.msg);
    expect(data.input_impulse_ids).toEqual(['i1']);
    expect(data.output_impulse_ids).toEqual(['o1']);
    expect(data.account_id).toBe(ACCT);
  });

  test('account_id null is a valid value (no auth context)', () => {
    const data = emitAndCapture({
      type: 'task.started',
      timestamp: new Date().toISOString(),
      data: {
        execution_id: 'null-test', task_id: 't0', task_index: 0,
        description: '', started_at: new Date().toISOString(),
        org_id: ORG, account_id: null,
      },
    } as WebSocketMessage);
    expect(data.org_id).toBe(ORG);
    expect(data.account_id).toBeNull();
  });
});
