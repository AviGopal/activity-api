/**
 * MINT DEDUP regression coverage (law 3 — a wrong mint is negative value).
 *
 * The compose loop re-mints the SAME capability hourly under
 * `-<timestamp>`-suffixed names (e.g.
 * `pulsevitals2-composed-aggregator-author-1753657200123`). Each re-mint landed
 * as a NEW `activity` row with a fresh Beta(1,1) posterior, splitting Thompson
 * selection traffic across uninformed clones (52-62% of a week's mints).
 *
 * Fix under test: POST /v2/activities/templates normalizes a trailing
 * `-<10+ digits>` suffix off the incoming name/id and, when an existing
 * template has the same normalized name AND the same consumed/produced shape
 * signature, UPSERTs onto that record (its metrics row — and therefore its
 * accumulated posterior — is preserved by the `??`-defaulted metrics UPSERT)
 * instead of inserting a fresh row.
 */

import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';

// Capture every SurrealDB query the handler issues. The dedup candidate SELECT
// (recognized by its `meta::id(id) AS id_str` projection) returns whatever the
// test placed in `dedupCandidates`; everything else returns [].
const surrealQueries: { sql: string; params: any }[] = [];
let dedupCandidates: any[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: unknown) => {
      surrealQueries.push({ sql, params });
      if (sql.includes('meta::id(id) AS id_str')) return dedupCandidates;
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

// Stub Redis so cache invalidation does not block on a missing local Redis.
const redisStub = {
  del: async () => 0,
  get: async () => null,
  set: async () => 'OK',
  sadd: async () => 0,
  smembers: async () => [],
  withLock: async (_lockKey: unknown, _cacheKey: unknown, fn: () => Promise<unknown>) => fn(),
};
mock.module('../db/redis', () => ({
  RedisClient: { getInstance: () => redisStub },
  redis: redisStub,
}));

// Loaded after the mocks so the handler picks them up.
const activitiesRouter = (await import('./activities')).default;

const app = new Hono();
app.route('/v2/activities', activitiesRouter);

const baseTemplate = {
  description: 'mint-dedup regression fixture',
  category: 'tool',
  tasks: [{ id: 't1', description: 'one', prompt: { template: 'do thing' } }],
  scope: 'global' as const,
  public: false,
  input_shapes: [] as string[],
  output_shapes: ['tool_output'],
};

function findActivityUpsertId(): string | null {
  for (const call of surrealQueries) {
    const m = call.sql.match(/UPSERT\s+activity:`([^`]+)`\s+CONTENT/);
    if (m) return m[1];
  }
  return null;
}

function findMetricsUpsertId(): string | null {
  for (const call of surrealQueries) {
    const m = call.sql.match(/UPSERT\s+variant_performance_metrics:`([^`]+)`\s+SET/);
    if (m) return m[1];
  }
  return null;
}

function reset(candidates: any[] = []): void {
  surrealQueries.length = 0;
  dedupCandidates = candidates;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  return app.request('/v2/activities/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v2/activities/templates — timestamp-suffix mint dedup', () => {
  test('timestamp-suffixed re-mint of an existing capability UPSERTs onto the existing row', async () => {
    reset([
      {
        id_str: 'pulsevitals2-composed-aggregator-author',
        name: 'pulsevitals2-composed-aggregator-author',
        input_shapes: [],
        output_shapes: ['tool_output'],
      },
    ]);
    const response = await post({
      ...baseTemplate,
      id: 'pulsevitals2-composed-aggregator-author-1753657200123',
      name: 'pulsevitals2-composed-aggregator-author-1753657200123',
    });

    expect(response.status).toBeLessThan(400);
    // The activity UPSERT and the metrics UPSERT both target the EXISTING id —
    // the metrics row keeps its accumulated Thompson posterior (?? defaults).
    expect(findActivityUpsertId()).toBe('pulsevitals2-composed-aggregator-author');
    expect(findMetricsUpsertId()).toBe('pulsevitals2-composed-aggregator-author');
  });

  test('timestamp-suffixed mint with NO existing capability inserts as new (first mint)', async () => {
    reset([]);
    const response = await post({
      ...baseTemplate,
      id: 'brand-new-capability-1753657200123',
      name: 'brand-new-capability-1753657200123',
    });

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe('brand-new-capability-1753657200123');
  });

  test('same normalized name but DIFFERENT shape signature is NOT deduped', async () => {
    reset([
      {
        id_str: 'pulsevitals2-composed-aggregator-author',
        name: 'pulsevitals2-composed-aggregator-author',
        input_shapes: ['source_code'],
        output_shapes: ['patch'],
      },
    ]);
    const response = await post({
      ...baseTemplate,
      id: 'pulsevitals2-composed-aggregator-author-1753657200123',
      name: 'pulsevitals2-composed-aggregator-author-1753657200123',
    });

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe('pulsevitals2-composed-aggregator-author-1753657200123');
  });

  test('un-suffixed names never trigger the dedup candidate query', async () => {
    reset([]);
    const response = await post({
      ...baseTemplate,
      id: 'plain-capability-name',
      name: 'plain-capability-name',
    });

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe('plain-capability-name');
    expect(surrealQueries.some((c) => c.sql.includes('meta::id(id) AS id_str'))).toBe(false);
  });
});
