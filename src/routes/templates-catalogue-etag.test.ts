/**
 * GET /v2/activities/templates CARRIES A CATALOGUE VERSION (ETag) AND ANSWERS 304 WITHOUT A QUERY.
 *
 * A pager that walks the whole catalogue every run (dev-vessel's reachable-unlearned report, ~30 pages of 100 per run,
 * many runs per hour from more than one node) re-read an unchanged list, and the listing route was the hub's top query
 * load. The route now answers a weak ETag naming the catalogue version of the caller's visibility key; a matching
 * If-None-Match answers 304 with no body. Every SurrealDB call is recorded here (the db client is a recorder):
 *   [MUST-FAIL] the first listing carries an ETag; a second GET with that If-None-Match on an unchanged catalogue
 *               answers 304 with an empty body and issues NO database query;
 *   [MUST-FAIL] a later page (offset 200) with the same If-None-Match answers 304: the tag covers the whole catalogue;
 *   [CONTROL]   after a template write (invalidateTemplateCache) that changes a row, the old tag gets the full body
 *               and a NEW ETag; a reload that finds the same rows keeps the same tag;
 *   [CONTROL]   tenant scope: another org presenting this org's tag gets the full body and a tag of its own;
 *   [CONTROL]   no If-None-Match, or a stale one, gets the full body; the FTS path carries no ETag.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const surrealQueries: { sql: string; params: any }[] = [];
let rows: any[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      if (/count\(\)\s+AS\s+total\s+FROM\s+activity/i.test(sql)) return [{ total: rows.length }];
      if (/FROM\s+activity\b/i.test(sql) && /ORDER BY created_at/i.test(sql)) {
        const start = Number(params?.offset) || 0;
        const lim = Number(params?.limit) || rows.length;
        return rows.slice(start, start + lim).map((r) => ({ ...r }));
      }
      return [];
    },
    getInstance: async () => ({}),
  },
  queryWithAuth: async (_t: string, sql: string, params: any) => { surrealQueries.push({ sql, params }); return []; },
  createAuthenticatedClient: async () => ({}),
  // The replacement outlives this file, so every real export stays (mock-module-completeness.test.ts).
  dbStats: { snapshot: () => ({}) },
  getDbStats: () => ({}),
}));

mock.module('../db/redis', () => ({
  // `redis` must be exported too (see activities.account-id.test.ts): the replacement outlives this file.
  get redis() { return this.RedisClient.getInstance(); },
  RedisClient: {
    getInstance: () => ({
      del: async () => 0, get: async () => null, set: async () => 'OK', sadd: async () => 0, smembers: async () => [],
      srem: async () => 0, withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(), getClient: () => null,
    }),
  },
}));

mock.module('../websocket/broadcaster', () => ({ broadcaster: { emit: () => {} } }));

mock.module('../db/paradigm', () => ({
  insertActivity: async () => null,
  insertExecution: async () => null,
  getActivityScores: async () => ({ data: [], path: 'legacy' as const }),
  getShapeConditionedScores: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByShapes: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByFTS: async () => ({ data: [{ id: 'activity:fts', name: 'fts' }], path: 'new' as const }),
  queryActivitiesByDense: async () => ({ data: [], path: 'legacy' as const }),
  transformToLegacyTemplate: (t: any) => t,
  isDualWriteEnabled: () => false,
  getVariantFamily: async () => ({ data: [], path: 'legacy' as const }),
  getVariantScores: async () => ({ data: [], path: 'legacy' as const }),
  buildVariantTree: async () => null,
  normalizeActivityId: (id: string) => id.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''),
  // The replacement outlives this file, so every real export stays (mock-module-completeness.test.ts).
  computeAdmissionLimit: (limit: number, cap = 1000) => Math.max(limit, cap),
  transformLegacyTemplate: (t: any) => t,
  computeShapeSignature: (shapes: string[]) => [...new Set(shapes)].sort(),
  queryActivitiesByEmbeddingDense: async () => ({ data: [], path: 'legacy' as const }),
  updateShapeActivityScores: async () => null,
  getActivityShapePatterns: async () => ({ data: [], path: 'legacy' as const }),
}));

mock.module('../services/variant-creator', () => ({
  autoCreateVariantIfNeeded: async () => null,
  checkAndRetireTemplate: async () => false,
  // The replacement outlives this file, so every real export stays (mock-module-completeness.test.ts).
  shouldCreateVariant: async () => false,
  createVariant: async () => null,
  checkAndRetireByPosterior: async () => false,
}));

const activitiesRouter = (await import('./activities')).default;
const { clearTemplateCatalogue, invalidateTemplateCache } = await import('../utils/template-cache');

function appFor(orgId: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('jwtAuth' as any, { authType: 'apikey', orgId, keyId: `fixture-key-${orgId}`, jwtToken: '' });
    await next();
  });
  app.route('/v2/activities', activitiesRouter);
  return app;
}

function makeRows(n: number, tag = 'v1'): any[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `activity:t${String(i).padStart(4, '0')}`,
    name: `t${i}-${tag}`,
    scope: 'global',
    execution_type: 'template',
    created_at: `2026-01-01T00:00:${String(59 - (i % 60)).padStart(2, '0')}Z`,
    output_shapes: ['x'],
  }));
}

const get = (org: string, qs: string, inm?: string) =>
  appFor(org).request(`/v2/activities/templates${qs}`, inm ? { headers: { 'If-None-Match': inm } } : undefined);

beforeEach(() => {
  clearTemplateCatalogue();
  rows = makeRows(250);
  surrealQueries.length = 0;
});

describe('GET /v2/activities/templates catalogue ETag', () => {
  test('[MUST-FAIL] an unchanged catalogue answers 304, empty body, no database query', async () => {
    const first = await get('org-a', '?limit=100&offset=0');
    expect(first.status).toBe(200);
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(((await first.json()) as any).templates.length).toBe(100);

    const before = surrealQueries.length;
    const second = await get('org-a', '?limit=100&offset=0', etag!);
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('ETag')).toBe(etag);
    expect(surrealQueries.length - before).toBe(0);
  });

  test('[MUST-FAIL] a later page with the catalogue tag answers 304 with no query', async () => {
    const first = await get('org-a', '?limit=100&offset=0');
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();
    const before = surrealQueries.length;
    const page = await get('org-a', '?limit=100&offset=200', `"other", ${etag}`);
    expect(page.status).toBe(304);
    expect(await page.text()).toBe('');
    expect(surrealQueries.length - before).toBe(0);
  });

  test('[CONTROL] a template write that changes a row returns the full body with a NEW ETag', async () => {
    const first = await get('org-a', '?limit=100&offset=0');
    const etag = first.headers.get('ETag')!;

    // a reload that finds the same rows keeps the tag
    void invalidateTemplateCache('t0000').catch(() => undefined);
    const same = await get('org-a', '?limit=100&offset=0', etag);
    expect(same.status).toBe(304);

    rows = makeRows(250, 'v2');
    void invalidateTemplateCache('t0000').catch(() => undefined);
    const before = surrealQueries.length;
    const after = await get('org-a', '?limit=100&offset=0', etag);
    expect(after.status).toBe(200);
    expect(surrealQueries.length - before).toBeGreaterThan(0);
    const body = (await after.json()) as any;
    expect(body.templates.length).toBe(100);
    expect(body.total).toBe(250);
    const next = after.headers.get('ETag');
    expect(next).toBeTruthy();
    expect(next).not.toBe(etag);
  });

  test("[CONTROL] another tenant presenting this tenant's tag gets the full body and its own tag", async () => {
    const a = await get('org-a', '?limit=100&offset=0');
    const etagA = a.headers.get('ETag')!;
    const b = await get('org-b', '?limit=100&offset=0', etagA);
    expect(b.status).toBe(200);
    expect(((await b.json()) as any).templates.length).toBe(100);
    const etagB = b.headers.get('ETag');
    expect(etagB).toBeTruthy();
    expect(etagB).not.toBe(etagA);
  });

  test('[CONTROL] no or a stale If-None-Match gets the full body; the FTS path carries no ETag', async () => {
    const plain = await get('org-a', '?limit=100&offset=100');
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as any).templates.length).toBe(100);
    const stale = await get('org-a', '?limit=100&offset=0', 'W/"tc-stale"');
    expect(stale.status).toBe(200);
    expect(((await stale.json()) as any).templates.length).toBe(100);
    const fts = await get('org-a', '?q=anything');
    expect(fts.status).toBe(200);
    expect(((await fts.json()) as any).fts).toBe(true);
    expect(fts.headers.get('ETag')).toBeNull();
  });
});
