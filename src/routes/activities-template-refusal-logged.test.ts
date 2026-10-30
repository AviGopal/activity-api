/**
 * A template write refused by a POST /v2/activities/templates guard must say WHY in the journal.
 *
 * Measured on a ribosome-extracted composition: activityTemplate_write answered `400 1ms` and the
 * journal held nothing else. No insert line, no reason, no error. The guards that reject a
 * malformed composition (an activity id used as an output shape, an input shape the composition
 * produces itself, a missing id or name) returned their reason in the response body only. Their
 * caller recorded the write task as a success, so the refused mint was invisible from both ends.
 *
 * Must-fail: each guard's refusal emits a `POST /v2/activities/templates refused` warn naming the
 * guard. Control: an accepted template emits no refusal line.
 */

import { describe, test, expect, mock, spyOn, afterAll } from 'bun:test';
import { Hono } from 'hono';

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async () => [],
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

// Same Redis stub as activities-template-id-normalize.test.ts: `redis` is exported too, because a
// mock.module replacement outlives this file and an omitted real export breaks later importers.
mock.module('../db/redis', () => ({
  get redis() { return this.RedisClient.getInstance(); },
  RedisClient: {
    getInstance: () => ({
      del: async () => 0,
      get: async () => null,
      set: async () => 'OK',
      sadd: async () => 0,
      smembers: async () => [],
      withLock: async (_lockKey: unknown, _cacheKey: unknown, fn: () => Promise<unknown>) => fn(),
    }),
  },
}));

const { logger } = await import('../utils/logger');
const activitiesRouter = (await import('./activities')).default;

const app = new Hono();
app.route('/v2/activities', activitiesRouter);

const warnSpy = spyOn(logger, 'warn');
afterAll(() => warnSpy.mockRestore());

const base = {
  id: 'refusal-log-fixture',
  name: 'Refusal Log Fixture',
  description: 'template refusal logging fixture',
  category: 'tool',
  scope: 'global' as const,
  public: false,
};

async function post(body: Record<string, unknown>): Promise<Response> {
  warnSpy.mockClear();
  return await app.request('/v2/activities/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function refusals(): Array<Record<string, unknown>> {
  return warnSpy.mock.calls
    .filter((c) => c[0] === 'POST /v2/activities/templates refused')
    .map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

describe('POST /v2/activities/templates: a guard refusal is logged with its reason', () => {
  test('an input shape the composition produces itself is refused AND logged', async () => {
    const res = await post({
      ...base,
      input_shapes: ['shellResult'],
      tasks: [
        { id: 't1', description: 'one', resolver: 'bash', inputShapes: [], outputShapes: ['shellResult'] },
        { id: 't2', description: 'two', resolver: 'memoryNote_write', inputShapes: ['shellResult'], outputShapes: ['memoryNote_write'] },
      ],
    });
    expect(res.status).toBe(400);
    const r = refusals();
    expect(r.length).toBe(1);
    expect(r[0]!['reason']).toBe('self_satisfied_input_shapes');
    expect(r[0]!['activity_id']).toBe('refusal-log-fixture');
    expect(r[0]!['self_satisfied']).toEqual(['shellResult']);
  });

  test('an activity id used as an output shape is refused AND logged', async () => {
    const res = await post({
      ...base,
      tasks: [
        { id: 't1', description: 'one', resolver: 'bash', outputShapes: ['activity:some-composition'] },
      ],
    });
    expect(res.status).toBe(400);
    const r = refusals();
    expect(r.length).toBe(1);
    expect(r[0]!['reason']).toBe('activity_id_as_output_shape');
    expect(r[0]!['offending']).toEqual(['activity:some-composition']);
  });

  test('a missing name is refused AND logged', async () => {
    const { name: _omit, ...noName } = base;
    const res = await post({ ...noName, tasks: [{ id: 't1', description: 'one', resolver: 'bash', outputShapes: ['shellResult'] }] });
    expect(res.status).toBe(400);
    const r = refusals();
    expect(r.length).toBe(1);
    expect(r[0]!['reason']).toBe('missing_name');
  });

  test('CONTROL: an accepted template logs no refusal', async () => {
    const res = await post({
      ...base,
      tasks: [
        { id: 't1', description: 'one', resolver: 'bash', inputShapes: [], outputShapes: ['shellResult'] },
      ],
      output_shapes: ['shellResult'],
    });
    expect(res.status).toBeLessThan(400);
    expect(refusals().length).toBe(0);
  });
});
