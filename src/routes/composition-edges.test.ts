/**
 * Composition Edge Tests (Phase 3)
 *
 * Tests for state-based composition learning endpoints:
 * - POST /v2/activities/composition/edges - Record composition edge
 * - GET /v2/activities/composition/edges/successors/:activityId - Query successors
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { surrealDB } from '../db/surreal';
import { app as activitiesApp } from './activities';

// Mock JWT auth context
const mockOrgId = 'test-org-123';
const mockJwtAuth = {
  orgId: mockOrgId,
  authenticated: true,
};

// Helper to create test request with auth context
function createTestRequest(method: string, path: string, body?: any) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Mock context with JWT auth
  const ctx = {
    req,
    json: (data: any, status?: number) => new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    get: (key: string) => {
      if (key === 'jwtAuth') return mockJwtAuth;
      return undefined;
    },
  };

  return ctx;
}

describe('Composition Edge Recording (Phase 3)', () => {
  beforeAll(async () => {
    // Clean up any existing test data
    await surrealDB.query(`
      DELETE FROM composition_edge WHERE org_id = $org_id
    `, { org_id: mockOrgId });
  });

  afterAll(async () => {
    // Clean up test data
    await surrealDB.query(`
      DELETE FROM composition_edge WHERE org_id = $org_id
    `, { org_id: mockOrgId });
  });

  it('should record a composition edge', async () => {
    const edgeData = {
      parent_activity_id: 'fix-bug',
      child_activity_id: 'run-tests',
      state_before: {
        shapes: ['error_log', 'source_code'],
        git: { branch: 'main', dirty: true },
        env: { NODE_ENV: 'development' },
      },
      state_after: {
        shapes: ['code_changes', 'source_code'],
        git: { branch: 'main', dirty: true },
        env: { NODE_ENV: 'development' },
      },
      success: true,
      duration_ms: 5000,
    };

    const ctx = createTestRequest('POST', '/v2/activities/composition/edges', edgeData);
    const response = await activitiesApp.request(ctx.req);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.success).toBe(true);
    expect(result.edge_id).toBeDefined();
  });

  it('should record multiple edges for the same parent-child pair', async () => {
    const baseEdge = {
      parent_activity_id: 'fix-bug',
      child_activity_id: 'run-tests',
      state_before: {
        shapes: ['error_log', 'source_code'],
      },
      state_after: {
        shapes: ['code_changes', 'source_code'],
      },
    };

    // Record successful edge
    const successCtx = createTestRequest('POST', '/v2/activities/composition/edges', {
      ...baseEdge,
      success: true,
      duration_ms: 4500,
    });
    const successResponse = await activitiesApp.request(successCtx.req);
    expect(successResponse.status).toBe(200);

    // Record failed edge
    const failCtx = createTestRequest('POST', '/v2/activities/composition/edges', {
      ...baseEdge,
      success: false,
      duration_ms: 8000,
    });
    const failResponse = await activitiesApp.request(failCtx.req);
    expect(failResponse.status).toBe(200);
  });

  it('should fail without authentication', async () => {
    const edgeData = {
      parent_activity_id: 'fix-bug',
      child_activity_id: 'run-tests',
      state_before: { shapes: [] },
      state_after: { shapes: [] },
      success: true,
      duration_ms: 1000,
    };

    // Create request without auth
    const req = new Request('http://localhost/v2/activities/composition/edges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edgeData),
    });

    const ctx = {
      req,
      json: (data: any, status?: number) => new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      get: () => undefined, // No auth
    };

    const response = await activitiesApp.request(ctx.req);
    expect(response.status).toBe(401);
  });

  it('should validate required fields', async () => {
    const invalidEdge = {
      parent_activity_id: 'fix-bug',
      // Missing child_activity_id
      state_before: { shapes: [] },
      success: true,
    };

    const ctx = createTestRequest('POST', '/v2/activities/composition/edges', invalidEdge);
    const response = await activitiesApp.request(ctx.req);
    expect(response.status).toBe(400);
  });
});

describe('Composition Successor Query (Phase 3)', () => {
  beforeAll(async () => {
    // Clean up and seed test data
    await surrealDB.query(`
      DELETE FROM composition_edge WHERE org_id = $org_id
    `, { org_id: mockOrgId });

    // Seed edges: fix-bug → run-tests (3 success, 1 failure)
    const edges = [
      { parent: 'fix-bug', child: 'run-tests', success: true },
      { parent: 'fix-bug', child: 'run-tests', success: true },
      { parent: 'fix-bug', child: 'run-tests', success: true },
      { parent: 'fix-bug', child: 'run-tests', success: false },
      { parent: 'fix-bug', child: 'commit-changes', success: true },
      { parent: 'fix-bug', child: 'commit-changes', success: true },
    ];

    for (const edge of edges) {
      await surrealDB.query(`
        CREATE composition_edge CONTENT {
          parent_activity_id: $parent,
          child_activity_id: $child,
          state_signature_before: 'test-sig-123',
          state_signature_after: 'test-sig-456',
          success: $success,
          duration_ms: 5000,
          org_id: $org_id,
          created_at: time::now()
        }
      `, {
        parent: edge.parent,
        child: edge.child,
        success: edge.success,
        org_id: mockOrgId,
      });
    }
  });

  afterAll(async () => {
    await surrealDB.query(`
      DELETE FROM composition_edge WHERE org_id = $org_id
    `, { org_id: mockOrgId });
  });

  it('should query successors for an activity', async () => {
    const ctx = createTestRequest('GET', '/v2/activities/composition/edges/successors/fix-bug');
    const response = await activitiesApp.request(ctx.req);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.successors).toBeDefined();
    expect(Array.isArray(result.successors)).toBe(true);
    expect(result.successors.length).toBeGreaterThan(0);

    // Should have run-tests and commit-changes
    const activityIds = result.successors.map((s: any) => s.child_activity_id);
    expect(activityIds).toContain('run-tests');
    expect(activityIds).toContain('commit-changes');
  });

  it('should return successors ranked by success rate', async () => {
    const ctx = createTestRequest('GET', '/v2/activities/composition/edges/successors/fix-bug');
    const response = await activitiesApp.request(ctx.req);
    const result = await response.json();

    expect(response.status).toBe(200);

    // Find run-tests (75% success: 3/4) and commit-changes (100% success: 2/2)
    const runTests = result.successors.find((s: any) => s.child_activity_id === 'run-tests');
    const commitChanges = result.successors.find((s: any) => s.child_activity_id === 'commit-changes');

    expect(runTests).toBeDefined();
    expect(commitChanges).toBeDefined();

    // Verify counts
    expect(runTests.total_occurrences).toBe(4);
    expect(runTests.successful_occurrences).toBe(3);
    expect(runTests.success_rate).toBeCloseTo(0.75, 2);

    expect(commitChanges.total_occurrences).toBe(2);
    expect(commitChanges.successful_occurrences).toBe(2);
    expect(commitChanges.success_rate).toBe(1.0);

    // commit-changes should rank higher (100% success rate)
    const commitIndex = result.successors.indexOf(commitChanges);
    const runTestsIndex = result.successors.indexOf(runTests);
    expect(commitIndex).toBeLessThan(runTestsIndex);
  });

  it('should filter by state signature', async () => {
    const ctx = createTestRequest(
      'GET',
      '/v2/activities/composition/edges/successors/fix-bug?stateSignature=test-sig-123'
    );
    const response = await activitiesApp.request(ctx.req);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.successors).toBeDefined();
    expect(result.successors.length).toBeGreaterThan(0);
  });

  it('should respect minOccurrences parameter', async () => {
    const ctx = createTestRequest(
      'GET',
      '/v2/activities/composition/edges/successors/fix-bug?minOccurrences=3'
    );
    const response = await activitiesApp.request(ctx.req);
    const result = await response.json();

    expect(response.status).toBe(200);

    // Only run-tests should appear (4 occurrences >= 3)
    expect(result.successors.length).toBe(1);
    expect(result.successors[0].child_activity_id).toBe('run-tests');
  });

  it('should respect limit parameter', async () => {
    const ctx = createTestRequest(
      'GET',
      '/v2/activities/composition/edges/successors/fix-bug?limit=1'
    );
    const response = await activitiesApp.request(ctx.req);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.successors.length).toBeLessThanOrEqual(1);
  });

  it('should fail without authentication', async () => {
    const req = new Request('http://localhost/v2/activities/composition/edges/successors/fix-bug');

    const ctx = {
      req,
      json: (data: any, status?: number) => new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      get: () => undefined, // No auth
    };

    const response = await activitiesApp.request(ctx.req);
    expect(response.status).toBe(401);
  });

  it('should return empty array for unknown activity', async () => {
    const ctx = createTestRequest(
      'GET',
      '/v2/activities/composition/edges/successors/unknown-activity'
    );
    const response = await activitiesApp.request(ctx.req);
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.successors).toBeDefined();
    expect(result.successors.length).toBe(0);
  });
});

describe('Multi-Tenant Isolation (Phase 3)', () => {
  const org1 = 'test-org-1';
  const org2 = 'test-org-2';

  beforeAll(async () => {
    // Clean up
    await surrealDB.query(`DELETE FROM composition_edge WHERE org_id IN [$org1, $org2]`, {
      org1,
      org2,
    });

    // Seed edges for org1
    await surrealDB.query(`
      CREATE composition_edge CONTENT {
        parent_activity_id: 'fix-bug',
        child_activity_id: 'run-tests',
        state_signature_before: 'sig-1',
        state_signature_after: 'sig-2',
        success: true,
        duration_ms: 5000,
        org_id: $org1,
        created_at: time::now()
      }
    `, { org1 });

    // Seed edges for org2
    await surrealDB.query(`
      CREATE composition_edge CONTENT {
        parent_activity_id: 'fix-bug',
        child_activity_id: 'deploy',
        state_signature_before: 'sig-1',
        state_signature_after: 'sig-2',
        success: true,
        duration_ms: 5000,
        org_id: $org2,
        created_at: time::now()
      }
    `, { org2 });
  });

  afterAll(async () => {
    await surrealDB.query(`DELETE FROM composition_edge WHERE org_id IN [$org1, $org2]`, {
      org1,
      org2,
    });
  });

  it('should only return edges for the authenticated org', async () => {
    // Query as org1
    const ctx1 = {
      ...createTestRequest('GET', '/v2/activities/composition/edges/successors/fix-bug'),
      get: (key: string) => {
        if (key === 'jwtAuth') return { orgId: org1, authenticated: true };
        return undefined;
      },
    };

    const response1 = await activitiesApp.request(ctx1.req);
    const result1 = await response1.json();

    expect(response1.status).toBe(200);
    expect(result1.successors.length).toBe(1);
    expect(result1.successors[0].child_activity_id).toBe('run-tests');

    // Query as org2
    const ctx2 = {
      ...createTestRequest('GET', '/v2/activities/composition/edges/successors/fix-bug'),
      get: (key: string) => {
        if (key === 'jwtAuth') return { orgId: org2, authenticated: true };
        return undefined;
      },
    };

    const response2 = await activitiesApp.request(ctx2.req);
    const result2 = await response2.json();

    expect(response2.status).toBe(200);
    expect(result2.successors.length).toBe(1);
    expect(result2.successors[0].child_activity_id).toBe('deploy');
  });
});
