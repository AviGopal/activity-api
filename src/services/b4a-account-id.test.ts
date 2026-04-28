/**
 * Phase B4a: account_id dual-write coverage for the top services.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Files in scope (3 of the 6 priority targets — see Phase B4a report):
 *   - circuit-breaker.ts   (writes circuit_breaker_trace; vessel_circuit_breaker
 *                           is NOT in migration 095 → skipped)
 *   - variant-creator.ts   (reads/writes activity + execution; both in 095)
 *   - vessel-router.ts     (reads vessel; in 095)
 *
 * Skipped — see report for rationale:
 *   - state-pattern-learner.ts: dead code; excluded from typecheck (broken
 *     `db.js` import). Already orphaned; aligns with B3 treatment of
 *     state-aware-recommendations.ts.
 *   - composition-graph.ts: queries composition_node + composition_chain;
 *     neither table is in migration 095.
 *   - health-scoring.ts: writes vessel_health_metrics; not in 095.
 *
 * Pattern (locked in by B1+B2+B3): writes set both account_id + org_id with
 * account_id_version=1 (or null + version=1 when caller has no accountId);
 * reads dual-bind both params so legacy rows (account_id IS NONE) still
 * match via the org_id branch. SurrealDB queries are captured via mock so
 * we can assert SQL text + params without round-tripping a live DB.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// =============================================================================
// SHARED MOCKS — capture every SurrealDB query the services issue
// =============================================================================

const surrealQueries: { sql: string; params: any }[] = [];
let queryReturnQueue: any[][] = [];

mock.module('../db/surreal', () => ({
  surrealDB: {
    query: async (sql: string, params: any) => {
      surrealQueries.push({ sql, params });
      return queryReturnQueue.shift() ?? [];
    },
    getInstance: async () => ({}),
  },
  queryWithAuth: async (_token: string, sql: string, params: any) => {
    surrealQueries.push({ sql, params });
    return queryReturnQueue.shift() ?? [];
  },
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
      acquireLock: async () => true,
      releaseLock: async () => true,
      withLock: async (_l: unknown, _c: unknown, fn: () => Promise<unknown>) => fn(),
      getClient: () => null,
    }),
  },
  redis: {
    acquireLock: async () => true,
    releaseLock: async () => true,
  },
}));

mock.module('../utils/logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

// Imports are deferred so the mock.module() calls above are in effect when
// the services initialize.
const { CircuitBreakerService } = await import('./circuit-breaker');
const variantCreator = await import('./variant-creator');
const { VesselRouter } = await import('./vessel-router');

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

// =============================================================================
// CIRCUIT BREAKER — circuit_breaker_trace dual-write
// =============================================================================

describe('Phase B4a: circuit-breaker dual-writes account_id on circuit_breaker_trace', () => {
  test('recordFailure → opened transition embeds account_id + version on trace', async () => {
    // Pre-canned getState response (closed state, 4 prior failures so the
    // 5th trips the threshold).
    const closedState = {
      vessel_id: 'v1',
      org_id: 'org-acme',
      state: 'closed',
      state_changed_at: new Date().toISOString(),
      consecutive_failures: 4,
      total_requests: 4,
      failed_requests: 4,
      failure_window_start: new Date().toISOString(),
      max_consecutive_failures: 5,
      failure_rate_threshold: 0.5,
      failure_window_seconds: 60,
      cooldown_period_ms: 30000,
      next_probe_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // 1st call: getState → returns existing row (so no CREATE).
    queryReturnQueue.push([[closedState]]);
    // 2nd call: recordTransition → CREATE circuit_breaker_trace (returns nothing meaningful).
    queryReturnQueue.push([]);
    // 3rd call: UPDATE vessel_circuit_breaker (out-of-scope table; we still
    // need to give it a return value so it doesn't blow up).
    queryReturnQueue.push([[{ ...closedState, state: 'open', consecutive_failures: 5 }]]);

    const result = await CircuitBreakerService.recordFailure(
      'v1',
      'org-acme',
      'TIMEOUT',
      'request timed out',
      undefined,
      'acc-acme-001',
    );

    expect(result.transitioned).toBe(true);

    // The CREATE on circuit_breaker_trace must be present and dual-write.
    const traceCreate = surrealQueries.find((q) =>
      /CREATE\s+circuit_breaker_trace/i.test(q.sql),
    )!;
    expect(traceCreate).toBeDefined();
    expect(traceCreate.sql).toContain('account_id: $account_id');
    expect(traceCreate.sql).toContain('account_id_version: $account_id_version');
    expect(traceCreate.params.org_id ?? traceCreate.params.orgId).toBe('org-acme');
    expect(traceCreate.params.account_id).toBe('acc-acme-001');
    expect(traceCreate.params.account_id_version).toBe(1);
  });

  test('recordFailure with no accountId still writes account_id=null + version=1', async () => {
    const closedState = {
      vessel_id: 'v2',
      org_id: 'org-legacy',
      state: 'closed',
      state_changed_at: new Date().toISOString(),
      consecutive_failures: 4,
      total_requests: 4,
      failed_requests: 4,
      failure_window_start: new Date().toISOString(),
      max_consecutive_failures: 5,
      failure_rate_threshold: 0.5,
      failure_window_seconds: 60,
      cooldown_period_ms: 30000,
      next_probe_at: null,
      last_error_code: null,
      last_error_message: null,
      last_error_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    queryReturnQueue.push([[closedState]]); // getState
    queryReturnQueue.push([]); // recordTransition CREATE
    queryReturnQueue.push([[{ ...closedState, state: 'open' }]]); // UPDATE vessel_circuit_breaker

    await CircuitBreakerService.recordFailure(
      'v2',
      'org-legacy',
      'ECONNRESET',
      'reset',
      // No accountId — should default to null.
    );

    const traceCreate = surrealQueries.find((q) =>
      /CREATE\s+circuit_breaker_trace/i.test(q.sql),
    )!;
    expect(traceCreate).toBeDefined();
    expect(traceCreate.params.account_id).toBeNull();
    // version=1 even when no accountId — Phase F backfill needs this to
    // distinguish "written by Phase B" from "pre-Phase-A".
    expect(traceCreate.params.account_id_version).toBe(1);
  });
});

// =============================================================================
// VARIANT CREATOR — reads + writes
// =============================================================================

describe('Phase B4a: variant-creator dual-binds reads + dual-writes activity variants', () => {
  test('shouldCreateVariant binds account_id and emits dual-tenant SQL on execution reads', async () => {
    // 1st call: SELECT recent executions — return 3 failures so consecutive >= 3.
    const failures = [
      { success: false, error: { message: 'e1', task_id: 't1' }, created_at: 'now' },
      { success: false, error: { message: 'e1', task_id: 't1' }, created_at: 'now' },
      { success: false, error: { message: 'e2', task_id: 't2' }, created_at: 'now' },
    ];
    queryReturnQueue.push([failures]);
    // 2nd call: stats query
    queryReturnQueue.push([[
      {
        total_executions: 10,
        successes: 5,
        failures: 5,
        error_messages: ['e1', 'e2'],
        failed_task_ids: ['t1', 't2'],
      },
    ]]);

    const pattern = await variantCreator.shouldCreateVariant(
      'tmpl-1',
      'org-acme',
      'acc-acme-001',
    );

    expect(pattern).not.toBeNull();
    expect(pattern!.consecutiveFailures).toBe(3);

    // Both reads should dual-bind via accountIdScopedWhere fragment.
    expect(surrealQueries.length).toBeGreaterThanOrEqual(2);
    for (const q of surrealQueries) {
      expect(q.sql).toContain('account_id = $account_id');
      expect(q.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
      expect(q.params.account_id).toBe('acc-acme-001');
      expect(q.params.org_id).toBe('org-acme');
    }
  });

  test('shouldCreateVariant with no accountId binds null and still dual-binds SQL', async () => {
    queryReturnQueue.push([[]]); // empty executions → returns null fast
    const pattern = await variantCreator.shouldCreateVariant('tmpl-x', 'org-legacy');
    expect(pattern).toBeNull();

    const q = surrealQueries[0]!;
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.params.account_id).toBeNull();
    expect(q.params.org_id).toBe('org-legacy');
  });

  test('createVariant writes account_id + version on the new variant row', async () => {
    // Parent template lookup
    const parent = {
      id: 'activity:tmpl-1',
      name: 'Parent',
      description: 'p',
      tags: [],
      category: 'feature',
      tasks: [{ id: 'a', description: '', prompt: { template: '', variables: [] } }],
      scope: 'org',
      project_id: null,
      input_shapes: [],
      output_shapes: [],
      execution_type: 'template',
      variant_generation: 0,
    };
    queryReturnQueue.push([[parent]]); // SELECT parent
    queryReturnQueue.push([[{ count: 0 }]]); // SELECT existing variant count
    queryReturnQueue.push([]); // CREATE variant

    const failurePattern = {
      templateId: 'tmpl-1',
      consecutiveFailures: 3,
      totalExecutions: 10,
      successRate: 0.4,
      commonErrors: ['boom'],
      failedTasks: ['a'],
    };

    const result = await variantCreator.createVariant(
      'tmpl-1',
      failurePattern,
      'org-acme',
      'consecutive_failures',
      'acc-acme-001',
    );

    expect(result).not.toBeNull();

    // Find the CREATE activity:⟨id⟩ statement.
    const createStmt = surrealQueries.find((q) =>
      /CREATE\s+activity:⟨\$variant_id⟩\s+SET/.test(q.sql),
    )!;
    expect(createStmt).toBeDefined();
    expect(createStmt.sql).toContain('account_id = $account_id');
    expect(createStmt.sql).toContain('account_id_version = $account_id_version');
    expect(createStmt.params.org_id).toBe('org-acme');
    expect(createStmt.params.account_id).toBe('acc-acme-001');
    expect(createStmt.params.account_id_version).toBe(1);

    // Reads on parent + variant-count must also dual-bind.
    const reads = surrealQueries.filter((q) =>
      /SELECT\s+\*\s+FROM\s+activity\b/i.test(q.sql) ||
      /SELECT\s+count\(\)/i.test(q.sql),
    );
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const r of reads) {
      expect(r.sql).toContain('account_id = $account_id');
      expect(r.params.account_id).toBe('acc-acme-001');
    }
  });

  test('createVariant with no accountId writes account_id=null', async () => {
    const parent = {
      id: 'activity:tmpl-2',
      name: 'P',
      description: '',
      tags: [],
      category: 'feature',
      tasks: [],
      scope: 'org',
      project_id: null,
      input_shapes: [],
      output_shapes: [],
      execution_type: 'template',
      variant_generation: 0,
    };
    queryReturnQueue.push([[parent]]);
    queryReturnQueue.push([[{ count: 0 }]]);
    queryReturnQueue.push([]);

    await variantCreator.createVariant(
      'tmpl-2',
      {
        templateId: 'tmpl-2',
        consecutiveFailures: 3,
        totalExecutions: 5,
        successRate: 0.0,
        commonErrors: [],
        failedTasks: [],
      },
      'org-legacy',
    );

    const createStmt = surrealQueries.find((q) =>
      /CREATE\s+activity:⟨\$variant_id⟩\s+SET/.test(q.sql),
    )!;
    expect(createStmt.params.account_id).toBeNull();
    expect(createStmt.params.account_id_version).toBe(1);
  });

  test('checkAndRetireTemplate dual-binds the executions read', async () => {
    // 25 successes — won't retire (returns false).
    const execs = Array.from({ length: 25 }, () => ({ success: true }));
    queryReturnQueue.push([execs]);

    const wasRetired = await variantCreator.checkAndRetireTemplate(
      'tmpl-3',
      'org-acme',
      'acc-acme-001',
    );
    expect(wasRetired).toBe(false);

    const q = surrealQueries[0]!;
    expect(q.sql).toMatch(/SELECT\s+success\s+FROM\s+execution/i);
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.params.account_id).toBe('acc-acme-001');
    expect(q.params.org_id).toBe('org-acme');
  });

  test('autoCreateVariantIfNeeded short-circuits on success without DB hit', async () => {
    const result = await variantCreator.autoCreateVariantIfNeeded(
      'tmpl-4',
      'org-acme',
      true, // success → returns null fast
      'acc-acme-001',
    );
    expect(result).toBeNull();
    expect(surrealQueries.length).toBe(0);
  });
});

// =============================================================================
// VESSEL ROUTER — vessel discovery dual-binds
// =============================================================================

describe('Phase B4a: vessel-router dual-binds vessel discovery query', () => {
  test('route() with no candidates issues a vessel SELECT that dual-binds', async () => {
    // Empty vessel list → routing returns no_candidates without invoking
    // health/circuit downstream calls.
    queryReturnQueue.push([[]]);

    const decision = await VesselRouter.route({
      shape: 'someShape',
      org_id: 'org-acme',
      account_id: 'acc-acme-001',
      impulse_id: 'i-1',
    });

    expect(decision.selected_vessel).toBeNull();

    // Find the vessel discovery query.
    const vesselQuery = surrealQueries.find((q) =>
      /SELECT\s+id,\s*endpoint,\s*last_heartbeat\s+FROM\s+vessel/i.test(q.sql),
    )!;
    expect(vesselQuery).toBeDefined();
    expect(vesselQuery.sql).toContain('account_id = $account_id');
    expect(vesselQuery.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(vesselQuery.params.account_id).toBe('acc-acme-001');
    expect(vesselQuery.params.org_id).toBe('org-acme');
  });

  test('route() without account_id binds null and still dual-binds SQL', async () => {
    queryReturnQueue.push([[]]);

    await VesselRouter.route({
      shape: 'someShape',
      org_id: 'org-legacy',
      impulse_id: 'i-2',
    });

    const vesselQuery = surrealQueries.find((q) =>
      /SELECT\s+id,\s*endpoint,\s*last_heartbeat\s+FROM\s+vessel/i.test(q.sql),
    )!;
    expect(vesselQuery).toBeDefined();
    expect(vesselQuery.params.account_id).toBeNull();
    expect(vesselQuery.params.org_id).toBe('org-legacy');
  });
});
