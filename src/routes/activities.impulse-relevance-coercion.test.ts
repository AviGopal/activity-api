/**
 * Legacy-field coercion: POST /v2/activities/impulse-relevance accepts both
 * `activity_id` (legacy, used by minibob mcp.ts:2469) and the canonical
 * `activity_variant_id`. The schema continues to require
 * `activity_variant_id`; the handler maps the legacy field at the entry
 * point and emits a deprecation warn-log so we can observe when callers
 * have all migrated and the coercion can be removed.
 *
 * Mocks `surrealDB.query` so the handler exercises validation + coercion
 * without touching the DB.
 */

import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { Hono } from 'hono';
import activitiesRouter from './activities';
import { surrealDB } from '../db/surreal';
import { logger } from '../utils/logger';

const app = new Hono();
app.route('/v2/activities', activitiesRouter);

const basePayload = {
  impulse_id: 'imp_test_1',
  was_loaded: true,
  execution_succeeded: true,
};

describe('POST /v2/activities/impulse-relevance — activity_id coercion', () => {
  let queryMock: ReturnType<typeof spyOn> | null = null;
  let warnMock: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    if (queryMock) { queryMock.mockRestore(); queryMock = null; }
    if (warnMock) { warnMock.mockRestore(); warnMock = null; }
  });

  test('canonical activity_variant_id only: accepted, no coercion warn log', async () => {
    queryMock = spyOn(surrealDB, 'query').mockResolvedValue([] as any);
    warnMock = spyOn(logger, 'warn');

    const response = await app.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basePayload, activity_variant_id: 'act_variant_canonical' }),
    });

    expect(response.status).toBe(200);
    const coercionWarns = (warnMock.mock.calls as unknown[][]).filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('Coercion applied'),
    );
    expect(coercionWarns.length).toBe(0);
  });

  test('legacy activity_id only: accepted, coercion warn log emitted', async () => {
    queryMock = spyOn(surrealDB, 'query').mockResolvedValue([] as any);
    warnMock = spyOn(logger, 'warn');

    const response = await app.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basePayload, activity_id: 'act_legacy_id' }),
    });

    expect(response.status).toBe(200);
    const coercionWarns = (warnMock.mock.calls as unknown[][]).filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('Coercion applied'),
    );
    expect(coercionWarns.length).toBe(1);
    // The mapped value must reach the DB call.
    const queryCalls = queryMock.mock.calls as unknown[][];
    const checkCall = queryCalls.find(
      (c) => typeof c[1] === 'object' && c[1] !== null && 'activity_variant_id' in (c[1] as Record<string, unknown>),
    );
    expect(checkCall).toBeDefined();
    expect((checkCall![1] as Record<string, unknown>).activity_variant_id).toBe('act_legacy_id');
  });

  test('both fields: explicit activity_variant_id wins, no coercion log', async () => {
    queryMock = spyOn(surrealDB, 'query').mockResolvedValue([] as any);
    warnMock = spyOn(logger, 'warn');

    const response = await app.request('/v2/activities/impulse-relevance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...basePayload,
        activity_id: 'act_legacy_should_be_ignored',
        activity_variant_id: 'act_variant_explicit',
      }),
    });

    expect(response.status).toBe(200);
    const coercionWarns = (warnMock.mock.calls as unknown[][]).filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('Coercion applied'),
    );
    expect(coercionWarns.length).toBe(0);
    const queryCalls = queryMock.mock.calls as unknown[][];
    const checkCall = queryCalls.find(
      (c) => typeof c[1] === 'object' && c[1] !== null && 'activity_variant_id' in (c[1] as Record<string, unknown>),
    );
    expect(checkCall).toBeDefined();
    expect((checkCall![1] as Record<string, unknown>).activity_variant_id).toBe('act_variant_explicit');
  });
});
