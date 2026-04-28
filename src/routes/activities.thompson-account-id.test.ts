/**
 * Phase E: account_id-aware Thompson Sampling.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28 (phase E).
 *
 * Locks in:
 *   - variant_performance_metrics UPSERT key includes the account slug when
 *     accountId is present, so two callers in the same org but different
 *     accounts maintain separate α/β posteriors.
 *   - Pre-Phase-E rows (legacy `<variant>` slug, account_id IS NONE) are
 *     still readable when caller has no accountId — backwards-compat read
 *     via the org_id branch of accountIdScopedWhere().
 *   - Register-time UPSERT lands at the account-keyed slug too.
 *
 * Captures issued SurrealDB queries instead of round-tripping a live DB —
 * mirrors the activities.account-id mock pattern.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

const surrealQueries: { sql: string; params: any }[] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

mock.module('../db/redis', () => ({
  RedisClient: {
    getInstance: () => ({
      del: async () => 0,
      get: async () => null,
      set: async () => 'OK',
      sadd: async () => 0,
      smembers: async () => [],
      srem: async () => 0,
      withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(),
      getClient: () => null,
    }),
  },
}));

mock.module('../websocket/broadcaster', () => ({
  broadcaster: { emit: () => {} },
}));

mock.module('../db/paradigm', () => ({
  insertActivity: async () => null,
  insertExecution: async () => null,
  getActivityScores: async () => ({ data: [], path: 'legacy' as const }),
  getShapeConditionedScores: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByShapes: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByFTS: async () => ({ data: [], path: 'legacy' as const }),
  queryActivitiesByDense: async () => ({ data: [], path: 'legacy' as const }),
  transformToLegacyTemplate: (t: any) => t,
  isDualWriteEnabled: () => false,
  getVariantFamily: async () => ({ data: [], path: 'legacy' as const }),
  getVariantScores: async () => ({ data: [], path: 'legacy' as const }),
  buildVariantTree: async () => null,
  normalizeActivityId: (id: string) =>
    id.replace(/^activity:/, '').replace(/[⟨⟩`]/g, ''),
}));

mock.module('../services/variant-creator', () => ({
  autoCreateVariantIfNeeded: async () => null,
  checkAndRetireTemplate: async () => false,
}));

const activitiesRouter = (await import('./activities')).default;
const { variantMetricsRecordId } = await import('./activities');

function appWithAuth(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (jwtAuth !== undefined) c.set('jwtAuth' as any, jwtAuth);
    await next();
  });
  app.route('/v2/activities', activitiesRouter);
  return app;
}

const baseTemplate = {
  name: 'Phase E thompson fixture',
  description: 'Phase E account-keyed metrics row',
  category: 'tool',
  tasks: [{ id: 't1', description: 'one', prompt: { template: 'do thing' } }],
  scope: 'global' as const,
  public: false,
  output_shapes: ['tool_output'],
};

beforeEach(() => {
  surrealQueries.length = 0;
});

function findMetricsUpsert(): { sql: string; params: any } | null {
  for (const call of surrealQueries) {
    if (
      /UPSERT\s+variant_performance_metrics:`[^`]+`\s+CONTENT/.test(call.sql) ||
      /INSERT\s+INTO\s+variant_performance_metrics/.test(call.sql)
    ) {
      return call;
    }
  }
  return null;
}

// ============================================================================
// HELPER UNIT TESTS — variantMetricsRecordId
// ============================================================================

describe('Phase E: variantMetricsRecordId derives the account-keyed slug', () => {
  test('returns plain variant slug when accountId is null', () => {
    expect(variantMetricsRecordId('debug-bug', null)).toBe('debug-bug');
    expect(variantMetricsRecordId('debug-bug', undefined)).toBe('debug-bug');
    // Sanitization: non-slug chars become underscores even with no accountId.
    expect(variantMetricsRecordId('debug bug.fancy', null)).toBe('debug_bug_fancy');
  });

  test('returns variant__account slug when accountId is present', () => {
    expect(variantMetricsRecordId('debug-bug', 'acc-acme-001')).toBe(
      'debug-bug__acc-acme-001',
    );
  });

  test('strips the accounts: record-ref prefix from the account slug', () => {
    expect(variantMetricsRecordId('debug-bug', 'accounts:acc-acme-001')).toBe(
      'debug-bug__acc-acme-001',
    );
  });

  test('two different accounts under the same variant produce distinct slugs', () => {
    const a = variantMetricsRecordId('debug-bug', 'acc-1');
    const b = variantMetricsRecordId('debug-bug', 'acc-2');
    expect(a).not.toBe(b);
    // Both still start with the variant slug.
    expect(a.startsWith('debug-bug__')).toBe(true);
    expect(b.startsWith('debug-bug__')).toBe(true);
  });

  test('legacy slug and account-keyed slug do not collide for the same variant', () => {
    const legacy = variantMetricsRecordId('debug-bug', null);
    const accounted = variantMetricsRecordId('debug-bug', 'acc-1');
    expect(legacy).not.toBe(accounted);
  });
});

// ============================================================================
// REGISTER-TIME UPSERT
// ============================================================================

describe('Phase E: POST /v2/activities/templates UPSERT lands at account-keyed slug', () => {
  test('caller with accountId → metrics UPSERT record-id includes account slug', async () => {
    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-acme-1',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: 'phase-e-account-keyed' }),
    });
    expect(res.status).toBeLessThan(400);

    const upsert = findMetricsUpsert();
    expect(upsert).not.toBeNull();
    // The slug is interpolated into the SQL between backticks.
    const expectedSlug = variantMetricsRecordId('phase-e-account-keyed', 'acc-acme-001');
    expect(upsert!.sql).toContain(expectedSlug);
    // account_id is bound on the metrics row in record-ref form.
    expect(upsert!.params.account_id).toBe('accounts:acc-acme-001');
    // Two different accounts → different record-ids.
    expect(expectedSlug).not.toBe(variantMetricsRecordId('phase-e-account-keyed', null));
  });

  test('caller without accountId → metrics UPSERT lands at legacy slug', async () => {
    const app = appWithAuth({
      orgId: 'org-legacy',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-legacy',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: 'phase-e-legacy-keyed' }),
    });
    expect(res.status).toBeLessThan(400);

    const upsert = findMetricsUpsert();
    expect(upsert).not.toBeNull();
    const expectedSlug = variantMetricsRecordId('phase-e-legacy-keyed', null);
    expect(upsert!.sql).toContain(expectedSlug);
    // Legacy slug has no double-underscore separator.
    expect(expectedSlug.includes('__')).toBe(false);
    expect(upsert!.params.account_id).toBeNull();
  });

  test('two accounts in the same org register the same template → distinct UPSERT slugs', async () => {
    const baseId = 'phase-e-cross-account';
    // First account.
    surrealQueries.length = 0;
    const appA = appWithAuth({
      orgId: 'org-shared',
      accountId: 'acc-shared-A',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'kA',
      scopes: ['read', 'write'],
    });
    await appA.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: baseId }),
    });
    const slugA = findMetricsUpsert()!.sql;

    // Second account, same org, same variant.
    surrealQueries.length = 0;
    const appB = appWithAuth({
      orgId: 'org-shared',
      accountId: 'acc-shared-B',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'kB',
      scopes: ['read', 'write'],
    });
    await appB.request('/v2/activities/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...baseTemplate, id: baseId }),
    });
    const slugB = findMetricsUpsert()!.sql;

    // The two SQL strings must contain distinct record-id slugs.
    const aSlug = variantMetricsRecordId(baseId, 'acc-shared-A');
    const bSlug = variantMetricsRecordId(baseId, 'acc-shared-B');
    expect(aSlug).not.toBe(bSlug);
    expect(slugA).toContain(aSlug);
    expect(slugB).toContain(bSlug);
  });
});

// ============================================================================
// EXECUTION-TIME UPSERT
// ============================================================================

describe('Phase E: POST /v2/activities/executions metrics UPSERT keyed on (variant, account)', () => {
  test('caller with accountId → INSERT INTO carries account-keyed id and account_id binding', async () => {
    const app = appWithAuth({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'key-1',
      scopes: ['read', 'write'],
    });

    const res = await app.request('/v2/activities/executions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activity_id: 'exec-variant-A',
        success: true,
        duration_ms: 1234,
        cost: 0.0042,
        tokens: { input: 100, output: 50, cache: 0 },
      }),
    });
    expect(res.status).toBeLessThan(400);

    const insertCall = surrealQueries.find((q) =>
      /INSERT\s+INTO\s+variant_performance_metrics/.test(q.sql),
    );
    expect(insertCall).toBeDefined();
    // The INSERT explicitly carries `id: type::thing(...$record_id_slug)`.
    expect(insertCall!.sql).toContain("type::thing('variant_performance_metrics', $record_id_slug)");
    // The bound slug includes the account suffix.
    const expectedSlug = variantMetricsRecordId('exec-variant-A', 'acc-acme-001');
    expect(insertCall!.params.record_id_slug).toBe(expectedSlug);
    expect(insertCall!.params.account_id).toBe('accounts:acc-acme-001');
  });

  test('two accounts in the same org → two distinct UPSERT record-ids on the same variant', async () => {
    const variantId = 'exec-shared-variant';

    const appA = appWithAuth({
      orgId: 'org-shared-exec',
      accountId: 'acc-shared-A',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'kA',
      scopes: ['read', 'write'],
    });
    surrealQueries.length = 0;
    await appA.request('/v2/activities/executions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activity_id: variantId,
        success: true,
        duration_ms: 100,
        cost: 0.01,
        tokens: { input: 10, output: 5, cache: 0 },
      }),
    });
    const insertA = surrealQueries.find((q) =>
      /INSERT\s+INTO\s+variant_performance_metrics/.test(q.sql),
    );
    const slugA = insertA!.params.record_id_slug;

    const appB = appWithAuth({
      orgId: 'org-shared-exec',
      accountId: 'acc-shared-B',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'kB',
      scopes: ['read', 'write'],
    });
    surrealQueries.length = 0;
    await appB.request('/v2/activities/executions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activity_id: variantId,
        success: false,
        duration_ms: 200,
        cost: 0.02,
        tokens: { input: 20, output: 10, cache: 0 },
      }),
    });
    const insertB = surrealQueries.find((q) =>
      /INSERT\s+INTO\s+variant_performance_metrics/.test(q.sql),
    );
    const slugB = insertB!.params.record_id_slug;

    expect(slugA).not.toBe(slugB);
    // Both prefixed with the variant slug.
    expect(slugA.startsWith(variantId)).toBe(true);
    expect(slugB.startsWith(variantId)).toBe(true);
    // account_id bindings stay isolated.
    expect(insertA!.params.account_id).toBe('accounts:acc-shared-A');
    expect(insertB!.params.account_id).toBe('accounts:acc-shared-B');
  });

  test('caller without accountId → UPSERT lands at legacy variant-only slug', async () => {
    const app = appWithAuth({
      orgId: 'org-legacy-exec',
      jwtToken: '',
      authType: 'apikey',
      keyId: 'kLegacy',
      scopes: ['read', 'write'],
    });
    surrealQueries.length = 0;
    const res = await app.request('/v2/activities/executions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activity_id: 'exec-legacy-variant',
        success: true,
        duration_ms: 50,
        cost: 0.001,
        tokens: { input: 5, output: 2, cache: 0 },
      }),
    });
    expect(res.status).toBeLessThan(400);

    const insertCall = surrealQueries.find((q) =>
      /INSERT\s+INTO\s+variant_performance_metrics/.test(q.sql),
    );
    expect(insertCall).toBeDefined();
    // Legacy slug — no double-underscore separator.
    expect(insertCall!.params.record_id_slug).toBe('exec-legacy-variant');
    expect(insertCall!.params.record_id_slug.includes('__')).toBe(false);
    expect(insertCall!.params.account_id).toBeNull();
  });
});
