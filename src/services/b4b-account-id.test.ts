/**
 * Phase B4b: account_id dual-write coverage for the remaining service files.
 * OpenSpec change: activity-api-account-id-migration-2026-04-28.
 *
 * Files in scope (4 of the 6 priority targets — see Phase B4b report):
 *   - pattern-extraction.ts    (reads + writes execution_pattern; impulse read
 *                               left untouched — it scopes by id IN list, not
 *                               org_id at all)
 *   - pattern-miner.ts         (reads execution_sequences, activity_composition_graph,
 *                               composite_sequence_patterns)
 *   - vessel-health.ts         (reads vessel, circuit_breaker_trace, routing_trace)
 *   - routing-trace.ts         (writes routing_trace; reads queryTraces)
 *
 * Skipped — see report for rationale:
 *   - auth.ts:               no SurrealDB queries; all JWT + HTTP. account_id
 *                            is already plumbed in AuthContext (Phase A.5).
 *   - discovery-client.ts:   no SurrealDB queries; pure HTTP client to
 *                            discovery-vessel.
 *
 * Pattern (locked in by B1+B2+B3+B4a): writes set both account_id + org_id
 * with account_id_version=1 (or null + version=1 when caller has no
 * accountId); reads dual-bind both params so legacy rows (account_id IS NONE)
 * still match via the org_id branch. SurrealDB queries are captured via mock
 * so we can assert SQL text + params without round-tripping a live DB.
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
const patternExtraction = await import('./pattern-extraction');
const patternMiner = await import('./pattern-miner');
const vesselHealth = await import('./vessel-health');
const { RoutingTraceService } = await import('./routing-trace');

beforeEach(() => {
  surrealQueries.length = 0;
  queryReturnQueue = [];
});

// =============================================================================
// PATTERN EXTRACTION — execution_pattern dual-write + queryPatterns dual-bind
// =============================================================================

describe('Phase B4b: pattern-extraction dual-writes execution_pattern', () => {
  test('extractAndUpsertPattern (CREATE branch) writes account_id + version', async () => {
    // queryReturnQueue items are returned verbatim from surrealDB.query.
    // pattern-extraction.ts treats results as flat row arrays (result[0]
    // → first row), so we mirror that here.
    // 1: extractShapesFromImpulses - input impulses
    queryReturnQueue.push([{ shape: 'fileDiff' }, { shape: 'gitLog' }]);
    // 2: extractShapesFromImpulses - output impulses
    queryReturnQueue.push([{ shape: 'patchSet' }]);
    // 3: SELECT existing pattern (none → triggers CREATE branch)
    queryReturnQueue.push([]);
    // 4: CREATE execution_pattern
    queryReturnQueue.push([]);

    await patternExtraction.extractAndUpsertPattern({
      executionId: 'exec-1',
      activityId: 'tmpl-1',
      inputImpulses: ['i1', 'i2'],
      outputImpulses: ['o1'],
      success: true,
      durationMs: 1234,
      costUsd: 0.01,
      tokensIn: 100,
      tokensOut: 50,
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
    });

    const createStmt = surrealQueries.find((q) =>
      /CREATE\s+execution_pattern\s+CONTENT/i.test(q.sql),
    )!;
    expect(createStmt).toBeDefined();
    expect(createStmt.sql).toContain('account_id: $account_id');
    expect(createStmt.sql).toContain('account_id_version: 1');
    expect(createStmt.sql).toContain('org_id: $org_id');
    expect(createStmt.params.org_id).toBe('org-acme');
    expect(createStmt.params.account_id).toBe('acc-acme-001');

    const findStmt = surrealQueries.find((q) =>
      /SELECT\s+\*\s+FROM\s+execution_pattern/i.test(q.sql),
    )!;
    expect(findStmt).toBeDefined();
    expect(findStmt.sql).toContain('account_id = $account_id');
    expect(findStmt.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(findStmt.params.org_id).toBe('org-acme');
    expect(findStmt.params.account_id).toBe('acc-acme-001');
  });

  test('extractAndUpsertPattern (UPDATE branch) writes account_id + version', async () => {
    queryReturnQueue.push([{ shape: 'fileDiff' }]);
    queryReturnQueue.push([{ shape: 'patchSet' }]);
    // SELECT existing pattern returns one row (flat array of rows)
    queryReturnQueue.push([
      {
        execution_count: 5,
        success_count: 4,
        failure_count: 1,
        avg_cost_usd: 0.02,
        avg_duration_ms: 1000,
        avg_tokens_in: 100,
        avg_tokens_out: 50,
        activity_templates: ['tmpl-1'],
      },
    ]);
    // UPDATE returns nothing meaningful
    queryReturnQueue.push([]);

    await patternExtraction.extractAndUpsertPattern({
      executionId: 'exec-2',
      activityId: 'tmpl-1',
      inputImpulses: ['i1'],
      outputImpulses: ['o1'],
      success: true,
      durationMs: 2000,
      costUsd: 0.03,
      tokensIn: 120,
      tokensOut: 60,
      orgId: 'org-legacy',
      // No accountId — should default to null.
    });

    const updateStmt = surrealQueries.find((q) =>
      /^\s*UPDATE\s+execution_pattern/im.test(q.sql),
    )!;
    expect(updateStmt).toBeDefined();
    expect(updateStmt.sql).toContain('account_id = $account_id');
    expect(updateStmt.sql).toContain('account_id_version = 1');
    expect(updateStmt.params.org_id).toBe('org-legacy');
    expect(updateStmt.params.account_id).toBeNull();
  });

  test('queryPatterns dual-binds the WHERE clause with account_id', async () => {
    queryReturnQueue.push([[]]); // patterns
    queryReturnQueue.push([[{ total: 0 }]]); // count

    const result = await patternExtraction.queryPatterns({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      sortBy: 'execution_count',
    });

    expect(result.total).toBe(0);

    for (const q of surrealQueries) {
      expect(q.sql).toContain('account_id = $account_id');
      expect(q.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
      expect(q.params.account_id).toBe('acc-acme-001');
      expect(q.params.org_id).toBe('org-acme');
    }
  });

  test('queryPatterns with no accountId binds null and still dual-binds SQL', async () => {
    queryReturnQueue.push([[]]);
    queryReturnQueue.push([[{ total: 0 }]]);

    await patternExtraction.queryPatterns({ orgId: 'org-legacy' });

    const q = surrealQueries[0]!;
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.params.account_id).toBeNull();
    expect(q.params.org_id).toBe('org-legacy');
  });
});

// =============================================================================
// PATTERN MINER — reads with optional org filter
// =============================================================================

describe('Phase B4b: pattern-miner dual-binds tenant-scoped reads', () => {
  test('discoverSequencePatterns dual-binds execution_sequences when orgId set', async () => {
    queryReturnQueue.push([[]]); // queryFrequentSequences → empty

    const patterns = await patternMiner.discoverSequencePatterns({
      orgId: 'org-acme',
      accountId: 'acc-acme-001',
      minFrequency: 1,
    });
    expect(patterns).toEqual([]);

    const seqQuery = surrealQueries.find((q) =>
      /FROM\s+execution_sequences/i.test(q.sql),
    )!;
    expect(seqQuery).toBeDefined();
    expect(seqQuery.sql).toContain('account_id = $account_id');
    expect(seqQuery.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(seqQuery.params.account_id).toBe('acc-acme-001');
    expect(seqQuery.params.org_id).toBe('org-acme');
  });

  test('discoverSequencePatterns omits tenant filter when orgId not provided', async () => {
    queryReturnQueue.push([[]]);

    await patternMiner.discoverSequencePatterns({ minFrequency: 1 });

    const seqQuery = surrealQueries.find((q) =>
      /FROM\s+execution_sequences/i.test(q.sql),
    )!;
    expect(seqQuery).toBeDefined();
    // Without orgId, no tenant filter is appended (legacy root-query path)
    expect(seqQuery.sql).not.toContain('account_id = $account_id');
  });

  test('isPatternExtracted dual-binds composite_sequence_patterns lookup', async () => {
    queryReturnQueue.push([]); // empty result

    const found = await patternMiner.isPatternExtracted(
      ['a', 'b'],
      'org-acme',
      'acc-acme-001',
    );
    expect(found).toBe(false);

    const q = surrealQueries[0]!;
    expect(q.sql).toMatch(/FROM\s+composite_sequence_patterns/i);
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.params.account_id).toBe('acc-acme-001');
    expect(q.params.org_id).toBe('org-acme');
  });
});

// =============================================================================
// VESSEL HEALTH — vessel + circuit_breaker_trace + routing_trace dual-binds
// =============================================================================

describe('Phase B4b: vessel-health dual-binds vessel + trace queries', () => {
  test('computeVesselHealthScore dual-binds all three reads', async () => {
    // 1: vessel SELECT
    queryReturnQueue.push([
      [
        {
          last_heartbeat: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    ]);
    // 2: circuit_breaker_trace SELECT
    queryReturnQueue.push([[{ state: 'closed', failure_count: 0 }]]);
    // 3: routing_trace SELECT
    queryReturnQueue.push([[{ success: true }]]);

    const score = await vesselHealth.computeVesselHealthScore(
      'v1',
      'org-acme',
      'acc-acme-001',
    );
    expect(score.vesselId).toBe('v1');

    expect(surrealQueries.length).toBe(3);
    for (const q of surrealQueries) {
      expect(q.sql).toContain('account_id = $account_id');
      expect(q.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
      expect(q.params.account_id).toBe('acc-acme-001');
      expect(q.params.org_id).toBe('org-acme');
    }
  });

  test('getOrganizationVesselHealth dual-binds vessel SELECT and threads accountId', async () => {
    // Outer SELECT id FROM vessel
    queryReturnQueue.push([[]]); // no vessels — short-circuits inner loop

    const scores = await vesselHealth.getOrganizationVesselHealth(
      'org-acme',
      'acc-acme-001',
    );
    expect(scores).toEqual([]);

    const q = surrealQueries[0]!;
    expect(q.sql).toMatch(/SELECT\s+id\s+FROM\s+vessel/i);
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.params.account_id).toBe('acc-acme-001');
    expect(q.params.org_id).toBe('org-acme');
  });

  test('computeVesselHealthScore with no accountId binds null', async () => {
    queryReturnQueue.push([
      [{ last_heartbeat: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }],
    ]);
    queryReturnQueue.push([[]]);
    queryReturnQueue.push([[]]);

    await vesselHealth.computeVesselHealthScore('v2', 'org-legacy');

    for (const q of surrealQueries) {
      expect(q.params.account_id).toBeNull();
      expect(q.params.org_id).toBe('org-legacy');
    }
  });
});

// =============================================================================
// ROUTING TRACE — sync write + queryTraces dual-bind
// =============================================================================

describe('Phase B4b: routing-trace dual-writes routing_trace and dual-binds queryTraces', () => {
  test('recordTraceSync writes account_id + version on routing_trace', async () => {
    queryReturnQueue.push([]); // CREATE routing_trace returns nothing

    await RoutingTraceService.recordTraceSync({
      impulse_id: 'i-1',
      shape: 'shape',
      org_id: 'org-acme',
      account_id: 'acc-acme-001',
      discovery_query_duration_ms: 5,
      candidates: [],
      health_scores: {},
      circuit_states: {},
      excluded_vessels: [],
      selected_vessel_id: null,
      selection_algorithm: 'health_weighted',
      outcome: 'failure',
    });

    const createStmt = surrealQueries.find((q) =>
      /CREATE\s+routing_trace\s+CONTENT/i.test(q.sql),
    )!;
    expect(createStmt).toBeDefined();
    expect(createStmt.sql).toContain('account_id: $accountId');
    expect(createStmt.sql).toContain('account_id_version: $accountIdVersion');
    expect(createStmt.params.accountId).toBe('acc-acme-001');
    expect(createStmt.params.accountIdVersion).toBe(1);
    expect(createStmt.params.orgId).toBe('org-acme');
  });

  test('recordTraceSync with no account_id writes null + version=1', async () => {
    queryReturnQueue.push([]);

    await RoutingTraceService.recordTraceSync({
      impulse_id: 'i-2',
      shape: 'shape',
      org_id: 'org-legacy',
      // No account_id — should default to null.
      discovery_query_duration_ms: 5,
      candidates: [],
      health_scores: {},
      circuit_states: {},
      excluded_vessels: [],
      selected_vessel_id: null,
      selection_algorithm: 'health_weighted',
      outcome: 'failure',
    });

    const createStmt = surrealQueries.find((q) =>
      /CREATE\s+routing_trace\s+CONTENT/i.test(q.sql),
    )!;
    expect(createStmt).toBeDefined();
    expect(createStmt.params.accountId).toBeNull();
    expect(createStmt.params.accountIdVersion).toBe(1);
  });

  test('queryTraces dual-binds the WHERE clause', async () => {
    queryReturnQueue.push([[]]);

    await RoutingTraceService.queryTraces({
      org_id: 'org-acme',
      account_id: 'acc-acme-001',
      shape: 'someShape',
    });

    const q = surrealQueries[0]!;
    expect(q.sql).toMatch(/FROM\s+routing_trace/i);
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.sql).toMatch(/account_id IS NONE\s+AND\s+org_id\s*=\s*\$org_id/);
    expect(q.params.account_id).toBe('acc-acme-001');
    expect(q.params.org_id).toBe('org-acme');
  });

  test('queryTraces with no account_id binds null and still dual-binds SQL', async () => {
    queryReturnQueue.push([[]]);

    await RoutingTraceService.queryTraces({ org_id: 'org-legacy' });

    const q = surrealQueries[0]!;
    expect(q.sql).toContain('account_id = $account_id');
    expect(q.params.account_id).toBeNull();
    expect(q.params.org_id).toBe('org-legacy');
  });
});
