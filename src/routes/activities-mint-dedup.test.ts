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
// Rows the exact-id existence check (`SELECT * FROM activity WHERE id = $id`) returns.
let existingById: Record<string, any[]> = {};

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: unknown) => {
      surrealQueries.push({ sql, params });
      if (sql.includes('meta::id(id) AS id_str')) return dedupCandidates;
      if (/SELECT \* FROM activity\s+WHERE id = \$id/.test(sql)) return existingById[(params as any)?.id] ?? [];
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
const activitiesModule = await import('./activities');
const activitiesRouter = activitiesModule.default;

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

function reset(candidates: any[] = [], byId: Record<string, any[]> = {}): void {
  surrealQueries.length = 0;
  dedupCandidates = candidates;
  existingById = byId;
}

function upsertIds(): string[] {
  return surrealQueries
    .map((c) => c.sql.match(/UPSERT\s+(?:activity|variant_performance_metrics):`([^`]+)`/)?.[1])
    .filter((x): x is string => !!x);
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
    // Same-body re-mint: the existing row carries the SAME task list as the incoming
    // mint (until the dedup SELECT projected `tasks`, no fixture needed a body).
    reset([
      {
        id_str: 'pulsevitals2-composed-aggregator-author',
        name: 'pulsevitals2-composed-aggregator-author',
        input_shapes: [],
        output_shapes: ['tool_output'],
        tasks: baseTemplate.tasks,
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

// THE 04:37:23Z FOLD. template-mitosis minted a variant of the seed
// development-vessel:own-check-baseline that ADDED a task. Same normalized name, same
// shape signature, so the dedup UPSERTed the variant's body over the seed. A different
// executable body is novel: it must land as a sibling under its own id.
describe('POST /v2/activities/templates — mint dedup folds only a NOT-NOVEL body', () => {
  // The metrics row's record id is the activity id slugged (variantMetricsRecordId).
  const slug = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const SEED_ID = 'development-vessel:own-check-baseline';
  const VARIANT_ID = 'development-vessel:own-check-baseline:1697520000-1793507842687';
  const classify = {
    id: 'classify',
    description: 'classify the own-check baseline',
    resolver: 'own_check_baseline_classify',
    inputShapes: ['goal'],
    outputShapes: ['ownCheckBaseline'],
  };
  const validate = {
    id: 'validate',
    description: 'validate the classification',
    resolver: 'own_check_baseline_validate',
    inputShapes: ['ownCheckBaseline'],
    outputShapes: ['ownCheckBaseline'],
  };
  const seedRow = (tasks: unknown[]) => ({
    id_str: SEED_ID,
    name: 'own-check-baseline',
    input_shapes: ['goal'],
    output_shapes: ['ownCheckBaseline'],
    tasks,
  });
  const mint = (tasks: unknown[], over: Record<string, unknown> = {}) => post({
    description: 'own-check baseline',
    category: 'tool',
    scope: 'global',
    public: false,
    id: VARIANT_ID,
    name: 'own-check-baseline',
    input_shapes: ['goal'],
    output_shapes: ['ownCheckBaseline'],
    tasks,
    ...over,
  });

  test('MUST-FAIL — a variant that adds a task inserts as a SIBLING; the seed row is untouched', async () => {
    reset([seedRow([classify])]);
    const response = await mint([classify, validate]);

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe(VARIANT_ID);
    // its own metrics row → a fresh posterior, not the seed's
    expect(findMetricsUpsertId()).toBe(slug(VARIANT_ID));
    expect(upsertIds()).not.toContain(SEED_ID);
    expect(upsertIds()).not.toContain(slug(SEED_ID));
  });

  test('two bodies differing ONLY in prompt text are different → sibling', async () => {
    const p = (template: string) => ({ ...classify, prompt: { template } });
    reset([seedRow([p('classify the baseline')])]);
    const response = await mint([p('classify the baseline and explain why')]);

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe(VARIANT_ID);
    expect(upsertIds()).not.toContain(SEED_ID);
    expect(upsertIds()).not.toContain(slug(SEED_ID));
  });

  test('CONTROL — a description-only / task-id-only difference is the same body → folds', async () => {
    reset([seedRow([{ ...classify, prompt: { template: 'classify the baseline' } }])]);
    const response = await mint([{ ...classify, id: 'renamed', description: 'reworded', prompt: { template: '  classify the baseline \n' } }]);

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe(SEED_ID);
    expect(findMetricsUpsertId()).toBe(slug(SEED_ID));
  });

  test('CONTROL — a same-body re-mint onto a timestamp-suffixed existing row still folds', async () => {
    const OLDER = 'development-vessel:own-check-baseline:1697520000-1793500000000';
    reset([{ ...seedRow([classify, validate]), id_str: OLDER, name: 'own-check-baseline' }]);
    const response = await mint([classify, validate]);

    expect(response.status).toBeLessThan(400);
    expect(findActivityUpsertId()).toBe(OLDER);
    expect(findMetricsUpsertId()).toBe(slug(OLDER));
  });

  test('CONTROL — a re-seed of an existing id is refused 409 and writes nothing', async () => {
    reset([], { [SEED_ID]: [{ id: `activity:${SEED_ID}`, name: 'own-check-baseline' }] });
    const response = await post({
      description: 'own-check baseline',
      category: 'tool',
      scope: 'global',
      public: false,
      id: SEED_ID,
      name: 'own-check-baseline',
      input_shapes: ['goal'],
      output_shapes: ['ownCheckBaseline'],
      tasks: [classify],
    });

    expect(response.status).toBe(409);
    expect(upsertIds()).toEqual([]);
  });

  test('the dedup candidate SELECT projects `tasks`, so a candidate body is comparable', async () => {
    reset([]);
    await mint([classify]);
    const sel = surrealQueries.find((c) => c.sql.includes('meta::id(id) AS id_str'));
    expect(sel).toBeDefined();
    expect(sel!.sql).toMatch(/meta::id\(id\) AS id_str,[^\n]*\btasks\b[^\n]*FROM activity/);
  });

  test('taskBodySignature: ordered, executable fields only', () => {
    const sig = (activitiesModule as any).taskBodySignature as (t: unknown) => string;
    expect(typeof sig).toBe('function');
    expect(sig([classify, validate])).not.toBe(sig([validate, classify]));
    expect(sig([{ ...classify, description: 'x', id: 'y' }])).toBe(sig([classify]));
    expect(sig([{ ...classify, inputShapes: ['b', 'a'] }])).toBe(sig([{ ...classify, inputShapes: ['a', 'b'] }]));
    expect(sig([{ ...classify, resolver: 'other' }])).not.toBe(sig([classify]));
    expect(sig(undefined)).toBe(sig([]));
  });
});
