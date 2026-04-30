/**
 * Phase 10 P1 regression: α/β increments are atomic in the SQL we issue.
 *
 * The earlier code paths read alpha/beta into JS, computed a new value,
 * then wrote it back — a classic lost-update race when two posterior
 * writes for the same row land concurrently. This test captures the SQL
 * statements produced by the route handlers and asserts:
 *
 *   - relevance-feedback emits a single bulk UPDATE per direction with
 *     the multiplier applied via SurrealDB's `math::ceil((alpha ?? 1) *
 *     $multiplier)` server-side expression. No SELECT-then-UPDATE loop
 *     remains, so concurrent writes accumulate cleanly.
 *
 *   - goal-paths execution-record produces one UPDATE whose SET clauses
 *     all reference the row's pre-update state via `(field ?? 0) + $delta`
 *     and rolling-mean expressions of the form
 *     `((mean ?? 0) * (total ?? 0) + $new) / ((total ?? 0) + 1)`. Counter,
 *     posterior, and average all land in the same statement, so the
 *     second concurrent UPDATE sees the first's increments rather than
 *     the original snapshot.
 *
 * The test does not round-trip a live DB. SurrealDB's atomic-row-update
 * semantics are documented; what we need to lock in is that the JS code
 * is not reintroducing a fetch-modify-write — that's a static property
 * of the issued SQL.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { Hono } from 'hono';

const surrealQueries: { sql: string; params: any }[] = [];

mock.module('../../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      // For the SELECT before UPDATE in the goal-paths route, return one
      // row so we exercise the update branch (not the create branch).
      if (/SELECT \* FROM goal_execution_paths/i.test(sql)) {
        return [
          {
            id: 'goal_execution_paths:abc',
            goal_hash: 'h1',
            path_signature: 'p1',
            total_executions: 5,
            successful_executions: 3,
            failed_executions: 2,
            thompson_alpha: 4,
            thompson_beta: 3,
            avg_duration_ms: 120,
            avg_cost_usd: 0.02,
            avg_token_usage: 1500,
          },
        ];
      }
      // For the relevance-feedback SELECT before update, return existing
      // shape-scored rows so the UPDATE path runs (not the init path).
      if (/SELECT \* FROM impulse_shape_activity_score/i.test(sql)) {
        return [
          { shape: 'goal', activity_id: 'a1', alpha: 2, beta: 1 },
          { shape: 'trace', activity_id: 'a1', alpha: 3, beta: 1 },
          { shape: 'memo', activity_id: 'a1', alpha: 1, beta: 5 },
        ];
      }
      // /feedback first verifies the activity exists; return a row so the
      // route reaches the bulk-multiply UPDATE branch we care about.
      if (/SELECT id, input_shapes FROM activity/i.test(sql)) {
        return [{ id: 'activity:a1', input_shapes: ['goal', 'trace', 'memo'] }];
      }
      // Default: empty
      return [];
    },
  },
  queryWithAuth: async () => [],
  createAuthenticatedClient: async () => ({}),
}));

mock.module('../../db/redis', () => ({
  RedisClient: {
    getInstance: () => ({
      del: async () => 0,
      get: async () => null,
      set: async () => 'OK',
      keys: async () => [],
      sadd: async () => 0,
      smembers: async () => [],
      srem: async () => 0,
      withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(),
      getClient: () => null,
    }),
  },
}));

mock.module('../../websocket/broadcaster', () => ({
  broadcaster: { emit: () => {} },
}));

mock.module('../../db/paradigm', () => ({
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

mock.module('../../services/variant-creator', () => ({
  autoCreateVariantIfNeeded: async () => null,
  checkAndRetireTemplate: async () => false,
}));

const activitiesRouter = (await import('../activities')).default;
const goalPathsRouter = (await import('../goal-paths')).default;

function appWithAuth(jwtAuth: unknown): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (jwtAuth !== undefined) c.set('jwtAuth' as any, jwtAuth);
    await next();
  });
  app.route('/v2/activities', activitiesRouter);
  app.route('/v2/goal-paths', goalPathsRouter);
  return app;
}

const jwt = {
  orgId: 'org-test',
  accountId: 'account-test',
  userId: 'user-test',
  scopes: ['write'],
  jwtToken: 'fake-jwt',
  authMethod: 'jwt' as const,
};

beforeEach(() => {
  surrealQueries.length = 0;
});

describe('Phase 10 P1 — atomic α/β increments', () => {
  test('relevance-feedback positive emits one bulk UPDATE with math::ceil server-side multiply', async () => {
    const app = appWithAuth(jwt);
    const res = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        activity_id: 'a1',
        direction: 'positive',
        intensity: 1,
      }),
    });
    expect(res.status).toBe(200);

    const updates = surrealQueries.filter((q) =>
      /UPDATE impulse_shape_activity_score/i.test(q.sql),
    );
    // Exactly one bulk UPDATE — not one-per-shape from the loop pattern.
    expect(updates.length).toBe(1);
    const sql = updates[0].sql;
    // Server-side math::ceil multiply expression on alpha.
    expect(sql).toContain('alpha = math::ceil((alpha ?? 1) * $multiplier)');
    // No JS-projected $new_alpha parameter.
    expect(sql).not.toContain('$new_alpha');
    // WHERE filters on activity_id only — applies to all shapes for the
    // activity in a single statement.
    expect(sql).toContain('AND activity_id = $activity_id');
    expect(sql).not.toContain('AND shape = $shape');
  });

  test('relevance-feedback negative emits one bulk UPDATE on beta', async () => {
    const app = appWithAuth(jwt);
    const res = await app.request('/v2/activities/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        activity_id: 'a1',
        direction: 'negative',
        intensity: 1,
      }),
    });
    expect(res.status).toBe(200);

    const updates = surrealQueries.filter((q) =>
      /UPDATE impulse_shape_activity_score/i.test(q.sql),
    );
    expect(updates.length).toBe(1);
    const sql = updates[0].sql;
    expect(sql).toContain('beta = math::ceil((beta ?? 1) * $multiplier)');
    expect(sql).not.toContain('$new_beta');
  });

  test('goal-paths execution record uses atomic increments and rolling means in a single UPDATE', async () => {
    const app = appWithAuth(jwt);
    const res = await app.request('/v2/goal-paths', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal_text: 'sample goal',
        goal_category: 'feature',
        path_activities: ['a1', 'a2'],
        success: true,
        duration_ms: 200,
        cost_usd: 0.05,
        token_usage: 1200,
      }),
    });
    // Tolerate any 2xx — schema strictness varies; we only care about the
    // SQL produced when the route accepts the body.
    if (res.status >= 300) {
      const body = await res.text();
      throw new Error(
        `goal-paths route refused fixture body (status ${res.status}): ${body}`,
      );
    }

    const updates = surrealQueries.filter((q) =>
      /UPDATE goal_execution_paths\b/i.test(q.sql),
    );
    expect(updates.length).toBe(1);
    const sql = updates[0].sql;

    // Counters reference pre-update row state.
    expect(sql).toContain('total_executions = (total_executions ?? 0) + 1');
    expect(sql).toContain(
      'successful_executions = (successful_executions ?? 0) + $success_delta',
    );
    expect(sql).toContain(
      'failed_executions = (failed_executions ?? 0) + $failure_delta',
    );
    // Posteriors derived from the same pre-update state.
    expect(sql).toContain(
      'thompson_alpha = (successful_executions ?? 0) + $success_delta + 1',
    );
    expect(sql).toContain(
      'thompson_beta = (failed_executions ?? 0) + $failure_delta + 1',
    );
    // Rolling means computed inline against pre-update mean and count.
    expect(sql).toContain('avg_duration_ms = (((avg_duration_ms ?? 0) * (total_executions ?? 0)) + $duration_ms) / ((total_executions ?? 0) + 1)');
    expect(sql).toContain('avg_cost_usd = (((avg_cost_usd ?? 0) * (total_executions ?? 0)) + $cost_usd) / ((total_executions ?? 0) + 1)');
    // Token-usage gated on null so a no-token caller doesn't reset the mean.
    expect(sql).toContain('IF $token_usage IS NULL');
    expect(sql).toContain('math::floor');

    // No JS-projected new-* parameters; only deltas.
    expect(updates[0].params.success_delta).toBe(1);
    expect(updates[0].params.failure_delta).toBe(0);
    expect(updates[0].params).not.toHaveProperty('total_executions');
    expect(updates[0].params).not.toHaveProperty('thompson_alpha');
  });

  test('execution-traces UPDATE on activity_template α/β stays atomic (already-atomic site)', async () => {
    // The activity_template UPDATE was already in atomic form pre-Phase-10
    // (`thompson_alpha = (thompson_alpha ?? 1) + $alpha_delta`). Lock it
    // in here so a future refactor doesn't accidentally regress to a
    // fetch-modify-write.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/routes/execution-traces.ts', 'utf8');
    expect(src).toContain('thompson_alpha = (thompson_alpha ?? 1) + $alpha_delta');
    expect(src).toContain('thompson_beta = (thompson_beta ?? 1) + $beta_delta');
  });
});
