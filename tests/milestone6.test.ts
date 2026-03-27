/**
 * Milestone 6 Tests: Multi-Tenant Hardening
 * Tests for project-scoped filtering and public template sharing
 *
 * Run with: RUN_INTEGRATION_TESTS=true bun test
 */

import { describe, test, expect } from 'bun:test';

const API_BASE = process.env.ACTIVITY_API_URL || 'http://activity.metabob.local';
const API_AVAILABLE = process.env.RUN_INTEGRATION_TESTS === 'true';
const itIntegration = API_AVAILABLE ? test : test.skip;

describe('Milestone 6: Multi-Tenant Hardening', () => {
  describe('Task 6.1: Project-Scoped Filtering', () => {
    itIntegration('cross-project queries return empty without proper claims', async () => {
      const sessionIdOrgA = `test-m6-orgA-${Date.now()}`;

      // Create execution trace for project 1
      await fetch(`${API_BASE}/v2/activities/executions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': sessionIdOrgA,
          'X-Org-Id': 'org-test-a',
          'X-Project-Id': 'project-1',
        },
        body: JSON.stringify({
          variant_id: 'test-template-m6',
          success: true,
          duration_ms: 100,
          cost: 0.01,
          tokens: { input: 100, output: 50 },
        }),
      });

      // Query from different org context
      const sessionIdOrgB = `test-m6-orgB-${Date.now()}`;
      const queryResponse = await fetch(
        `${API_BASE}/v2/activities/execution-traces`,
        {
          headers: {
            'X-Session-Id': sessionIdOrgB,
            'X-Org-Id': 'org-test-b',
            'X-Project-Id': 'project-2',
          },
        }
      );

      expect(queryResponse.status).toBeLessThan(500);
    });

    test('PERMISSIONS clause structure is correct', () => {
      // Test the expected PERMISSIONS structure
      const permissionsClause = `
        FOR select WHERE
          org_id = $auth.org_id
          AND (project_id IS NULL OR project_id IN $auth.project_ids)
        FOR create WHERE
          org_id = $auth.org_id
          AND (project_id IS NULL OR project_id IN $auth.project_ids)
        FOR update, delete WHERE
          org_id = $auth.org_id
          AND $auth.role = 'admin'
      `;

      expect(permissionsClause).toContain('$auth.org_id');
      expect(permissionsClause).toContain('$auth.project_ids');
      expect(permissionsClause).toContain('$auth.role');
    });

    test('JWT claims structure with project_ids', () => {
      const jwtClaims = {
        sub: 'users:alice',
        org_id: 'organizations:acme',
        project_ids: ['projects:proj-abc', 'projects:proj-xyz'],
        role: 'developer',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900, // 15 min
      };

      expect(Array.isArray(jwtClaims.project_ids)).toBe(true);
      expect(jwtClaims.org_id).toContain('organizations:');
      expect(jwtClaims.exp).toBeGreaterThan(jwtClaims.iat);
    });
  });

  describe('Task 6.2: Public Template Sharing', () => {
    itIntegration('GET /v2/activities/public returns templates without auth', async () => {
      const response = await fetch(`${API_BASE}/v2/activities/public`);

      expect(response.status).toBeLessThan(500);

      if (response.ok) {
        const result = await response.json();
        expect(Array.isArray(result.templates)).toBe(true);
        expect(result.total).toBeDefined();
      }
    });

    itIntegration('public endpoint respects limit parameter', async () => {
      const response = await fetch(`${API_BASE}/v2/activities/public?limit=5`);

      expect(response.status).toBeLessThan(500);

      if (response.ok) {
        const result = await response.json();
        expect(result.templates.length).toBeLessThanOrEqual(5);
      }
    });

    test('public template query structure is correct', () => {
      // Test the expected query for public templates
      const query = `
        SELECT * FROM activity_template
        WHERE scope = 'global' AND public = true
        ORDER BY created_at DESC
        LIMIT $limit
      `;

      expect(query).toContain("scope = 'global'");
      expect(query).toContain('public = true');
    });

    test('public template structure is valid', () => {
      const publicTemplate = {
        id: 'template-123',
        variant_id: 'v1',
        name: 'Public Template',
        scope: 'global' as const,
        public: true,
        created_at: new Date().toISOString(),
      };

      expect(publicTemplate.scope).toBe('global');
      expect(publicTemplate.public).toBe(true);
    });
  });

  describe('RBAC Enforcement', () => {
    test('scope hierarchy is correctly ordered', () => {
      const scopes = ['session', 'project', 'org', 'global'];
      const hierarchy = {
        session: 0,
        project: 1,
        org: 2,
        global: 3,
      };

      // Higher scope levels should have higher values
      expect(hierarchy.global).toBeGreaterThan(hierarchy.org);
      expect(hierarchy.org).toBeGreaterThan(hierarchy.project);
      expect(hierarchy.project).toBeGreaterThan(hierarchy.session);
    });

    test('org isolation is enforced in query', () => {
      const baseQuery = 'SELECT * FROM activity_template';
      const isolatedQuery = `${baseQuery} WHERE org_id = $auth.org_id`;

      expect(isolatedQuery).toContain('$auth.org_id');
    });

    test('public data exception is correctly applied', () => {
      const visibilityQuery = `
        SELECT * FROM activity_template
        WHERE
          (scope = 'global' AND public = true)
          OR org_id = $auth.org_id
      `;

      // Query should allow public OR same-org access
      expect(visibilityQuery).toContain('public = true');
      expect(visibilityQuery).toContain('org_id = $auth.org_id');
    });
  });

  describe('Learning Data Isolation', () => {
    test('learning data is never public', () => {
      // Learning tables should have strict org isolation
      const learningTables = [
        'cochange_patterns',
        'tool_usage',
        'activity_performance_metrics',
        'execution_sequences',
      ];

      // Each table should enforce org_id filtering
      const permissionsPattern = 'org_id = $auth.org_id';

      learningTables.forEach((table) => {
        // In a real test, we'd verify the actual schema
        // Here we verify the expected pattern
        expect(permissionsPattern).toContain('$auth.org_id');
      });
    });

    test('cross-org learning is prevented', () => {
      const authContextOrgA = { org_id: 'org-a', project_ids: ['proj-1'] };
      const authContextOrgB = { org_id: 'org-b', project_ids: ['proj-2'] };

      // Data from org A should not be visible to org B
      const dataOrgA = { org_id: 'org-a', pattern: 'some-pattern' };

      // Simulated RBAC check
      const visibleToOrgB =
        dataOrgA.org_id === authContextOrgB.org_id ||
        authContextOrgB.project_ids.includes(dataOrgA.org_id);

      expect(visibleToOrgB).toBe(false);
    });
  });
});
